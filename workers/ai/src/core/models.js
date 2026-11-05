/**
 * @fileoverview 模型登记（P4-2）：可用模型列表 + 默认模型，从 KV 读，换模型改 KV 值即可，不用补丁部署。
 *
 * KV：KV_SEARCH_INDEX（和索引同一个命名空间，本 Worker 只读）键 MODELS_KEY = 'ai:models'，值 JSON：
 *   { "default": "<id>", "models": [{ "id", "label", "provider": "workers-ai" | "gemini" }] }
 *   provider = workers-ai：自营模型，env.AI.run(id)，不走网关；id 必须以 @cf/ 开头。
 *   provider = gemini：外部模型（chat 并入，2026-11-04 补充说明），Gemini API，钥匙 Secrets Store SGX_CHAT_API_KEY。
 * KV 里没有 / 坏 JSON / 一条合格的都没有 → 退回 [vars] 的 AI_MODELS（同格式）；再不行 → 内置 FALLBACK。
 * 默认模型不在列表里 → 用列表第一条。
 *
 * 谁能选：只有带账号结论头（X-Styrigx-Account-Session: 1）的请求，body.model 才生效；进站（没有账号会话）一律默认模型。
 * 读 KV 带 60 秒 isolate 内缓存（同索引），不多吃读额度。
 */

export const MODELS_KEY = 'ai:models';
export const MAX_MODELS = 8;
const CACHE_MS = 60 * 1000;

/** 模型 id 只许这些字符（gemini 的 id 进 URL 路径前还会 encodeURIComponent） */
const ID_RE = /^[A-Za-z0-9@][A-Za-z0-9._:@/-]{0,99}$/;

/** 内置兜底（KV 和 vars 都没配时）：Gemma 4 默认 + GPT-OSS 20B，都走 Workers AI */
export const FALLBACK = Object.freeze({
  def: '@cf/google/gemma-4-26b-a4b-it',
  models: Object.freeze([
    Object.freeze({ id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4', provider: 'workers-ai' }),
    Object.freeze({ id: '@cf/openai/gpt-oss-20b', label: 'GPT-OSS 20B', provider: 'workers-ai' }),
  ]),
});

/**
 * 解析一份登记（对象或 JSON 字符串）。不合格 → null。
 * @param {any} raw
 * @returns {{ def: string, models: Array<{id: string, label: string, provider: 'workers-ai'|'gemini'}> } | null}
 */
export function parseModels(raw) {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (e) { return null; }
  }
  if (!v || typeof v !== 'object' || !Array.isArray(v.models)) return null;
  /** @type {Array<{id: string, label: string, provider: 'workers-ai'|'gemini'}>} */
  const models = [];
  for (const m of v.models) {
    if (models.length >= MAX_MODELS) break;
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !ID_RE.test(m.id)) continue;
    const provider = m.provider === 'gemini' ? 'gemini' : m.provider === 'workers-ai' || m.provider == null ? 'workers-ai' : null;
    if (!provider) continue;
    if (provider === 'workers-ai' && !m.id.startsWith('@cf/')) continue;
    if (models.some((x) => x.id === m.id)) continue;
    const label = typeof m.label === 'string' && m.label.trim() ? m.label.trim().slice(0, 40) : m.id;
    models.push({ id: m.id, label, provider });
  }
  if (!models.length) return null;
  const def = typeof v.default === 'string' && models.some((x) => x.id === v.default) ? v.default : models[0].id;
  return { def, models };
}

/** @type {{ at: number, val: any } | null} */
let cache = null;

/** 测试用 */
export function _resetModelsCache() { cache = null; }

/**
 * 当前登记：KV → vars → 内置。KV 读失败不算错（退回 vars / 内置），只记一行日志。
 * @param {any} env
 */
export async function loadModels(env) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.val;
  let val = null;
  const kv = env && env.KV_SEARCH_INDEX;
  if (kv && typeof kv.get === 'function') {
    try { val = parseModels(await kv.get(MODELS_KEY)); } catch (e) { console.error('[ai] models read failed'); }
  }
  if (!val) val = parseModels(env && env.AI_MODELS);
  if (!val) val = { def: FALLBACK.def, models: FALLBACK.models.map((m) => ({ ...m })) };
  cache = { at: now, val };
  return val;
}

/**
 * 这次用哪个模型。want 只在 canChoose（有账号会话）时看；不在列表里 → { ok: false }（400 bad_model）。
 * @param {{ def: string, models: Array<{id: string, label: string, provider: string}> }} reg
 * @param {any} want
 * @param {boolean} canChoose
 * @returns {{ ok: true, model: {id: string, label: string, provider: string} } | { ok: false }}
 */
export function pickModel(reg, want, canChoose) {
  const byId = (/** @type {string} */ id) => reg.models.find((m) => m.id === id);
  if (!canChoose || want === undefined || want === null || want === '') return { ok: true, model: byId(reg.def) || reg.models[0] };
  if (typeof want !== 'string') return { ok: false };
  const m = byId(want);
  return m ? { ok: true, model: m } : { ok: false };
}

/** 给浏览器看的列表（不带 provider 以外的内部字段） @param {{ def: string, models: Array<any> }} reg */
export function publicModels(reg) {
  return { default: reg.def, models: reg.models.map((m) => ({ id: m.id, label: m.label, provider: m.provider })) };
}
