/**
 * v6 身份统一（P2）：数据表有没有 uid 列（迁移 migrations/0007_v6_uid_columns.sql 跑没跑）。
 *
 * 头像 / 偏好 / 设备按 uid 分（ADR-0006 §2.12 (a)：uid 只取服务端会话）。加 uid 列的迁移要 Gray 批准后才对生产执行，
 * 所以代码两种表结构都要能跑：
 * - 有 uid 列：一律按 uid 读写（旧会话的数据归 styrigx = 1000，同迁移对照）。
 * - 没有 uid 列（迁移前）：表里的数据全是 styrigx 的；只有 styrigx（uid 1000）读写这些行，别的 uid 读到空、写被拒 / 丢弃——
 *   绝不让别的用户读写 styrigx 的数据。
 * 查表结构用 PRAGMA table_info，结果按表缓存在 isolate 里：有 → 永久；没有 → 60 秒后再查一次（迁移跑完最多 60 秒切过去）。
 * 叶子模块：不 import 任何东西。
 */

const RECHECK_MS = 60 * 1000;
/** @type {WeakMap<object, Map<string, {has:boolean, at:number}>>} */
const cache = new WeakMap();

/** 测试用：清缓存 @param {object} [db] */
export function _resetUidSchemaCache(db) {
  if (db) cache.delete(db);
}

/**
 * 这张表有没有 uid 列。读不到表结构 → false（按迁移前处理：只有 styrigx 能碰）。
 * @param {any} db D1 绑定 @param {string} table @param {number} [now]
 * @returns {Promise<boolean>}
 */
export async function hasUidColumn(db, table, now) {
  return hasColumn(db, table, 'uid', now);
}

/**
 * 这张表有没有某一列（v6 P4-3 起 2g 的 account_sessions.device 也用它：设备列迁移部署绿后才执行，代码两种表结构都要能跑）。
 * 读不到表结构 → false。缓存同上：有 → 永久；没有 → 60 秒后再查。
 * @param {any} db D1 绑定 @param {string} table @param {string} column @param {number} [now]
 * @returns {Promise<boolean>}
 */
export async function hasColumn(db, table, column, now) {
  if (!/^[a-z_]+$/.test(table)) throw new Error('uid-schema: bad table ' + table);
  if (!/^[a-z_]+$/.test(column)) throw new Error('uid-schema: bad column ' + column);
  const t = typeof now === 'number' ? now : Date.now();
  let m = cache.get(db);
  if (!m) { m = new Map(); cache.set(db, m); }
  const key = table + '.' + column;
  const hit = m.get(key);
  if (hit && (hit.has || t - hit.at < RECHECK_MS)) return hit.has;
  let has = false;
  try {
    const r = await db.prepare('PRAGMA table_info(' + table + ')').all();
    has = ((r && r.results) || []).some((c) => c && c.name === column);
  } catch (e) {
    has = false;
  }
  m.set(key, { has, at: t });
  return has;
}
