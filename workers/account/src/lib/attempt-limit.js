/**
 * 输错计数的 D1 读写（账号库 account_attempt_limit 表）：v6 身份（core/identity-auth.js）、救援（core/rescue.js）共用（旧账号密码限速 password-limit.js 与全局窗口随旧账号会话删除，v6 清理 #11/#12）。
 *
 * 行：(kind, bucket)。kind = 'password' | 'recovery-key'（限速按钥匙算，不按入口算：session 和 reauth 输错的是同一把密码，共用一个计数）；
 * bucket = IP 分桶（http.js ipBucket）或调用方给的键。
 *
 * 每次记失败都是一条原子 UPSERT（INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 ... RETURNING）：
 * 并发的两次输错不会互相覆盖（以前 KV 读-改-写，并发时只记上一次）。过期（expires_at <= now）的行在更新时按新行算，
 * 读时一律不认；记失败后顺手清掉本域过期行。SQLite 的 UPDATE SET 里每个表达式都按更新前的值算，所以同一条语句里
 * 「先判过期、再加一、到阈值清零并锁定」是一个原子步骤。
 *
 * 读写都走主库（db.js，不开 session、不缓存）。出错抛错，调用方 fail closed（503）。
 */
import { onDb, sweepExpired } from './db.js';

/**
 * 单 IP 的当前记录（过期的不认 → null）。
 * @param {any} env @param {string} kind @param {string} bucket
 * @returns {Promise<{count:number, strikes:number, lockedUntil:number}|null>}
 */
export async function readAttempt(env, kind, bucket) {
  const now = Date.now();
  const row = await onDb(env, (d) => d.prepare(
    'SELECT count, strikes, locked_until FROM account_attempt_limit WHERE kind = ? AND bucket = ? AND expires_at > ?'
  ).bind(kind, bucket, now).first());
  if (!row) return null;
  return { count: Number(row.count) || 0, strikes: Number(row.strikes) || 0, lockedUntil: Number(row.locked_until) || 0 };
}

/**
 * 记一次单 IP 失败（原子）。本轮连错到 max 次：count 清零、锁到 now + 锁定时长（strikes 模式下 strikes +1，
 * 锁定时长按新的 strikes 查 lockTable，超出表长取最后一项）。整行 expires_at = now + ttlMs（每次失败都续）。
 * @param {any} env @param {string} kind @param {string} bucket
 * 新行（第一次失败）原来只记数；o.lockFromFirst = true 时新行同样按 max 判（max 1 → 第一次失败就按第 1 轮锁，救援入口用，定稿 §十「1s→5s→30s→5min」）。
 * @param {{max:number, ttlMs:number, lockMs?:number, lockTable?:number[], lockFromFirst?:boolean}} o lockMs：固定锁定时长；lockTable：按轮次递增（第 i 项 = 第 i+1 轮）
 * @returns {Promise<boolean>} 这次是否刚进入锁定 / 冷却
 */
export async function recordAttempt(env, kind, bucket, o) {
  const now = Date.now();
  const expired = '(account_attempt_limit.expires_at <= ?3)';
  const c0 = '(CASE WHEN ' + expired + ' THEN 0 ELSE account_attempt_limit.count END)';
  const s0 = '(CASE WHEN ' + expired + ' THEN 0 ELSE account_attempt_limit.strikes END)';
  const l0 = '(CASE WHEN ' + expired + ' THEN 0 ELSE account_attempt_limit.locked_until END)';
  const hit = '(' + c0 + ' + 1 >= ?4)';
  let lockExpr = '?6';
  let strikesExpr = s0;
  if (o.lockTable && o.lockTable.length) {
    const t = o.lockTable.map((v) => Math.floor(Number(v)) || 0);
    lockExpr = '(CASE ' + s0 + ' + 1 ' + t.slice(0, -1).map((v, i) => 'WHEN ' + (i + 1) + ' THEN ' + v).join(' ') + ' ELSE ' + t[t.length - 1] + ' END)';
    strikesExpr = '(CASE WHEN ' + hit + ' THEN ' + s0 + ' + 1 ELSE ' + s0 + ' END)';
  }
  /* 新行的初值：默认只记数；lockFromFirst 且 1 次就到 max → 当场锁第 1 轮 */
  let firstVals = '1, 0, 0';
  if (o.lockFromFirst && o.max <= 1) {
    const first = o.lockTable && o.lockTable.length ? Math.floor(Number(o.lockTable[0])) || 0 : Math.floor(Number(o.lockMs)) || 0;
    firstVals = '0, ' + (o.lockTable && o.lockTable.length ? 1 : 0) + ', ?3 + ' + first;
  }
  const sql =
    'INSERT INTO account_attempt_limit (kind, bucket, count, strikes, locked_until, window_start, expires_at) VALUES (?1, ?2, ' + firstVals + ', ?3, ?3 + ?5) ' +
    'ON CONFLICT (kind, bucket) DO UPDATE SET ' +
    'count = CASE WHEN ' + hit + ' THEN 0 ELSE ' + c0 + ' + 1 END, ' +
    'strikes = ' + strikesExpr + ', ' +
    'locked_until = CASE WHEN ' + hit + ' THEN ?3 + ' + lockExpr + ' ELSE ' + l0 + ' END, ' +
    'expires_at = ?3 + ?5 ' +
    'RETURNING count, locked_until';
  const row = await onDb(env, async (d) => {
    const params = [kind, bucket, now, o.max, o.ttlMs];
    if (lockExpr === '?6') params.push(o.lockMs || 0); /* 按轮次查表时语句里没有 ?6，不能多绑 */
    const res = await d.prepare(sql).bind(...params).first();
    await sweepExpired(d, 'account_attempt_limit', now);
    return res;
  });
  return !!(row && Number(row.count) === 0 && Number(row.locked_until) > now);
}

/**
 * 清掉单 IP 的记录（验对后）。出错抛错（调用方自己决定吞不吞）。
 * @param {any} env @param {string} kind @param {string} bucket
 */
export async function clearAttempt(env, kind, bucket) {
  await onDb(env, (d) => d.prepare('DELETE FROM account_attempt_limit WHERE kind = ? AND bucket = ?').bind(kind, bucket).run());
}
