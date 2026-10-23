/**
 * 2.11 补充：恢复开关（KV 键 + D1 计时/单次）。
 *
 * - 开关：KV 固定键 `recovery-switch`，值为任意字符串，由用户在 Cloudflare
 *   后台手动添加/修改。代码永不写这个键。
 * - 首次见到计时：服务端第一次读到某个值时，在 D1 记录 hash(值) 与首次时间；
 *   从首次时间起 24 小时内有效。
 * - 单次：成功签发一次 lockreset 后在 D1 原子标记该 hash 已用（D1 强一致，
 *   防止 KV 同步延迟导致重复使用）。过期或已用的值永不重新生效，
 *   换新值才能再次开启。
 * - fail closed：KV 或 D1 读写失败、D1 未绑定、键不存在、值为空，一律视为关闭。
 *
 * 只在重置锁屏路径、且根凭证正确后调用（其他请求一律不读开关）。
 */

export const SWITCH_KV_KEY = 'recovery-switch';
const SWITCH_WINDOW_MS = 24 * 3600 * 1000;

/** @param {string} s */
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

/**
 * 检查开关是否有效。
 * @param {any} kv KV_LOCK_DOOR
 * @param {any} db D1 binding（缺失则 fail closed）
 * @returns {Promise<{valid:boolean, hash:string|null, reason:string}>}
 *   reason: 'first-seen' | 'within-window' | 'not-set' | 'empty' |
 *           'used' | 'expired' | 'kv-error' | 'd1-error' | 'unavailable'
 */
export async function checkRecoverySwitch(kv, db) {
  try {
    if (!kv || !db) return { valid: false, hash: null, reason: 'unavailable' };
    let val = null;
    try {
      val = await kv.get(SWITCH_KV_KEY);
    } catch (e) {
      return { valid: false, hash: null, reason: 'kv-error' };
    }
    if (val === null || val === undefined) {
      return { valid: false, hash: null, reason: 'not-set' };
    }
    if (!String(val).trim()) {
      return { valid: false, hash: null, reason: 'empty' };
    }
    const hash = await sha256Hex(String(val));
    try {
      await db.prepare(
        'CREATE TABLE IF NOT EXISTS recovery_switch (hash TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)'
      ).run();
    } catch (e) {
      return { valid: false, hash: null, reason: 'd1-error' };
    }
    let row = null;
    try {
      row = await db.prepare('SELECT first_seen, used FROM recovery_switch WHERE hash = ?').bind(hash).first();
    } catch (e) {
      return { valid: false, hash: null, reason: 'd1-error' };
    }
    const now = Date.now();
    if (!row) {
      /* 首次见到该值：记录首次时间 */
      try {
        await db.prepare('INSERT INTO recovery_switch (hash, first_seen, used) VALUES (?, ?, 0)').bind(hash, now).run();
      } catch (e) {
        return { valid: false, hash: null, reason: 'd1-error' };
      }
      return { valid: true, hash: hash, reason: 'first-seen' };
    }
    if (row.used) {
      return { valid: false, hash: hash, reason: 'used' };
    }
    if (now - Number(row.first_seen) > SWITCH_WINDOW_MS) {
      return { valid: false, hash: hash, reason: 'expired' };
    }
    return { valid: true, hash: hash, reason: 'within-window' };
  } catch (e) {
    return { valid: false, hash: null, reason: 'error' };
  }
}

/**
 * 轻触开关计时（管理页加载时调用）。
 * 若 KV 中有新值（D1 未见过），在 D1 记录 hash 与首次时间，开始 24 小时计时。
 * 只计时：不签票、不标记已用。所有错误一律吞掉，不影响调用方。
 * @param {any} kv KV_LOCK_DOOR
 * @param {any} db D1 binding
 * @returns {Promise<void>}
 */
export async function touchRecoverySwitch(kv, db) {
  try {
    if (!kv || !db) return;
    let val = null;
    try {
      val = await kv.get(SWITCH_KV_KEY);
    } catch (e) {
      return;
    }
    if (val === null || val === undefined || !String(val).trim()) return;
    const hash = await sha256Hex(String(val));
    try {
      await db.prepare(
        'CREATE TABLE IF NOT EXISTS recovery_switch (hash TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)'
      ).run();
      const row = await db.prepare('SELECT first_seen FROM recovery_switch WHERE hash = ?').bind(hash).first();
      if (!row) {
        await db.prepare('INSERT INTO recovery_switch (hash, first_seen, used) VALUES (?, ?, 0)').bind(hash, Date.now()).run();
      }
    } catch (e) {
      /* 吞掉：不影响页面加载 */
    }
  } catch (e) {}
}

/**
 * 原子标记已用（成功签发 lockreset 前调用）。
 * 仅当 used=0 时更新；返回 true 表示本次抢到（可签发），false 表示已被用过。
 * @param {any} db D1 binding
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function claimSwitchUsed(db, hash) {
  try {
    if (!db || !hash) return false;
    const r = await db.prepare('UPDATE recovery_switch SET used = 1 WHERE hash = ? AND used = 0').bind(hash).run();
    const changes = r && r.meta ? r.meta.changes : 0;
    return changes > 0;
  } catch (e) {
    return false;
  }
}
