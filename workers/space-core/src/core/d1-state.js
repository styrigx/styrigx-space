/**
 * 网关的 D1 状态原语（2026-10-27 从 KV 全部搬来；网关不再绑定 KV）。
 * 通用原语（authDb / onAuthDb / withSchema / sweepExpired / parseRecord / SCHEMA）：按域描述对象（至少有 id、d1Binding）工作，
 * 只按形状校验（realmShape；字符串只认锁屏域的 id 'lock'）。AI 全站总闸（ai-limit.js）、审计（space-audit.js）经这里访问自己的表。
 *
 * v6 P4（定稿 v5.2 §十三）起进站签发删除：纪元、锁屏通行密钥、解锁密码、user handle、challenge、设备的读写都删了，
 * 运行时只剩 attempt_limit（AI 全站总闸）与 audit 有读写。旧进站 8 张表的建表语句也删了（定稿 v5.4 §十一，Gray 11-11 19:52、20:11），
 * 生产库里的表由 docs/ops/v6-p4-drop-space-legacy.sql 在部署绿后 drop。
 *
 * 读主库（安全读的硬性要求）：网关不开 D1 read replication，也不用 D1 session API。
 * （tests/workers/space-core/d1-state.test.mjs 扫网关源码核对：任何地方出现 session API 调用就失败。）
 *
 * 出错一律抛（D1 未绑定、查询失败）；调用方按 fail closed 处理。
 * 表不存在（正式网关的部署 job 不跑迁移）：建表后整次操作重试一次。
 */
import { REALM_LOCK } from './realms.js';


/**
 * 运行时还在读写的两张表（attempt_limit、audit）的建表语句，与 migrations/0001_baseline.sql 里这两张逐条一致（d1-state.test.mjs 核对）。
 * 旧进站 8 张表（epoch、passkey、password、user_handle、challenge、device、kv_migration、lock_reset_switch）的语句删了：
 * 否则兜底建表会在 drop 后把空表建回来（定稿 v5.4 §十一）。
 * 全部 IF NOT EXISTS：代码兜底建表和迁移重复跑都不出错。
 */
export const SCHEMA = Object.freeze([
  'CREATE TABLE IF NOT EXISTS attempt_limit (realm TEXT NOT NULL, kind TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, kind, bucket))',
  'CREATE TABLE IF NOT EXISTS audit (realm TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, ip_prefix TEXT NOT NULL, ok INTEGER NOT NULL, decoy INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL DEFAULT \'\', path TEXT NOT NULL DEFAULT \'\', expires_at INTEGER NOT NULL, PRIMARY KEY (realm, id))',
  'CREATE INDEX IF NOT EXISTS audit_ts ON audit (realm, ts)',
]);

/**
 * 域描述对象（至少有非空的 id、d1Binding）。只按形状校验，不认识具体的域：具体有哪些域由调用方决定。不像域描述的一律抛错。
 * @param {any} realm
 * @returns {{id:string, d1Binding:string}}
 */
function realmShape(realm) {
  if (realm && typeof realm === 'object' && typeof realm.id === 'string' && realm.id &&
    typeof realm.d1Binding === 'string' && realm.d1Binding) return realm;
  throw new Error('d1-state: bad realm ' + JSON.stringify(realm && realm.id ? realm.id : realm));
}

/**
 * 网关认识的域：只有锁屏域 REALM_LOCK（也认它的 id 'lock'）；别的域描述一律抛错（账号拆分 PR3）。
 * @param {any} realm
 */
export function realmOf(realm) {
  if (realm === REALM_LOCK || realm === REALM_LOCK.id) return REALM_LOCK;
  throw new Error('d1-state: bad realm ' + JSON.stringify(realm && realm.id ? realm.id : realm));
}

/**
 * 某域的 D1 绑定（主库；不开 session，见文件头）。没绑 → 抛错。
 * @param {any} env @param {any} realm
 */
export function authDb(env, realm) {
  const r = realmShape(realm === REALM_LOCK.id ? REALM_LOCK : realm);
  const db = env && env[r.d1Binding];
  if (!db) throw new Error('d1-missing ' + r.d1Binding);
  return db;
}

/**
 * 跑一次操作；遇到「no such table / no such index」就建表再整次重试一次（建表前没有任何写入成功，可以安全重试）。
 * @template T @param {any} db @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function withSchema(db, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!/no such table/i.test(String((e && e.message) || e))) throw e;
    for (const sql of SCHEMA) await db.prepare(sql).run();
    return await fn();
  }
}

/**
 * 某域 D1 上跑一次操作（authDb + withSchema）。
 * 兜底建表用本文件的 SCHEMA。
 * @template T @param {any} env @param {any} realm @param {(db:any, r:any) => Promise<T>} fn @returns {Promise<T>}
 */
export function onAuthDb(env, realm, fn) {
  const r = realmShape(realm === REALM_LOCK.id ? REALM_LOCK : realm);
  const db = authDb(env, r);
  return withSchema(db, () => fn(db, r));
}

/**
 * 顺手清掉某表某域已过期的行（尽力而为，出错吞掉；读路径本来就不认过期行）。
 * @param {any} db @param {'attempt_limit'|'audit'} table @param {string} realmId @param {number} [now]
 */
export async function sweepExpired(db, table, realmId, now) {
  if (!/^(attempt_limit|audit)$/.test(table)) throw new Error('sweep: bad table ' + table);
  try {
    await db.prepare('DELETE FROM ' + table + ' WHERE realm = ? AND expires_at <= ?').bind(realmId, now || Date.now()).run();
  } catch (e) {}
}

/** @param {any} row */
export function parseRecord(row) {
  if (!row || typeof row.record !== 'string') return null;
  try { return JSON.parse(row.record); } catch (e) { return null; }
}
