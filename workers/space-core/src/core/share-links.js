/**
 * @fileoverview 分享短链的规则和存储（D1 styrigx-space-core 的 share_* 表，绑定 D1_SPACE；表结构见 migrations/0001_baseline.sql）。
 *
 * - 码：16 字节随机数 → 22 位 base64url（128 位），不可枚举。存 D1（分享列表里复制要用），只经 /api/share 的 list 给进门的人看。
 * - 有效期：1–24 小时任选，或 3 / 7 / 15 / 30 天。
 * - 会话时长：30 分钟、1 / 3 / 12 小时、1 / 3 / 7 天，且不超过有效期（core/link-keys.js LINK_SESSION_OPTS 同一张表）。
 * - 带会话的短链（v5 S1）：点开时签进站会话 by=link、linkId = 这一行的 id（core/link-keys.js openLinkSession）；
 *   验会话时查这一行（isLinkLive）：作废 / 过期 / 已清理 → 会话失效。不再签「短链钥匙」（tempkey 表、key_id 列不再读写，
 *   新行 key_id 写 ''；表和列的删除在后面单独的收尾 PR）。
 * - 目标：站内相对路径（/ 开头），或 https 绝对地址且主机正好是 styrigx.com（合并 PR3 起各站都在 styrigx.com/<站>/ 下）
 *   （不能带端口、用户名密码，不能 // 开头，不含控制字符 / 空白 / 反斜杠）。规范化：一律存成相对路径；
 *   去掉锁屏 / 回跳 / 分享参数（lock、why、return、share）；不能指向 /s/（自己）和任何 /api/、/<站>/api/。默认 /。点开时再验一次（防开放重定向）。
 * - 复用：顶栏分享按钮（create + reuse:true）遇到同一目标、同样档位、还剩 ≥ 12 小时的有效短链，直接返回它，不再签新钥匙。
 * SQL 都在 SQL 里（单测用同一组语句跑 node:sqlite，Node 20 上换成内存替身）。
 */

export const ORIGIN = 'https://styrigx.com';
/** 同时有效的短链上限 */
export const SHARE_MAX = 20;
export const NAME_MAX = 24;
/** 目标最长（规范化前后都算；中文 slug 编码后会比较长） */
export const TARGET_MAX = 512;
/** 过期 / 作废后在列表里留几天 */
export const KEEP_DEAD_MS = 7 * 86400e3;
export const SESSION_OPTS = Object.freeze([1800, 3600, 3 * 3600, 12 * 3600, 86400, 3 * 86400, 7 * 86400]);
export const DAYS = Object.freeze([3, 7, 15, 30]);
/** /s/<码>（结尾斜杠可有可无） */
export const SHARE_PATH_RE = /^\/s\/([^/]*)\/?$/;
const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const LINK_ID_RE = /^[A-Za-z0-9_-]{16}$/;

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
 * 进站会话票里的 linkId（by=link，v5 S1）：就是 share_link.id。和 isId 同一个格式，但单独一个校验函数——
 * 票的格式校验（core/lock-session.js validCombo）只认它，不和管理接口的参数校验共用，以后两边各改各的。
 * @param {any} s
 */
export function isLinkId(s) { return typeof s === 'string' && LINK_ID_RE.test(s); }

/**
 * 有效期参数 → 毫秒；不合法返回 0。
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

/** 目标能指向的主机（https、默认端口）：只有 styrigx.com（旧图志 atlas.styrigx.com 已下线，2026-11 删出白名单，存量短链由 migrations-archive/0002 删除） */
export const TARGET_HOSTS = Object.freeze(['styrigx.com']);
/** 存目标前去掉的查询参数（锁屏 / 回跳 / 分享自己的参数，带进去会把人送回锁屏或绕圈） */
export const STRIP_PARAMS = Object.freeze(['entry', 'lock', 'why', 'return', 'share']);
const ABS_RE = /^https:\/\/([a-z0-9.-]+)(?=[/?#]|$)/i;

/**
 * 目标：站内相对路径，或 https://styrigx.com 的地址。规范化后一律返回 pathname + search + hash（如 /blog/post/x/?a=1；
 * 合并 PR3 起三站在主域名 /blog/ /curio/ /daymark/ 下）。空 = '/'。不合法返回 null。
 * 拒绝：别的主机（含已下线的 atlas.styrigx.com、styrigx.com.evil.com）、http:、// 开头、带端口（含 :443）、带用户名密码、javascript: 等别的协议、
 * 控制字符 / 空白 / 反斜杠、/s/、/api/ 和 /<站>/api/、超长。
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
  if (v.charAt(0) === '/') {
    if (v.charAt(1) === '/') return null;
  } else {
    const m = ABS_RE.exec(v);
    if (!m) return null;
    if (!TARGET_HOSTS.includes(m[1].toLowerCase())) return null;
  }
  let u;
  try {
    u = new URL(v, ORIGIN);
  } catch (e) {
    return null;
  }
  if (u.origin !== ORIGIN || u.username || u.password || u.port) return null;
  const p = u.pathname;
  /* /..//evil.com 这类解析后 pathname 以 // 开头的，存成相对路径会变成协议相对地址 */
  if (p.startsWith('//')) return null;
  if (p === '/api' || p.startsWith('/api/')) return null;
  if (/^\/[^/]+\/api(\/|$)/.test(p)) return null;
  if (p === '/s' || p.startsWith('/s/')) return null;
  for (const k of STRIP_PARAMS) u.searchParams.delete(k);
  const out = p + u.search + u.hash;
  if (out.length > TARGET_MAX) return null;
  return out;
}

/**
 * 规范化后的目标 → 302 去的完整地址（相对路径接主站）。
 * 存量里不是 / 开头的（只可能是旧图志的完整地址，migrations-archive/0002 已删）不再认，退回主站首页。
 * @param {string} t
 */
export function targetUrl(t) {
  return typeof t === 'string' && t.charAt(0) === '/' && t.charAt(1) !== '/' ? ORIGIN + t : ORIGIN + '/';
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
  /* share rm --all：把所有还没作废的一次作废（已过期的也写上，列表里显示「已作废」，7 天后一起清） */
  revokeAll: 'UPDATE share_link SET revoked_at = ?1 WHERE revoked_at IS NULL',
  /* 验 by=link 的进站会话：这条链接还在不在、作废没有、到期没有（core/lock-session.js；每个请求读一次主库，不缓存） */
  linkState: 'SELECT revoked_at, expires_at FROM share_link WHERE id = ?1',
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
 * 清理入口（v5 S1）：删掉过期或作废满 KEEP_DEAD_MS（7 天）的行，一条 DELETE。返回删掉的行数（D1 meta.changes，拿不到就 0）。
 * 每日由 styrigx-status 的 Cron（03:00 CST 那轮）经服务绑定 JOB_SPACE 调命名入口 ShareJanitor.purgeShareLinks（rpc/share-janitor.js，v5 S2）；/api/share list 前也顺手调一次。
 * 删的都是早已失效的行：作废 / 过期的那一刻 by=link 的会话就验不过了（core/lock-session.js 查 linkState），行在不在都一样（不在也按失效算）。
 * D1 出错抛错（调用方决定吞掉还是 503）。
 * @param {any} db D1_SPACE
 * @param {number} [now] 毫秒，默认现在
 * @returns {Promise<number>}
 */
export async function purgeDeadLinks(db, now) {
  if (!db) throw new Error('purgeDeadLinks: no db');
  const t = (typeof now === 'number' && Number.isFinite(now) ? now : Date.now()) - KEEP_DEAD_MS;
  const r = await run(db, SQL.purge, t);
  const n = r && r.meta && r.meta.changes;
  return typeof n === 'number' ? n : 0;
}

/**
 * 链接会话还能不能用（core/lock-session.js 验 by=link 的票时调）：行在、没作废、没到期 → true；
 * 行不在（已清理）/ 作废 / 到期 → false。D1 出错抛错（调用方 fail closed）。不缓存，每次读主库。
 * @param {any} db D1_SPACE
 * @param {string} id share_link.id
 * @param {number} [now]
 * @returns {Promise<boolean>}
 */
export async function isLinkLive(db, id, now) {
  if (!db) throw new Error('isLinkLive: no db');
  if (!isLinkId(id)) return false;
  const row = await first(db, SQL.linkState, id);
  if (!row) return false;
  if (row.revoked_at) return false;
  return row.expires_at > (typeof now === 'number' ? now : Date.now());
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
 * 列表里的一条（不含 key_id 列）。
 * sessionLeft：带会话的短链，最近一次点开发出去的临时会话最多还剩几秒（没人点开过 / 已过期 / 已作废 = 0）。
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
