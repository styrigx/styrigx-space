/**
 * 授权判断（方案 2.3.3、2.4；P2-1 授权骨架）：作用域判断的唯一入口。
 *
 * - grantedScopes(env, accountSession)：当前授权。骨架阶段（P2-1 到第 3 件实现之前）= 账号会话有效就返回作用域表里的全部作用域，
 *   行为上和现行「账号会话能做一切」等价。第 3 件实现（另批）只把这里换成读授权记录，返回 已授权 ∩ 作用域表；
 *   函数签名、authorize 的结论形状都不变，下游不用再改。
 * - authorize(env, request, opts)：验账号会话 → 取 deviceId → 算作用域 → opts.reauth 为真时再验 sgx-account-reauth。
 *   结论 { ok, reason, deviceId, scopes, reauth }；只读不签：不写 cookie、不签票、不推纪元
 *   （验证通过时照旧刷新设备 lastSeen，沿用 account-session.js 的节流）。永不抛错，出错 fail closed。
 *
 * 调用方：rpc/account-verifier.js 的 AccountVerifier.authorize()（网关经 ACCOUNT_VERIFIER 问）。
 * P2-1 只新增，现有接口的判断一行不改；以后 /api/account、/api/prefs、/api/avatar、/api/wellbeing 也用这同一份（P2-2）。
 *
 * 只 import 本目录（account-session.js、realm.js、scopes.js）。
 */
import { verifyAccountSession, verifyTicket } from './account-session.js';
import { ACCOUNT_REAUTH_TICKET } from './realm.js';
import { SCOPE_IDS, knownScopes } from './scopes.js';

/**
 * @typedef {{ ok: boolean, reason: string, deviceId: string, scopes: string[], reauth: boolean }} Authorization
 */

/**
 * 当前授权（骨架版）：账号会话有效 → 作用域表里的全部作用域；否则 []。
 * @param {Record<string, any>} env 预留给第 3 件读授权记录
 * @param {{ ok?: boolean }|null|undefined} accountSession verifyAccountSession 的结论
 * @returns {Promise<string[]>}
 */
export async function grantedScopes(env, accountSession) {
  if (!accountSession || accountSession.ok !== true) return [];
  return SCOPE_IDS.slice();
}

/** @param {string} reason @returns {Authorization} */
function denied(reason) {
  return { ok: false, reason: reason || 'denied', deviceId: '', scopes: [], reauth: false };
}

/**
 * 授权结论。
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 * @param {Request} request 只读 Cookie / User-Agent / 地点头
 * @param {{ reauth?: boolean }} [opts] reauth 为 true 时才读 sgx-account-reauth（多读一张票）
 * @returns {Promise<Authorization>}
 *   reason：ok，或 verifyAccountSession 的原因代号（no-cookie / bad-format / expired / epoch-changed / revoked / d1-error …），或 error
 */
export async function authorize(env, request, opts) {
  try {
    const s = await verifyAccountSession(request, env);
    if (!s || s.ok !== true) return denied((s && s.reason) || 'denied');
    const scopes = knownScopes(await grantedScopes(env, s));
    let reauth = false;
    if (opts && typeof opts === 'object' && opts.reauth === true) {
      try {
        const t = await verifyTicket(request, env, ACCOUNT_REAUTH_TICKET);
        reauth = !!(t && t.ok === true);
      } catch (e) {
        reauth = false;
      }
    }
    return { ok: true, reason: 'ok', deviceId: s.deviceId || '', scopes, reauth };
  } catch (e) {
    console.error('[sgx-account] authorize unhandled: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return denied('error');
  }
}
