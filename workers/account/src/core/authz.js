/**
 * 授权判断（方案 2.3.3、2.4；P2-1 授权骨架）：作用域判断的唯一入口。
 *
 * - grantedScopes(env, accountSession)：当前授权。P3-1（第 3 件）起读授权记录（app_grant，core/app-grant.js）：
 *   - 账号会话无效 → []
 *   - 还没有种子标记（上线到首次打开授权卡页 / 首次登录后授权检查之间）→ 保持骨架行为：作用域表里的全部作用域
 *     （否则上线后全部写接口立即 403 scope；设计方案 4.7「用户感知不到变化」）
 *   - 有种子标记 → 已授权 ∩ 作用域表（0 行 = []）；首次切换之后新增、还没补种的应用（app-grant.js SEED_SUPPLEMENTS）按已授权算
 *   函数签名、authorize 的结论形状都不变（P2-1 定的），下游不用改。只读不写：种子不在这里写（走 grant-list，见 api/account.js）。
 * - authorize(env, request, opts)：验账号会话 → 取 deviceId → 算作用域 → opts.reauth 为真时再验 sgx-account-reauth。
 *   结论 { ok, reason, deviceId, scopes, reauth }；只读不签：不写 cookie、不签票、不推纪元
 *   （验证通过时照旧刷新设备 lastSeen，沿用 account-session.js 的节流）。永不抛错，出错 fail closed。
 *
 * 调用方：rpc/account-verifier.js 的 AccountVerifier.authorize()（网关经 ACCOUNT_VERIFIER 问）。
 * P2-1 只新增，现有接口的判断一行不改；以后 /api/account、/api/prefs、/api/avatar、/api/wellbeing 也用这同一份（P2-2）。
 *
 * 每次授权请求读一次 D1 主库（授权记录 + 种子标记；账号纪元和设备黑名单在 verifyAccountSession 里），不缓存：取消后下次请求即拦截。
 *
 * 只 import 本目录（account-session.js、realm.js、scopes.js、app-grant.js）。
 */
import { verifyAccountSession, verifyTicket } from './account-session.js';
import { ACCOUNT_REAUTH_TICKET } from './realm.js';
import { SCOPE_IDS, knownScopes } from './scopes.js';
import { readGrantState, scopesOfRows, scopesOfApp } from './app-grant.js';

/**
 * @typedef {{ ok: boolean, reason: string, deviceId: string, scopes: string[], reauth: boolean }} Authorization
 */

/**
 * 当前授权：账号会话有效 → 有种子标记时 已授权 ∩ 作用域表，没有标记时作用域表全部（骨架行为）；否则 []。
 * 读授权记录出错抛错（authorize 接住，fail closed）。
 * @param {Record<string, any>} env
 * @param {{ ok?: boolean }|null|undefined} accountSession verifyAccountSession 的结论
 * @returns {Promise<string[]>}
 */
export async function grantedScopes(env, accountSession) {
  if (!accountSession || accountSession.ok !== true) return [];
  const st = await readGrantState(env);
  if (!st.seeded) return SCOPE_IDS.slice();
  /* 已切换、新应用还没补种（SEED_SUPPLEMENTS 标记没写）：那批应用按已授权算（同骨架行为） */
  const pend = [];
  for (const app of st.pending || []) for (const s of scopesOfApp(app)) pend.push(s);
  return knownScopes(scopesOfRows(st.rows).concat(pend));
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
