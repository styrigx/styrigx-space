/**
 * 临时 LockKey（2026-10-23，取代 Turnstile「访客进入」）。
 *
 * 定位：lock 是保护 account 的一道屏障；临时 LockKey 是管理员在账号页签发给别人的一把临时进门钥匙。
 * 不是另一套认证体系：
 * - 访客在锁屏输入临时码 → 签发的仍是锁屏会话 LockSessionTicket（role=visitor，by=tempkey，tempkeyId=<钥匙 id>），
 *   用 lock 私钥（SGX_LOCK_PRIVATE）签名、lock 公钥验签（lock-session.js）。
 * - 会话的到期时间不晚于钥匙本身；验会话时再查「这把钥匙有没有被作废」（D1 tempkey 表一次主键读，主库、不缓存）：
 *   钥匙到期（票自己的 exp）或被作废，访客下一个请求就进不来（以前 KV 作废标记在别的节点上最长约 60 秒才生效）。
 *
 * 临时码：12 位 Crockford Base32（60 位随机，不含 I L O U），显示成 XXXX-XXXX-XXXX；
 * 输入时忽略大小写、空格和连字符，O→0、I/L→1。服务端只存 SHA-256(pepper|code)，
 * 临时码只在签发那一刻返回一次。
 *
 * 存储（D1 styrigx-auth-gateway，绑定 D1_LOCK_AUTH；2026-10-27 从 KV 搬来，realm = 'lock'）：
 * - tempkey (realm, id, name, code_hash, link, created_at, revoked_at, expires_at)：一把钥匙一行（以前 lock-tempkey:<id>）；
 *   code_hash 有唯一索引 tempkey_code（以前 lock-tempkey-code:<hash> → id）；
 *   link = 1：分享短链自动签的钥匙（styrigx-share 经服务绑定 ShareIssuer 签，src/share-issuer.js）：
 *   没有临时码、不占 TEMPKEY_MAX、不在钥匙列表里，只能经短链换会话
 * - 作废 = revoked_at = now，行留到原来的到期时间（以前另写 lock-tempkey-revoked:<id> 标记）；
 *   已作废的不出现在列表里、临时码进不来、不占上限；过期行读时一律不认，签发新钥匙时顺手清掉
 * - 输错限速：attempt_limit 表 realm = 'lock'、kind = 'tempkey'（attempt-limit.js，原子 UPSERT）：
 *   单 IP 连错 5 次冷却 15 分钟（IPv6 按 /64，见 http.js ipBucket）；全站每小时错满 30 次后，每次校验先等 2 秒（只减速、不封锁）。
 *   不设全站暂停：以前错满 30 次暂停 1 小时，任何人换几个 IP 就能让所有访客都进不来。
 *   临时码 60 位随机、同时最多 20 把，穷举靠单 IP 冷却 + 减速就够。
 * 名字只在管理员侧保存和显示，访客那边永远拿不到。
 */
import { b64urlEnc } from './crypto.js';
import { REALM_LOCK } from './realms.js';
import { ipBucket } from './http.js';
import { onAuthDb, sweepExpired } from './d1-state.js';
import { readAttempt, globalHot, recordAttempt, recordGlobal, clearAttempt } from './attempt-limit.js';

const REALM = REALM_LOCK.id;
const LIMIT_KIND = 'tempkey';
/* 临时码哈希的域分隔串（第 5 层改名后旧临时码全部失效，PR 3 部署后重发全部临时钥匙） */
const CODE_HASH_DOMAIN = 'lock-tempkey|';

/** 同时有效的临时钥匙上限 */
export const TEMPKEY_MAX = 20;
/** 名字最长（字符） */
export const TEMPKEY_NAME_MAX = 24;
/** 一次访客会话最长 12 小时（钥匙剩余时间更短时取剩余时间），到点重新输入临时码 */
export const TEMPKEY_SESSION_MAX = 12 * 3600;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
/** 允许的有效期：1–24 小时任选，或 3 / 7 / 15 / 30 天 */
export const TEMPKEY_DAYS = Object.freeze([3, 7, 15, 30]);

const IP_MAX_FAIL = 5;
const IP_LOCK_MS = 15 * 60 * 1000;
/** 全站每小时输错满这么多次后开始减速 */
export const TEMPKEY_GLOBAL_SLOW_AT = 30;
/** 全站减速时每次校验先等的毫秒数 */
export const TEMPKEY_GLOBAL_DELAY_MS = 2000;
const GLOBAL_WINDOW_MS = HOUR;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; /* Crockford Base32 */

/**
 * 有效期参数 → 毫秒；不合法返回 0。
 * @param {{hours?:any, days?:any}} p
 */
export function durationMs(p) {
  const h = p && p.hours;
  const d = p && p.days;
  if (h !== undefined && h !== null && d !== undefined && d !== null) return 0;
  if (Number.isInteger(h) && h >= 1 && h <= 24) return h * HOUR;
  if (Number.isInteger(d) && TEMPKEY_DAYS.includes(d)) return d * DAY;
  return 0;
}

/**
 * 名字规则：去控制字符、去首尾空格、最多 TEMPKEY_NAME_MAX 字；可以为空。
 * @param {any} s
 * @returns {string|null} 超长返回 null
 */
export function cleanName(s) {
  const v = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if ([...v].length > TEMPKEY_NAME_MAX) return null;
  return v;
}

/** 生成 12 位临时码（不带连字符） */
export function newCode() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[b[i] & 31];
  return s;
}

/** 显示格式：XXXX-XXXX-XXXX @param {string} code */
export function formatCode(code) {
  return code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8, 12);
}

/**
 * 输入规范化：大写，去空白和连字符，O→0、I/L→1；不是 12 位合法字符返回 ''。
 * @param {any} s
 */
export function normalizeCode(s) {
  const v = String(s || '')
    .toUpperCase()
    .replace(/[\s\-_]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (v.length !== 12) return '';
  for (const c of v) if (ALPHABET.indexOf(c) < 0) return '';
  return v;
}

/** @param {string} pepper @param {string} code 规范化后的临时码 */
export async function hashCode(pepper, code) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CODE_HASH_DOMAIN + pepper + '|' + code));
  return Array.from(new Uint8Array(d), function (x) { return x.toString(16).padStart(2, '0'); }).join('');
}

function newId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return b64urlEnc(b);
}

/** @param {string} id */
export function isTempkeyId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{16}$/.test(id);
}

/** @param {any} row D1 tempkey 行 → 钥匙对象 */
function rowKey(row) {
  const k = { id: String(row.id), name: String(row.name || ''), createdAt: Number(row.created_at) || 0, expiresAt: Number(row.expires_at) || 0 };
  if (row.link) k.link = true;
  if (row.code_hash) k.h = String(row.code_hash);
  return k;
}

/**
 * 列出还有效的临时钥匙（按签发时间新到旧；含 link 钥匙，带 link:true）。D1 出错抛错。
 * @param {any} env
 * @returns {Promise<Array<{id:string, name:string, createdAt:number, expiresAt:number, link?:boolean}>>}
 */
export async function listTempkeys(env) {
  const res = await onAuthDb(env, REALM, (db, r) => db.prepare(
    'SELECT id, name, link, created_at, expires_at FROM tempkey WHERE realm = ? AND revoked_at = 0 AND expires_at > ? ORDER BY created_at DESC'
  ).bind(r.id, Date.now()).all());
  return ((res && res.results) || []).map(rowKey);
}

/**
 * 读一把还有效的钥匙（不存在 / 已作废 / 已过期 → null）。D1 出错抛错。
 * @param {any} env @param {string} id
 */
export async function getTempkey(env, id) {
  if (!isTempkeyId(id)) return null;
  const row = await onAuthDb(env, REALM, (db, r) => db.prepare(
    'SELECT id, name, code_hash, link, created_at, expires_at FROM tempkey WHERE realm = ? AND id = ? AND revoked_at = 0 AND expires_at > ?'
  ).bind(r.id, id, Date.now()).first());
  return row ? rowKey(row) : null;
}

/**
 * 签发一把临时钥匙。返回 { key, code }（code 已格式化，只此一次）。
 * 已满 TEMPKEY_MAX（只数普通钥匙）→ 抛 Error('full')；D1 出错原样抛。
 * p.link：分享短链用的钥匙——不生成临时码（锁屏上输不进来），不占 TEMPKEY_MAX（短链 Worker 自己有上限），返回 code ''。
 * 上限判断与插入在同一条 INSERT ... SELECT ... WHERE (SELECT COUNT ...) < TEMPKEY_MAX 里（并发签发不会超）。
 * @param {any} env
 * @param {string} pepper
 * @param {{name:string, ms:number, link?:boolean}} p
 */
export async function createTempkey(env, pepper, p) {
  const now = Date.now();
  const key = { id: newId(), name: p.name || '', createdAt: now, expiresAt: now + p.ms };
  if (p.link) {
    await onAuthDb(env, REALM, async (db, r) => {
      await db.prepare('INSERT INTO tempkey (realm, id, name, code_hash, link, created_at, expires_at) VALUES (?, ?, ?, NULL, 1, ?, ?)')
        .bind(r.id, key.id, key.name, key.createdAt, key.expiresAt).run();
      await sweepExpired(db, 'tempkey', r.id, now);
    });
    return { key: key, code: '' };
  }
  const code = newCode();
  const h = await hashCode(pepper, code);
  const res = await onAuthDb(env, REALM, async (db, r) => {
    await sweepExpired(db, 'tempkey', r.id, now);
    return db.prepare(
      'INSERT INTO tempkey (realm, id, name, code_hash, link, created_at, expires_at) SELECT ?1, ?2, ?3, ?4, 0, ?5, ?6 ' +
      'WHERE (SELECT COUNT(*) FROM tempkey WHERE realm = ?1 AND link = 0 AND revoked_at = 0 AND expires_at > ?5) < ?7'
    ).bind(r.id, key.id, key.name, h, key.createdAt, key.expiresAt, TEMPKEY_MAX).run();
  });
  if (!(res && res.meta && res.meta.changes > 0)) throw new Error('full');
  return { key: key, code: formatCode(code) };
}

/**
 * 作废：一条 UPDATE ... SET revoked_at = now WHERE 还没作废 RETURNING（写完下一个请求 isTempkeyRevoked 就是 true）。
 * 不存在 / 已作废 / 已过期返回 false。
 * @param {any} env
 * @param {string} id
 */
export async function revokeTempkey(env, id) {
  if (!isTempkeyId(id)) return false;
  const now = Date.now();
  const row = await onAuthDb(env, REALM, (db, r) => db.prepare(
    'UPDATE tempkey SET revoked_at = ? WHERE realm = ? AND id = ? AND revoked_at = 0 AND expires_at > ? RETURNING id'
  ).bind(now, r.id, id, now).first());
  return !!row;
}

/**
 * 按临时码找钥匙；找不到或已过期返回 null。D1 出错抛错。
 * @param {any} env
 * @param {string} pepper
 * @param {string} code 规范化后的临时码
 */
export async function findByCode(env, pepper, code) {
  const h = await hashCode(pepper, code);
  const row = await onAuthDb(env, REALM, (db, r) => db.prepare(
    'SELECT id, name, code_hash, link, created_at, expires_at FROM tempkey WHERE realm = ? AND code_hash = ? AND revoked_at = 0 AND expires_at > ?'
  ).bind(r.id, h, Date.now()).first());
  if (!row || row.link) return null;
  return rowKey(row);
}

/**
 * 钥匙是否已被作废（验访客会话时用：每个请求一次主键读，主库、不缓存；到期由会话票自己的 exp 管）。D1 出错抛错。
 * @param {any} env
 * @param {string} id
 */
export async function isTempkeyRevoked(env, id) {
  if (!isTempkeyId(id)) return true;
  const row = await onAuthDb(env, REALM, (db, r) => db.prepare(
    'SELECT 1 AS x FROM tempkey WHERE realm = ? AND id = ? AND revoked_at > 0'
  ).bind(r.id, id).first());
  return !!row;
}

/* ---------- 输错限速 ---------- */

/** @param {number} ms */
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/**
 * 本 IP 是否在冷却中；不在冷却、但全站正在减速时，先等 TEMPKEY_GLOBAL_DELAY_MS 再返回 false。D1 出错抛错。
 * @param {any} env @param {string} ip
 * @param {{sleep?:(ms:number)=>Promise<void>}} [opts] 测试可替换 sleep
 */
export async function isTempkeyLimited(env, ip, opts) {
  const r = await readAttempt(env, REALM, LIMIT_KIND, ipBucket(ip));
  if (r && r.lockedUntil > Date.now()) return true;
  if (await globalHot(env, REALM, LIMIT_KIND, GLOBAL_WINDOW_MS, TEMPKEY_GLOBAL_SLOW_AT)) {
    await ((opts && opts.sleep) || sleep)(TEMPKEY_GLOBAL_DELAY_MS);
  }
  return false;
}

/** 记一次输错（原子）；返回本 IP 这次是否刚进入冷却。D1 出错抛错。 @param {any} env @param {string} ip */
export async function recordTempkeyFail(env, ip) {
  const locked = await recordAttempt(env, REALM, LIMIT_KIND, ipBucket(ip), { max: IP_MAX_FAIL, ttlMs: HOUR, lockMs: IP_LOCK_MS });
  await recordGlobal(env, REALM, LIMIT_KIND, GLOBAL_WINDOW_MS);
  return locked;
}

/** 输对后清掉这个 IP 的计数（失败不影响） @param {any} env @param {string} ip */
export async function clearTempkeyFail(env, ip) {
  try { await clearAttempt(env, REALM, LIMIT_KIND, ipBucket(ip)); } catch (e) {}
}
