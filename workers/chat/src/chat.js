/**
 * @fileoverview styrigx-chat 的聊天内核（2026-10-22 从网关 functions/api/chat.js 搬过来）：只做「联网检索 + 回答」。
 *
 * 用途（管理员定）：聊天只用来检索网站，不放私密信息、没有长期记忆。这里不存任何对话：
 * 浏览器每次把整段对话（只在 sessionStorage）发给网关 /api/chat，网关验完门转进来，这里转给模型、把回答以 SSE 流回去，什么都不留。
 *
 * 门在网关（workers/auth-gateway/functions/api/chat.js），这里不验 cookie：
 * - 同源 POST（否则 403 origin）、锁屏会话（没有 / 无效 → 401）、只许管理员（访客 → 403 admin_only），都由网关先做。
 * - 本 Worker 没有公开地址（workers_dev / preview_urls 关、没有路由），唯一入口是网关的服务绑定 CHAT；
 *   入口（src/index.js）再要求网关写的 X-Sgx-Role: admin，没有就 403 admin_only（双保险）。
 *
 *   GET  /models → 200 { ok:true, default:'<id>', models:[{ id, label, search }] }（网关 GET /api/chat 原样转回）
 *     search = 这个模型实际会不会带联网工具（CHAT_SEARCH=off 或 openai 模式时一律 false）。
 *   POST /chat  { messages: [{ role: 'user'|'model', text }], model?: '<id>' }（网关 POST /api/chat 原样转进来、原样流回去）
 *   model 可选：必须是 CHAT_MODELS 白名单里的 id → 否则 400 { error: 'bad_model' }（绝不接受任意模型名）；不给 = 默认模型。
 *   校验：1–20 条，每条 text 是非空字符串、≤ 4000 字，合计 ≤ 24000 字，最后一条必须是 user → 否则 400 { error: 'bad_request' }
 *   → 200 text/event-stream，每个事件一行 `data: <JSON>`：
 *       {"t":"delta","text":"…"}                      回答的一段（按顺序拼起来）
 *       {"t":"meta","web":false}                     只在「工具被上游拒了、不带工具重试」时第一条发：这次回答没联网
 *       {"t":"sources","items":[{"title","uri"}]}     检索来源（gemini 才有，去重、最多 8 条；没有就不发）
 *       {"t":"done"}                                  正常结束
 *       {"t":"error","code":"rate_limited"|"model_unavailable"|"upstream"} 流到一半出错（之后不再有事件）
 *   开始流之前的错误回 JSON { ok:false, error }：
 *       400 bad_request / bad_model · 405 method
 *       503 no_key（没配钥匙 / 读不到）· 429 rate_limited（上游 429，这个模型的免费额度用完）·
 *       502 model_unavailable（上游 404，或 403 / 400 说模型 not found / not supported / permission）· 502 upstream（上游其他错误 / 超时）
 *   （401 unauthorized · 403 origin / admin_only 由网关回。）
 *   上游 400 说的是工具 / 搜索接地（google_search 等不支持）→ 不带工具自动重试一次（只一次），回答开头带 meta web:false。
 *
 * 配置（workers/chat/wrangler.toml [vars]）：
 *   CHAT_PROVIDER  "gemini"（默认）| "openai"（任意 OpenAI 兼容接口，没有联网检索）
 *   CHAT_API_BASE  gemini："https://generativelanguage.googleapis.com/v1beta"；openai：到 /v1 为止
 *   CHAT_MODEL     "gemini-2.5-flash"（免费档能用 Google 搜索接地的只有 2.5 flash / flash-lite，2026-10-22 查 ai.google.dev）
 *   CHAT_SEARCH    "on" | "off"：总开关（gemini 才看；off = 哪个模型都不带联网工具）
 *   CHAT_MODELS    模型白名单（JSON 字符串，2026-10-22）：[{ "id", "label", "search" }]。
 *                  search = 这个模型带不带 google_search + url_context（免费档 Gemini 3+ 的搜索接地是「Not available」，只有 2.5 Flash / Flash-Lite 能开）。
 *                  CHAT_MODEL 是默认 id（不在白名单里就用第一个）；CHAT_MODELS 没配 / 坏 JSON / 没有一条合格 →
 *                  退回只有 [{ id: CHAT_MODEL, label: CHAT_MODEL, search: CHAT_SEARCH 开 }]。openai 模式也用这份列表（search 忽略）。
 * 钥匙：Secrets Store 绑定 SGX_CHAT_API_KEY（await env.SGX_CHAT_API_KEY.get()；本地测试可以直接是字符串）。
 *   只在 POST 用到时才读；没配 / 读失败 → 503 no_key。钥匙绝不回给浏览器、绝不打印。
 *   2026-10-22 起这把钥匙只绑在本 Worker 上，网关不再绑定它：钥匙没建好只影响本 Worker 的部署，不拖累网关。
 * 注意：Gemini 的 OpenAI 兼容端点（/v1beta/openai/chat/completions）不支持 Google 搜索接地，所以 gemini 走原生 streamGenerateContent。
 */

export const MAX_MESSAGES = 20;
export const MAX_TEXT = 4000;
export const MAX_TOTAL = 24000;
export const MAX_SOURCES = 8;
export const UPSTREAM_TIMEOUT_MS = 60 * 1000;

const NO_STORE = 'private, no-store';
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash';

/** @param {number} status @param {any} body */
export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE },
  });
}

/**
 * 系统提示：简短回答、用用户的语言、凡是时效性的东西先搜、给出处。today = UTC 日期（模型不知道今天几号）。
 * search = false（不联网的模型 / 工具被上游拒了重试）：不提搜索，改成「靠已有知识回答、可能过时就直说」。
 * @param {string} today YYYY-MM-DD
 * @param {boolean} [search]
 */
export function systemPrompt(today, search = true) {
  return [
    'You are the web-search helper on a personal website. Today is ' + today + ' (UTC).',
    'Answer concisely in the language the user writes in (中文问就用简体中文回答).',
    search
      ? 'Use Google Search for anything current, factual, or that you are not sure about; read linked pages when the user gives a URL.'
      : 'Web search is not available for this answer: reply from what you already know and say plainly when it may be out of date.',
    search
      ? 'Base the answer on what you found and mention the sources. If the results do not answer it, say so plainly.'
      : 'Do not invent sources or links.',
    'Use short paragraphs, bullet lists and **bold** sparingly; no tables, no HTML.',
  ].join('\n');
}

/**
 * 上游没成功（HTTP 非 2xx）→ 我们的错误码。text = 上游错误体（只用来分类，不回给浏览器、不打印）。
 *   429 → rate_limited（这个模型的免费额度用完了）
 *   400 + 带了工具 + 错误说的是工具 / 搜索接地（google_search、url_context、grounding、tool）→ tools（不带工具重试一次）
 *   404；403 / 400 且说 not found / not supported / permission / not available → model_unavailable（换个模型）
 *   其他 → upstream
 * @param {number} status @param {string} text @param {boolean} hadTools
 * @returns {'rate_limited'|'tools'|'model_unavailable'|'upstream'}
 */
export function classifyUpstream(status, text, hadTools) {
  const t = String(text || '');
  if (status === 429) return 'rate_limited';
  if (status === 400 && hadTools && /google_search|url_context|grounding|\btools?\b/i.test(t)) return 'tools';
  if (status === 404) return 'model_unavailable';
  if ((status === 403 || status === 400) && /not[ _]found|not[ _]supported|permission|not[ _]available|unsupported/i.test(t)) return 'model_unavailable';
  return 'upstream';
}

/** 读上游错误体（最多 4 KB，读失败 → ''） @param {Response} res */
async function errText(res) {
  try {
    const t = await res.text();
    return t.slice(0, 4096);
  } catch (e) {
    return '';
  }
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

export const MAX_MODELS = 12;
/** 模型 id：只许这些字符（进 URL 路径前还会 encodeURIComponent）；openai 兼容接口常见的 org/model 也认 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,99}$/;

/**
 * 模型白名单（CHAT_MODELS）。坏的条目跳过、id 去重、最多 MAX_MODELS 条；一条合格的都没有 → 退回只有默认模型。
 * search：gemini + CHAT_SEARCH 开 + 这条 search === true 才是 true。
 * @param {any} env
 * @returns {{ def: string, models: Array<{id:string, label:string, search:boolean}> }}
 */
export function chatModels(env) {
  const provider = String((env && env.CHAT_PROVIDER) || 'gemini').toLowerCase() === 'openai' ? 'openai' : 'gemini';
  const globalSearch = provider === 'gemini' && String((env && env.CHAT_SEARCH) || 'on').toLowerCase() !== 'off';
  const fallbackId = String((env && env.CHAT_MODEL) || DEFAULT_MODEL);
  let raw = env && env.CHAT_MODELS;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { raw = null; }
  }
  /** @type {Array<{id:string, label:string, search:boolean}>} */
  const models = [];
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (models.length >= MAX_MODELS) break;
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !MODEL_ID_RE.test(m.id)) continue;
      if (models.some((x) => x.id === m.id)) continue;
      const label = typeof m.label === 'string' && m.label.trim() ? m.label.trim().slice(0, 60) : m.id;
      models.push({ id: m.id, label, search: globalSearch && m.search === true });
    }
  }
  if (!models.length) return { def: fallbackId, models: [{ id: fallbackId, label: fallbackId, search: globalSearch }] };
  const def = models.some((x) => x.id === fallbackId) ? fallbackId : models[0].id;
  return { def, models };
}

/**
 * @param {any} env
 * @param {string} [modelId] 已经核对过在白名单里的 id；不给 = 默认
 */
function chatConfig(env, modelId) {
  const provider = String((env && env.CHAT_PROVIDER) || 'gemini').toLowerCase() === 'openai' ? 'openai' : 'gemini';
  const base = String((env && env.CHAT_API_BASE) || (provider === 'gemini' ? DEFAULT_GEMINI_BASE : '')).replace(/\/+$/, '');
  const { def, models } = chatModels(env);
  const m = models.find((x) => x.id === (modelId || def)) || models[0];
  return { provider, base, model: m.id, search: m.search };
}

/**
 * GET /models：模型列表（页面的模型切换）。只读、不碰钥匙、不调上游。
 * @param {any} env
 */
export function handleModels(env) {
  const { def, models } = chatModels(env);
  return json(200, { ok: true, default: def, models });
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
    systemInstruction: { parts: [{ text: systemPrompt(new Date().toISOString().slice(0, 10), cfg.search) }] },
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
    messages: [{ role: 'system', content: systemPrompt(new Date().toISOString().slice(0, 10), false) }].concat(
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

/**
 * POST /chat：回答（SSE）。门（同源 / 会话 / 只许管理员）已经在网关做过。
 * @param {Request} request @param {any} env
 */
export async function handleChat(request, env) {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method' });

  let body;
  try { body = await request.json(); } catch (e) { return json(400, { ok: false, error: 'bad_request' }); }
  const v = validateMessages(body);
  if (!v.ok) return json(400, { ok: false, error: 'bad_request' });
  /* 模型：只认白名单里的 id（null / 不给 = 默认） */
  const want = body.model;
  if (want !== undefined && want !== null && (typeof want !== 'string' || !chatModels(env).models.some((x) => x.id === want))) {
    return json(400, { ok: false, error: 'bad_model' });
  }

  const cfg = chatConfig(env, typeof want === 'string' ? want : undefined);
  if (!hasKeyBinding(env) || !cfg.base) return json(503, { ok: false, error: 'no_key' });
  const key = await readKey(env);
  if (!key) return json(503, { ok: false, error: 'no_key' });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  /* 浏览器点「停止」/ 断开 → 一起断上游，不白花额度 */
  try { if (request.signal) request.signal.addEventListener('abort', () => ac.abort(), { once: true }); } catch (e) {}

  /** @type {Response} */
  let up;
  /* 工具（搜索接地）被上游拒了 → 不带工具重试一次，这次回答开头发 {"t":"meta","web":false}（页面脚注「未联网」） */
  let degraded = false;
  try {
    const attempt = (/** @type {any} */ c) => (c.provider === 'gemini' ? geminiRequest(c, key, v.messages, ac.signal) : openaiRequest(c, key, v.messages, ac.signal));
    up = await attempt(cfg);
    if (!up.ok && up.status === 400 && cfg.provider === 'gemini' && cfg.search) {
      const kind = classifyUpstream(up.status, await errText(up), true);
      if (kind === 'tools') {
        console.error('[chat] tools rejected, retrying without tools');
        degraded = true;
        up = await attempt({ ...cfg, search: false });
      } else {
        clearTimeout(timer);
        console.error('[chat] upstream status', up.status);
        return json(502, { ok: false, error: kind === 'model_unavailable' ? 'model_unavailable' : 'upstream' });
      }
    }
  } catch (e) {
    clearTimeout(timer);
    console.error('[chat] upstream fetch failed', e && /** @type {any} */ (e).name);
    return json(502, { ok: false, error: 'upstream' });
  }
  if (!up.ok || !up.body) {
    clearTimeout(timer);
    console.error('[chat] upstream status', up.status);
    const kind = up.ok ? 'upstream' : classifyUpstream(up.status, await errText(up), false);
    try { await up.body?.cancel(); } catch (e) {}
    if (kind === 'rate_limited') return json(429, { ok: false, error: 'rate_limited' });
    if (kind === 'model_unavailable') return json(502, { ok: false, error: 'model_unavailable' });
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
        if (degraded) send({ t: 'meta', web: false });
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
              const ec = chunk.error.code === 429 || chunk.error.status === 'RESOURCE_EXHAUSTED' ? 'rate_limited' : chunk.error.code === 404 || chunk.error.status === 'NOT_FOUND' ? 'model_unavailable' : 'upstream';
              send({ t: 'error', code: ec });
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
