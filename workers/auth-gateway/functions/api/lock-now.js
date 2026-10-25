/**
 * 立即锁定接口。
 * POST /api/lock-now
 * - 清除锁屏会话 cookie sgx-lock-session（Domain=.styrigx.com；子站共用该 cookie，清掉后一起上锁）。
 *   访客会话同样清掉（临时钥匙换来的也是这张票）。
 * - 同时清除 LockReauthTicket（sgx-lock-reauth），否则锁定后 3 分钟内仍可用残留的票改密码 / 删密钥。
 * - 幂等：无会话时调用也是 {ok:true}。
 * - 只接受 POST。
 */
import { clearLockSessionCookie } from '../_kernel/lock-session.js';
import { clearTicket } from '../_kernel/tickets.js';
import { LOCK_REAUTH_TICKET } from '../_kernel/realms.js';

/**
 * @param {any} context
 */
export async function onRequestPost(context) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  clearLockSessionCookie(headers);
  clearTicket(headers, LOCK_REAUTH_TICKET);
  return new Response(JSON.stringify({ ok: true }), { headers });
}

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  return Response.json({ ok: false, error: 'method' }, { status: 405 });
}
