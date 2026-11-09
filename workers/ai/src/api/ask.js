/**
 * @fileoverview POST /ask：站内召回 + 模型流式回答（方案 5.2；P4-2 起模型两类：自营 Workers AI / 外部 Gemini）。
 * 只经网关 /api/ai 的服务绑定 AI_SERVICE 进来。
 *
 * 请求：POST { q, lang?: 'zh'|'en', history?: [{ role:'user'|'assistant', text }], model?: '<id>' }，JSON，最多 BODY_MAX 字节。
 *   头 X-Styrigx-Account-Session: 1（网关写的账号结论头）→ 私密条目进召回，且 model 生效（只认登记里的 id，见 core/models.js）；
 *   没有 / 别的值 → 只召回公开条目，model 忽略，一律默认模型（切模型只能登账号）。
 * 回答：200 text/event-stream，事件顺序固定（2026-11-06 起不再发 event: hits：召回只作模型上下文，不给浏览器来源列表）：
 *   event: delta    data: { text }                                         （0 到多次）
 *   event: sources  data: { items: [{ title, url }] }                      （只有 gemini 模型用了 Google 搜索时，0 或 1 次，在 done 之前；2026-11 AI 语义召回）
 *   event: done     data: {}
 *   出错时（已经开始流以后）：event: error data: { code: 'upstream' }，然后关流（不再发 done）。
 *   响应头 X-Styrigx-AI-Scope: private | public（这次召回用了哪一档；前端只用来显示，方案 5.5）。
 *   召回为空也调模型：hits 空，上下文写明没有相关条目，由模型回应（打招呼照常答，站内问题说没找到）。
 *   2026-11-05 前召回为空直接回固定句不调模型，连「你好」都答不了，已去掉。
 *   外部模型出错时 code 也可能是 rate_limited / model_unavailable（Gemini 429 / 404 等）。
 *   模型正常结束但一个字正文都没有 → event: error { code: 'empty' }（日志 [ai] empty answer 带 finish_reason 和思考字数；
 *   gemini 是 [ai] gemini empty，带 finishReason 和 usageMetadata 的计数）。
 *   gemini 首字前的重试见 core/gemini.js geminiOpen（5xx 退避 2 次、每次首字 20 秒、总共 60 秒；搜索被拒不带工具重试一次；
 *   3.x Flash 429 → 换 Flash-Lite 一次，Lite 也 429 → error { code: 'daily_limit' }，明确是每分钟限额才是 rate_limited）；
 *   首字一直不来 → error { code: 'timeout' }。
 * 错误（还没开始流）：405 method · 400 bad_request / too-long / bad_model · 413 too-large ·
 *   503 config（选中自营模型但没绑 AI）/ no_key（选中外部模型但钥匙没绑 / 读不到）/ index（索引读不了）。
 *
 * 召回（2026-11 AI 语义召回）：三路并行，合成给模型的上下文——
 *   固定查询（core/fixed.js，问句认出「最近 N 部电影」「某专辑曲目」等 → 奇趣的服务绑定 CURIO，只读、参数化）放最前；
 *   语义召回（core/semantic.js，问句嵌入 → Vectorize topK）在前、关键词召回（core/recall.js，KV 索引）补后，去重后最多 AI_CONTEXT_HITS 条。
 *   语义召回出错（没建索引、嵌入失败…）只打日志，退回关键词召回；KV 也读不了才 503 index。
 * 浏览器断开：网关把浏览器请求的 signal 带进服务绑定请求；这里 request.signal abort 或流被取消时，取消上游的流。
 * 不存对话。不写 KV（写只在 Cron 同步向量时，见 core/vector-sync.js）。
 */
import { loadIndexes, recall } from '../core/recall.js';
import { semanticRecall, mergeHits } from '../core/semantic.js';
import { fixedHits } from '../core/fixed.js';
import { buildMessages, Q_MAX, AI_LANGS } from '../core/prompt.js';
import { thinkFilter } from '../core/think.js';
import { loadModels, pickModel } from '../core/models.js';
import { readKey, hasKeyBinding, geminiOpen, geminiChunk, geminiSources, geminiMeta, geminiMaxTokens, redact, UPSTREAM_TIMEOUT_MS } from '../core/gemini.js';
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
  const ms = parseFloat(String((env && env.AI_RECALL_MIN_SCORE) || ''));
  return {
    maxTokens: intVar(env && env.AI_MAX_TOKENS, 1024, 64, 2048),
    contextHits: intVar(env && env.AI_CONTEXT_HITS, 5, 1, 10),
    /** 语义召回的最低相似度（余弦，0–1）；没配 / 坏的用 core/semantic.js MIN_SCORE */
    minScore: Number.isFinite(ms) && ms >= 0 && ms <= 1 ? ms : undefined,
    /** gemini 模型带 Google 搜索（默认开；AI_GEMINI_SEARCH = "0" 关） */
    geminiSearch: String((env && env.AI_GEMINI_SEARCH) == null ? '1' : env.AI_GEMINI_SEARCH) !== '0',
  };
}

/**
 * 三路召回 → 上下文条目。KV 和 Vectorize 都用不了 → { ok:false }（调用方回 503 index）。
 * @param {any} env @param {{q: string, lang: 'zh'|'en'}} a @param {boolean} showPrivate @param {ReturnType<typeof aiConfig>} cfg
 */
export async function gatherHits(env, a, showPrivate, cfg) {
  let kwOk = true;
  const kwP = loadIndexes(env).then(
    (ix) => recall(ix, { q: a.q, lang: a.lang, showPrivate, limit: cfg.contextHits }),
    (e) => { kwOk = false; console.error('[ai] index load failed', e && /** @type {any} */ (e).message); return []; },
  );
  let semOk = true;
  const semP = semanticRecall(env, { q: a.q, lang: a.lang, showPrivate, limit: cfg.contextHits, minScore: cfg.minScore }).catch((e) => {
    semOk = false;
    const msg = String((e && /** @type {any} */ (e).message) || 'error');
    if (msg !== 'no-vectorize') console.error('[ai] semantic recall failed', msg.slice(0, 200));
    return [];
  });
  const [kw, sem, fixed] = await Promise.all([kwP, semP, fixedHits(env, a.q, a.lang)]);
  if (!kwOk && !semOk) return { ok: false, hits: [] };
  return { ok: true, hits: [...fixed, ...mergeHits(sem, kw, cfg.contextHits)] };
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
  return { ok: true, q, lang: AI_LANGS.includes(body.lang) ? body.lang : 'en' /* P4-3 PR-4c：没带语言（或不认识）按英文，四站默认语言；语言列表 = prompt.js AI_LANGS */, history: body.history, model: body.model };
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
  const gathered = await gatherHits(env, a, showPrivate, cfg);
  if (!gathered.ok) return apiError(503, 'index');
  const hits = gathered.hits;

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
      /** @type {Array<{title: string, url: string}>} Gemini 联网来源（去重） */
      const sources = [];
      let reasoningChars = 0;
      let finish = '';
      /* gemini 空回答排查用：最后的 finishReason、usageMetadata 计数、这次带没带搜索 */
      let gFinish = '';
      /** @type {Record<string, number> | null} */
      let gUsage = null;
      let gSearch = false;
      /** gemini 实际用的模型（429 换过 Flash-Lite 就是它；响应头 X-Styrigx-AI-Model 仍是选中的那个） */
      let gModel = model.id;
      try {
        const search = model.provider === 'gemini' && cfg.geminiSearch;
        const messages = buildMessages({ q: a.q, lang: a.lang, history: a.history, hits, web: search });
        const filter = thinkFilter();
        if (model.provider === 'gemini') {
          const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;
          const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
          try {
            const opened = await geminiOpen(env, key, model.id, (/** @type {boolean} */ s) => (s === search ? messages : buildMessages({ q: a.q, lang: a.lang, history: a.history, hits, web: s })), geminiMaxTokens(cfg.maxTokens), { search, signal: ac.signal, deadline });
            gModel = opened.model || model.id;
            if (!opened.ok) {
              if (opened.aborted || closed) return;
              /* 脱敏日志（不含钥匙）：2026-10-28 起的故障靠这行定位（reason=location 即地区不支持） */
              console.error('[ai] gemini upstream', JSON.stringify({ model: gModel, picked: model.id, attempts: opened.attempts, ...opened.d }));
              send('error', { code: opened.d.code });
              return;
            }
            upReader = opened.reader;
            if (closed) { try { await upReader.cancel(); } catch (e) {} return; }
            for await (const data of sseData(/** @type {any} */ (upReader))) {
              if (closed) break;
              let chunk;
              try { chunk = JSON.parse(data); } catch (e) { continue; }
              const r = geminiChunk(chunk);
              if (r.error) {
                console.error('[ai] gemini stream error', JSON.stringify({ model: gModel, code: r.error, detail: redact(JSON.stringify(chunk.error || chunk.promptFeedback || {}), 300) }));
                send('error', { code: r.error });
                return;
              }
              const meta = geminiMeta(chunk);
              if (meta.finishReason) gFinish = meta.finishReason;
              if (meta.usage) gUsage = meta.usage;
              for (const s of geminiSources(chunk)) if (!sources.some((x) => x.url === s.url)) sources.push(s);
              const text = filter.push(r.text);
              if (text) { sentText = true; send('delta', { text }); }
            }
            gSearch = opened.search;
          } catch (e) {
            if (closed) return;
            const timedOut = Date.now() >= deadline - 50;
            console.error('[ai] gemini answer failed', JSON.stringify({ model: gModel, timedOut, sentText, name: e && /** @type {any} */ (e).name, message: redact(e && /** @type {any} */ (e).message, 200) }));
            send('error', { code: timedOut ? 'timeout' : 'upstream' });
            return;
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
          if (model.provider === 'gemini') console.error('[ai] gemini empty', redact(JSON.stringify({ model: gModel, picked: model.id, finishReason: gFinish, usage: gUsage, search: gSearch, hits: hits.length }), 600));
          else console.error('[ai] empty answer', JSON.stringify({ model: model.id, finish, reasoningChars, hits: hits.length }));
          send('error', { code: 'empty' });
          return;
        }
        if (sources.length) send('sources', { items: sources.slice(0, 8) });
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
