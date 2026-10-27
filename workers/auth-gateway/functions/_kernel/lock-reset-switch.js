/**
 * 2.11 补充：恢复开关（D1 recovery_switch 表，绑定 D1_LOCK_AUTH；2026-10-27 起开关本身也在 D1，不再读 KV lock-reset-switch）。
 *
 * - 打开开关：Sloan 在 Cloudflare 后台 D1 styrigx-auth-gateway 的控制台手动插一行「还没见过」的开关：
 *     INSERT INTO recovery_switch (hash, first_seen, used) VALUES (lower(hex(randomblob(16))), 0, 0);
 *   hash 只是这一行的随机编号（以前是 KV 开关值的 SHA-256；旧行原样留着，都已用过或过期，不会再生效）。代码永不插入开关。
 * - 首次见到计时：服务端第一次读到 first_seen = 0 的行，原子写入首次时间（UPDATE ... WHERE first_seen = 0）；
 *   从首次时间起 24 小时内有效。
 * - 单次：成功签发一次 LockResetTicket 前原子标记已用（UPDATE ... SET used = 1 WHERE used = 0）。
 *   过期或已用的行永不重新生效，要再开就再插一行。
 * - fail closed：D1 读写失败、D1 未绑定、没有可用的行，一律视为关闭。
 *
 * 只在重置锁屏路径、且根凭证正确后调用（其他请求一律不读开关）；管理页加载时只计时（touchLockResetSwitch）。
 */

const SWITCH_WINDOW_MS = 24 * 3600 * 1000;
const CREATE_SQL = 'CREATE TABLE IF NOT EXISTS recovery_switch (hash TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)';

/**
 * 读开关状态：优先认「计时中」的行，其次认「还没见过」的行（并开始计时）。
 * @param {any} db @param {boolean} start 是否给还没见过的行开始计时
 * @returns {Promise<{valid:boolean, hash:string|null, reason:string}>}
 */
async function readSwitch(db, start) {
  await db.prepare(CREATE_SQL).run();
  const now = Date.now();
  const live = await db.prepare(
    'SELECT hash FROM recovery_switch WHERE used = 0 AND first_seen > 0 AND first_seen >= ? ORDER BY first_seen DESC LIMIT 1'
  ).bind(now - SWITCH_WINDOW_MS).first();
  if (live) return { valid: true, hash: String(live.hash), reason: 'within-window' };
  const fresh = await db.prepare('SELECT hash FROM recovery_switch WHERE used = 0 AND first_seen = 0 LIMIT 1').first();
  if (fresh) {
    if (!start) return { valid: true, hash: String(fresh.hash), reason: 'unseen' };
    const r = await db.prepare('UPDATE recovery_switch SET first_seen = ? WHERE hash = ? AND first_seen = 0').bind(now, fresh.hash).run();
    /* 并发的另一个请求先开始了计时：同样有效（它刚写的 first_seen 就在窗口里） */
    return { valid: true, hash: String(fresh.hash), reason: r && r.meta && r.meta.changes > 0 ? 'first-seen' : 'within-window' };
  }
  const used = await db.prepare('SELECT 1 AS x FROM recovery_switch WHERE used = 1 LIMIT 1').first();
  const expired = await db.prepare('SELECT 1 AS x FROM recovery_switch WHERE used = 0 LIMIT 1').first();
  if (expired) return { valid: false, hash: null, reason: 'expired' };
  if (used) return { valid: false, hash: null, reason: 'used' };
  return { valid: false, hash: null, reason: 'not-set' };
}

/**
 * 检查开关是否有效（并给还没见过的行开始计时）。
 * @param {any} db D1_LOCK_AUTH（缺失则 fail closed）
 * @returns {Promise<{valid:boolean, hash:string|null, reason:string}>}
 *   reason: 'first-seen' | 'within-window' | 'not-set' | 'used' | 'expired' | 'd1-error' | 'unavailable'
 */
export async function checkLockResetSwitch(db) {
  if (!db) return { valid: false, hash: null, reason: 'unavailable' };
  try {
    return await readSwitch(db, true);
  } catch (e) {
    return { valid: false, hash: null, reason: 'd1-error' };
  }
}

/**
 * 轻触开关计时（管理页加载时调用）：有还没见过的行就开始 24 小时计时。只计时：不签票、不标记已用。所有错误一律吞掉。
 * @param {any} db D1_LOCK_AUTH
 * @returns {Promise<void>}
 */
export async function touchLockResetSwitch(db) {
  if (!db) return;
  try { await readSwitch(db, true); } catch (e) {}
}

/**
 * 原子标记已用（成功签发 LockResetTicket 前调用）。
 * 仅当 used=0 时更新；返回 true 表示本次抢到（可签发），false 表示已被用过。
 * @param {any} db D1 binding
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function claimLockResetSwitch(db, hash) {
  try {
    if (!db || !hash) return false;
    const r = await db.prepare('UPDATE recovery_switch SET used = 1 WHERE hash = ? AND used = 0').bind(hash).run();
    const changes = r && r.meta ? r.meta.changes : 0;
    return changes > 0;
  } catch (e) {
    return false;
  }
}
