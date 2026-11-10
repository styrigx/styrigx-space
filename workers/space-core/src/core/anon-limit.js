/**
 * @fileoverview 无会话写接口的按 IP 总限流（2026-10-28 PR2）。
 *
 * 为什么：锁屏前的几个接口不要会话就能调，而且每次都写 D1——challenge 每次插一行（顺手清过期的），
 * 输错要写输错计数。没有总闸时，刷接口能把 D1 每天的写入额度耗光，连带自己也解不了锁。
 *
 * 做法：Workers Rate Limiting 绑定 ANON_LIMITER（workers/space-core/wrangler.toml [[ratelimits]]，
 * 每个 IP 60 秒 20 次；计数在 Cloudflare 边缘，不占存储、不收费）。只管「没有有效进站会话 + POST + 下面这几个接口」；
 * 有会话的、GET 的都不限。超过 → 429 { error: 'cooldown' }（前端已有的「太频繁」文案）+ Retry-After: 60，不进端点，不写 D1。
 *
 * 这只是防刷的总闸，不是安全门：真正的门槛仍是各端点自己的输错锁定（password-limit / space-limit）。
 * 绑定缺失 = 部署配错（wrangler.toml 漏了 [[ratelimits]]）：fail-closed，503 config + console.error（2026-11-09；以前放行，配错了没人知道）。
 * Pages 预览 / 本地测试台不支持这个绑定，由测试入口（tests/space/e2e/helpers/preview-worker.js、edge-harness）塞一个放行的桩。
 * 限流器调用本身出错（边缘偶发）仍放行，只打日志：别因为它把锁屏整个关掉。
 */
import { apiError, clientIp } from '../lib/http.js';

/** 不要会话、每次会写 D1 的接口（都是 gate.js 访问表 ROUTE_ACCESS 里的 public 条目） */
export const ANON_LIMITED_APIS = Object.freeze([
  '/api/lock-passkey',
  '/api/lock-reset',
  '/api/lock-password',
  '/api/space-auth',
]);

/** 和 wrangler.toml 里 [[ratelimits]] simple.period 一致（秒） */
export const ANON_LIMIT_PERIOD = 60;

/**
 * 需要限流就返回 429 响应，否则 null。
 * @param {Request} request
 * @param {any} env
 * @param {boolean} sessionValid 当前请求是否带有效进站会话（任何角色）
 * @returns {Promise<Response|null>}
 */
export async function anonLimit(request, env, sessionValid) {
  if (sessionValid || request.method !== 'POST') return null;
  const path = new URL(request.url).pathname;
  if (!ANON_LIMITED_APIS.includes(path)) return null;
  const limiter = env && env.ANON_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') {
    console.error('[sgx-anon-limit] no ANON_LIMITER binding, fail-closed 503 path=' + path);
    return apiError(503, 'config');
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
