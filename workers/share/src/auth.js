/**
 * @fileoverview 分享短链 Worker 的会话判断（本 Worker 自己一份，不 import 任何别的 Worker 的代码）：
 * 浏览器带来的 Cookie 头原样交给验证方，只回结论；同一请求各只问一次；不可达 / 绑定没配 → 当作无会话（fail closed）。
 * - lockSession() → 网关 AuthVerifier（服务绑定 AUTH）
 * 进门二值（P2-3）：锁屏会话只回进门与否，不分等级。短链管理：看列表 = 进门；生成 / 作废 = 进门 + 锁侧复验（网关 ShareIssuer 验）。
 * 不问账号会话（不绑账号 Worker）。
 * 本 Worker 不持任何钥匙、不绑认证库。
 */

const MAX_COOKIE_HEADER = 8192;

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {{ lockSession: () => Promise<{ok:boolean, reason:string}> }}
 */
export function authFor(request, env) {
  const cookie = cookieOf(request);
  const verifier = env && env.AUTH;
  /** @type {Promise<any>|null} */
  let sessP = null;
  return {
    lockSession() {
      if (!sessP) sessP = askLockSession(verifier, cookie);
      return sessP;
    },
  };
}

/** 浏览器 Cookie 头，原样（截到 8192 字节）交给网关 @param {Request} request */
export function cookieOf(request) {
  return (request.headers.get('Cookie') || '').slice(0, MAX_COOKIE_HEADER);
}

/** @param {any} verifier @param {string} cookie */
async function askLockSession(verifier, cookie) {
  if (!verifier || typeof verifier.lockSession !== 'function') return { ok: false, reason: 'no-verifier' };
  if (!cookie) return { ok: false, reason: 'no-cookie' };
  try {
    const r = await verifier.lockSession(cookie);
    if (r && r.ok === true) return { ok: true, reason: 'ok' };
    return { ok: false, reason: (r && typeof r.reason === 'string' && r.reason) || 'denied' };
  } catch (e) {
    console.error('[sgx-share] session rpc failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return { ok: false, reason: 'rpc-error' };
  }
}
