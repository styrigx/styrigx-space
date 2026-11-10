/**
 * @fileoverview /api/find 的按 IP 限流（v5 S4）：关键词搜索谁都能用（访客也能），所以单独一个闸。
 *
 * Workers Rate Limiting 绑定 FIND_LIMITER（wrangler.toml [[ratelimits]]，自己的 namespace，不和 ANON_LIMITER / AI_LIMITER 共用：
 *   共用会让搜索挤占锁屏接口或 AI 的配额）。按 CF-Connecting-IP 计数，计数在边缘，不占存储、不收费。
 * 超了 → 429 cooldown + Retry-After + 一句终端能直接显示的 message（前端按码显示自己的本地化文案，message 是兜底）。
 * 绑定缺失（本地、单测、Pages 预览）或调用出错 → 放行，打一行日志：它是防刷的闸，不是安全门（只读、只回公开元数据，KV 读有 60 秒缓存）。
 */
import { apiError, clientIp } from '../lib/http.js';

/** 和 wrangler.toml 里 FIND_LIMITER 的 simple.period 一致（秒） */
export const FIND_PERIOD = 60;
/** 429 时给终端的兜底句子 */
export const FIND_LIMITED_MESSAGE = 'too many searches · try again in a minute';

/**
 * 超了回 429 响应，否则 null。
 * @param {Request} request @param {any} env
 * @returns {Promise<Response|null>}
 */
export async function findLimit(request, env) {
  const limiter = env && env.FIND_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') {
    console.log('[sgx-find-limit] no FIND_LIMITER binding, pass');
    return null;
  }
  let ok = true;
  try {
    const r = await limiter.limit({ key: clientIp(request) });
    ok = !(r && r.success === false);
  } catch (e) {
    console.log('[sgx-find-limit] limiter error, pass: ' + (e && /** @type {any} */ (e).message));
    return null;
  }
  if (ok) return null;
  return apiError(429, 'cooldown', { retryAfter: FIND_PERIOD, message: FIND_LIMITED_MESSAGE }, { 'Retry-After': String(FIND_PERIOD) });
}
