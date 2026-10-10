/**
 * 2.4.1：立即锁定接口。
 * POST /api/lock
 * - 清除 sgx-verified 会话 cookie（两条 Set-Cookie：Domain=.styrigx.com 和
 *   不带 Domain 的 host-only，旧版残留的一起清掉；blog/book 共用该 cookie，
 *   清掉后一起上锁）。
 * - 幂等：无会话时调用也是 {ok:true}。
 * - 只接受 POST。
 */
import { clearVerifiedCookie } from '../_kernel/session.js';

/**
 * @param {any} context
 */
export async function onRequestPost(context) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  clearVerifiedCookie(headers);
  return new Response(JSON.stringify({ ok: true }), { headers });
}

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  return Response.json({ ok: false, error: 'method' }, { status: 405 });
}
