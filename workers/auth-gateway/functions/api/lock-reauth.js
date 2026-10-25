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
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import { REALM_LOCK, LOCK_REAUTH_TICKET, LOCK_RESET_TICKET } from '../_kernel/realms.js';
import { verifyTicket, clearTicket } from '../_kernel/tickets.js';
import { getPasskeys, PASSKEY_LOCK } from '../_kernel/passkey-store.js';

/** 接口 / 前端用的票标识（status 的 ticket 字段） */
export const TICKET_IDS = Object.freeze({ [LOCK_REAUTH_TICKET]: 'lock-reauth', [LOCK_RESET_TICKET]: 'lock-reset' });

/**
 * 锁屏凭证管理的统一检查（lock-password / lock-passkey / lock-all-devices 共用）。
 *
 * - LockReauthTicket 有效 + admin 锁屏会话有效 → 通过
 * - allowReset 时，LockResetTicket 有效 → 通过（无会话，sess=null）
 * - 都没有：无 admin 会话 → 401 session；有会话 → 403 reauth（前端回到验证入口重新验证）
 *
 * @param {any} request
 * @param {any} env
 * @param {{allowReset?: boolean}} [opts]
 * @returns {Promise<{ok:true, tv:{ok:boolean, by?:string, exp?:number}, ticket:string, isLockReset:boolean, sess:any}|{ok:false, status:number, body:object}>}
 */
export async function checkLockManage(request, env, opts) {
  const allowReset = !!(opts && opts.allowReset);
  const tv = await verifyTicket(request, env, LOCK_REAUTH_TICKET);
  if (!tv.ok && allowReset) {
    const rv = await verifyTicket(request, env, LOCK_RESET_TICKET);
    if (rv.ok) return { ok: true, tv: rv, ticket: LOCK_RESET_TICKET, isLockReset: true, sess: null };
  }
  const sess = await verifyLockSession(request, env);
  if (!sess.ok || sess.role !== ROLE_ADMIN) {
    return { ok: false, status: 401, body: { ok: false, error: 'session' } };
  }
  if (!tv.ok) {
    return { ok: false, status: 403, body: { ok: false, error: 'reauth', reason: tv.reason } };
  }
  return { ok: true, tv: tv, ticket: LOCK_REAUTH_TICKET, isLockReset: false, sess: sess };
}

/**
 * 访客会话（只看 role 段，不验签、不读存储）：验证入口对访客一律写死「密码错误」。
 * @param {any} request
 */
export function looksVisitor(request) {
  try {
    const h = request.headers.get('Cookie') || '';
    for (const part of h.split(';')) {
      const kv2 = part.trim().split('=');
      if (kv2[0] === REALM_LOCK.cookie && kv2[1]) {
        const parts = kv2.slice(1).join('=').split('.');
        if (parts.length === 6 && parts[1] === 'visitor') return true;
      }
    }
  } catch (e) {}
  return false;
}

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
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }
  if (!isSameOrigin(request)) return originDenied();

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false, error: 'body' }, { status: 400 });
  }
  const action = (body && body.action) || '';

  if (action === 'clear') {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    clearTicket(headers, LOCK_REAUTH_TICKET);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  if (action === 'status') {
    if (!kv) return Response.json({ ok: false, error: 'config' }, { status: 500 });
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
      return Response.json({ ok: false, error: 'session' }, { status: 401 });
    }
    let password = false;
    let passkey = false;
    try {
      const pw = await kv.get(REALM_LOCK.kv.password, 'json');
      password = !!(pw && pw.hash);
      passkey = (await getPasskeys(kv, PASSKEY_LOCK)).length > 0;
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    const valid = !!ticket;
    return Response.json({
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

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
