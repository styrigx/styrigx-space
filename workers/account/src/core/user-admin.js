/**
 * v6 身份统一（P2）：用户管理（root，或 sudoers 用户 sudo 借 root 执行）——useradd / userdel / usermod / passwd <名>，以及 groups、who 的读。
 *
 * 护栏（定稿 v4 §八 / §十）：
 * - useradd：名字合法且没人用、不叫 root；uid 从 1001 起递增；-e 日期按 Linux 语义（该日 00:00 Asia/Shanghai 起失效，存 UTC），
 *   必须是将来；-G 每个组先过 canJoinGroup（普通用户（uid 1001 起，含临时用户）进 wheel / sudoers / 写组一律拒绝，整条命令不执行）；
 *   生成一次性密码（只回一次、库里只存哈希），首登强制改，24 小时过期。
 * - userdel：拒删 root、拒删 styrigx（站长，名片属主）；连同会话、身份栈、密码、通行密钥、组一起删（一个 batch，deleteUserRows）。
 * - 到期：到期即禁用、会话作废（admit 判 expires_at）；满宽限期自动删除（core/user-expiry.js，同 deleteUserRows）。useradd 前顺手清一次。
 * - usermod -aG / -rG：加组过 canJoinGroup；减掉最后一个 wheel / sudoers 成员时先回 last-member 警告，调用方带 force 才执行。
 * - passwd <名>：发一次性密码（同 useradd），该用户会话全部作废（epoch +1）。不能对 root 用：root 的凭据只能在
 *   su root 或救援会话里用 passwd 自己改（sudo 夺不走 root，定稿 v4 §十）。
 * 每次凭据 / 组 / 期限变更都 bump epoch（core/users.js）。审计由调用方（api/identity.js）写。
 *
 * 只 import lib/ 和 core/。
 */
import { onDb } from '../lib/db.js';
import { sessionsHaveDevice } from './device-mark.js';
import { ROOT_UID, STYRIGX_UID, FIRST_USER_UID, USER_NAME_RE, GROUPS, PRIVILEGED_GROUPS, canJoinGroup } from './groups.js';
import { expiryFromDate, getUser, getGroups, addToGroup, removeFromGroup, credentialsChanged, deleteUserRows } from './users.js';
import { oneTimePassword, savePasswordFor, ONE_TIME_TTL_MS } from './identity-auth.js';
import { purgeExpiredUsers } from './user-expiry.js';

/** 用户名 → 用户（没有 → null；root 也查得到）。出错抛错。 @param {any} env @param {string} name */
export async function userByName(env, name) {
  if (typeof name !== 'string' || !USER_NAME_RE.test(name)) return null; /* 墓碑（#deleted-<uid>）与任何不合法的名字都查不到 */
  const row = await onDb(env, (d) => d.prepare('SELECT uid FROM account_users WHERE name = ?').bind(String(name)).first());
  return row ? getUser(env, Number(row.uid)) : null;
}

/**
 * useradd。成功 { ok:true, uid, name, password, expiresAt, groups, passwordExpiresAt }（password 只在这里出现一次）。
 * @param {any} env @param {{name:any, expire?:any, groups?:any}} q @param {number} [now]
 * @returns {Promise<{ok:true, uid:number, name:string, password:string, expiresAt:number, groups:string[], passwordExpiresAt:number}|{ok:false, error:string, group?:string}>}
 */
export async function useradd(env, q, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const name = typeof q.name === 'string' ? q.name : '';
  if (!USER_NAME_RE.test(name) || name === 'root') return { ok: false, error: 'name' };
  let expiresAt = 0;
  if (q.expire !== undefined && q.expire !== null && q.expire !== '') {
    const e = expiryFromDate(String(q.expire));
    if (e === null || e <= t) return { ok: false, error: 'expiry' };
    expiresAt = e;
  }
  const list = Array.isArray(q.groups) ? q.groups : (typeof q.groups === 'string' && q.groups ? q.groups.split(',') : []);
  const groups = Array.from(new Set(list.map((g) => String(g).trim()).filter(Boolean)));
  for (const g of groups) {
    const c = canJoinGroup({ uid: FIRST_USER_UID, expiresAt }, g);
    if (!c.ok) return { ok: false, error: c.reason === 'temporary' || c.reason === 'action' ? c.reason : 'group', group: g };
  }
  /* 到期满宽限期的用户顺手删掉（core/user-expiry.js；每日一轮之外的懒清理），同名的过期用户不挡 useradd */
  try { await purgeExpiredUsers(env, t); } catch (e) {}
  if (await userByName(env, name)) return { ok: false, error: 'exists' };
  const password = oneTimePassword();
  const uid = await onDb(env, async (d) => {
    const row = await d.prepare('SELECT MAX(uid) AS m FROM account_users').first();
    const next = Math.max(FIRST_USER_UID, (Number(row && row.m) || 0) + 1);
    await d.batch([d.prepare('INSERT INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (?, ?, \'\', ?, 0, 0, ?)').bind(next, name, expiresAt, t)]
      .concat(groups.map((g) => d.prepare('INSERT INTO account_user_groups (uid, grp, added_at) VALUES (?, ?, ?)').bind(next, g, t))));
    return next;
  });
  await savePasswordFor(env, uid, password, { mustChange: true, now: t });
  return { ok: true, uid, name, password, expiresAt, groups: groups.slice().sort(), passwordExpiresAt: t + ONE_TIME_TTL_MS };
}

/**
 * userdel。拒删 root / styrigx。
 * @param {any} env @param {any} name
 * @returns {Promise<{ok:true, uid:number}|{ok:false, error:string}>}
 */
export async function userdel(env, name) {
  if (typeof name !== 'string' || !name) return { ok: false, error: 'name' };
  const u = await userByName(env, name);
  if (!u) return { ok: false, error: 'no-user' };
  if (u.uid === ROOT_UID) return { ok: false, error: 'protected-root' };
  if (u.uid === STYRIGX_UID) return { ok: false, error: 'protected-owner' };
  await deleteUserRows(env, u.uid);
  return { ok: true, uid: u.uid };
}

/**
 * usermod -aG | -rG <组[,组]> <名>。减掉最后一个 wheel / sudoers 成员 → 先回 { ok:false, error:'last-member', group }，force 才执行。
 * @param {any} env @param {{name:any, op:any, groups:any, force?:any}} q @param {number} [now]
 * @returns {Promise<{ok:true, changed:boolean, warning?:string}|{ok:false, error:string, group?:string}>}
 */
export async function usermod(env, q, now) {
  const op = q.op === '-aG' || q.op === 'add' ? 'add' : q.op === '-rG' || q.op === 'remove' ? 'remove' : '';
  if (!op) return { ok: false, error: 'params' };
  const list = Array.isArray(q.groups) ? q.groups : (typeof q.groups === 'string' ? q.groups.split(',') : []);
  const groups = Array.from(new Set(list.map((g) => String(g).trim()).filter(Boolean)));
  if (!groups.length) return { ok: false, error: 'params' };
  for (const g of groups) if (GROUPS.indexOf(g) === -1) return { ok: false, error: 'group', group: g };
  const u = typeof q.name === 'string' ? await userByName(env, q.name) : null;
  if (!u) return { ok: false, error: 'no-user' };
  if (u.uid === ROOT_UID) return { ok: false, error: 'protected-root' };
  let changed = false;
  let warning = '';
  if (op === 'add') {
    for (const g of groups) {
      const c = canJoinGroup(u, g);
      if (!c.ok) return { ok: false, error: c.reason === 'temporary' || c.reason === 'action' ? c.reason : 'group', group: g };
    }
    for (const g of groups) {
      const r = await addToGroup(env, u.uid, g, now);
      if (!r.ok) return { ok: false, error: r.reason === 'temporary' || r.reason === 'action' ? r.reason : 'group', group: g };
      changed = changed || r.changed;
    }
    return { ok: true, changed };
  }
  for (const g of groups) {
    if (PRIVILEGED_GROUPS.indexOf(g) === -1) continue;
    const row = await onDb(env, (d) => d.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN uid = ? THEN 1 ELSE 0 END) AS me FROM account_user_groups WHERE grp = ?').bind(u.uid, g).first());
    if (Number(row && row.me) === 1 && Number(row && row.n) === 1) {
      if (q.force !== true) return { ok: false, error: 'last-member', group: g };
      warning = 'last-member';
    }
  }
  for (const g of groups) {
    const r = await removeFromGroup(env, u.uid, g);
    if (!r.ok) return { ok: false, error: 'no-user' };
    changed = changed || r.changed;
  }
  return warning ? { ok: true, changed, warning } : { ok: true, changed };
}

/**
 * passwd <名>（root 替别人重置）：发一次性密码，该用户会话全部作废。目标是 root → 拒绝（root-creds）。
 * @param {any} env @param {any} name @param {number} [now]
 * @returns {Promise<{ok:true, uid:number, password:string, passwordExpiresAt:number}|{ok:false, error:string}>}
 */
export async function passwdReset(env, name, now) {
  const t = typeof now === 'number' ? now : Date.now();
  if (typeof name !== 'string' || !name) return { ok: false, error: 'name' };
  const u = await userByName(env, name);
  if (!u) return { ok: false, error: 'no-user' };
  if (u.uid === ROOT_UID) return { ok: false, error: 'root-creds' };
  const password = oneTimePassword();
  await savePasswordFor(env, u.uid, password, { mustChange: true, now: t });
  await credentialsChanged(env, u.uid, {});
  return { ok: true, uid: u.uid, password, passwordExpiresAt: t + ONE_TIME_TTL_MS };
}

/** groups <名> 的读：{ name, groups }；没有 → null @param {any} env @param {string} name */
export async function groupsOf(env, name) {
  const u = await userByName(env, name);
  if (!u) return null;
  return { name: u.name, uid: u.uid, groups: u.uid === ROOT_UID ? ['root'] : await getGroups(env, u.uid) };
}

/**
 * who：会话列表，每行一条身份路径（root via styrigx / styrigx / root (rescue)）。onlyUid 给了 → 只列这个人的会话（非 root 只看自己）。
 * 过期的不列。current = 当前会话 id。
 * withDevice：带上会话 id 与设备标记（不可枚举属性 _id / _device，只给 deviceList 归并用，不出接口）。
 * @param {any} env @param {{onlyUid?:number|null, current?:string, now?:number, withDevice?:boolean}} q
 * @returns {Promise<Array<{n:number, path:string, user:string, since:number, expiresAt:number, current:boolean}>>}
 */
export async function whoList(env, q) {
  const t = typeof q.now === 'number' ? q.now : Date.now();
  const only = Number.isInteger(q.onlyUid) ? q.onlyUid : null;
  const rows = await onDb(env, async (d) => {
    const dev = q.withDevice === true && (await sessionsHaveDevice(d));
    const sql = 'SELECT s.id, s.uid, s.rescue, s.created_at, s.expires_at, u.name, k.expires_at AS k_exp' + (dev ? ', s.device' : '') +
      ' FROM account_sessions s JOIN account_users u ON u.uid = s.uid LEFT JOIN account_session_stack k ON k.session_id = s.id AND k.depth = 1' +
      ' WHERE s.expires_at > ?' + (only === null ? '' : ' AND s.uid = ?') + ' ORDER BY s.created_at';
    const st = only === null ? d.prepare(sql).bind(t) : d.prepare(sql).bind(t, only);
    return ((await st.all()).results) || [];
  });
  return rows.map((r, i) => {
    const rootOn = r.k_exp !== null && r.k_exp !== undefined && Number(r.k_exp) > t;
    const path = Number(r.rescue) === 1 ? 'root (rescue)' : rootOn ? 'root via ' + r.name : String(r.name);
    /** @type {any} */
    const v = { n: i + 1, path, user: String(r.name), since: Number(r.created_at), expiresAt: Number(r.expires_at), current: !!q.current && r.id === q.current };
    if (q.withDevice === true) Object.defineProperties(v, { _id: { value: String(r.id) }, _device: { value: r.device ? String(r.device) : '' } });
    return v;
  });
}

/**
 * 设备列表（定稿 v5.5 §五「列表为全站视图、列出全站会话」；§十一 2g「设备列表按 sgx-device 合并同一台设备的会话」）：
 * 全站会话按设备标记（account_sessions.device）归成一台台设备；没有设备标记的会话（2g 之前签的老会话、迁移前）各算一台。
 * 每台：{ n, path（这台上各会话的身份路径，按开始时间，逗号分隔）, since（最早开始）, expiresAt（最晚到期）, current（含本会话） }。
 * 设备标记本身不出接口（只用来归并）。另回 ids：第 n 台的会话 id（踢出用，不出接口）。
 * @param {any} env @param {{current?: string, now?: number}} q
 * @returns {Promise<{devices: Array<{n:number, path:string, since:number, expiresAt:number, current:boolean}>, ids: string[][]}>}
 */
export async function deviceList(env, q) {
  const list = await whoList(env, { onlyUid: null, current: q.current || '', now: q.now, withDevice: true });
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  list.forEach((/** @type {any} */ s) => {
    const k = s._device ? 'd:' + s._device : 's:' + s._id;
    const g = groups.get(k);
    if (g) g.push(s); else groups.set(k, [s]);
  });
  const devices = [];
  const ids = [];
  let n = 0;
  for (const g of groups.values()) {
    n++;
    devices.push({
      n, path: g.map((s) => s.path).join(', '), since: Math.min(...g.map((s) => s.since)), expiresAt: Math.max(...g.map((s) => s.expiresAt)),
      current: g.some((s) => s.current),
    });
    ids.push(g.map((s) => s._id));
  }
  return { devices, ids };
}
