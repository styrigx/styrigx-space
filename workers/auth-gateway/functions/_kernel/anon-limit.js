/**
 * @fileoverview 无会话写接口的按 IP 总限流（2026-10-28 PR2）。
 *
 * 为什么：锁屏前的几个接口不要会话就能调，而且每次都写 D1——challenge 每次插一行（顺手清过期的），
 * 输错要写输错计数。没有总闸时，刷接口能把 D1 每天的写入额度耗光，连带自己也解不了锁。
 *
 * 做法：Workers Rate Limiting 绑定 ANON_LIMITER（workers/auth-gateway/wrangler.toml [[ratelimits]]，
 * 每个 IP 60 秒 20 次；计数在 Cloudflare 边缘，不占存储、不收费）。只管「没有有效锁屏会话 + POST + 下面这几个接口」；
 * 有会话的、GET 的都不限。超过 → 429 { error: 'cooldown' }（前端已有的「太频繁」文案）+ Retry-After: 60，不进端点，不写 D1。
 *
 * 这只是防刷的总闸，不是安全门：真正的门槛仍是各端点自己的输错锁定（password-limit / root-limit / lock-tempkey）。
 * 所以绑定缺失（本地、单测、Pages 预览不支持这个绑定）或调用出错时放行，只打一行日志。
 */
import { apiError, clientIp } from '../../../shared/http.js';

/** 不要会话、每次会写 D1 的接口（都在 _middleware.js 的 API_WHITELIST 里） */
export const ANON_LIMITED_APIS = Object.freeze([
  '/api/lock-passkey',
  '/api/lock-reset',
  '/api/lock-password',
  '/api/root-auth',
  '/api/lock-tempkey-unlock',
]);

/** 和 wrangler.toml 里 [[ratelimits]] simple.period 一致（秒） */
export const ANON_LIMIT_PERIOD = 60;

/**
 * 需要限流就返回 429 响应，否则 null。
 * @param {Request} request
 * @param {any} env
 * @param {boolean} sessionValid 当前请求是否带有效锁屏会话（任何角色）
 * @returns {Promise<Response|null>}
 */
export async function anonLimit(request, env, sessionValid) {
  if (sessionValid || request.method !== 'POST') return null;
  const path = new URL(request.url).pathname;
  if (!ANON_LIMITED_APIS.includes(path)) return null;
  const limiter = env && env.ANON_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') {
    console.log('[sgx-anon-limit] no ANON_LIMITER binding, pass');
    return null;
  }
  let ok = true;
  try {
    const r = await limiter.limit({ key: clientIp(request) });
    ok = !(r && r.success === false);
  } catch (e) {
    console.log('[sgx-anon-limit] limiter error, pass: ' + (e && e.message));
    return null;
  }
  if (ok) return null;
  console.log('[sgx-anon-limit] limited path=' + path);
  return apiError(429, 'cooldown', { retryAfter: ANON_LIMIT_PERIOD }, { 'Retry-After': String(ANON_LIMIT_PERIOD) });
}
