/**
 * @fileoverview 分享短链的规则和存储（D1 styrigx-share，绑定 D1_SHARE_LINK；表结构见 migrations/0001_share_links.sql）。
 *
 * - 码：16 字节随机数 → 22 位 base64url（128 位），不可枚举。存 D1（站长在列表里复制要用），只经 /api/share 给站长看。
 * - 有效期：1–24 小时任选，或 3 / 7 / 15 / 30 天（和网关临时钥匙同一张表；带会话的短链以网关签回的钥匙到期时间为准）。
 * - 会话时长：30 分钟、1 / 3 / 12 小时、1 / 3 / 7 天，且不超过有效期（网关 src/share-issuer.js 再验一次）。
 * - 目标（2026-10-24 起也收子站）：站内相对路径（/ 开头），或 https 绝对地址且主机正好是 styrigx.com / blog / daymark / curio 子站
 *   （不能带端口、用户名密码，不能 // 开头，不含控制字符 / 空白 / 反斜杠）。规范化：主站存成相对路径，子站存成完整地址；
 *   去掉锁屏 / 回跳 / 分享参数（lock、why、return、share）；不能指向主站 /s/（自己）和任何站的 /api/。默认 /。点开时再验一次（防开放重定向）。
 * - 复用：子站顶栏分享按钮（create + reuse:true）遇到同一目标、同样档位、还剩 ≥ 12 小时的有效短链，直接返回它，不再签新钥匙。
 * SQL 都在 SQL 里（单测用同一组语句跑 node:sqlite，Node 20 上换成内存替身）。
 */

export const ORIGIN = 'https://styrigx.com';
/** 同时有效的短链上限 */
export const SHARE_MAX = 20;
export const NAME_MAX = 24;
/** 目标最长（规范化前后都算；子站完整地址 + 中文 slug 编码后会比较长） */
export const TARGET_MAX = 512;
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

/** 目标能指向的站（只认这几个主机，https、默认端口） */
export const TARGET_HOSTS = Object.freeze(['styrigx.com', 'blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com']);
/** 存目标前去掉的查询参数（锁屏 / 回跳 / 分享自己的参数，带进去会把人送回锁屏或绕圈） */
export const STRIP_PARAMS = Object.freeze(['lock', 'why', 'return', 'share']);
const ABS_RE = /^https:\/\/([a-z0-9.-]+)(?=[/?#]|$)/i;

/**
 * 目标：站内相对路径，或 styrigx.com 及三个子站的 https 地址。规范化后返回：主站 → pathname + search + hash（如 /blog/?a=1），
 * 子站 → 完整地址（如 https://blog.styrigx.com/post/x/）。空 = '/'。不合法返回 null。
 * 拒绝：别的主机（含 styrigx.com.evil.com）、http:、// 开头、带端口（含 :443）、带用户名密码、javascript: 等别的协议、
 * 控制字符 / 空白 / 反斜杠、主站 /s/ 和任何站 /api/、超长。
 * @param {any} to
 * @returns {string|null}
 */
export function cleanTarget(to) {
  if (to === undefined || to === null || to === '') return '/';
  if (typeof to !== 'string') return null;
  const v = to.trim();
  if (v === '') return '/';
  if (v.length > TARGET_MAX) return null;
  if (/[\u0000-\u0020\u007f\\]/.test(v)) return null;
  let base = ORIGIN;
  if (v.charAt(0) === '/') {
    if (v.charAt(1) === '/') return null;
  } else {
    const m = ABS_RE.exec(v);
    if (!m) return null;
    const host = m[1].toLowerCase();
    if (!TARGET_HOSTS.includes(host)) return null;
    base = 'https://' + host;
  }
  let u;
  try {
    u = new URL(v, base);
  } catch (e) {
    return null;
  }
  if (u.origin !== base || u.username || u.password || u.port) return null;
  const p = u.pathname;
  /* /..//evil.com 这类解析后 pathname 以 // 开头的，存成相对路径会变成协议相对地址 */
  if (p.startsWith('//')) return null;
  if (p === '/api' || p.startsWith('/api/')) return null;
  if (base === ORIGIN && (p === '/s' || p.startsWith('/s/'))) return null;
  for (const k of STRIP_PARAMS) u.searchParams.delete(k);
  const rel = p + u.search + u.hash;
  const out = base === ORIGIN ? rel : base + rel;
  if (out.length > TARGET_MAX) return null;
  return out;
}

/** 规范化后的目标 → 302 去的完整地址（相对路径接主站） @param {string} t */
export function targetUrl(t) {
  return t.charAt(0) === '/' ? ORIGIN + t : t;
}

/** 复用的门槛：还剩至少这么久的有效短链才拿来复用 */
export const REUSE_MIN_LEFT_MS = 12 * 3600e3;
/** 判断「同样档位」时有效期允许的误差（带会话的到期时间是网关签钥匙那一刻算的） */
export const REUSE_SLACK_MS = 5 * 60e3;

export const SQL = Object.freeze({
  byCode: 'SELECT * FROM share_link WHERE code = ?1',
  byId: 'SELECT * FROM share_link WHERE id = ?1',
  list: 'SELECT * FROM share_link ORDER BY created_at DESC',
  countActive: 'SELECT COUNT(*) AS n FROM share_link WHERE revoked_at IS NULL AND expires_at > ?1',
  /* 复用：同目标、同会话档位、没作废、到期 ≥ ?3、有效期（到期 − 生成）在 [?4, ?5] 里；剩得最久的那条 */
  reusable: 'SELECT * FROM share_link WHERE target = ?1 AND session_sec = ?2 AND revoked_at IS NULL AND expires_at >= ?3 ' +
    'AND expires_at - created_at BETWEEN ?4 AND ?5 ORDER BY expires_at DESC LIMIT 1',
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
