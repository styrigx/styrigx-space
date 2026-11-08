/**
 * @fileoverview 账号 Worker 的命名入口 AccountVerifier（WorkerEntrypoint，RPC；只有网关绑定，服务绑定 ACCOUNT_VERIFIER）：
 * - session(cookieHeader, clientContext)：只回账号会话的校验结论（网关的首帧提示用；
 *   临时钥匙管理、短链只认进站会话 + 锁侧复验，不再问它）。
 * - authorize(cookieHeader, clientContext, opts)：授权结论 { ok, reason, deviceId, scopes, reauth }（逻辑在 core/authorize.js）。
 *   P2-1 只新增：网关 core/account-rpc.js askAuthorize 会问它，但网关里还没有调用方（P2-2 起子站接口经 AuthVerifier.conclusion() 间接用）。
 * 两个方法都不签发任何东西。
 * cloudflare:workers 只在 Workers 里有：node 单测用 tests/workers/account/_cf-workers.mjs 的替身。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { MAX_COOKIE_HEADER } from '../lib/cookies.js';
import { CLIENT_CONTEXT_HEADERS } from '../lib/gateway.js';
import { resolveSecrets } from '../secrets.js';
import { verifySession } from '../core/session.js';
import { authorize } from '../core/authorize.js';

const MAX_UA = 512;

/**
 * 把 RPC 参数还原成一个只带 Cookie / User-Agent / 地点头的内部请求（账号会话验证和设备 lastSeen 刷新读这些）。
 * @param {string} cookieHeader
 * @param {{ua?:string, country?:string, city?:string}} [clientContext]
 */
export function verifierRequest(cookieHeader, clientContext) {
  /** @type {Record<string,string>} */
  const headers = {};
  const c = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
  if (c) headers.Cookie = c;
  const m = clientContext && typeof clientContext === 'object' ? clientContext : {};
  if (typeof m.ua === 'string' && m.ua) headers['User-Agent'] = m.ua.slice(0, MAX_UA);
  if (typeof m.country === 'string' && m.country) headers[CLIENT_CONTEXT_HEADERS.country] = m.country;
  if (typeof m.city === 'string' && m.city) headers[CLIENT_CONTEXT_HEADERS.city] = m.city;
  return new Request('https://internal.invalid/', { headers });
}

/**
 * AccountVerifier.session 的实现：{ ok: true } 或 { ok: false, reason }。
 * 只验不签：不写 cookie、不签票、不推纪元（验证通过时照旧刷新设备 lastSeen，同网关）。
 * @param {Record<string, any>} env
 * @param {string} cookieHeader
 * @param {{ua?:string, country?:string, city?:string}} [clientContext]
 */
export async function checkSession(env, cookieHeader, clientContext) {
  try {
    const a = await verifySession(verifierRequest(cookieHeader, clientContext), await resolveSecrets(env || {}));
    return a && a.ok ? { ok: true } : { ok: false, reason: (a && a.reason) || 'denied' };
  } catch (e) {
    console.error('[sgx-account] verifier unhandled: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return { ok: false, reason: 'error' };
  }
}

/**
 * AccountVerifier.authorize 的实现：{ ok, reason, deviceId, scopes, reauth }（core/authorize.js authorize）。
 * opts 只认 reauth === true（RPC 传来的别的东西一律当没要复验）。永不抛错，出错 fail closed。
 * @param {Record<string, any>} env
 * @param {string} cookieHeader
 * @param {{ua?:string, country?:string, city?:string}} [clientContext]
 * @param {{reauth?:boolean}} [opts]
 */
export async function checkAuthorize(env, cookieHeader, clientContext, opts) {
  try {
    const want = { reauth: !!(opts && typeof opts === 'object' && opts.reauth === true) };
    return await authorize(await resolveSecrets(env || {}), verifierRequest(cookieHeader, clientContext), want);
  } catch (e) {
    console.error('[sgx-account] verifier authorize unhandled: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return { ok: false, reason: 'error', deviceId: '', scopes: [], reauth: false };
  }
}

/** 账号会话只读校验与授权结论（服务绑定 ACCOUNT_VERIFIER：只有网关） */
export class AccountVerifier extends WorkerEntrypoint {
  /**
   * @param {string} cookieHeader 浏览器发来的 Cookie 头
   * @param {{ua?:string, country?:string, city?:string}} [clientContext]
   */
  async session(cookieHeader, clientContext) {
    return checkSession(this.env, cookieHeader, clientContext);
  }

  /**
   * 授权结论：账号会话有效 → ok、deviceId 取自票、scopes = account_grant 里的当前授权；
   * opts.reauth 为 true 时再验挂在这个会话上的 sgx-account-reauth。
   * @param {string} cookieHeader 浏览器发来的 Cookie 头
   * @param {{ua?:string, country?:string, city?:string}} [clientContext]
   * @param {{reauth?:boolean}} [opts]
   */
  async authorize(cookieHeader, clientContext, opts) {
    return checkAuthorize(this.env, cookieHeader, clientContext, opts);
  }
}
