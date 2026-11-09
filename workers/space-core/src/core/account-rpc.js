/**
 * 网关 → 账号 Worker 的只读 RPC：ACCOUNT_VERIFIER.authorize()。
 *
 * 网关不再持账号钥匙、不读账号库，经服务绑定 ACCOUNT_VERIFIER（styrigx-account / AccountVerifier）问一句，只拿结论：
 * - 账号命名 v2 起不再问账号 session：旧账号整页没了（#327），首帧提示 askSessionFor / gate.js isAccountPage 删掉；账号终端自己读 GET /api/account。
 *   临时钥匙管理（api/lock-tempkey.js）和短链签发 / 作废（core/link-keys.js）只认进站会话（生成 / 作废另要锁侧复验）。
 * - askAuthorize：授权结论（core/conclusion.js 组装网关结论时用）。
 * 绑定没配 / RPC 抛错 / 回了看不懂的东西 → 按「无账号会话」处理（fail closed，account.ok=false），reason 只是原因代号。
 * askAuthorize 只管传话和「ok 是不是 true」；deviceId、作用域的白名单校验在 core/conclusion.js。
 *
 * 不 import 任何账号代码（账号与网关互相不许 import，space/scripts/check-layers.mjs 规则 14）。
 */

const MAX_COOKIE_HEADER = 8192;
const MAX_UA = 512;

/**
 * AccountVerifier 的 clientContext：User-Agent、cf 国家城市（账号设备 lastSeen / 地点用；同 workers/account/src/rpc/account-verifier.js verifierRequest）。
 * @param {Request|null|undefined} request
 * @returns {{ua?:string, country?:string, city?:string}}
 */
function verifierContextOf(request) {
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
 * RPC 传进来的 clientContext（子站接口 Worker 经 SpaceVerifier.conclusion 转来的）只留 ua / country / city 三个字符串，截长。
 * @param {any} c
 * @returns {{ua?:string, country?:string, city?:string}}
 */
function cleanVerifierContext(c) {
  /** @type {{ua?:string, country?:string, city?:string}} */
  const m = {};
  if (!c || typeof c !== 'object') return m;
  if (typeof c.ua === 'string' && c.ua) m.ua = c.ua.slice(0, MAX_UA);
  if (typeof c.country === 'string' && c.country) m.country = c.country.slice(0, 4);
  if (typeof c.city === 'string' && c.city) m.city = c.city.slice(0, 40);
  return m;
}

/**
 * @typedef {{ ok: boolean, reason: string, deviceId: any, scopes: any, reauth: any }} AskedAuthorization
 *   ok=true 时 deviceId / scopes / reauth 是账号 Worker 回的原样值（白名单校验在 core/conclusion.js）；ok=false 时为 '' / [] / false
 */

/**
 * 问账号 Worker 要授权结论（AccountVerifier.authorize）。
 * 绑定没配 → no-verifier；没 cookie → no-cookie（不问）；RPC 抛错 → rpc-error；回的不是对象 / ok 不是 true → ok=false。
 * @param {Record<string, any>} env
 * @param {string} cookieHeader 浏览器发来的 Cookie 头（原样）
 * @param {any} [clientContext] { ua, country, city }
 * @param {{reauth?:boolean}} [opts] 只认 reauth === true
 * @returns {Promise<AskedAuthorization>}
 */
export async function askAuthorize(env, cookieHeader, clientContext, opts) {
  const no = (/** @type {string} */ reason) => ({ ok: false, reason, deviceId: '', scopes: [], reauth: false });
  const v = env && env.ACCOUNT_VERIFIER;
  if (!v || typeof v.authorize !== 'function') return no('no-verifier');
  const cookie = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
  if (!cookie) return no('no-cookie');
  const want = { reauth: !!(opts && typeof opts === 'object' && opts.reauth === true) };
  try {
    const r = await v.authorize(cookie, cleanVerifierContext(clientContext), want);
    if (!r || typeof r !== 'object') return no('bad-reply');
    if (r.ok !== true) return no((typeof r.reason === 'string' && r.reason) || 'denied');
    return { ok: true, reason: 'ok', deviceId: r.deviceId, scopes: r.scopes, reauth: r.reauth };
  } catch (e) {
    console.error('[sgx-auth] account authorize rpc failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return no('rpc-error');
  }
}

/**
 * 请求版 askAuthorize：取请求的 Cookie 头和客户端上下文再问（P2-2 起；P4-2 后只有 api/ai.js 用）。
 * @param {Request} request @param {Record<string, any>} env @param {{reauth?:boolean}} [opts]
 * @returns {Promise<AskedAuthorization>}
 */
export function askAuthorizeFor(request, env, opts) {
  return askAuthorize(env, (request && request.headers.get('Cookie')) || '', verifierContextOf(request), opts);
}
