/**
 * 账号库 D1 的访问层（命名 v2）：一个绑定 D1_ACCOUNT（库 styrigx-account），账号的表全部叫 account_*，没有 realm 列。
 *
 * 读主库（安全读的硬性要求）：不开 D1 read replication，也不用 D1 session API。设备吊销、challenge、输错计数
 * 这些安全读只走绑定本身（= 主库）；内存和 KV 都不缓存，任何吊销判断都以这一次请求读到的 D1 为准。
 *
 * 表全部由 migrations/ 建（账号部署 job 先 d1 migrations apply 再部署；Worker 不自己建表）：
 * - account_epoch(name, value)：旧账号会话的纪元表（v6 P4 起没有代码读写；生产库由 docs/ops/v6-p4-drop-account-epoch.sql drop）
 * - account_password(id=1, record)、account_passkey(credential_id, record)、account_user_handle(id=1, handle, legacy_handle)
 * - account_challenge(id, purpose, challenge, expires_at)、account_attempt_limit(kind, bucket, …)
 * - account_device(device_id, …)、account_audit(id, ts, ip_prefix, ok, event, expires_at)
 * - v6 身份表（migrations/0006_identity.sql）：account_users / user_groups / user_password / user_passkey / sessions /
 *   session_stack / user_audit / recovery_key
 * 同一个库里的 settings_sync（api/prefs.js）也经 D1_ACCOUNT，表由 0002 建（数字健康 wb_daily v6 P4 删，drop 见 docs/ops/v6-p4-drop-wellbeing.sql）。
 *
 * 出错一律抛（D1 未绑定、查询失败、表不存在）；调用方按 fail closed 处理（签发 503、验票无效）。
 *
 * 叶子模块：不 import 任何东西。
 */

/** 账号库的 D1 绑定名（wrangler.toml；正式 styrigx-account，预览 styrigx-test-preview） */
export const DB_BINDING = 'D1_ACCOUNT';

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
 * 在账号库上跑一次操作。
 * @template T @param {any} env @param {(d:any) => Promise<T>} fn @returns {Promise<T>}
 */
export function onDb(env, fn) {
  const d = db(env);
  return (async () => fn(d))();
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
