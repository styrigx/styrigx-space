/**
 * 会话自检接口：前端唯一的「现在是什么状态、接下来去哪」的来源。
 * GET /api/lock-session-check[?return=<url>]
 * - 有有效 sgx-lock-session 会话 → 200 {ok:true, role:'admin'|'visitor', next, upgrade}
 *   - 带 return：next = 服务端校验后的去处（与首页 302 同一个 resolveReturn：站内路径或 *.styrigx.com 白名单，
 *     不合法回首页）；upgrade=true 表示访客要去管理员专属页 → 前端就地弹管理员验证，不跳、不出锁屏
 *   - 不带 return：next = null
 * - 否则 → 401 {ok:false}
 * 锁屏前端解锁成功后、页面状态与 cookie 可能不一致时（切回标签页、bfcache 恢复）都只问这里，
 * 拿到 next 直接跳过去；不再「重载同一地址等 L1 302」（那依赖锁屏页本身过网关，2026-10-21 线上不成立）。
 * 只接受 GET；验签用 _kernel/lock-session.js 的 verifyLockSession，回跳用 _kernel/return.js 的 resolveReturn（都与 middleware 同一份）。
 */
import { verifyLockSession } from '../_kernel/lock-session.js';
import { resolveReturn } from '../_kernel/return.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const sess = await verifyLockSession(request, env);
  if (!sess.ok) return Response.json({ ok: false }, { status: 401, headers: NO_STORE });
  let next = null;
  let upgrade = false;
  let ret = '';
  try {
    ret = new URL(request.url).searchParams.get('return') || '';
  } catch (e) {}
  if (ret) {
    const dest = resolveReturn(ret, sess.role);
    next = dest.location;
    upgrade = dest.upgrade;
  }
  return Response.json({ ok: true, role: sess.role, next, upgrade }, { headers: NO_STORE });
}
