/**
 * @fileoverview /api/chat：主站聊天页（/chat/，2026-10-22）的后端——只做「联网检索 + 回答」。
 *
 * 用途（站长定）：聊天只用来检索网站，不放私密信息、没有长期记忆。网关不存任何对话：
 * 浏览器每次把整段对话（只在 sessionStorage）发过来，这里转给模型、把回答以 SSE 流回去，什么都不留。
 *
 * 门：
 * - 只接受同源 POST（_kernel/http.js isSameOrigin，同 /api/prefs）→ 否则 403 origin
 * - 锁屏会话：没有 / 无效 → 401；访客（visitor）→ 403 { error: 'owner_only' }（聊天额度是站长的，访客不能用）
 *
 *   POST /api/chat  { messages: [{ role: 'user'|'model', text }] }
 *   校验：1–20 条，每条 text 是非空字符串、≤ 4000 字，合计 ≤ 24000 字，最后一条必须是 user → 否则 400 { error: 'bad_request' }
 *   → 200 text/event-stream，每个事件一行 `data: <JSON>`：
 *       {"t":"delta","text":"…"}                      回答的一段（按顺序拼起来）
 *       {"t":"sources","items":[{"title","uri"}]}     检索来源（gemini 才有，去重、最多 8 条；没有就不发）
 *       {"t":"done"}                                  正常结束
 *       {"t":"error","code":"rate_limited"|"upstream"} 流到一半出错（之后不再有事件）
 *   开始流之前的错误回 JSON { ok:false, error }：
 *       400 bad_request · 401 unauthorized · 403 origin / owner_only · 405 method
 *       503 no_key（没配钥匙 / 读不到）· 429 rate_limited（上游 429，免费额度用完）· 502 upstream（上游其他错误 / 超时）
 *
 * 配置（wrangler.toml [vars]）：
 *   CHAT_PROVIDER  "gemini"（默认）| "openai"（任意 OpenAI 兼容接口，没有联网检索）
 *   CHAT_API_BASE  gemini："https://generativelanguage.googleapis.com/v1beta"；openai：到 /v1 为止
 *   CHAT_MODEL     "gemini-2.5-flash"（免费档能用 Google 搜索接地的只有 2.5 flash / flash-lite，2026-10-22 查 ai.google.dev）
 *   CHAT_SEARCH    "on" | "off"（gemini 才看：开 = tools 里加 google_search + url_context）
 * 钥匙：Secrets Store 绑定 SGX_CHAT_API_KEY（await env.SGX_CHAT_API_KEY.get()；本地测试可以直接是字符串）。
 *   不进 src/secrets.js 的 SECRET_NAMES：那份是每个请求都预读的签名钥匙，聊天钥匙只在这里用到时才读，
 *   没配 / 读失败也只影响聊天（503 no_key），不拖累锁屏、账号等其他接口。钥匙绝不回给浏览器、绝不打印。
 * 注意：Gemini 的 OpenAI 兼容端点（/v1beta/openai/chat/completions）不支持 Google 搜索接地，所以 gemini 走原生 streamGenerateContent。
 */
import { verifySessionDetailed } from '../_middleware.js';
import { ROLE_OWNER } from '../_kernel/session.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';

export const MAX_MESSAGES = 20;
export const MAX_TEXT = 4000;
export const MAX_TOTAL = 24000;
export const MAX_SOURCES = 8;
export const UPSTREAM_TIMEOUT_MS = 60 * 1000;

const NO_STORE = 'private, no-store';
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash';

/** @param {number} status @param {any} body */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE },
  });
}

/**
 * 系统提示：简短回答、用用户的语言、凡是时效性的东西先搜、给出处。today = UTC 日期（模型不知道今天几号）。
 * @param {string} today YYYY-MM-DD
 */
export function systemPrompt(today) {
  return [
    'You are the web-search helper on a personal website. Today is ' + today + ' (UTC).',
    'Answer concisely in the language the user writes in (中文问就用简体中文回答).',
    'Use Google Search for anything current, factual, or that you are not sure about; read linked pages when the user gives a URL.',
    'Base the answer on what you found and mention the sources. If the results do not answer it, say so plainly.',
    'Use short paragraphs, bullet lists and **bold** sparingly; no tables, no HTML.',
  ].join('\n');
}

/**
 * 校验并清洗请求体。
 * @param {any} body
 * @returns {{ok:true, messages:Array<{role:'user'|'model', text:string}>}|{ok:false}}
 */
export function validateMessages(body) {
  const list = body && Array.isArray(body.messages) ? body.messages : null;
  if (!list || list.length < 1 || list.length > MAX_MESSAGES) return { ok: false };
  let total = 0;
  /** @type {Array<{role:'user'|'model', text:string}>} */
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') return { ok: false };
    if (m.role !== 'user' && m.role !== 'model') return { ok: false };
    if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > MAX_TEXT) return { ok: false };
    total += m.text.length;
    if (total > MAX_TOTAL) return { ok: false };
    out.push({ role: m.role, text: m.text });
  }
  if (out[out.length - 1].role !== 'user') return { ok: false };
  return { ok: true, messages: out };
}

/** 读聊天钥匙：字符串原样；Secrets Store 绑定 → get()；没绑 / 读失败 → ''（不打印值） @param {any} env */
async function readKey(env) {
  const v = env && env.SGX_CHAT_API_KEY;
  if (typeof v === 'string') return v.trim();
  if (v && typeof v.get === 'function') {
    try {
      const s = await v.get();
      return typeof s === 'string' ? s.trim() : '';
    } catch (e) {
      console.error('[chat] key read failed');
      return '';
    }
  }
  return '';
}

/** @param {any} env */
function chatConfig(env) {
  const provider = String((env && env.CHAT_PROVIDER) || 'gemini').toLowerCase() === 'openai' ? 'openai' : 'gemini';
  const base = String((env && env.CHAT_API_BASE) || (provider === 'gemini' ? DEFAULT_GEMINI_BASE : '')).replace(/\/+$/, '');
  const model = String((env && env.CHAT_MODEL) || DEFAULT_MODEL);
  const search = String((env && env.CHAT_SEARCH) || 'on').toLowerCase() !== 'off';
  return { provider, base, model, search };
}

/**
 * 逐个吐出上游 SSE 的 data 字段（多行 data 用 \n 拼起来）。兼容 \n / \r\n 分隔。
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<string>}
 */
export async function* sseData(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  /** @param {string} block */
  const dataOf = (block) => {
    const lines = block.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (!lines.length) return null;
    return lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const d = dataOf(block);
      if (d != null) yield d;
    }
  }
  buf += dec.decode();
  const d = dataOf(buf);
  if (d != null && d.trim()) yield d;
}

/** 来源去重（按 uri）、只要 http(s)、最多 MAX_SOURCES 条 @param {Array<{title:string, uri:string}>} list @param {any} src */
function addSources(list, src) {
  for (const s of src) {
    if (list.length >= MAX_SOURCES) return;
    const uri = s && typeof s.uri === 'string' ? s.uri : '';
    if (!/^https?:\/\//i.test(uri) || list.some((x) => x.uri === uri)) continue;
    const title = s && typeof s.title === 'string' ? s.title.slice(0, 200) : '';
    list.push({ title, uri });
  }
}

/**
 * Gemini 一个流片段（GenerateContentResponse）→ 文本 + 来源。
 * 文本 = candidates[0].content.parts[].text（跳过 thought）；来源 = groundingMetadata.groundingChunks[].web
 * 和 urlContextMetadata.urlMetadata[].retrievedUrl（读成功的）。
 * @param {any} chunk
 * @returns {{text:string, sources:Array<{title:string, uri:string}>, blocked:boolean}}
 */
export function geminiChunk(chunk) {
  const c = chunk && Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
  let text = '';
  /** @type {Array<{title:string, uri:string}>} */
  const sources = [];
  if (c && c.content && Array.isArray(c.content.parts)) {
    for (const p of c.content.parts) if (p && typeof p.text === 'string' && !p.thought) text += p.text;
  }
  const gm = c && c.groundingMetadata;
  if (gm && Array.isArray(gm.groundingChunks)) {
    for (const g of gm.groundingChunks) if (g && g.web) sources.push({ title: g.web.title || '', uri: g.web.uri || '' });
  }
  const um = c && c.urlContextMetadata;
  if (um && Array.isArray(um.urlMetadata)) {
    for (const u of um.urlMetadata) {
      if (u && u.retrievedUrl && (!u.urlRetrievalStatus || /SUCCESS/.test(u.urlRetrievalStatus))) sources.push({ title: '', uri: u.retrievedUrl });
    }
  }
  const blocked = !!(chunk && chunk.promptFeedback && chunk.promptFeedback.blockReason);
  return { text, sources, blocked };
}

/** @param {{base:string, model:string, search:boolean}} cfg @param {string} key @param {Array<{role:string, text:string}>} messages @param {AbortSignal} signal */
function geminiRequest(cfg, key, messages, signal) {
  /** @type {any} */
  const body = {
    contents: messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    systemInstruction: { parts: [{ text: systemPrompt(new Date().toISOString().slice(0, 10)) }] },
  };
  if (cfg.search) body.tools = [{ google_search: {} }, { url_context: {} }];
  const url = cfg.base + '/models/' + encodeURIComponent(cfg.model) + ':streamGenerateContent?alt=sse';
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal,
  });
}

/** @param {{base:string, model:string}} cfg @param {string} key @param {Array<{role:string, text:string}>} messages @param {AbortSignal} signal */
function openaiRequest(cfg, key, messages, signal) {
  const body = {
    model: cfg.model,
    stream: true,
    messages: [{ role: 'system', content: systemPrompt(new Date().toISOString().slice(0, 10)) }].concat(
      messages.map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text }))
    ),
  };
  return fetch(cfg.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
    signal,
  });
}

/** OpenAI 兼容流片段 → 文本 @param {any} chunk */
export function openaiChunk(chunk) {
  const ch = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  const d = ch && ch.delta;
  return d && typeof d.content === 'string' ? d.content : '';
}

/** @param {any} env */
function hasKeyBinding(env) {
  const v = env && env.SGX_CHAT_API_KEY;
  return typeof v === 'string' || (v != null && typeof v.get === 'function');
}

/** @param {{request: Request, env: any}} ctx */
export async function onRequestPost({ request, env }) {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method' });
  if (!isSameOrigin(request)) return originDenied();
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok) return json(401, { ok: false, error: 'unauthorized' });
  if (sess.role !== ROLE_OWNER) return json(403, { ok: false, error: 'owner_only' });

  let body;
  try { body = await request.json(); } catch (e) { return json(400, { ok: false, error: 'bad_request' }); }
  const v = validateMessages(body);
  if (!v.ok) return json(400, { ok: false, error: 'bad_request' });

  const cfg = chatConfig(env);
  if (!hasKeyBinding(env) || !cfg.base) return json(503, { ok: false, error: 'no_key' });
  const key = await readKey(env);
  if (!key) return json(503, { ok: false, error: 'no_key' });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  /* 浏览器点「停止」/ 断开 → 一起断上游，不白花额度 */
  try { if (request.signal) request.signal.addEventListener('abort', () => ac.abort(), { once: true }); } catch (e) {}

  /** @type {Response} */
  let up;
  try {
    up = cfg.provider === 'gemini' ? await geminiRequest(cfg, key, v.messages, ac.signal) : await openaiRequest(cfg, key, v.messages, ac.signal);
  } catch (e) {
    clearTimeout(timer);
    console.error('[chat] upstream fetch failed', e && /** @type {any} */ (e).name);
    return json(502, { ok: false, error: 'upstream' });
  }
  if (!up.ok || !up.body) {
    clearTimeout(timer);
    console.error('[chat] upstream status', up.status);
    try { await up.body?.cancel(); } catch (e) {}
    if (up.status === 429) return json(429, { ok: false, error: 'rate_limited' });
    return json(502, { ok: false, error: 'upstream' });
  }

  const enc = new TextEncoder();
  const upBody = up.body;
  const stream = new ReadableStream({
    async start(controller) {
      /** @param {any} ev */
      const send = (ev) => controller.enqueue(enc.encode('data: ' + JSON.stringify(ev) + '\n\n'));
      /** @type {Array<{title:string, uri:string}>} */
      const sources = [];
      let failed = false;
      try {
        for await (const data of sseData(upBody)) {
          if (cfg.provider === 'openai') {
            if (data.trim() === '[DONE]') break;
            let chunk;
            try { chunk = JSON.parse(data); } catch (e) { continue; }
            if (chunk && chunk.error) { failed = true; send({ t: 'error', code: 'upstream' }); break; }
            const text = openaiChunk(chunk);
            if (text) send({ t: 'delta', text });
          } else {
            let chunk;
            try { chunk = JSON.parse(data); } catch (e) { continue; }
            if (chunk && chunk.error) {
              failed = true;
              send({ t: 'error', code: chunk.error.code === 429 || chunk.error.status === 'RESOURCE_EXHAUSTED' ? 'rate_limited' : 'upstream' });
              break;
            }
            const r = geminiChunk(chunk);
            if (r.blocked) { failed = true; send({ t: 'error', code: 'upstream' }); break; }
            if (r.text) send({ t: 'delta', text: r.text });
            addSources(sources, r.sources);
          }
        }
        if (!failed) {
          if (sources.length) send({ t: 'sources', items: sources });
          send({ t: 'done' });
        }
      } catch (e) {
        console.error('[chat] stream failed', e && /** @type {any} */ (e).name);
        try { send({ t: 'error', code: 'upstream' }); } catch (e2) {}
      } finally {
        clearTimeout(timer);
        try { controller.close(); } catch (e) {}
      }
    },
    cancel() {
      clearTimeout(timer);
      ac.abort();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': NO_STORE,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
