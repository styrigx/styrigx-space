/**
 * 锁屏凭证状态只读接口。
 *
 * GET /api/lock-credentials → { ok:true, password:bool, passkey:bool }
 * - 只读：锁屏密码是否有 hash、是否有锁屏通行密钥。
 * - 鉴权：有效admin 会话（任何 by），或有效的 LockResetTicket——重置锁屏页没有会话也要能显示。
 * - 只返回「是否已设置」，不返回任何敏感数据。
 * - 密码读取失败（D1）→ 503（fail closed），不按未设置退回。
 * 外层 try/catch：异常一律返回 { ok:false }，不暴露细节。
 */
import { verifyLockSession } from '../_kernel/lock-session.js';
import { ROLE_ADMIN } from '../_kernel/lock-session.js';
import { verifyLockResetTicket } from '../_kernel/tickets.js';
import { getPasskeys, PASSKEY_LOCK } from '../_kernel/passkey-store.js';
import { REALM_LOCK } from '../_kernel/realms.js';
import { hasPassword } from '../_kernel/password.js';
import { json, apiError } from '../_kernel/http.js';

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json(500, { ok: false });
  }
}

/** @param {any} context */
async function handleGet(context) {
  const { request, env } = context;
  const lockDb = env && env[REALM_LOCK.d1Binding]; /* D1_LOCK_AUTH（纪元、临时钥匙都在这里）：没绑 → 500 config */
  if (!lockDb) {
    /* 未绑 D1：会话/票据校验本身也读 D1 纪元，直接按配置错误处理（fail closed）。
       注意：实际请求中 verifyLockSession/verifyLockResetTicket 无 D1 时均返回
       无效，正常走 401；此处为纵深防御。 */
    return apiError(500, 'config');
  }

  /* 鉴权：有效 admin 锁屏会话，或 LockResetTicket */
  let authed = false;
  try {
    const sess = await verifyLockSession(request, env);
    if (sess.ok && sess.role === ROLE_ADMIN) authed = true;
  } catch (e) {}
  if (!authed) {
    try {
      const st = await verifyLockResetTicket(request, env);
      if (st.ok) authed = true;
    } catch (e) {}
  }
  if (!authed) {
    return apiError(401, 'session');
  }

  /* 只读锁屏凭证状态 */
  try {
    const password = await hasPassword(env, REALM_LOCK);
    const passkey = (await getPasskeys(env, PASSKEY_LOCK)).length > 0;
    return json(200, { ok: true, password: password, passkey: passkey }, { 'Cache-Control': 'no-store' });
  } catch (e) {
    /* 读取失败 → 503 fail closed */
    return apiError(503, 'server');
  }
}
