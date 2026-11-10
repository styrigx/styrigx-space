/**
 * 锁定所有设备 —— 独立 L2 API（从锁屏密码接口的 lockout action 拆出）。
 *
 * 锁屏凭证门内操作：进门 + LockReauthTicket（锁侧复验，方案 3.6）。
 *
 * POST /api/lock-all-devices
 * - 没进门 → 401。
 * - 无 LockReauthTicket → 403 reauth（前端重新验证）。
 * - 逻辑：lock-epoch +1（D1，所有设备旧 cookie 失效），用 Set-Cookie 清当前进站会话和 LockReauthTicket。
 * - 返回 {ok:true}。
 *
 * lock-epoch 在 D1（强一致，2026-10-27 前在 KV、要等约 60 秒）：推进后主站与子站的下一个请求就看到新纪元，旧会话立刻失效。
 * 只接受 POST；外层 try/catch：任何未捕获异常都返回 JSON { ok:false, error:'server' }。
 */
import { verifyLockSession } from '../core/lock-session.js';
import {
  clearLockSessionCookie,
  bumpLockEpoch,
} from '../core/lock-session.js';
import { checkLockManage } from '../core/lock-manage.js';
import { clearTicket } from '../core/tickets.js';
import { LOCK_REAUTH_TICKET, REALM_LOCK } from '../core/realms.js';
import { json, apiError } from '../lib/http.js';

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
  const lockDb = env && env[REALM_LOCK.d1Binding]; /* D1_SPACE（纪元、分享链接都在这里）：没绑 → 500 config */
  if (!lockDb) {
    return apiError(500, 'config');
  }

  /* 会话校验：要进门 */
  const sess = await verifyLockSession(request, env);
  if (!sess.ok) {
    return json(401, { ok: false });
  }
  /* LockReauthTicket（见 checkLockManage） */
  const gate = await checkLockManage(request, env);
  if (!gate.ok) {
    return json(gate.status, gate.body);
  }

  /* lock-epoch +1（D1 原子自增）：出错 → 503，绝不继续 */
  try {
    await bumpLockEpoch(env);
  } catch (e) {
    return apiError(503, 'server');
  }

  /* 清当前 cookie（带 Domain=.styrigx.com，三站一起锁） */
  const headers = new Headers();
  clearLockSessionCookie(headers);
  clearTicket(headers, LOCK_REAUTH_TICKET);
  return json(200, { ok: true }, headers);
}
