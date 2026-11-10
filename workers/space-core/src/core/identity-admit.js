/**
 * v6 身份统一（P1）：网关 admit 的新路径——请求带新会话 cookie（sgx-session）、旧进站会话又不成立时，经服务绑定
 * ACCOUNT_VERIFIER.admit() 问账号 Worker「这个新会话能不能走这条路由」，只认 allowed === true。
 *
 * - 分步割接：旧进站会话（sgx-space-session）的判定原样不动、先判；这里只是并存的第二条路，不做新旧格式互转。
 * - 没有 sgx-session cookie → 不问（生产上 P1 没有任何签发入口，所以线上请求一律走不到 RPC，行为不变）。
 * - 判断不在网关：路由要哪一档、身份够不够，都在账号 Worker（core/route-access.js + core/groups.js permits）；网关只传方法和路径。
 * - 绑定没配 / RPC 抛错 / 回了看不懂的东西 → 不放行（fail closed）。
 *
 * 不 import 任何账号代码（规则 14）；只用字符串。切 Cookie 头只用 lib/cookies.js。
 */
import { readCookie, MAX_COOKIE_HEADER } from '../lib/cookies.js';

/** 新会话 cookie 名（同账号 Worker core/identity-session.js SESSION_COOKIE；单测核对两边一致） */
export const NEW_SESSION_COOKIE = 'sgx-session';

/**
 * 新会话能不能走这条路由。没 cookie → false（不问）。
 * @param {Record<string, any>} env @param {Request} request
 * @returns {Promise<boolean>}
 */
export async function newSessionAdmits(env, request) {
  if (!request || !readCookie(request, NEW_SESSION_COOKIE)) return false;
  const cookie = (request.headers.get('Cookie') || '').slice(0, MAX_COOKIE_HEADER);
  const v = env && env.ACCOUNT_VERIFIER;
  if (!v || typeof v.admit !== 'function') return false;
  try {
    const r = await v.admit(cookie, String(request.method || 'GET').toUpperCase(), new URL(request.url).pathname);
    return !!(r && typeof r === 'object' && r.allowed === true);
  } catch (e) {
    console.error('[sgx-auth] account admit rpc failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return false;
  }
}
