/**
 * 锁屏凭证再验证（LockReauthTicket）：状态查询与清票。
 *
 * 安全与隐私 → 锁屏凭证是安全操作页：每次进页都要再验一次锁屏凭证（锁屏通行密钥 / 锁屏密码，
 * 设了哪个显示哪个）或根凭证，通过后签 3 分钟 LockReauthTicket（cookie sgx-lock-reauth，SGX_LOCK_* 签名，
 * _kernel/tickets.js）。离开页面前端立即 clear，再进重新验证。
 *
 * 签票的三个入口（各自签票，本接口只管状态与清票）：
 * - 锁屏通行密钥：/api/lock-passkey { action:'auth', reauth:true }（challenge 同解锁）
 * - 锁屏密码：/api/lock-password { action:'verify', reauth:true }（与解锁共用限速）
 * - 根凭证：/api/root-auth { key, purpose:'lock-reauth' }（要 admin 锁屏会话，by=root）
 * 重置锁屏（/api/lock-reset，或锁屏从零设置时 /api/root-auth purpose:'lock-reset'）签 LockResetTicket（sgx-lock-reset）：
 * 没有会话，只能设置锁屏密码 / 增删锁屏通行密钥。
 *
 * POST /api/lock-reauth
 * - { action:'status' } → { ok:true, valid, ticket?, by?, expiresAt?, password, passkey }
 *   ticket = 'lock-reauth' | 'lock-reset'（当前有效的是哪张票）
 *   需要 admin 锁屏会话或有效的 LockResetTicket；password/passkey = 锁屏凭证是否已设置（按它显示验证入口）
 * - { action:'clear' } → 清 LockReauthTicket（幂等，不要求会话；不动锁屏会话，也不动 LockResetTicket）
 *
 * 只接受 POST；校验 Origin；外层 try/catch 异常一律 { ok:false, error:'server' }。
 */
import { verifyLockSession, ROLE_ADMIN } from '../_kernel/lock-session.js';
import { isSameOrigin, originDenied, json, apiError } from '../_kernel/lib/http.js';
import { REALM_LOCK, LOCK_REAUTH_TICKET, LOCK_RESET_TICKET } from '../_kernel/realms.js';
import { verifyTicket, clearTicket } from '../_kernel/tickets.js';
import { getPasskeys, PASSKEY_LOCK } from '../_kernel/passkey-store.js';
import { hasPassword } from '../_kernel/lib/password.js';
import { TICKET_IDS } from '../_kernel/lock-manage.js';

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
  const lockDb = env && env[REALM_LOCK.d1Binding]; /* D1_LOCK_AUTH（纪元、临时钥匙都在这里）：没绑 → 500 config */
  if (request.method !== 'POST') {
    return apiError(405, 'method');
  }
  if (!isSameOrigin(request)) return originDenied();

  let body;
  try { body = await request.json(); } catch (e) {
    return apiError(400, 'body');
  }
  const action = (body && body.action) || '';

  if (action === 'clear') {
    const headers = new Headers();
    clearTicket(headers, LOCK_REAUTH_TICKET);
    return json(200, { ok: true }, headers);
  }

  if (action === 'status') {
    if (!lockDb) return apiError(500, 'config');
    let ticket = '';
    let tv = await verifyTicket(request, env, LOCK_REAUTH_TICKET);
    const sess = await verifyLockSession(request, env);
    const isAdmin = sess.ok && sess.role === ROLE_ADMIN;
    /* LockReauthTicket 必须配 admin 锁屏会话；LockResetTicket 本来就没有会话 */
    if (tv.ok && isAdmin) ticket = LOCK_REAUTH_TICKET;
    if (!ticket) {
      const rv = await verifyTicket(request, env, LOCK_RESET_TICKET);
      if (rv.ok) {
        tv = rv;
        ticket = LOCK_RESET_TICKET;
      }
    }
    if (!isAdmin && ticket !== LOCK_RESET_TICKET) {
      return apiError(401, 'session');
    }
    let password = false;
    let passkey = false;
    try {
      password = await hasPassword(env, REALM_LOCK);
      passkey = (await getPasskeys(env, PASSKEY_LOCK)).length > 0;
    } catch (e) {
      return apiError(503, 'server');
    }
    const valid = !!ticket;
    return json(200, {
      ok: true,
      valid: valid,
      ticket: valid ? TICKET_IDS[ticket] : undefined,
      by: valid ? tv.by : undefined,
      expiresAt: valid ? tv.exp : undefined,
      reason: valid ? undefined : tv.reason,
      password: password,
      passkey: passkey,
    });
  }

  return apiError(400, 'params');
}
