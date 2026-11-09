/**
 * @fileoverview 外部模型：Gemini API（P4-2，2026-11-04 补充说明「chat 并入 AI」）。调用逻辑从 workers/chat/src/chat.js 搬来。
 *
 * 系统提示 + 召回上下文同自营模型（core/prompt.js）。2026-11 AI 语义召回起带 Google 搜索（google_search 工具，Gray 2026-11-07 同意），
 * 只对 gemini 模型：回答里用到的网页来源从 groundingMetadata.groundingChunks 取 { title, url }，由 api/ask.js 发 event: sources，前端按可点链接显示。
 * 工具被拒（400 且错误里提到 tool / google_search）→ api/ask.js 不带工具重试一次。
 * 原生 streamGenerateContent（?alt=sse）；钥匙 Secrets Store 绑定 SGX_CHAT_API_KEY，用到才读，绝不回给浏览器、绝不打印。
 *
 * 2026-10-28 起 Gemini 答不了话：原来 errText 读了上游错误体却只用来分类，日志只有状态码，看不出原因。
 * 现在 describeUpstream 把错误体解析成 { code, reason, googleStatus, message }（message 脱敏：去掉形如 AIza… 的钥匙和 key= 参数，截 300 字），
 * 打一行 [ai] gemini upstream 日志。推测（未验证）根因是 Worker 在 Gemini 不支持的地区（如香港）执行，上游回
 * 400 FAILED_PRECONDITION「User location is not supported for the API use.」→ reason = 'location'，回浏览器 code 'region'。
 * 对策见 wrangler.toml [placement]（固定到美国区）；部署后看这行日志验证。
 *
 * 2026-11-09 换 Gemini 3（fix/ai-gemini-3）：Workers Logs 2026-11-09 06:12 UTC 上游 404 NOT_FOUND「gemini-2.5-flash no longer available to new users」。
 * 只换模型 id 不够（之前试过 3.8 Flash 也不行），一起改了这些：
 * - 3.x 默认思考（3.8 Flash 默认 medium），思考也吃 maxOutputTokens；1024 的额度会被思考吃光，正文为空 / 长时间无首字。
 *   → gemini-3* / 4* 带 generationConfig.thinkingConfig.thinkingLevel = 'low'（generateContent 文档：3.x 用 thinkingLevel，
 *   不能和 thinkingBudget 一起发；3.8 Flash 不支持 minimal），maxOutputTokens 抬到 geminiMaxTokens()（至少 4096，封顶 8192）。
 * - 免费档 3.8 Flash 偶尔 503 overloaded；429 限流 → 首字前最多重试 2 次（退避 0.8 s、2 s），每次首字超时 20 s，总共不超过 60 s（geminiOpen）。
 * - 免费档 3.x 不提供 Google 搜索 grounding（价目表「Grounding with Google Search：Free Tier Not available」），拒绝不一定是 400
 *   → searchRejected 放宽成：带工具时任何 4xx（除 429 / 404 / 地区 / 钥匙），不带工具重试一次，并在本 isolate 内 10 分钟不再带工具。
 * - 退役 id（gemini-2.5-flash 等）→ 当前 id（GEMINI_CURRENT）：KV ai:models 是手写的值，优先于 wrangler.toml，里面可能还是旧 id。
 * - 脱敏多认一种钥匙格式 AQ.…（新版 auth key）。
 *
 * 2026-11-09 第二轮（fix/ai-gemini-lite）：这把钥匙是免费档，AI Studio 配额页：3.8 / 3.6 / 3 Flash、2.5 Flash 每分钟 5 次、每天 20 次；
 * 3.5 / 3.1 Flash-Lite 每分钟 15 次、每天 500 次（最宽）；Pro 免费额度 0。所以：
 * - 主力外部模型改为 gemini-3.5-flash-lite（GEMINI_LITE），3.8 Flash（GEMINI_FLASH）留作第二选项；退役 id 换成这两条。
 * - 思考档按模型：Flash-Lite 用 minimal（文档：3.5 Flash-Lite 默认就是 minimal，支持 minimal/low/medium/high；发 low 反而多想），
 *   其余 3.x / 4.x 用 low（3.8 Flash 不支持 minimal）。
 * - 3.x Flash（非 Lite）429 → 不再退避重试，直接换 Flash-Lite 一次（日志 [ai] gemini fallback）；Flash-Lite 也 429 → code daily_limit
 *   （错误体明确是每分钟限额时才回 rate_limited，并按原节奏退避重试）。
 * - 搜索被拒的记忆改为整把钥匙（免费档所有模型都没有搜索 grounding），不再按模型记。
 */

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** 一次回答的总时限（首字前的重试 + 流式输出都算在里面） */
export const UPSTREAM_TIMEOUT_MS = 60 * 1000;

/**
 * 首字前的重试节奏（可调，测试会改小）。firstByteMs：每次尝试从发请求到读到第一段字节的上限；
 * backoffMs：第 n 次重试前等多久（长度 = 最多重试几次）；minAttemptMs：总时限剩不到这么多就不再发起新的尝试。
 */
export const GEMINI_TIMING = { firstByteMs: 20 * 1000, backoffMs: [800, 2000], minAttemptMs: 3 * 1000 };

/** 外部模型（docs: https://ai.google.dev/gemini-api/docs/models ，2026-11-09 核对）。主力 Flash-Lite（免费档每天 500 次），第二选项 3.8 Flash（每天 20 次） */
export const GEMINI_LITE = Object.freeze({ id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' });
export const GEMINI_FLASH = Object.freeze({ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' });
/** 退役 id 换成的那条（主力） */
export const GEMINI_CURRENT = GEMINI_LITE;
/** 已退役 / 新用户不可用的 id → 换成 GEMINI_CURRENT（KV 里的旧登记、浏览器里存的旧选择都能接着用） */
export const RETIRED_GEMINI = Object.freeze(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-pro']);

/** 退役 id → 当前 id；别的原样 @param {string} id */
export function currentGeminiId(id) {
  return RETIRED_GEMINI.includes(id) ? GEMINI_CURRENT.id : id;
}

/** Gemini 3 及以后（3.x / 4.x…）：用 thinkingLevel 控思考 @param {any} id */
export function isThinkingLevelModel(id) {
  return /^(?:models\/)?gemini-(?:[3-9]|[1-9]\d)(?:[.-]|$)/.test(String(id || ''));
}

/** Flash-Lite 系（不含出图的 -image） @param {any} id */
export function isFlashLite(id) {
  return /flash-lite(?!-image)/.test(String(id || ''));
}

/**
 * 这个模型发什么思考档：Flash-Lite → minimal（它的默认、最省；文档 thinking?generate-content=true 表里 3.5 / 3.1 Flash-Lite 支持 minimal）；
 * 其余 Gemini 3 / 4 → low（3.8 Flash、4 Argon 不支持 minimal，发了报错）；2.x 及别的 → ''（不发 thinkingConfig）。
 * @param {any} id @returns {''|'minimal'|'low'}
 */
export function thinkingLevelFor(id) {
  if (!isThinkingLevelModel(id)) return '';
  return isFlashLite(id) ? 'minimal' : 'low';
}

/** 429 时换哪个模型（只换一次）：3.x / 4.x 的非 Lite → GEMINI_LITE；Lite 自己和别的 → '' @param {string} id */
export function quotaFallbackFor(id) {
  return isThinkingLevelModel(id) && !isFlashLite(id) && id !== GEMINI_LITE.id ? GEMINI_LITE.id : '';
}

/** 429 的错误体明确说是每分钟限额（等一会儿能好）；否则按每天额度处理 @param {string} text */
export function perMinuteQuota(text) {
  const t = String(text || '');
  return /PerMinute|per[ _-]?minute|RPM\b/i.test(t) && !/PerDay|per[ _-]?day|RPD\b/i.test(t);
}

/** 外部模型的输出额度：思考也算在 maxOutputTokens 里，至少 4096，封顶 8192 @param {number} n */
export function geminiMaxTokens(n) {
  const v = Number.isFinite(n) ? n : 0;
  return Math.min(Math.max(v, 4096), 8192);
}

/** 读钥匙：字符串原样（本地测试）；Secrets Store 绑定 → get()；没绑 / 读失败 → ''（不打印值） @param {any} env */
export async function readKey(env) {
  const v = env && env.SGX_CHAT_API_KEY;
  if (typeof v === 'string') return v.trim();
  if (v && typeof v.get === 'function') {
    try {
      const s = await v.get();
      return typeof s === 'string' ? s.trim() : '';
    } catch (e) {
      console.error('[ai] gemini key read failed');
      return '';
    }
  }
  return '';
}

/** 钥匙绑定在不在（不读值） @param {any} env */
export function hasKeyBinding(env) {
  const v = env && env.SGX_CHAT_API_KEY;
  return typeof v === 'string' || (v != null && typeof v.get === 'function');
}

/** 「地区不支持」的上游错误（Gemini API：FAILED_PRECONDITION + User location is not supported） */
const LOCATION_RE = /user location is not supported|location is not supported|not available in your (?:country|region)|unsupported_country|region[^.]{0,40}not supported/i;

/**
 * 上游非 2xx → 错误码（回浏览器的只有这个码；错误体不回给浏览器）。
 * @param {number} status @param {string} text
 * @returns {'rate_limited'|'model_unavailable'|'region'|'upstream'}
 */
export function classifyUpstream(status, text) {
  const t = String(text || '');
  if (status === 429) return 'rate_limited';
  if (LOCATION_RE.test(t)) return 'region';
  if (status === 404) return 'model_unavailable';
  if ((status === 403 || status === 400) && /not[ _]found|not[ _]supported|permission|not[ _]available|unsupported/i.test(t)) return 'model_unavailable';
  return 'upstream';
}

/**
 * 脱敏：去掉可能混进错误信息的钥匙（Google API key 形如 AIza + 35 位；新版 auth key 形如 AQ.…；key= / x-goog-api-key 参数），压空白、截 n 字。
 * @param {any} s @param {number} [n]
 */
export function redact(s, n = 300) {
  return String(s == null ? '' : s)
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, '[key]')
    .replace(/AQ\.[0-9A-Za-z_\-]{10,}/g, '[key]')
    .replace(/((?:api[_-]?)?key|x-goog-api-key)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, '$1$2[key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

/**
 * 上游错误体 → 排查用的分类（打日志用，已脱敏，不含钥匙）。
 * reason：location（地区不支持）/ key（钥匙无效 / 没权限）/ quota（限流 / 额度）/ model（模型不存在）/ tool（工具被拒）/ safety（被拦）/ server（5xx）/ other。
 * @param {number} status @param {string} text
 */
export function describeUpstream(status, text) {
  const t = String(text || '');
  /** @type {any} */
  let e = null;
  try { const j = JSON.parse(t); e = j && (Array.isArray(j) ? j[0] && j[0].error : j.error); } catch (x) { e = null; }
  const googleStatus = e && typeof e.status === 'string' ? e.status : '';
  const message = redact(e && typeof e.message === 'string' ? e.message : t);
  const hay = message + ' ' + googleStatus;
  let reason = 'other';
  if (LOCATION_RE.test(hay)) reason = 'location';
  else if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(hay)) reason = 'quota';
  else if (/API[_ ]?key|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(hay) || status === 401 || status === 403) reason = 'key';
  else if (status === 404 || /NOT_FOUND|not found/i.test(hay)) reason = 'model';
  else if (/google_search|tool/i.test(hay)) reason = 'tool';
  else if (/SAFETY|blocked/i.test(hay)) reason = 'safety';
  else if (status >= 500) reason = 'server';
  return { status, code: classifyUpstream(status, t), reason, googleStatus, message };
}

/** 钥匙本身的问题（换不换工具都一样失败） */
const KEY_RE = /API[_ ]?key|API_KEY_INVALID|UNAUTHENTICATED/i;

/**
 * 带 Google 搜索的请求被拒 → 不带工具重试一次。2026-11-09 起放宽：免费档 3.x 没有搜索 grounding，拒绝的形式不一定是
 * 400 + 「tool」字样，所以带工具时任何 4xx 都算，除了 429（限流，走重试）、404（模型不存在，去掉工具也一样）、地区不支持、钥匙无效 / 未认证。
 * @param {number} status @param {string} text
 */
export function searchRejected(status, text) {
  const t = String(text || '');
  if (!(status >= 400 && status < 500) || status === 429 || status === 404 || status === 401) return false;
  return !LOCATION_RE.test(t) && !KEY_RE.test(t);
}
/** 旧名（只认 400 + 提到工具的那种），保留给老调用方 / 测试 @param {number} status @param {string} text */
export function toolRejected(status, text) {
  return status === 400 && /google_search|tool/i.test(String(text || '')) && searchRejected(status, text);
}

/** 上游暂时不行（过载 / 内部错误 / 限流）→ 首字前退避重试 @param {number} status @param {string} text */
export function retryableUpstream(status, text) {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return status >= 500 && /UNAVAILABLE|overloaded|INTERNAL/i.test(String(text || ''));
}

/** 本 isolate 里搜索被拒过 → 到期时间（ms）；期间不带工具，省掉每次先失败一回。免费档整把钥匙都没有搜索，所以不分模型（键固定 '*'） */
const SEARCH_OFF_MS = 10 * 60 * 1000;
/** @type {Map<string, number>} */
const searchOff = new Map();
/** @param {string} model */
export function searchSuppressed(model) {
  void model;
  const until = searchOff.get('*');
  if (until == null) return false;
  if (Date.now() < until) return true;
  searchOff.delete('*');
  return false;
}
/** 测试用 */
export function _resetGeminiState() { searchOff.clear(); }

/**
 * core/prompt.js 的消息（system / user / assistant）→ Gemini 请求体。search = true 时带 Google 搜索工具。
 * opt.model 是 Gemini 3 及以后 → thinkingConfig.thinkingLevel = thinkingLevelFor(model)（Lite minimal，其余 low；不发 thinkingBudget：两者同发会 400）。
 * maxTokens 由调用方传 geminiMaxTokens(...) 之后的值。
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {number} maxTokens
 * @param {{search?: boolean, model?: string}} [opt]
 */
export function geminiBody(messages, maxTokens, opt) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  /** @type {Record<string, any>} */
  const body = {
    contents: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    systemInstruction: { parts: [{ text: sys }] },
    generationConfig: { maxOutputTokens: maxTokens },
  };
  const level = opt ? thinkingLevelFor(opt.model) : '';
  if (level) body.generationConfig.thinkingConfig = { thinkingLevel: level };
  if (opt && opt.search) body.tools = [{ google_search: {} }];
  return body;
}

/**
 * 一个流片段里的联网来源（groundingMetadata.groundingChunks[].web）→ [{ title, url }]（只认 http(s)；标题缺就用域名）。
 * @param {any} chunk
 * @returns {Array<{title: string, url: string}>}
 */
export function geminiSources(chunk) {
  const c = chunk && Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
  const g = c && c.groundingMetadata;
  const list = g && Array.isArray(g.groundingChunks) ? g.groundingChunks : [];
  const out = [];
  for (const x of list) {
    const w = x && x.web;
    const url = w && typeof w.uri === 'string' ? w.uri : '';
    if (!/^https?:\/\//i.test(url)) continue;
    let title = w && typeof w.title === 'string' ? w.title.trim() : '';
    if (!title) { try { title = new URL(url).hostname; } catch (e) { title = url; } }
    out.push({ title: title.slice(0, 120), url: url.slice(0, 2000) });
  }
  return out;
}

/**
 * Gemini 一个流片段 → 文本（跳过 thought）；被拦 / 片段里带 error → code。
 * @param {any} chunk
 * @returns {{ text: string, error: ''|'rate_limited'|'model_unavailable'|'region'|'upstream' }}
 */
export function geminiChunk(chunk) {
  if (chunk && chunk.error) {
    const e = chunk.error;
    if (LOCATION_RE.test(String(e.message || ''))) return { text: '', error: 'region' };
    return { text: '', error: e.code === 429 || e.status === 'RESOURCE_EXHAUSTED' ? 'rate_limited' : e.code === 404 || e.status === 'NOT_FOUND' ? 'model_unavailable' : 'upstream' };
  }
  if (chunk && chunk.promptFeedback && chunk.promptFeedback.blockReason) return { text: '', error: 'upstream' };
  const c = chunk && Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
  let text = '';
  if (c && c.content && Array.isArray(c.content.parts)) {
    for (const p of c.content.parts) if (p && typeof p.text === 'string' && !p.thought) text += p.text;
  }
  return { text, error: '' };
}

/**
 * 发请求。返回上游 Response（调用方看 ok / body）。
 * @param {any} env @param {string} key @param {string} model
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages @param {number} maxTokens @param {AbortSignal} signal
 * @param {{search?: boolean}} [opt]
 */
export function geminiRequest(env, key, model, messages, maxTokens, signal, opt) {
  const base = String((env && env.GEMINI_API_BASE) || GEMINI_BASE).replace(/\/+$/, '');
  return fetch(base + '/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(geminiBody(messages, maxTokens, { ...(opt || {}), model })),
    signal,
  });
}

/** 读上游错误体（最多 4 KB，读失败 → ''） @param {Response} res */
export async function errText(res) {
  try { return (await res.text()).slice(0, 4096); } catch (e) { return ''; }
}

/**
 * 流片段里排查空回答用的字段：finishReason、usageMetadata（只留计数）。
 * @param {any} chunk
 * @returns {{ finishReason: string, usage: Record<string, number> | null }}
 */
export function geminiMeta(chunk) {
  const c = chunk && Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
  const finishReason = c && typeof c.finishReason === 'string' ? c.finishReason : '';
  const u = chunk && chunk.usageMetadata;
  /** @type {Record<string, number> | null} */
  let usage = null;
  if (u && typeof u === 'object') {
    usage = {};
    for (const k of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount', 'totalTokenCount']) {
      if (typeof u[k] === 'number') usage[k] = u[k];
    }
  }
  return { finishReason, usage };
}

/** 可被 signal 打断的等待 @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve(undefined);
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve(undefined); }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * 发请求直到拿到第一段字节（首字前的重试都在这里）：
 * - 5xx / UNAVAILABLE → 退避重试（GEMINI_TIMING.backoffMs，最多 2 次）；
 * - 429：能换（quotaFallbackFor）→ 立即换 Flash-Lite 一次（[ai] gemini fallback）；不能换 → 每分钟限额才退避重试，最终 code daily_limit / rate_limited；
 * - 每次尝试首字超时 GEMINI_TIMING.firstByteMs（算重试）；总时限 deadline（调用方给，≤ 60 s）；
 * - 带搜索被拒（searchRejected）→ 不带工具重试一次（不占上面的次数），并在本 isolate 记 10 分钟；
 * - 调用方的 signal abort（浏览器断开 / 总时限）→ 立即停。
 * 成功 → { ok: true, reader }：reader 先吐已读到的第一段，再接着读上游（cancel 会断上游）。
 * 失败 → { ok: false, d }：d 同 describeUpstream 的形状（code 回浏览器，其余只进日志）；aborted = 调用方自己停的。
 * @param {any} env @param {string} key @param {string} model
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}> | ((search: boolean) => Array<{role: 'system'|'user'|'assistant', content: string}>)} messages
 *   函数形式：按这次带不带搜索生成（系统提示里「联网来源」那句跟着走）
 * @param {number} maxTokens
 * @param {{ search?: boolean, signal?: AbortSignal, deadline?: number }} [opt]
 * @returns {Promise<{ ok: true, reader: any, search: boolean, attempts: number, model: string } | { ok: false, aborted?: boolean, d: any, attempts: number, model: string }>}
 *   model：最后实际用的模型（换过 Flash-Lite 就是它）
 */
export async function geminiOpen(env, key, firstModel, messages, maxTokens, opt) {
  let model = firstModel;
  let fellBack = false;
  const o = opt || {};
  const outer = o.signal;
  const deadline = typeof o.deadline === 'number' ? o.deadline : Date.now() + UPSTREAM_TIMEOUT_MS;
  let search = !!o.search && !searchSuppressed(model);
  let toolRetried = false;
  let retries = 0;
  let attempts = 0;
  /** @type {any} */
  let last = null;
  for (;;) {
    if (outer && outer.aborted) return { ok: false, aborted: true, d: { status: 0, code: 'upstream', reason: 'aborted', googleStatus: '', message: '' }, attempts, model };
    const remaining = deadline - Date.now();
    if (remaining < GEMINI_TIMING.minAttemptMs) {
      return { ok: false, d: last || { status: 0, code: 'timeout', reason: 'timeout', googleStatus: '', message: '' }, attempts, model };
    }
    attempts++;
    const ac = new AbortController();
    const onOuter = () => ac.abort();
    if (outer) outer.addEventListener('abort', onOuter, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, Math.min(GEMINI_TIMING.firstByteMs, remaining));
    /** @type {Response|null} */
    let res = null;
    let opened = false;
    let status = 0;
    let text = '';
    try {
      const msgs = typeof messages === 'function' ? messages(search) : messages;
      res = await geminiRequest(env, key, model, msgs, maxTokens, ac.signal, { search });
      if (res.ok && res.body) {
        const r = res.body.getReader();
        const first = await r.read();
        clearTimeout(timer);
        let pending = /** @type {any} */ (first);
        const reader = {
          read() { if (pending) { const p = pending; pending = null; return Promise.resolve(p); } return r.read(); },
          cancel(/** @type {any} */ why) { pending = null; ac.abort(); return r.cancel(why); },
          releaseLock() { try { r.releaseLock(); } catch (e) {} },
        };
        opened = true; /* 流式期间调用方的 abort 仍要断上游：监听留着 */
        return { ok: true, reader, search, attempts, model };
      }
      status = res.status;
      text = res.ok ? '' : await errText(res);
      clearTimeout(timer);
      if (res.ok) return { ok: false, d: { status, code: 'upstream', reason: 'no-body', googleStatus: '', message: '' }, attempts, model };
    } catch (e) {
      clearTimeout(timer);
      if (outer && outer.aborted) return { ok: false, aborted: true, d: { status: 0, code: 'upstream', reason: 'aborted', googleStatus: '', message: '' }, attempts, model };
      status = 0;
      text = '';
      last = timedOut
        ? { status: 0, code: 'timeout', reason: 'first-byte-timeout', googleStatus: '', message: '' }
        : { status: 0, code: 'upstream', reason: 'network', googleStatus: '', message: redact(e && /** @type {any} */ (e).message) };
    } finally {
      if (outer && !opened) outer.removeEventListener('abort', onOuter);
    }
    if (status) last = describeUpstream(status, text);
    if (status && search && !toolRetried && searchRejected(status, text)) {
      toolRetried = true;
      search = false;
      searchOff.set('*', Date.now() + SEARCH_OFF_MS);
      console.error('[ai] gemini search tool rejected, retrying without it', JSON.stringify({ model, ...last }));
      continue;
    }
    if (status === 429) {
      const to = fellBack ? '' : quotaFallbackFor(model);
      if (to) {
        /* 免费档 3.x Flash 每天只有 20 次：额度用完就换 Flash-Lite（每天 500 次），只换一次，不等 */
        console.error('[ai] gemini fallback', JSON.stringify({ from: model, to, status, reason: last.reason, googleStatus: last.googleStatus }));
        model = to;
        fellBack = true;
        retries = 0;
        continue;
      }
      const perMinute = perMinuteQuota(text);
      if (perMinute && retries < GEMINI_TIMING.backoffMs.length) {
        const wait = GEMINI_TIMING.backoffMs[retries++];
        console.error('[ai] gemini retry', JSON.stringify({ model, attempt: attempts, wait, status, reason: last.reason, googleStatus: last.googleStatus }));
        await sleep(wait, outer);
        continue;
      }
      return { ok: false, d: { ...last, code: perMinute ? 'rate_limited' : 'daily_limit' }, attempts, model };
    }
    const again = status ? retryableUpstream(status, text) : true; /* status 0：首字超时 / 网络错 */
    if (again && retries < GEMINI_TIMING.backoffMs.length) {
      const wait = GEMINI_TIMING.backoffMs[retries++];
      console.error('[ai] gemini retry', JSON.stringify({ model, attempt: attempts, wait, status: last.status, reason: last.reason, googleStatus: last.googleStatus }));
      await sleep(wait, outer);
      continue;
    }
    return { ok: false, d: last, attempts, model };
  }
}
