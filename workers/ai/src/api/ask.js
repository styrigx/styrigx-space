/**
 * @fileoverview POST /ask：站内召回 + 模型流式回答（方案 5.2；P4-2 起模型两类：自营 Workers AI / 外部 Gemini）。
 * 只经网关 /api/ai 的服务绑定 AI_SERVICE 进来。
 *
 * 请求：POST { q, lang?: 'zh'|'en', history?: [{ role:'user'|'assistant', text }], model?: '<id>' }，JSON，最多 BODY_MAX 字节。
 *   头 X-Styrigx-Account-Session: 1（网关写的账号结论头）→ 私密条目进召回，且 model 生效（只认登记里的 id，见 core/models.js）；
 *   没有 / 别的值 → 只召回公开条目，model 忽略，一律默认模型（切模型只能登账号）。
 * 回答：200 text/event-stream，事件顺序固定：
 *   event: hits   data: { hits: [{ site, type, title, subtitle, url }] }   （来源列表，不带正文）
 *   event: delta  data: { text }                                         （0 到多次）
 *   event: done   data: {}
 *   出错时（已经开始流以后）：event: error data: { code: 'upstream' }，然后关流（不再发 done）。
 *   响应头 X-Styrigx-AI-Scope: private | public（这次召回用了哪一档；前端只用来显示，方案 5.5）。
 *   召回为空 → 不调模型，hits 空 + 一段固定 delta（站内没有找到相关内容）+ done。
 *   外部模型出错时 code 也可能是 rate_limited / model_unavailable（Gemini 429 / 404 等）。
 * 错误（还没开始流）：405 method · 400 bad_request / too-long / bad_model · 413 too-large ·
 *   503 config（选中自营模型但没绑 AI）/ no_key（选中外部模型但钥匙没绑 / 读不到）/ index（索引读不了）。
 *
 * 浏览器断开：网关把浏览器请求的 signal 带进服务绑定请求；这里 request.signal abort 或流被取消时，取消上游的流。
 * 不存对话、不写 KV。
 */
import { loadIndexes, recall, publicHits } from '../core/recall.js';
import { buildMessages, Q_MAX, NOTHING_FOUND } from '../core/prompt.js';
import { thinkFilter } from '../core/think.js';
import { loadModels, pickModel } from '../core/models.js';
import { readKey, hasKeyBinding, geminiRequest, geminiChunk, classifyUpstream, errText, UPSTREAM_TIMEOUT_MS } from '../core/gemini.js';
import { apiError, SSE_HEADERS, sseEvent, sseData } from '../lib/http.js';

export const BODY_MAX = 16 * 1024;
export const ACCOUNT_SESSION_HEADER = 'X-Styrigx-Account-Session';
export const SCOPE_HEADER = 'X-Styrigx-AI-Scope';
/** 这次回答用的模型 id（只用来显示 / 排查，不含钥匙） */
export const MODEL_HEADER = 'X-Styrigx-AI-Model';

/** @param {any} v @param {number} dflt @param {number} lo @param {number} hi */
function intVar(v, dflt, lo, hi) {
  const n = parseInt(String(v == null ? '' : v), 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

/** @param {any} env */
export function aiConfig(env) {
  return {
    maxTokens: intVar(env && env.AI_MAX_TOKENS, 512, 64, 1024),
    contextHits: intVar(env && env.AI_CONTEXT_HITS, 5, 1, 10),
  };
}

/**
 * Workers AI 流里一段的正文：老格式 { response }，OpenAI 兼容格式 { choices: [{ delta: { content } }] }。
 * @param {any} chunk
 */
export function chunkText(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  if (typeof chunk.response === 'string') return chunk.response;
  const c = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (c && c.delta && typeof c.delta.content === 'string') return c.delta.content;
  return '';
}

/**
 * 解析并校验请求体。
 * @param {Request} request
 * @returns {Promise<{ok: true, q: string, lang: 'zh'|'en', history: any, model: any} | {ok: false, res: Response}>}
 */
async function readAsk(request) {
  let buf;
  try { buf = await request.arrayBuffer(); } catch (e) { return { ok: false, res: apiError(400, 'bad_request') }; }
  if (buf.byteLength > BODY_MAX) return { ok: false, res: apiError(413, 'too-large') };
  let body;
  try { body = JSON.parse(new TextDecoder().decode(buf)); } catch (e) { return { ok: false, res: apiError(400, 'bad_request') }; }
  if (!body || typeof body !== 'object' || typeof body.q !== 'string') return { ok: false, res: apiError(400, 'bad_request') };
  const q = body.q.trim();
  if (!q) return { ok: false, res: apiError(400, 'bad_request') };
  if ([...q].length > Q_MAX) return { ok: false, res: apiError(400, 'too-long') };
  return { ok: true, q, lang: body.lang === 'en' ? 'en' : 'zh', history: body.history, model: body.model };
}

/**
 * @param {Request} request
 * @param {any} env
 */
export async function onRequestPost(request, env) {
  if (request.method !== 'POST') return apiError(405, 'method');
  const a = await readAsk(request);
  if (!a.ok) return a.res;
  const cfg = aiConfig(env);
  const showPrivate = request.headers.get(ACCOUNT_SESSION_HEADER) === '1';
  const picked = pickModel(await loadModels(env), a.model, showPrivate);
  if (!picked.ok) return apiError(400, 'bad_model');
  const model = picked.model;
  const ai = env && env.AI;
  let key = '';
  if (model.provider === 'gemini') {
    if (!hasKeyBinding(env)) return apiError(503, 'no_key');
    key = await readKey(env);
    if (!key) return apiError(503, 'no_key');
  } else if (!ai || typeof ai.run !== 'function') {
    return apiError(503, 'config');
  }
  let indexes;
  try {
    indexes = await loadIndexes(env);
  } catch (e) {
    console.error('[ai] index load failed', e && /** @type {any} */ (e).message);
    return apiError(503, 'index');
  }
  const hits = recall(indexes, { q: a.q, lang: a.lang, showPrivate, limit: cfg.contextHits });

  /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */
  let upReader = null;
  let closed = false;
  const ac = new AbortController();
  const stopUpstream = () => {
    closed = true;
    ac.abort();
    if (upReader) { try { upReader.cancel(); } catch (e) {} }
  };
  try { if (request.signal) request.signal.addEventListener('abort', stopUpstream, { once: true }); } catch (e) {}

  const stream = new ReadableStream({
    async start(controller) {
      const send = (/** @type {string} */ ev, /** @type {any} */ data) => { if (!closed) controller.enqueue(sseEvent(ev, data)); };
      try {
        send('hits', { hits: publicHits(hits) });
        if (!hits.length) {
          send('delta', { text: NOTHING_FOUND[a.lang] });
          send('done', {});
          return;
        }
        const messages = buildMessages({ q: a.q, lang: a.lang, history: a.history, hits });
        const filter = thinkFilter();
        if (model.provider === 'gemini') {
          const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
          try {
            const up = await geminiRequest(env, key, model.id, messages, cfg.maxTokens, ac.signal);
            if (!up.ok || !up.body) {
              const code = up.ok ? 'upstream' : classifyUpstream(up.status, await errText(up));
              console.error('[ai] gemini upstream status', up.status);
              send('error', { code });
              return;
            }
            upReader = up.body.getReader();
            if (closed) { try { await upReader.cancel(); } catch (e) {} return; }
            for await (const data of sseData(upReader)) {
              if (closed) break;
              let chunk;
              try { chunk = JSON.parse(data); } catch (e) { continue; }
              const r = geminiChunk(chunk);
              if (r.error) { send('error', { code: r.error }); return; }
              const text = filter.push(r.text);
              if (text) send('delta', { text });
            }
          } finally {
            clearTimeout(timer);
          }
        } else {
          const up = await ai.run(model.id, { messages, stream: true, max_tokens: cfg.maxTokens });
          if (!up || typeof up.getReader !== 'function') throw new Error('not-a-stream');
          upReader = up.getReader();
          if (closed) { try { await upReader.cancel(); } catch (e) {} return; }
          for await (const data of sseData(upReader)) {
            if (closed) break;
            if (data.trim() === '[DONE]') break;
            let chunk;
            try { chunk = JSON.parse(data); } catch (e) { continue; }
            const text = filter.push(chunkText(chunk));
            if (text) send('delta', { text });
          }
        }
        if (closed) return;
        const tail = filter.flush();
        if (tail) send('delta', { text: tail });
        send('done', {});
      } catch (e) {
        console.error('[ai] answer failed', e && /** @type {any} */ (e).name);
        try { send('error', { code: 'upstream' }); } catch (e2) {}
      } finally {
        try { controller.close(); } catch (e) {}
      }
    },
    cancel() {
      stopUpstream();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { ...SSE_HEADERS, [SCOPE_HEADER]: showPrivate ? 'private' : 'public', [MODEL_HEADER]: model.id },
  });
}
