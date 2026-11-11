/**
 * v6 身份统一（P1）：用户的期限、组成员与 epoch（account_users、account_user_groups；会话行 account_sessions / account_session_stack）。
 *
 * epoch 规则（定稿 §八、Muse 复盘 5）：凭据、组、期限任何变更都让该用户 epoch +1；会话里存快照，严格相等才有效（core/identity-session.js）。
 * - 自己改自己的密码 / 通行密钥（credentialsChanged(..., { sessionId })）：+1 后把当前这一个会话的快照刷成新值（续命），
 *   该用户的其他会话（含别的会话里压着的这一层）删掉；
 * - root 替别人重置（credentialsChanged(..., {})）、组变更、期限变更：+1 后该用户的会话全部作废（行也删掉，who 才准）。
 * 每次变更是一个 batch（一个事务）：+1 和删会话要么都成、要么都不成。
 *
 * 期限：useradd -e YYYY-MM-DD 按 Linux 语义，该日 00:00（Asia/Shanghai）起失效、可用到前一天结束；存 UTC 毫秒（expiryFromDate）。
 * 普通用户（uid 1001 起，含临时用户；定稿 v5.5 §四）永不进 wheel、sudoers、写组：加组先过 core/groups.js canJoinGroup；给已在这些组里的用户设期限也拒绝。
 *
 * P1 只提供这些函数和单测，还没有调用方（useradd / usermod / passwd <名> 是 P2 的终端命令）。
 * 只 import lib/db.js 和 core/groups.js。
 */
import { onDb } from '../lib/db.js';
import { canJoinGroup, PRIVILEGED_GROUPS, WRITE_GROUPS, ROOT_UID, STYRIGX_UID } from './groups.js';

/** Asia/Shanghai 相对 UTC 的偏移（毫秒；中国不实行夏令时） */
export const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

/**
 * useradd -e / usermod -e 的日期 → 失效时刻（UTC 毫秒）：该日 00:00 Asia/Shanghai。不合法的日期 → null。
 * 例：'2026-12-01' → 2026-11-30T16:00:00Z（可用到 11 月 30 日 23:59:59 北京时间）。
 * @param {string} ymd YYYY-MM-DD
 * @returns {number|null}
 */
export function expiryFromDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return utc - SHANGHAI_OFFSET_MS;
}

/**
 * @typedef {{ uid:number, name:string, avatar:string, expiresAt:number, epoch:number, disabled:boolean }} User
 */

/** @param {any} row @returns {User|null} */
function toUser(row) {
  if (!row) return null;
  return { uid: Number(row.uid), name: String(row.name), avatar: String(row.avatar || ''), expiresAt: Number(row.expires_at) || 0,
    epoch: Number(row.epoch) || 0, disabled: Number(row.disabled) === 1 };
}

/**
 * 用户此刻能不能用：没禁用、没到期。
 * @param {User|null} user @param {number} now
 */
export function isUserActive(user, now) {
  return !!user && !user.disabled && (user.expiresAt === 0 || user.expiresAt > now);
}

/** 按 uid 读用户（没有 → null）。出错抛错。 @param {any} env @param {number} uid */
export async function getUser(env, uid) {
  return onDb(env, async (d) => toUser(await d.prepare('SELECT uid, name, avatar, expires_at, epoch, disabled FROM account_users WHERE uid = ?').bind(uid).first()));
}

/** 用户的组（按名字排序）。出错抛错。 @param {any} env @param {number} uid @returns {Promise<string[]>} */
export async function getGroups(env, uid) {
  return onDb(env, async (d) => {
    const r = await d.prepare('SELECT grp FROM account_user_groups WHERE uid = ? ORDER BY grp').bind(uid).all();
    return (r.results || []).map((x) => String(x.grp));
  });
}

/* 「+1 并作废该用户的全部会话」的三条语句（同一个 batch 里用） */
/** @param {any} d @param {number} uid */
function bumpAndRevokeAll(d, uid) {
  return [
    d.prepare('UPDATE account_users SET epoch = epoch + 1 WHERE uid = ?').bind(uid),
    d.prepare('DELETE FROM account_session_stack WHERE uid = ?').bind(uid),
    d.prepare('DELETE FROM account_session_stack WHERE session_id IN (SELECT id FROM account_sessions WHERE uid = ?)').bind(uid),
    d.prepare('DELETE FROM account_sessions WHERE uid = ?').bind(uid),
  ];
}

/** @param {any} d @param {number} uid @returns {Promise<number>} */
async function epochOf(d, uid) {
  const row = await d.prepare('SELECT epoch FROM account_users WHERE uid = ?').bind(uid).first();
  if (!row) throw new Error('user-missing ' + uid);
  return Number(row.epoch);
}

/**
 * 凭据变了（passwd / passkey，自己改或 root 重置）。
 * - opts.sessionId 给了（自己改）：epoch +1；当前会话里这一层（栈底或压着的那层）的快照刷成新 epoch，继续有效；该用户别的会话删掉。
 * - 没给（root 替别人重置、救援重置）：epoch +1，该用户的会话全部作废。
 * 返回新 epoch。用户不存在 → 抛错。
 * @param {any} env @param {number} uid @param {{sessionId?: string}} [opts]
 * @returns {Promise<number>}
 */
export async function credentialsChanged(env, uid, opts) {
  const sid = opts && typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : null;
  return onDb(env, async (d) => {
    await epochOf(d, uid);
    if (!sid) {
      await d.batch(bumpAndRevokeAll(d, uid));
      return epochOf(d, uid);
    }
    const fresh = '(SELECT epoch FROM account_users WHERE uid = ?)';
    await d.batch([
      d.prepare('UPDATE account_users SET epoch = epoch + 1 WHERE uid = ?').bind(uid),
      d.prepare('UPDATE account_sessions SET epoch = ' + fresh + ' WHERE id = ? AND uid = ?').bind(uid, sid, uid),
      d.prepare('UPDATE account_session_stack SET epoch = ' + fresh + ' WHERE session_id = ? AND uid = ?').bind(uid, sid, uid),
      d.prepare('DELETE FROM account_session_stack WHERE uid = ? AND session_id <> ?').bind(uid, sid),
      d.prepare('DELETE FROM account_session_stack WHERE session_id IN (SELECT id FROM account_sessions WHERE uid = ? AND id <> ?)').bind(uid, sid),
      d.prepare('DELETE FROM account_sessions WHERE uid = ? AND id <> ?').bind(uid, sid),
    ]);
    return epochOf(d, uid);
  });
}

/**
 * 加组（useradd -G / usermod -aG）。先过 canJoinGroup（不认识的组、root、普通用户进特权 / 写组都拒绝）；
 * 已在组里 → { ok:true, changed:false }（不动 epoch）；加进去 → epoch +1、该用户会话全部作废。
 * @param {any} env @param {number} uid @param {string} group @param {number} [now]
 * @returns {Promise<{ok:true, changed:boolean}|{ok:false, reason:string}>}
 */
export async function addToGroup(env, uid, group, now) {
  const user = await getUser(env, uid);
  if (!user) return { ok: false, reason: 'no-user' };
  const can = canJoinGroup(user, group);
  if (!can.ok) return can;
  return onDb(env, async (d) => {
    const has = await d.prepare('SELECT 1 AS x FROM account_user_groups WHERE uid = ? AND grp = ?').bind(uid, group).first();
    if (has) return { ok: true, changed: false };
    await d.batch([d.prepare('INSERT INTO account_user_groups (uid, grp, added_at) VALUES (?, ?, ?)').bind(uid, group, now || Date.now())].concat(bumpAndRevokeAll(d, uid)));
    return { ok: true, changed: true };
  });
}

/**
 * 删组（usermod -rG）。不在组里 → { ok:true, changed:false }；删掉 → epoch +1、会话全部作废（收回的权限立刻失效）。
 * @param {any} env @param {number} uid @param {string} group
 * @returns {Promise<{ok:true, changed:boolean}|{ok:false, reason:string}>}
 */
export async function removeFromGroup(env, uid, group) {
  const user = await getUser(env, uid);
  if (!user) return { ok: false, reason: 'no-user' };
  return onDb(env, async (d) => {
    const has = await d.prepare('SELECT 1 AS x FROM account_user_groups WHERE uid = ? AND grp = ?').bind(uid, group).first();
    if (!has) return { ok: true, changed: false };
    await d.batch([d.prepare('DELETE FROM account_user_groups WHERE uid = ? AND grp = ?').bind(uid, group)].concat(bumpAndRevokeAll(d, uid)));
    return { ok: true, changed: true };
  });
}

/**
 * 改期限（usermod -e；0 = 永久）。root 不能有期限；要设期限的用户若还在特权组或写组里 → 拒绝（先删组）。
 * 改了 → epoch +1、会话全部作废。
 * @param {any} env @param {number} uid @param {number} expiresAt UTC 毫秒（expiryFromDate 的结果）或 0
 * @returns {Promise<{ok:true, changed:boolean}|{ok:false, reason:string}>}
 */
export async function setUserExpiry(env, uid, expiresAt) {
  if (!Number.isInteger(expiresAt) || expiresAt < 0) return { ok: false, reason: 'bad-expiry' };
  if (uid === ROOT_UID && expiresAt > 0) return { ok: false, reason: 'root' };
  const user = await getUser(env, uid);
  if (!user) return { ok: false, reason: 'no-user' };
  if (user.expiresAt === expiresAt) return { ok: true, changed: false };
  if (expiresAt > 0) {
    const groups = await getGroups(env, uid);
    if (groups.some((g) => PRIVILEGED_GROUPS.indexOf(g) !== -1 || WRITE_GROUPS.indexOf(g) !== -1)) return { ok: false, reason: 'privileged-groups' };
  }
  return onDb(env, async (d) => {
    await d.batch([d.prepare('UPDATE account_users SET expires_at = ? WHERE uid = ?').bind(expiresAt, uid)].concat(bumpAndRevokeAll(d, uid)));
    return { ok: true, changed: true };
  });
}

/**
 * 删一个用户的全部身份数据（userdel 与到期自动删除共用，core/user-expiry.js）：会话、身份栈、密码、通行密钥、组，一个 batch；
 * 用户行改成墓碑（见下，uid 永不复用）。
 * root（0）与 styrigx（1000）在这里再拦一道（调用方已拦）：拒绝 → false，不删任何东西。
 * @param {any} env @param {number} uid
 * @returns {Promise<boolean>}
 */
export async function deleteUserRows(env, uid) {
  if (!Number.isInteger(uid) || uid === ROOT_UID || uid === STYRIGX_UID) return false;
  await onDb(env, (d) => d.batch([
    d.prepare('DELETE FROM account_session_stack WHERE uid = ?').bind(uid),
    d.prepare('DELETE FROM account_session_stack WHERE session_id IN (SELECT id FROM account_sessions WHERE uid = ?)').bind(uid),
    d.prepare('DELETE FROM account_sessions WHERE uid = ?').bind(uid),
    d.prepare('DELETE FROM account_user_password WHERE uid = ?').bind(uid),
    d.prepare('DELETE FROM account_user_passkey WHERE uid = ?').bind(uid),
    d.prepare('DELETE FROM account_user_groups WHERE uid = ?').bind(uid),
    /* 用户行不删、留墓碑（P2c）：uid 永不复用——头像 / 偏好 / 数字健康按 uid 存，复用 uid 的新用户会继承旧用户的数据。
       墓碑：名字改成 #deleted-<uid>（USER_NAME_RE 不认 #，谁都登不上、查不到），禁用、无期限、epoch +1；名字因此可以再 useradd。 */
    d.prepare("UPDATE account_users SET name = '#deleted-' || uid, avatar = '', expires_at = 0, disabled = 1, epoch = epoch + 1 WHERE uid = ?").bind(uid),
  ]));
  return true;
}
