/**
 * 2.4.1：会话自检接口（防解锁后跳转循环）。
 * 2.8.0：返回角色供 UI 展示（UI 不做鉴权）。
 * GET /api/session-check
 * - 有有效 sgx-verified 会话 → 200 {ok:true, role:'owner'|'visitor'}
 * - 否则 → 401 {ok:false}
 * 锁屏前端在解锁成功后先调这个确认服务端真的认到会话，
 * 确认后才跳 ?return=；没确认到就停在锁屏显示错误，绝不跳转。
 * 只接受 GET；复用 _middleware.js 的 verifySessionDetailed（同一套验签逻辑）。
 */
import { verifySessionDetailed } from '../_middleware.js';

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const sess = await verifySessionDetailed(request, env);
  if (sess.ok) {
    return Response.json(
      { ok: true, role: sess.role },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
  return Response.json({ ok: false }, { status: 401 });
}
