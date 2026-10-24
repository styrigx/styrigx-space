/**
 * @fileoverview 分享短链的规则和存储（D1 styrigx-share，绑定 D1_SHARE_LINK；表结构见 migrations/0001_share_links.sql）。
 *
 * - 码：16 字节随机数 → 22 位 base64url（128 位），不可枚举。存 D1（站长在列表里复制要用），只经 /api/share 给站长看。
 * - 有效期：1–24 小时任选，或 3 / 7 / 15 / 30 天（和网关临时钥匙同一张表；带会话的短链以网关签回的钥匙到期时间为准）。
 * - 会话时长：30 分钟、1 / 3 / 12 小时、1 / 3 / 7 天，且不超过有效期（网关 src/share-issuer.js 再验一次）。
 * - 目标：只收站内相对路径（/ 开头，不能 // 或 /\，不含控制字符 / 空白 / 反斜杠），按 https://styrigx.com 解析后必须同源；
 *   不能指向 /s/（自己）和 /api/。默认 /。点开时再验一次。
 * SQL 都在 SQL 里（单测用同一组语句跑 node:sqlite，Node 20 上换成内存替身）。
 */

export const ORIGIN = 'https://styrigx.com';
/** 同时有效的短链上限 */
export const SHARE_MAX = 20;
export const NAME_MAX = 24;
export const TARGET_MAX = 200;
/** 过期 / 作废后在列表里留几天 */
export const KEEP_DEAD_MS = 7 * 86400e3;
export const SESSION_OPTS = Object.freeze([1800, 3600, 3 * 3600, 12 * 3600, 86400, 3 * 86400, 7 * 86400]);
export const DAYS = Object.freeze([3, 7, 15, 30]);
/** /s/<码>（结尾斜杠可有可无） */
export const SHARE_PATH_RE = /^\/s\/([^/]*)\/?$/;
const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const ID_RE = /^[A-Za-z0-9_-]{16}$/;

/** @param {Uint8Array} b */
function b64url(b) {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {number} n */
function rand(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b64url(b);
}

export function newCode() { return rand(16); }
export function newId() { return rand(12); }
/** @param {any} s */
export function isCode(s) { return typeof s === 'string' && CODE_RE.test(s); }
/** @param {any} s */
export function isId(s) { return typeof s === 'string' && ID_RE.test(s); }

/**
 * 有效期参数 → 毫秒；不合法返回 0（与网关临时钥匙的有效期同规则，单测核对）。
 * @param {{hours?:any, days?:any}} p
 */
export function durationMs(p) {
  const h = p && p.hours;
  const d = p && p.days;
  if (h !== undefined && h !== null && d !== undefined && d !== null) return 0;
  if (Number.isInteger(h) && h >= 1 && h <= 24) return h * 3600e3;
  if (Number.isInteger(d) && DAYS.includes(d)) return d * 86400e3;
  return 0;
}

/** 名字：去控制字符、去首尾空格、最多 24 字；超长返回 null @param {any} s */
export function cleanName(s) {
  const v = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if ([...v].length > NAME_MAX) return null;
  return v;
}

/**
 * 会话时长：0 / 不传 = 普通短链；否则必须是档位之一，且不超过有效期。不合法返回 -1。
 * @param {any} sec @param {number} ms
 */
export function sessionSeconds(sec, ms) {
  if (sec === undefined || sec === null || sec === 0) return 0;
  if (!Number.isInteger(sec) || !SESSION_OPTS.includes(sec)) return -1;
  if (sec * 1000 > ms) return -1;
  return sec;
}

/**
 * 目标路径：只收同源相对路径，规范成 pathname + search + hash。空 = '/'。不合法返回 null。
 * @param {any} to
 * @returns {string|null}
 */
export function cleanTarget(to) {
  if (to === undefined || to === null || to === '') return '/';
  if (typeof to !== 'string') return null;
  const v = to.trim();
  if (v === '') return '/';
  if (v.length > TARGET_MAX) return null;
  if (v.charAt(0) !== '/' || v.charAt(1) === '/' || v.charAt(1) === '\\') return null;
  if (/[\u0000-\u0020\u007f\\]/.test(v)) return null;
  let u;
  try {
    u = new URL(v, ORIGIN);
  } catch (e) {
    return null;
  }
  if (u.origin !== ORIGIN || u.username || u.password) return null;
  const p = u.pathname;
  if (p === '/s' || p.startsWith('/s/') || p === '/api' || p.startsWith('/api/')) return null;
  return p + u.search + u.hash;
}

export const SQL = Object.freeze({
  byCode: 'SELECT * FROM share_link WHERE code = ?1',
  byId: 'SELECT * FROM share_link WHERE id = ?1',
  list: 'SELECT * FROM share_link ORDER BY created_at DESC',
  countActive: 'SELECT COUNT(*) AS n FROM share_link WHERE revoked_at IS NULL AND expires_at > ?1',
  insert: 'INSERT INTO share_link (id, code, name, target, session_sec, key_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
  revoke: 'UPDATE share_link SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL',
  opened: 'UPDATE share_link SET opens = opens + 1, last_open_at = ?2 WHERE id = ?1',
  purge: 'DELETE FROM share_link WHERE expires_at < ?1 OR revoked_at < ?1',
  failGet: 'SELECT count, window_start, locked_until FROM share_fail WHERE ip = ?1',
  failPut: 'INSERT INTO share_fail (ip, count, window_start, locked_until) VALUES (?1, ?2, ?3, ?4) ' +
    'ON CONFLICT(ip) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, locked_until = excluded.locked_until',
  failPurge: 'DELETE FROM share_fail WHERE window_start < ?1 AND locked_until < ?1',
});

/** @param {any} db @param {string} sql @param {...any} args */
export async function first(db, sql, ...args) {
  return (await db.prepare(sql).bind(...args).first()) || null;
}
/** @param {any} db @param {string} sql @param {...any} args */
export async function all(db, sql, ...args) {
  const r = await db.prepare(sql).bind(...args).all();
  return (r && r.results) || [];
}
/** @param {any} db @param {string} sql @param {...any} args */
export async function run(db, sql, ...args) {
  return db.prepare(sql).bind(...args).run();
}

/**
 * 状态：active / expired / revoked。
 * @param {any} row @param {number} now
 */
export function statusOf(row, now) {
  if (row.revoked_at) return 'revoked';
  if (!(row.expires_at > now)) return 'expired';
  return 'active';
}

/**
 * 给站长看的一条（不含钥匙 id）。
 * sessionLeft：带会话的短链，最近一次点开发出去的访客会话最多还剩几秒（没人点开过 / 已过期 / 已作废 = 0）。
 * openFor：现在点开能看多久（秒）= min(会话时长, 短链剩余)；普通短链 0。
 * @param {any} row @param {number} now
 */
export function view(row, now) {
  const status = statusOf(row, now);
  const live = status === 'active';
  const sess = row.session_sec || 0;
  let sessionLeft = 0;
  if (live && sess && row.last_open_at) {
    sessionLeft = Math.max(0, Math.floor((Math.min(row.last_open_at + sess * 1000, row.expires_at) - now) / 1000));
  }
  const v = {
    id: row.id,
    name: row.name || '',
    to: row.target || '/',
    session: sess,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at || 0,
    status: status,
    opens: row.opens || 0,
    lastOpenAt: row.last_open_at || 0,
    openFor: live && sess ? Math.max(0, Math.min(sess, Math.floor((row.expires_at - now) / 1000))) : 0,
    sessionLeft: sessionLeft,
  };
  if (live) v.path = '/s/' + row.code;
  return v;
}
