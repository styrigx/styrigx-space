/**
 * @fileoverview POST /ask：站内召回 + 模型流式回答（方案 5.2；P4-2 起模型两类：自营 Workers AI / 外部 Gemini）。
 * 只经网关 /api/ai 的服务绑定 AI_SERVICE 进来。
 *
 * 请求：POST { q, lang?: 'zh'|'en', history?: [{ role:'user'|'assistant', text }], model?: '<id>' }，JSON，最多 BODY_MAX 字节。
 *   头 X-Styrigx-Account-Session: 1（网关写的账号结论头）→ 私密条目进召回，且 model 生效（只认登记里的 id，见 core/models.js）；
 *   没有 / 别的值 → 只召回公开条目，model 忽略，一律默认模型（切模型只能登账号）。
 * 回答：200 text/event-stream，事件顺序固定（2026-11-06 起不再发 event: hits：召回只作模型上下文，不给浏览器来源列表）：
 * *   event: delta  data: { text }                                         （0 到多次）
 *   event: done   data: {}
 *   出错时（已经开始流以后）：event: error data: { code: 'upstream' }，然后关流（不再发 done）。
 *   响应头 X-Styrigx-AI-Scope: private | public（这次召回用了哪一档；前端只用来显示，方案 5.5）。
 *   召回为空也调模型：hits 空，上下文写明没有相关条目，由模型回应（打招呼照常答，站内问题说没找到）。
 *   2026-11-05 前召回为空直接回固定句不调模型，连「你好」都答不了，已去掉。
 *   外部模型出错时 code 也可能是 rate_limited / model_unavailable（Gemini 429 / 404 等）。
 *   模型正常结束但一个字正文都没有 → event: error { code: 'empty' }（日志 [ai] empty answer 带 finish_reason 和思考字数）。
 * 错误（还没开始流）：405 method · 400 bad_request / too-long / bad_model · 413 too-large ·
 *   503 config（选中自营模型但没绑 AI）/ no_key（选中外部模型但钥匙没绑 / 读不到）/ index（索引读不了）。
 *
 * 浏览器断开：网关把浏览器请求的 signal 带进服务绑定请求；这里 request.signal abort 或流被取消时，取消上游的流。
 * 不存对话、不写 KV。
 */
import { loadIndexes, recall } from '../core/recall.js';
import { buildMessages, Q_MAX } from '../core/prompt.js';
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
    maxTokens: intVar(env && env.AI_MAX_TOKENS, 1024, 64, 2048),
    contextHits: intVar(env && env.AI_CONTEXT_HITS, 5, 1, 10),
  };
}

/**
 * 各自营模型的额外参数。Gemma 4 在 Workers AI 上默认开思考（chat_template_kwargs.enable_thinking 默认 true），
 * 思考段单独走 reasoning 字段、也吃 max_tokens：站内问答带上下文时思考就能把额度用完，正文一个字都没有
 * （2026-11-05 #273 冒烟：有召回的问题全回「没能拿到回答」，只有几乎无召回的「你好」答得出）。这里关掉思考。
 * GPT-OSS 的输入没有这个开关（传了会被校验拒），不加。
 * @param {string} id
 */
export function runExtras(id) {
  if (/gemma-4/.test(id)) return { chat_template_kwargs: { enable_thinking: false } };
  return {};
}

/**
 * 流里一段的思考字数（只计数用于排查，不回浏览器）。
 * @param {any} chunk
 */
export function chunkReasoning(chunk) {
  const c = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  const d = c && c.delta;
  if (!d) return 0;
  const r = typeof d.reasoning_content === 'string' ? d.reasoning_content : typeof d.reasoning === 'string' ? d.reasoning : '';
  return r.length;
}

/** @param {any} chunk */
function finishReason(chunk) {
  const c = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  return c && typeof c.finish_reason === 'string' ? c.finish_reason : '';
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
  return { ok: true, q, lang: body.lang === 'zh' ? 'zh' : 'en' /* P4-3 PR-4c：没带语言（或不认识）按英文，四站默认语言 */, history: body.history, model: body.model };
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
      let sentText = false;
      let reasoningChars = 0;
      let finish = '';
      try {
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
              if (text) { sentText = true; send('delta', { text }); }
            }
          } finally {
            clearTimeout(timer);
          }
        } else {
          const up = await ai.run(model.id, { messages, stream: true, max_tokens: cfg.maxTokens, ...runExtras(model.id) });
          if (!up || typeof up.getReader !== 'function') throw new Error('not-a-stream');
          upReader = up.getReader();
          if (closed) { try { await upReader.cancel(); } catch (e) {} return; }
          for await (const data of sseData(upReader)) {
            if (closed) break;
            if (data.trim() === '[DONE]') break;
            let chunk;
            try { chunk = JSON.parse(data); } catch (e) { continue; }
            reasoningChars += chunkReasoning(chunk);
            finish = finishReason(chunk) || finish;
            const text = filter.push(chunkText(chunk));
            if (text) { sentText = true; send('delta', { text }); }
          }
        }
        if (closed) return;
        const tail = filter.flush();
        if (tail) { sentText = true; send('delta', { text: tail }); }
        if (!sentText) {
          /* 模型正常结束但没有正文（额度被思考段用完 / 只输出了思考）：记日志，回 error 让前端提示，不当成功 */
          console.error('[ai] empty answer', JSON.stringify({ model: model.id, finish, reasoningChars, hits: hits.length }));
          send('error', { code: 'empty' });
          return;
        }
        send('done', {});
      } catch (e) {
        console.error('[ai] answer failed', e && /** @type {any} */ (e).name, e && String(/** @type {any} */ (e).message || '').slice(0, 300));
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
