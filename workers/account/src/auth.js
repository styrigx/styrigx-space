/**
 * @fileoverview 账号 Worker 的会话判断：全部交给鉴权网关的 AuthVerifier（服务绑定 AUTH，RPC）。
 *
 * 本 Worker 不持任何钥匙、不绑认证库：浏览器带来的 Cookie 头原样交给网关，网关用自己 Secrets Store 里的公钥验签、
 * 用认证库里的 epoch / 吊销记录核对，只回结论。和这些接口还在网关里时用的是同一套函数：
 * - lockSession()     → 网关 verifyLockSession（锁屏会话 sgx-lock-session；访客会话带 tempkeyId，钥匙作废即失效）
 * - accountSession()  → 网关 verifyAccountSession（账号会话 sgx-account-session；刷新设备 lastSeen 用的 User-Agent / 国家城市一并带过去）
 * 同一个请求里各只问一次（缓存 Promise）。
 * 网关不可达 / 绑定没配 / 回了看不懂的东西 → 当作无会话（fail closed）。
 */

export const ROLE_ADMIN = 'admin';
export const ROLE_VISITOR = 'visitor';
const MAX_COOKIE_HEADER = 8192;

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {{ lockSession: () => Promise<{ok:boolean, role:string|null, reason:string}>, accountSession: () => Promise<{ok:boolean, reason:string}> }}
 */
export function authFor(request, env) {
  const cookie = (request.headers.get('Cookie') || '').slice(0, MAX_COOKIE_HEADER);
  const verifier = env && env.AUTH;
  /** @type {Promise<any>|null} */
  let sessP = null;
  /** @type {Promise<any>|null} */
  let accP = null;
  return {
    lockSession() {
      if (!sessP) sessP = askLockSession(verifier, cookie);
      return sessP;
    },
    accountSession() {
      if (!accP) accP = askAccountSession(verifier, cookie, metaOf(request));
      return accP;
    },
  };
}

/** @param {Request} request */
function metaOf(request) {
  /** @type {any} */
  const cf = /** @type {any} */ (request).cf || {};
  /** @type {{ua?:string, country?:string, city?:string}} */
  const m = {};
  const ua = request.headers.get('User-Agent');
  if (ua) m.ua = ua;
  if (typeof cf.country === 'string' && cf.country) m.country = cf.country;
  if (typeof cf.city === 'string' && cf.city) m.city = cf.city;
  return m;
}

/** @param {any} verifier @param {string} cookie */
async function askLockSession(verifier, cookie) {
  if (!verifier || typeof verifier.lockSession !== 'function') return { ok: false, role: null, reason: 'no-verifier' };
  if (!cookie) return { ok: false, role: null, reason: 'no-cookie' };
  try {
    const r = await verifier.lockSession(cookie);
    if (r && r.ok === true && (r.role === ROLE_ADMIN || r.role === ROLE_VISITOR)) return { ok: true, role: r.role, reason: 'ok' };
    return { ok: false, role: null, reason: (r && typeof r.reason === 'string' && r.reason) || 'denied' };
  } catch (e) {
    console.error('[sgx-account] session rpc failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return { ok: false, role: null, reason: 'rpc-error' };
  }
}

/** @param {any} verifier @param {string} cookie @param {object} meta */
async function askAccountSession(verifier, cookie, meta) {
  if (!verifier || typeof verifier.accountSession !== 'function') return { ok: false, reason: 'no-verifier' };
  if (!cookie) return { ok: false, reason: 'no-cookie' };
  try {
    const r = await verifier.accountSession(cookie, meta);
    if (r && r.ok === true) return { ok: true, reason: 'ok' };
    return { ok: false, reason: (r && typeof r.reason === 'string' && r.reason) || 'denied' };
  } catch (e) {
    console.error('[sgx-account] account rpc failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return { ok: false, reason: 'rpc-error' };
  }
}
