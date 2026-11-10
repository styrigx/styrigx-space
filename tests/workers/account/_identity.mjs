/**
 * v6 身份（P1）单测的公共测试台：账号库替身上种用户 / 组 / 会话 / 身份栈（P1 没有签发入口，会话行直接写库）。
 *
 * - identityEnv()：{ D1_ACCOUNT }（跑过全部迁移，含 0006）
 * - seedUser(env, { uid, name, epoch?, expiresAt?, disabled?, groups? })
 * - seedSession(env, { token?, uid, epoch?, rescue?, createdAt?, expiresAt?, renewedAt? }) → { token, id }
 * - pushRoot(env, sessionId, { epoch?, expiresAt? })
 * - token()：一个合法的会话令牌（43 位 base64url）
 */
import { makeAccountD1 } from './_d1.mjs';

const SRC = '../../../workers/account/src/';
export const groups = await import(SRC + 'core/groups.js');
export const idSession = await import(SRC + 'core/identity-session.js');
export const users = await import(SRC + 'core/users.js');
export const routeAccess = await import(SRC + 'core/route-access.js');
export const admit = await import(SRC + 'core/admit.js');
export const userAudit = await import(SRC + 'core/user-audit.js');

export const DAY = 86400 * 1000;
export const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

export function identityEnv() {
  return { D1_ACCOUNT: makeAccountD1() };
}

let n = 0;
/** 合法令牌：43 位 base64url，每次不同 */
export function token() {
  n += 1;
  return ('tok' + String(n).padStart(8, '0') + 'A'.repeat(43)).slice(0, 43);
}

/** @param {any} env @param {{uid:number, name:string, epoch?:number, expiresAt?:number, disabled?:boolean, groups?:string[]}} u */
export function seedUser(env, u) {
  const raw = env.D1_ACCOUNT.raw;
  raw.prepare('INSERT INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(u.uid, u.name, '', u.expiresAt || 0, u.epoch || 0, u.disabled ? 1 : 0, 1);
  for (const g of u.groups || []) raw.prepare('INSERT INTO account_user_groups (uid, grp, added_at) VALUES (?, ?, 1)').run(u.uid, g);
}

/**
 * @param {any} env
 * @param {{token?:string, uid:number, epoch?:number, rescue?:boolean, createdAt?:number, expiresAt?:number, renewedAt?:number}} s
 */
export async function seedSession(env, s) {
  const t = s.token || token();
  const id = await idSession.sessionIdOf(t);
  env.D1_ACCOUNT.raw.prepare('INSERT INTO account_sessions (id, uid, epoch, rescue, created_at, expires_at, renewed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, s.uid, s.epoch || 0, s.rescue ? 1 : 0, s.createdAt === undefined ? NOW - DAY : s.createdAt,
      s.expiresAt === undefined ? NOW + 29 * DAY : s.expiresAt, s.renewedAt || 0);
  return { token: t, id };
}

/** @param {any} env @param {string} sessionId @param {{epoch?:number, expiresAt?:number, uid?:number}} [o] */
export function pushRoot(env, sessionId, o = {}) {
  env.D1_ACCOUNT.raw.prepare('INSERT INTO account_session_stack (session_id, depth, uid, epoch, pushed_at, expires_at) VALUES (?, 1, ?, ?, ?, ?)')
    .run(sessionId, o.uid === undefined ? 0 : o.uid, o.epoch || 0, NOW - 60000, o.expiresAt === undefined ? NOW + 3000000 : o.expiresAt);
}

/** root + styrigx（默认组），epoch 都是 0 @param {any} env */
export function seedBase(env) {
  seedUser(env, { uid: 0, name: 'root' });
  seedUser(env, { uid: 1000, name: 'styrigx', groups: [...groups.STYRIGX_DEFAULT_GROUPS] });
}

/** @param {any} env @param {string} sql @param {...any} p */
export const all = (env, sql, ...p) => env.D1_ACCOUNT.raw.prepare(sql).all(...p).map((r) => ({ ...r }));

/** @param {string} t @returns {Request} */
export const reqWithToken = (t) => new Request('https://internal.invalid/', { headers: t ? { Cookie: 'other=1; sgx-session=' + t } : {} });
