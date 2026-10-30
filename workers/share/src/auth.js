/**
 * @fileoverview 分享短链 Worker 的会话判断（本 Worker 自己一份，不 import 任何别的 Worker 的代码）：
 * 浏览器带来的 Cookie 头原样交给验证方，只回结论；同一请求各只问一次；不可达 / 绑定没配 → 当作无会话（fail closed）。
 * - lockSession()    → 网关 AuthVerifier（服务绑定 AUTH）
 * - accountSession() → 账号 Worker AccountVerifier（服务绑定 ACCOUNT_VERIFIER，方案 10.3；账号拆分 PR3 起网关不再验账号会话）
 * 本 Worker 不持任何钥匙、不绑认证库。
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
  const cookie = cookieOf(request);
  const verifier = env && env.AUTH;
  const accountVerifier = env && env.ACCOUNT_VERIFIER;
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
      if (!accP) accP = askAccountSession(accountVerifier, cookie, verifierMetaOf(request));
      return accP;
    },
  };
}

/** 浏览器 Cookie 头，原样（截到 8192 字节）交给网关 @param {Request} request */
export function cookieOf(request) {
  return (request.headers.get('Cookie') || '').slice(0, MAX_COOKIE_HEADER);
}

/** authFor().accountSession() 带给验证方的 meta（User-Agent 原样、cf 国家城市） @param {Request} request */
function verifierMetaOf(request) {
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
    console.error('[sgx-share] session rpc failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
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
    console.error('[sgx-share] account rpc failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return { ok: false, reason: 'rpc-error' };
  }
}

/**
 * 网关 ShareIssuer 记账号设备用的 meta（User-Agent 截到 512、cf 国家城市）。
 * @param {Request} request
 */
export function metaOf(request) {
  /** @type {any} */
  const cf = /** @type {any} */ (request).cf || {};
  /** @type {{ua?:string, country?:string, city?:string}} */
  const m = {};
  const ua = request.headers.get('User-Agent');
  if (ua) m.ua = ua.slice(0, 512);
  if (typeof cf.country === 'string' && cf.country) m.country = cf.country;
  if (typeof cf.city === 'string' && cf.city) m.city = cf.city;
  return m;
}
