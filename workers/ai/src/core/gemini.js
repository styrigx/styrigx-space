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
 */

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const UPSTREAM_TIMEOUT_MS = 60 * 1000;

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
 * 脱敏：去掉可能混进错误信息的钥匙（Google API key 形如 AIza + 35 位；key= / x-goog-api-key 参数），压空白、截 n 字。
 * @param {any} s @param {number} [n]
 */
export function redact(s, n = 300) {
  return String(s == null ? '' : s)
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, '[key]')
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

/** 工具被拒（不带工具重试一次） @param {number} status @param {string} text */
export function toolRejected(status, text) {
  return status === 400 && /google_search|tool/i.test(String(text || '')) && !LOCATION_RE.test(String(text || ''));
}

/**
 * core/prompt.js 的消息（system / user / assistant）→ Gemini 请求体。search = true 时带 Google 搜索工具。
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {number} maxTokens
 * @param {{search?: boolean}} [opt]
 */
export function geminiBody(messages, maxTokens, opt) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  /** @type {Record<string, any>} */
  const body = {
    contents: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    systemInstruction: { parts: [{ text: sys }] },
    generationConfig: { maxOutputTokens: maxTokens },
  };
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
    body: JSON.stringify(geminiBody(messages, maxTokens, opt)),
    signal,
  });
}

/** 读上游错误体（最多 4 KB，读失败 → ''） @param {Response} res */
export async function errText(res) {
  try { return (await res.text()).slice(0, 4096); } catch (e) { return ''; }
}
