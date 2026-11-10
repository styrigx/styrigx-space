/**
 * 锁屏凭证管理的门槛（lock-password / lock-passkey / lock-all-devices 共用）和票标识。
 * 放在内核而不是 api/lock-reauth.js：api/ 之间不互相 import（分层规则 4）。
 */
import { verifyLockSession } from './lock-session.js';
import { LOCK_REAUTH_TICKET, LOCK_RESET_TICKET, BY_LINK } from './realms.js';
import { verifyTicket } from './tickets.js';

/** 接口 / 前端用的票标识（status 的 ticket 字段） */
export const TICKET_IDS = Object.freeze({ [LOCK_REAUTH_TICKET]: 'lock-reauth', [LOCK_RESET_TICKET]: 'lock-reset' });

/**
 * 锁屏凭证管理的统一检查（lock-password / lock-passkey / lock-all-devices 共用）。
 *
 * - LockReauthTicket 有效 + 进门（进站会话有效，锁屏密码 / 通行密钥进的门）→ 通过
 * - 分享链接进来的会话（by=link，v5 S1）：就算带着 reauth 票也不放行 → 403 link（纵深防御：reauth 本来就不给 by=link 签）
 * - allowReset 时，LockResetTicket 有效 → 通过（无会话，sess=null）
 * - 都没有：没进门 → 401 session；进门了 → 403 reauth（前端回到验证入口重新验证）
 *
 * @param {any} request
 * @param {any} env
 * @param {{allowReset?: boolean}} [opts]
 * @returns {Promise<{ok:true, tv:{ok:boolean, by?:string, exp?:number}, ticket:string, isLockReset:boolean, sess:any}|{ok:false, status:number, body:object}>}
 */
export async function checkLockManage(request, env, opts) {
  const allowReset = !!(opts && opts.allowReset);
  const tv = await verifyTicket(request, env, LOCK_REAUTH_TICKET);
  if (!tv.ok && allowReset) {
    const rv = await verifyTicket(request, env, LOCK_RESET_TICKET);
    if (rv.ok) return { ok: true, tv: rv, ticket: LOCK_RESET_TICKET, isLockReset: true, sess: null };
  }
  const sess = await verifyLockSession(request, env);
  if (!sess.ok) {
    return { ok: false, status: 401, body: { ok: false, error: 'session' } };
  }
  if (sess.by === BY_LINK) {
    return { ok: false, status: 403, body: { ok: false, error: 'link' } };
  }
  if (!tv.ok) {
    return { ok: false, status: 403, body: { ok: false, error: 'reauth', reason: tv.reason } };
  }
  return { ok: true, tv: tv, ticket: LOCK_REAUTH_TICKET, isLockReset: false, sess: sess };
}

