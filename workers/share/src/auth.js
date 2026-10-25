/**
 * @fileoverview 分享短链 Worker 的会话判断：直接用账号 Worker 那一份（workers/account/src/auth.js，不复制）。
 * 浏览器带来的 Cookie 头原样交给网关的 AuthVerifier（服务绑定 AUTH，RPC），网关只回结论；同一请求各只问一次；
 * 网关不可达 / 绑定没配 → 当作无会话（fail closed）。本 Worker 不持任何钥匙、不绑认证库。
 */
export { authFor, ROLE_ADMIN, ROLE_VISITOR } from '../../account/src/auth.js';

/**
 * 网关 ShareIssuer 记账号设备用的 meta（同 account auth.js：User-Agent、cf 国家城市）。
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

/** 浏览器 Cookie 头（交给网关 ShareIssuer 再验一次管理员） @param {Request} request */
export function cookieOf(request) {
  return (request.headers.get('Cookie') || '').slice(0, 8192);
}
