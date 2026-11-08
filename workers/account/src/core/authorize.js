/**
 * 授权判断：作用域判断的唯一入口（网关经 AccountVerifier.authorize() 问，见 rpc/account-verifier.js；本 Worker 的 gate.js 也用它）。
 *
 * - grantedScopes(env, session)：session 无效 → []；有效 → account_grant 里已授权 ∩ 作用域表（0 行 = []）
 * - authorize(env, request, opts)：验 session → 取 deviceId → 算作用域 → opts.reauth 为真时再验挂在这个 session 上的 reauth 票。
 *   结论 { ok, reason, deviceId, scopes, reauth }；只读不签：不写 cookie、不签票、不推纪元
 *   （验证通过时照旧刷新设备 lastSeen）。永不抛错，出错 fail closed。
 * 每次读一次 D1 主库，不缓存：取消授权后下次请求即拦截。
 *
 * 只 import 本目录。
 */
import { verifySession } from './session.js';
import { verifyReauth } from './reauth.js';
import { knownScopes } from './scopes.js';
import { listGrants, scopesOfRows } from './grants.js';

/**
 * @typedef {{ ok: boolean, reason: string, deviceId: string, scopes: string[], reauth: boolean }} Authorization
 */

/**
 * 当前授权（读授权行出错抛错，authorize 接住）。
 * @param {Record<string, any>} env @param {{ ok?: boolean }|null|undefined} session verifySession 的结论
 * @returns {Promise<string[]>}
 */
export async function grantedScopes(env, session) {
  if (!session || session.ok !== true) return [];
  return scopesOfRows(await listGrants(env));
}

/** @param {string} reason @returns {Authorization} */
function denied(reason) {
  return { ok: false, reason: reason || 'denied', deviceId: '', scopes: [], reauth: false };
}

/**
 * 授权结论。
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 * @param {Request} request 只读 Cookie / User-Agent / 地点头
 * @param {{ reauth?: boolean }} [opts] reauth 为 true 时才读 sgx-account-reauth
 * @returns {Promise<Authorization>} reason：ok，或 verifySession 的原因代号，或 error
 */
export async function authorize(env, request, opts) {
  try {
    const s = await verifySession(request, env);
    if (!s || s.ok !== true) return denied((s && s.reason) || 'denied');
    const scopes = knownScopes(await grantedScopes(env, s));
    let reauth = false;
    if (opts && typeof opts === 'object' && opts.reauth === true) {
      try { reauth = (await verifyReauth(request, env, s)).ok === true; } catch (e) { reauth = false; }
    }
    return { ok: true, reason: 'ok', deviceId: s.deviceId || '', scopes, reauth };
  } catch (e) {
    console.error('[sgx-account] authorize unhandled: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return denied('error');
  }
}
