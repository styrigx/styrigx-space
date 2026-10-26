/**
 * 2.8.0：锁定所有设备 —— 独立 L2 API（从锁屏密码接口的 lockout action 拆出）。
 *
 * 锁屏凭证门内操作：需有效 admin 锁屏会话 + LockReauthTicket。
 *
 * POST /api/lock-all-devices
 * - 只允许admin 会话调用（L1 middleware 已按 ADMIN_ONLY_APIS 拒绝 visitor → 403；
 *   本接口再做一次角色校验，纵深防御）。
 * - 无会话 → 401；visitor 会话 → 403 {ok:false, error:'role'}。
 * - 无 LockReauthTicket → 403 reauth（前端重新验证）。
 * - 逻辑：KV lock-epoch +1（所有设备旧 cookie 失效），用 Set-Cookie 清当前锁屏会话和 LockReauthTicket。
 * - 返回 {ok:true}。
 *
 * 注意：子站 缓存 epoch 约 60 秒，锁定后最多 60 秒内在 子站 生效。
 * 只接受 POST；外层 try/catch：任何未捕获异常都返回 JSON { ok:false, error:'server' }。
 */
import { verifyLockSession } from '../_kernel/lock-session.js';
import {
  clearLockSessionCookie,
  bumpLockEpoch,
  ROLE_ADMIN,
} from '../_kernel/lock-session.js';
import { checkLockManage } from '../_kernel/lock-manage.js';
import { clearTicket } from '../_kernel/tickets.js';
import { LOCK_REAUTH_TICKET } from '../_kernel/realms.js';
import { json, apiError } from '../_kernel/http.js';

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return apiError(500, 'server');
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  const kv = env && env.KV_LOCK_DOOR;
  if (!kv) {
    return apiError(500, 'config');
  }

  /* 会话校验：必须是管理员。L1 已拒绝 visitor（403），这里再验一次。 */
  const sess = await verifyLockSession(request, env);
  if (!sess.ok) {
    return json(401, { ok: false });
  }
  if (sess.role !== ROLE_ADMIN) {
    return apiError(403, 'role');
  }
  /* LockReauthTicket（见 checkLockManage） */
  const gate = await checkLockManage(request, env);
  if (!gate.ok) {
    return json(gate.status, gate.body);
  }

  /* lock-epoch +1：KV 出错 → 503，绝不继续 */
  try {
    await bumpLockEpoch(kv);
  } catch (e) {
    return apiError(503, 'server');
  }

  /* 清当前 cookie（带 Domain=.styrigx.com，三站一起锁） */
  const headers = new Headers();
  clearLockSessionCookie(headers);
  clearTicket(headers, LOCK_REAUTH_TICKET);
  return json(200, { ok: true }, headers);
}
