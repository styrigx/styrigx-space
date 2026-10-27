/**
 * 输错计数的 D1 读写（D1 attempt_limit 表，2026-10-27 从 KV 搬来）：锁屏 / 账号密码（password-limit.js）、
 * 临时码（lock-tempkey.js）、根凭证（root-limit.js）共用。
 *
 * 行：(realm, kind, bucket)。realm = 'lock' | 'account' | 'root'；kind = 'password' | 'tempkey' | 'rootkey'；
 * bucket = IP 分桶（http.js ipBucket），全局窗口那一行 bucket = GLOBAL_BUCKET（'*'）。
 *
 * 每次记失败都是一条原子 UPSERT（INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 ... RETURNING）：
 * 并发的两次输错不会互相覆盖（以前 KV 读-改-写，并发时只记上一次）。过期（expires_at <= now）的行在更新时按新行算，
 * 读时一律不认；记失败后顺手清掉本域过期行。SQLite 的 UPDATE SET 里每个表达式都按更新前的值算，所以同一条语句里
 * 「先判过期、再加一、到阈值清零并锁定」是一个原子步骤。
 *
 * 读写都走主库（d1-state.js authDb，不开 session、不缓存）。出错抛错，调用方 fail closed（503）。
 */
import { onAuthDb, sweepExpired } from './d1-state.js';

export const GLOBAL_BUCKET = '*';

/**
 * 单 IP 的当前记录（过期的不认 → null）。
 * @param {any} env @param {string} realm @param {string} kind @param {string} bucket
 * @returns {Promise<{count:number, strikes:number, lockedUntil:number}|null>}
 */
export async function readAttempt(env, realm, kind, bucket) {
  const now = Date.now();
  const row = await onAuthDb(env, realm, (db, r) => db.prepare(
    'SELECT count, strikes, locked_until FROM attempt_limit WHERE realm = ? AND kind = ? AND bucket = ? AND expires_at > ?'
  ).bind(r.id, kind, bucket, now).first());
  if (!row) return null;
  return { count: Number(row.count) || 0, strikes: Number(row.strikes) || 0, lockedUntil: Number(row.locked_until) || 0 };
}

/**
 * 全局窗口当前是否「热」（窗口内失败次数 ≥ slowAt）。
 * @param {any} env @param {string} realm @param {string} kind @param {number} windowMs @param {number} slowAt
 */
export async function globalHot(env, realm, kind, windowMs, slowAt) {
  const now = Date.now();
  const row = await onAuthDb(env, realm, (db, r) => db.prepare(
    'SELECT count, window_start FROM attempt_limit WHERE realm = ? AND kind = ? AND bucket = ?'
  ).bind(r.id, kind, GLOBAL_BUCKET).first());
  return !!(row && Number(row.window_start) + windowMs >= now && (Number(row.count) || 0) >= slowAt);
}

/**
 * 记一次单 IP 失败（原子）。本轮连错到 max 次：count 清零、锁到 now + 锁定时长（strikes 模式下 strikes +1，
 * 锁定时长按新的 strikes 查 lockTable，超出表长取最后一项）。整行 expires_at = now + ttlMs（每次失败都续）。
 * @param {any} env @param {string} realm @param {string} kind @param {string} bucket
 * @param {{max:number, ttlMs:number, lockMs?:number, lockTable?:number[]}} o lockMs：固定锁定时长；lockTable：按轮次递增（第 i 项 = 第 i+1 轮）
 * @returns {Promise<boolean>} 这次是否刚进入锁定 / 冷却
 */
export async function recordAttempt(env, realm, kind, bucket, o) {
  const now = Date.now();
  const expired = '(attempt_limit.expires_at <= ?4)';
  const c0 = '(CASE WHEN ' + expired + ' THEN 0 ELSE attempt_limit.count END)';
  const s0 = '(CASE WHEN ' + expired + ' THEN 0 ELSE attempt_limit.strikes END)';
  const l0 = '(CASE WHEN ' + expired + ' THEN 0 ELSE attempt_limit.locked_until END)';
  const hit = '(' + c0 + ' + 1 >= ?5)';
  let lockExpr = '?7';
  let strikesExpr = s0;
  if (o.lockTable && o.lockTable.length) {
    const t = o.lockTable.map((v) => Math.floor(Number(v)) || 0);
    lockExpr = '(CASE ' + s0 + ' + 1 ' + t.slice(0, -1).map((v, i) => 'WHEN ' + (i + 1) + ' THEN ' + v).join(' ') + ' ELSE ' + t[t.length - 1] + ' END)';
    strikesExpr = '(CASE WHEN ' + hit + ' THEN ' + s0 + ' + 1 ELSE ' + s0 + ' END)';
  }
  const sql =
    'INSERT INTO attempt_limit (realm, kind, bucket, count, strikes, locked_until, window_start, expires_at) VALUES (?1, ?2, ?3, 1, 0, 0, ?4, ?4 + ?6) ' +
    'ON CONFLICT (realm, kind, bucket) DO UPDATE SET ' +
    'count = CASE WHEN ' + hit + ' THEN 0 ELSE ' + c0 + ' + 1 END, ' +
    'strikes = ' + strikesExpr + ', ' +
    'locked_until = CASE WHEN ' + hit + ' THEN ?4 + ' + lockExpr + ' ELSE ' + l0 + ' END, ' +
    'expires_at = ?4 + ?6 ' +
    'RETURNING count, locked_until';
  const row = await onAuthDb(env, realm, async (db, r) => {
    const params = [r.id, kind, bucket, now, o.max, o.ttlMs];
    if (lockExpr === '?7') params.push(o.lockMs || 0); /* 按轮次查表时语句里没有 ?7，不能多绑 */
    const res = await db.prepare(sql).bind(...params).first();
    await sweepExpired(db, 'attempt_limit', r.id, now);
    return res;
  });
  return !!(row && Number(row.count) === 0 && Number(row.locked_until) > now);
}

/**
 * 全局窗口 +1（原子；窗口已过 → 从 1 重新开始）。
 * @param {any} env @param {string} realm @param {string} kind @param {number} windowMs
 */
export async function recordGlobal(env, realm, kind, windowMs) {
  const now = Date.now();
  const stale = '(attempt_limit.window_start + ?4 < ?3)';
  await onAuthDb(env, realm, (db, r) => db.prepare(
    'INSERT INTO attempt_limit (realm, kind, bucket, count, window_start, expires_at) VALUES (?1, ?2, \'' + GLOBAL_BUCKET + '\', 1, ?3, ?3 + ?4) ' +
    'ON CONFLICT (realm, kind, bucket) DO UPDATE SET ' +
    'count = CASE WHEN ' + stale + ' THEN 1 ELSE attempt_limit.count + 1 END, ' +
    'window_start = CASE WHEN ' + stale + ' THEN ?3 ELSE attempt_limit.window_start END, ' +
    'expires_at = (CASE WHEN ' + stale + ' THEN ?3 ELSE attempt_limit.window_start END) + ?4'
  ).bind(r.id, kind, now, windowMs).run());
}

/**
 * 清掉单 IP 的记录（验对后）。出错抛错（调用方自己决定吞不吞）。
 * @param {any} env @param {string} realm @param {string} kind @param {string} bucket
 */
export async function clearAttempt(env, realm, kind, bucket) {
  await onAuthDb(env, realm, (db, r) => db.prepare('DELETE FROM attempt_limit WHERE realm = ? AND kind = ? AND bucket = ?').bind(r.id, kind, bucket).run());
}

/**
 * 清掉某域某类的全部单 IP 记录（不动全局窗口）：删锁屏密码时清 IP 限速残留。
 * @param {any} env @param {string} realm @param {string} kind
 */
export async function clearAllAttempts(env, realm, kind) {
  await onAuthDb(env, realm, (db, r) => db.prepare('DELETE FROM attempt_limit WHERE realm = ? AND kind = ? AND bucket <> ?').bind(r.id, kind, GLOBAL_BUCKET).run());
}
