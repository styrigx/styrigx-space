/**
 * 2.4.1：会话自检接口（防解锁后跳转循环）。
 * GET /api/session-check
 * - 有有效 sgx-verified 会话 → 200 {ok:true}
 * - 否则 → 401 {ok:false}
 * 锁屏前端在解锁成功后先调这个确认服务端真的认到会话，
 * 确认后才跳 ?return=；没确认到就停在锁屏显示错误，绝不跳转。
 * 只接受 GET；复用 _middleware.js 的 verifySession（同一套验签逻辑）。
 */
import { verifySession } from '../_middleware.js';

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  if (await verifySession(request, env)) {
    return Response.json({ ok: true });
  }
  return Response.json({ ok: false }, { status: 401 });
}
