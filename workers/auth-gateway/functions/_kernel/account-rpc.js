/**
 * 网关 → 账号 Worker 的只读 RPC：ACCOUNT_VERIFIER.accountSession()（方案第 2、10.1 节）。
 *
 * 网关不再持账号钥匙、不读账号库；仍要账号会话的锁屏侧功能（临时钥匙管理 api/lock-tempkey.js、短链签发 / 作废 src/share-issuer.js、
 * 账号页首帧提示 _middleware.js）都经服务绑定 ACCOUNT_VERIFIER（styrigx-account / AccountVerifier）问一句，只拿结论。
 * 绑定没配 / RPC 抛错 / 回了看不懂的东西 → 按「无账号会话」处理（fail closed），reason 只是原因代号。
 *
 * 不 import 任何账号代码（账号与网关互相不许 import，scripts/check-layers.mjs 规则 14）。
 */

const MAX_COOKIE_HEADER = 8192;
const MAX_UA = 512;

/**
 * AccountVerifier 的 clientContext：User-Agent、cf 国家城市（账号设备 lastSeen / 地点用；同 workers/account/src/entrypoints.js verifierRequest）。
 * @param {Request|null|undefined} request
 * @returns {{ua?:string, country?:string, city?:string}}
 */
export function verifierContextOf(request) {
  /** @type {{ua?:string, country?:string, city?:string}} */
  const m = {};
  if (!request) return m;
  const ua = request.headers && request.headers.get('User-Agent');
  if (ua) m.ua = ua.slice(0, MAX_UA);
  const cf = /** @type {any} */ (request).cf || {};
  if (typeof cf.country === 'string' && cf.country) m.country = cf.country;
  if (typeof cf.city === 'string' && cf.city) m.city = cf.city;
  return m;
}

/**
 * 问账号 Worker：这个 Cookie 头里有没有有效账号会话。
 * @param {Record<string, any>} env
 * @param {string} cookieHeader 浏览器发来的 Cookie 头（原样）
 * @param {{ua?:string, country?:string, city?:string}} [clientContext]
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
export async function askAccountSession(env, cookieHeader, clientContext) {
  const v = env && env.ACCOUNT_VERIFIER;
  if (!v || typeof v.accountSession !== 'function') return { ok: false, reason: 'no-verifier' };
  const cookie = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
  if (!cookie) return { ok: false, reason: 'no-cookie' };
  try {
    const r = await v.accountSession(cookie, clientContext || {});
    if (r && r.ok === true) return { ok: true, reason: 'ok' };
    return { ok: false, reason: (r && typeof r.reason === 'string' && r.reason) || 'denied' };
  } catch (e) {
    console.error('[sgx-auth] account rpc failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return { ok: false, reason: 'rpc-error' };
  }
}

/**
 * 请求版：取请求的 Cookie 头和客户端上下文再问。
 * @param {Request} request @param {Record<string, any>} env
 */
export function askAccountSessionFor(request, env) {
  return askAccountSession(env, (request && request.headers.get('Cookie')) || '', verifierContextOf(request));
}
