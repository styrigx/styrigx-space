/**
 * 2.8.0：锁定所有设备 —— 独立 L2 API（从锁屏密码接口的 lockout action 拆出）。
 *
 * 锁屏凭证门内操作：需有效站长会话 + 锁屏门票（door=lock）。
 *
 * POST /api/lock-all-devices
 * - 只允许站长会话调用（L1 middleware 已按 ADMIN_ONLY_APIS 拒绝 visitor → 403；
 *   本接口再做一次角色校验，纵深防御）。
 * - 无会话 → 401；visitor 会话 → 403 {ok:false, error:'role'}。
 * - 无锁屏门票 → 403 door（前端回到门口重新验证）。
 * - 逻辑：KV session-epoch +1（所有设备旧 cookie 失效），用 Set-Cookie 清当前 cookie 和门票。
 * - 返回 {ok:true}。
 *
 * 注意：子站 缓存 epoch 约 60 秒，锁定后最多 60 秒内在 子站 生效。
 * 只接受 POST；外层 try/catch：任何未捕获异常都返回 JSON { ok:false, error:'server' }。
 */
import { verifySessionDetailed } from '../_middleware.js';
import {
  clearVerifiedCookie,
  bumpSessionEpoch,
  ROLE_OWNER,
} from '../_kernel/lock-session.js';
import { checkLockManage } from './lock-reauth.js';
import { clearDoorCookie } from '../_kernel/tickets.js';

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  const kv = env && env.KV_LOCK_DOOR;
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* 会话校验：必须是站长。L1 已拒绝 visitor（403），这里再验一次。 */
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok) {
    return Response.json({ ok: false }, { status: 401 });
  }
  if (sess.role !== ROLE_OWNER) {
    return Response.json({ ok: false, error: 'role' }, { status: 403 });
  }
  /* 锁屏门票（by=root 的代开会话在锁屏已配置时拒绝，见 checkLockManage） */
  const gate = await checkLockManage(request, env);
  if (!gate.ok) {
    return Response.json(gate.body, { status: gate.status });
  }

  /* session-epoch +1：KV 出错 → 503，绝不继续 */
  try {
    await bumpSessionEpoch(kv);
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }

  /* 清当前 cookie（带 Domain=.styrigx.com，三站一起锁） */
  const headers = new Headers({ 'Content-Type': 'application/json' });
  clearVerifiedCookie(headers);
  clearDoorCookie(headers);
  return new Response(JSON.stringify({ ok: true }), { headers });
}
