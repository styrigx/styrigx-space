/**
 * v6 身份统一（P2）：身份栈的写操作——签发新会话（su <用户>）、压 root 层（su root）、弹一层（exit / 空闲）、清栈（lock）、
 * 滑动续期的续写。判定（admit，只读）在 core/identity-session.js。
 *
 * - 客户端只拿到不透明随机令牌（cookie sgx-session，HttpOnly、Secure、SameSite=Lax、Path=/，只发给 styrigx.com 本主机）；
 *   库里存它的 SHA-256（account_sessions.id）。token 不带 uid、组或栈。
 * - 栈：栈底在 account_sessions（普通用户；救援会话的 root），su root 压的那一层在 account_session_stack（深度 1，只会是 root）。
 *   访客 → 普通用户 → root，最多三层。sudo 不压栈。
 * - root 代码级禁止公开登录：issueSession 拒绝 uid = root；救援会话走 issueRescueSession，唯一调用方是 P3 救援入口 core/rescue.js（验过恢复钥匙才签）。
 * - 时长（identity-session.js SESSION_TTL_MS）：普通用户层 30 天滑动续期（admit 只回 renew 标志，renewSession 按节流续写）；
 *   root 层 ≤ 1 小时（且不超过会话本身）；救援 15 分钟、不续期。
 *
 * 只 import lib/ 和 core/。
 */
import { onDb } from '../lib/db.js';
import { COOKIE_EXPIRED } from '../lib/cookies.js';
import { b64urlEnc } from '../lib/crypto.js';
import { ROOT_UID } from './groups.js';
import { SESSION_COOKIE, SESSION_TTL_MS, sessionIdOf } from './identity-session.js';
import { sessionsHaveDevice } from './device-mark.js';

/** 新会话 cookie 的属性（主机级：不写 Domain） */
export const SESSION_COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

/**
 * 登录标记（P2b）：值固定 1、非 HttpOnly、不含任何秘密，只给前端首帧决定要不要问 whoami（同 v5 的 sgx-account-signed-in）。
 * 鉴权从不读它；随 sgx-session 签发 / 续期 / 清除。
 */
export const V6_MARKER_COOKIE = 'sgx-id';
/** @param {number} maxAgeSec */
export function markerCookie(maxAgeSec) {
  return V6_MARKER_COOKIE + '=1; Path=/; Secure; SameSite=Lax; Max-Age=' + Math.max(0, Math.floor(maxAgeSec));
}
export function clearMarkerCookie() {
  return V6_MARKER_COOKIE + '=; Path=/; Secure; SameSite=Lax; ' + COOKIE_EXPIRED;
}

/** 新令牌：32 字节随机数的 base64url（43 字符，同 SESSION_TOKEN_RE） */
export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return b64urlEnc(b);
}

/** 设 cookie 的 Set-Cookie 值 @param {string} token @param {number} maxAgeSec */
export function sessionCookie(token, maxAgeSec) {
  return SESSION_COOKIE + '=' + token + '; ' + SESSION_COOKIE_ATTRS + '; Max-Age=' + Math.max(0, Math.floor(maxAgeSec));
}
/** 清 cookie 的 Set-Cookie 值 */
export function clearSessionCookie() {
  return SESSION_COOKIE + '=; ' + SESSION_COOKIE_ATTRS + '; ' + COOKIE_EXPIRED;
}

/**
 * 签发普通用户会话（su <用户> 成功后）。uid 是 root → 抛错（root 代码级禁止公开登录）。出错抛错。
 * 2g（定稿 v5.5 §十一）：opts.device = 这台设备的标记（core/device-mark.js）；account_sessions 有设备列（迁移跑过）才写，没有照旧。
 * @param {any} env @param {{uid:number, epoch:number}} user @param {number} [now] @param {{device?: string}} [opts]
 * @returns {Promise<{token:string, id:string, expiresAt:number, cookie:string}>}
 */
export async function issueSession(env, user, now, opts) {
  if (!user || !Number.isInteger(user.uid) || user.uid === ROOT_UID) throw new Error('root-login-forbidden');
  const t = typeof now === 'number' ? now : Date.now();
  const token = newToken();
  const id = /** @type {string} */ (await sessionIdOf(token));
  const expiresAt = t + SESSION_TTL_MS.user;
  const device = opts && typeof opts.device === 'string' && opts.device ? opts.device : '';
  await onDb(env, async (d) => {
    if (device && (await sessionsHaveDevice(d))) {
      return d.prepare('INSERT INTO account_sessions (id, uid, epoch, rescue, created_at, expires_at, renewed_at, device) VALUES (?, ?, ?, 0, ?, ?, 0, ?)')
        .bind(id, user.uid, user.epoch, t, expiresAt, device).run();
    }
    return d.prepare('INSERT INTO account_sessions (id, uid, epoch, rescue, created_at, expires_at, renewed_at) VALUES (?, ?, ?, 0, ?, ?, 0)')
      .bind(id, user.uid, user.epoch, t, expiresAt).run();
  });
  return { token, id, expiresAt, cookie: sessionCookie(token, SESSION_TTL_MS.user / 1000) };
}

/**
 * 救援会话（唯一调用方：P3 救援入口 core/rescue.js，定稿 v5.2 §九）：栈底 root、rescue = 1、15 分钟、不续期。出错抛错。
 * @param {any} env @param {{epoch:number}} root @param {number} [now]
 */
export async function issueRescueSession(env, root, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const token = newToken();
  const id = /** @type {string} */ (await sessionIdOf(token));
  const expiresAt = t + SESSION_TTL_MS.rescue;
  await onDb(env, (d) => d.prepare('INSERT INTO account_sessions (id, uid, epoch, rescue, created_at, expires_at, renewed_at) VALUES (?, 0, ?, 1, ?, ?, 0)')
    .bind(id, root.epoch, t, expiresAt).run());
  return { token, id, expiresAt, cookie: sessionCookie(token, SESSION_TTL_MS.rescue / 1000) };
}

/**
 * su root：在会话上压 root 层（已有的旧层先替换）。到期 = min(now + 1 小时, 会话到期)。出错抛错。
 * @param {any} env @param {string} sessionId @param {number} rootEpoch @param {number} sessionExpiresAt @param {number} [now]
 * @returns {Promise<number>} 这一层的到期时间
 */
export async function pushRootLayer(env, sessionId, rootEpoch, sessionExpiresAt, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const exp = Math.min(t + SESSION_TTL_MS.rootLayer, sessionExpiresAt);
  await onDb(env, (d) => d.prepare(
    'INSERT INTO account_session_stack (session_id, depth, uid, epoch, pushed_at, expires_at) VALUES (?, 1, 0, ?, ?, ?)' +
    ' ON CONFLICT (session_id, depth) DO UPDATE SET uid = 0, epoch = excluded.epoch, pushed_at = excluded.pushed_at, expires_at = excluded.expires_at'
  ).bind(sessionId, rootEpoch, t, exp).run());
  return exp;
}

/** 弹掉 root 层（没有 → false）。出错抛错。 @param {any} env @param {string} sessionId @returns {Promise<boolean>} */
export async function popRootLayer(env, sessionId) {
  const r = await onDb(env, (d) => d.prepare('DELETE FROM account_session_stack WHERE session_id = ?').bind(sessionId).run());
  return !!(r && r.meta && Number(r.meta.changes) > 0);
}

/** 这个会话有没有 root 层（过没过期都算；exit 先弹它） @param {any} env @param {string} sessionId */
export async function hasRootLayer(env, sessionId) {
  const row = await onDb(env, (d) => d.prepare('SELECT 1 AS x FROM account_session_stack WHERE session_id = ?').bind(sessionId).first());
  return !!row;
}

/** 删整个会话（栈一起删；lock / exit 到底 / 救援 exit）。出错抛错。 @param {any} env @param {string} sessionId */
export async function endSession(env, sessionId) {
  await onDb(env, (d) => d.batch([
    d.prepare('DELETE FROM account_session_stack WHERE session_id = ?').bind(sessionId),
    d.prepare('DELETE FROM account_sessions WHERE id = ?').bind(sessionId),
  ]));
}

/** 按令牌删整个会话（令牌格式不对 → 什么都不做）。出错抛错。 @param {any} env @param {string} token */
export async function endSessionByToken(env, token) {
  const id = await sessionIdOf(token);
  if (id) await endSession(env, id);
}

/**
 * 滑动续期的续写（admit 回了 renew 才调；救援会话的条件写在 SQL 里，永不续）。成功回新的 Set-Cookie，否则 null。尽力而为，不抛错。
 * @param {any} env @param {string} sessionId @param {string} token @param {number} [now]
 * @returns {Promise<string|null>}
 */
export async function renewSession(env, sessionId, token, now) {
  const t = typeof now === 'number' ? now : Date.now();
  try {
    const r = await onDb(env, (d) => d.prepare('UPDATE account_sessions SET expires_at = ?, renewed_at = ? WHERE id = ? AND rescue = 0 AND expires_at > ?')
      .bind(t + SESSION_TTL_MS.user, t, sessionId, t).run());
    if (!r || !r.meta || Number(r.meta.changes) !== 1) return null;
    return sessionCookie(token, SESSION_TTL_MS.user / 1000);
  } catch (e) {
    return null;
  }
}
