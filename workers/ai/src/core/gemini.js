/**
 * @fileoverview 外部模型：Gemini API（P4-2，2026-11-04 补充说明「chat 并入 AI」）。调用逻辑从 workers/chat/src/chat.js 搬来。
 *
 * 和原 chat 的区别：只回答站内内容（系统提示 + 召回上下文同自营模型，见 core/prompt.js），不带 google_search / url_context
 * 工具（搜索只作 AI 内部召回，定案第 2 条），所以没有「工具被拒、不带工具重试」那一支，也没有外部来源列表。
 * 原生 streamGenerateContent（?alt=sse）；钥匙 Secrets Store 绑定 SGX_CHAT_API_KEY，用到才读，绝不回给浏览器、绝不打印。
 * 注意：合并保能力，不等于修好 Gemini（2026-10-28 起的故障另案诊断）。
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

/**
 * 上游非 2xx → 错误码（只用来分类，错误体不回给浏览器、不打印）。
 * @param {number} status @param {string} text
 * @returns {'rate_limited'|'model_unavailable'|'upstream'}
 */
export function classifyUpstream(status, text) {
  const t = String(text || '');
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'model_unavailable';
  if ((status === 403 || status === 400) && /not[ _]found|not[ _]supported|permission|not[ _]available|unsupported/i.test(t)) return 'model_unavailable';
  return 'upstream';
}

/**
 * core/prompt.js 的消息（system / user / assistant）→ Gemini 请求体。
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {number} maxTokens
 */
export function geminiBody(messages, maxTokens) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  return {
    contents: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    systemInstruction: { parts: [{ text: sys }] },
    generationConfig: { maxOutputTokens: maxTokens },
  };
}

/**
 * Gemini 一个流片段 → 文本（跳过 thought）；被拦 / 片段里带 error → code。
 * @param {any} chunk
 * @returns {{ text: string, error: ''|'rate_limited'|'model_unavailable'|'upstream' }}
 */
export function geminiChunk(chunk) {
  if (chunk && chunk.error) {
    const e = chunk.error;
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
 */
export function geminiRequest(env, key, model, messages, maxTokens, signal) {
  const base = String((env && env.GEMINI_API_BASE) || GEMINI_BASE).replace(/\/+$/, '');
  return fetch(base + '/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(geminiBody(messages, maxTokens)),
    signal,
  });
}

/** 读上游错误体（最多 4 KB，读失败 → ''） @param {Response} res */
export async function errText(res) {
  try { return (await res.text()).slice(0, 4096); } catch (e) { return ''; }
}
