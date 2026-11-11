/**
 * 账号库 D1 的访问层（命名 v2）：一个绑定 D1_ACCOUNT（库 styrigx-account），账号的表全部叫 account_*，没有 realm 列。
 *
 * 读主库（安全读的硬性要求）：不开 D1 read replication，也不用 D1 session API。纪元、设备吊销、challenge、输错计数
 * 这些安全读只走绑定本身（= 主库）；内存和 KV 都不缓存，任何吊销判断都以这一次请求读到的 D1 为准。
 *
 * 表（ACCOUNT_SCHEMA = migrations/0005_account_tables.sql 建的那几张，tests/workers/account 核对两边一致）：
 * - account_epoch(name, value)：纪元，两行 session（管 session 和 reauth 票）/ reset（只管 reset 票）
 * - account_password(id=1, record)、account_passkey(credential_id, record)、account_user_handle(id=1, handle, legacy_handle)
 * - account_challenge(id, purpose, challenge, expires_at)、account_attempt_limit(kind, bucket, …)
 * - account_device(device_id, …)、account_audit(id, ts, ip_prefix, ok, event, expires_at)
 * - account_grant 不在兜底里（应用授权删除，定稿 v5.4 §十一 / §十二：部署绿后由 docs/ops/v6-p4-drop-account-grant.sql drop，不得被兜底建回）
 * - v6 身份表（IDENTITY_SCHEMA = migrations/0006_identity.sql）：account_users / user_groups / user_password / user_passkey / sessions /
 *   session_stack / user_audit / recovery_key
 * 同一个库里的 settings_sync（api/prefs.js）、wb_daily（api/wellbeing.js）也经 D1_ACCOUNT，表由 0001 / 0002 建。
 *
 * 出错一律抛（D1 未绑定、查询失败）；调用方按 fail closed 处理（签发 503、验票无效）。
 * 表不存在（迁移没跑的库）：按 ACCOUNT_SCHEMA 建表后整次操作重试一次。
 *
 * 叶子模块：不 import 任何东西。
 */

/** 账号库的 D1 绑定名（wrangler.toml；正式 styrigx-account，预览 styrigx-test-preview） */
export const DB_BINDING = 'D1_ACCOUNT';

/**
 * 与 migrations/0005_account_tables.sql 相同的表结构（兜底建表用；全部 IF NOT EXISTS），去掉已删的 account_grant。
 * 0005 自己用的是不带 IF NOT EXISTS 的同样语句（外加搬数据），tests/workers/account 逐条核对列。
 */
export const ACCOUNT_SCHEMA = Object.freeze([
  'CREATE TABLE IF NOT EXISTS account_epoch (name TEXT PRIMARY KEY, value INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS account_password (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS account_passkey (credential_id TEXT PRIMARY KEY, record TEXT NOT NULL)',
  "CREATE TABLE IF NOT EXISTS account_user_handle (id INTEGER PRIMARY KEY CHECK (id = 1), handle TEXT NOT NULL, legacy_handle TEXT NOT NULL DEFAULT '')",
  'CREATE TABLE IF NOT EXISTS account_challenge (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS account_attempt_limit (kind TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (kind, bucket))',
  'CREATE TABLE IF NOT EXISTS account_device (device_id TEXT PRIMARY KEY, record TEXT NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS account_audit (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, ip_prefix TEXT NOT NULL, ok INTEGER NOT NULL, event TEXT NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS account_audit_ts ON account_audit (ts)',
]);

/**
 * v6 身份表（migrations/0006_identity.sql 原样，tests/workers/account/identity-schema.test.mjs 核对两边逐条一致）：
 * account_users、account_user_groups、account_user_password、account_user_passkey、account_sessions、account_session_stack、
 * account_user_audit、account_recovery_key。P1 只建表；读写在 core/users.js、core/identity-session.js、core/user-audit.js。
 */
export const IDENTITY_SCHEMA = Object.freeze([
  "CREATE TABLE IF NOT EXISTS account_users (uid INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, avatar TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)",
  'CREATE TABLE IF NOT EXISTS account_user_groups (uid INTEGER NOT NULL, grp TEXT NOT NULL, added_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, grp))',
  "CREATE TABLE IF NOT EXISTS account_user_password (uid INTEGER PRIMARY KEY, record TEXT NOT NULL, pepper_id TEXT NOT NULL DEFAULT 'account', must_change INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS account_user_passkey (credential_id TEXT PRIMARY KEY, uid INTEGER NOT NULL, user_handle TEXT NOT NULL, legacy_handle TEXT NOT NULL DEFAULT '', record TEXT NOT NULL)",
  'CREATE INDEX IF NOT EXISTS account_user_passkey_uid ON account_user_passkey (uid)',
  'CREATE TABLE IF NOT EXISTS account_sessions (id TEXT PRIMARY KEY, uid INTEGER NOT NULL, epoch INTEGER NOT NULL, rescue INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS account_sessions_uid ON account_sessions (uid)',
  'CREATE TABLE IF NOT EXISTS account_session_stack (session_id TEXT NOT NULL, depth INTEGER NOT NULL CHECK (depth = 1), uid INTEGER NOT NULL, epoch INTEGER NOT NULL, pushed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (session_id, depth))',
  'CREATE TABLE IF NOT EXISTS account_user_audit (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, uid INTEGER, command TEXT NOT NULL, ok INTEGER NOT NULL, ip_prefix TEXT NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS account_user_audit_ts ON account_user_audit (ts)',
  'CREATE TABLE IF NOT EXISTS account_recovery_key (id TEXT PRIMARY KEY, record TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER NOT NULL DEFAULT 0)',
  'CREATE UNIQUE INDEX IF NOT EXISTS account_recovery_key_active ON account_recovery_key (used_at) WHERE used_at = 0',
]);

/** 账号库是否绑好（缺 → 调用方 500 config） @param {any} env */
export function dbReady(env) {
  return !!(env && env[DB_BINDING]);
}

/**
 * 账号库的 D1 绑定（主库；不开 session）。没绑 → 抛错。
 * @param {any} env
 */
export function db(env) {
  const d = env && env[DB_BINDING];
  if (!d) throw new Error('d1-missing ' + DB_BINDING);
  return d;
}

/**
 * 跑一次操作；遇到「no such table」就按 ACCOUNT_SCHEMA + IDENTITY_SCHEMA 建表再整次重试一次（建表前没有任何写入成功，可以安全重试）。
 * @template T @param {any} d @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function withSchema(d, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!/no such table/i.test(String((e && e.message) || e))) throw e;
    for (const sql of ACCOUNT_SCHEMA.concat(IDENTITY_SCHEMA)) await d.prepare(sql).run();
    return await fn();
  }
}

/**
 * 在账号库上跑一次操作（db + withSchema）。
 * @template T @param {any} env @param {(d:any) => Promise<T>} fn @returns {Promise<T>}
 */
export function onDb(env, fn) {
  const d = db(env);
  return withSchema(d, () => fn(d));
}

/** 带 expires_at、可以顺手清过期行的表 */
const SWEEPABLE = /^account_(challenge|attempt_limit|device|audit|sessions|user_audit)$/;

/**
 * 顺手清掉某表已过期的行（尽力而为，出错吞掉；读路径本来就不认过期行）。
 * @param {any} d @param {string} table @param {number} [now]
 */
export async function sweepExpired(d, table, now) {
  if (!SWEEPABLE.test(table)) throw new Error('sweep: bad table ' + table);
  try {
    await d.prepare('DELETE FROM ' + table + ' WHERE expires_at <= ?').bind(now || Date.now()).run();
  } catch (e) {}
}

/** @param {any} row */
export function parseRecord(row) {
  if (!row || typeof row.record !== 'string') return null;
  try { return JSON.parse(row.record); } catch (e) { return null; }
}

/* ---------------- 纪元（account_epoch） ---------------- */

/** @param {string} name */
function epochName(name) {
  if (name !== 'session' && name !== 'reset') throw new Error('epoch: bad name ' + JSON.stringify(name));
  return name;
}

/**
 * 读某个纪元（每次都读 D1 主库，不缓存）。还没有这一行 → 写入 0。出错抛错。
 * @param {any} env @param {'session'|'reset'} name
 * @returns {Promise<number>}
 */
export async function readEpoch(env, name) {
  const n = epochName(name);
  return onDb(env, async (d) => {
    const sel = () => d.prepare('SELECT value FROM account_epoch WHERE name = ?').bind(n).first();
    let row = await sel();
    if (!row) {
      await d.prepare('INSERT OR IGNORE INTO account_epoch (name, value) VALUES (?, 0)').bind(n).run();
      row = await sel();
    }
    if (!row) throw new Error('epoch-missing ' + n);
    return Number(row.value);
  });
}

/**
 * 某个纪元 +1（原子：UPDATE ... SET value = value + 1 RETURNING value）。出错抛错（调用方 503，绝不继续）。
 * @param {any} env @param {'session'|'reset'} name
 * @returns {Promise<number>} 新纪元
 */
export async function bumpEpoch(env, name) {
  const n = epochName(name);
  return onDb(env, async (d) => {
    const up = () => d.prepare('UPDATE account_epoch SET value = value + 1 WHERE name = ? RETURNING value').bind(n).first();
    let row = await up();
    if (!row) {
      await d.prepare('INSERT OR IGNORE INTO account_epoch (name, value) VALUES (?, 0)').bind(n).run();
      row = await up();
    }
    if (!row) throw new Error('epoch-missing ' + n);
    return Number(row.value);
  });
}
