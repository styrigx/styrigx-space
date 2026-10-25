/**
 * 临时 LockKey（2026-10-23，取代 Turnstile「访客进入」）。
 *
 * 定位：lock 是保护 account 的一道屏障；临时 LockKey 是站长在账号页签发给别人的一把临时进门钥匙。
 * 不是另一套认证体系：
 * - 访客在锁屏输入临时码 → 签发的仍是 sgx-verified 会话（role=visitor，by=owner），
 *   用现有 lock 私钥（SGX_LOCK_PRIVATE）签名、lock 公钥验签，格式和其它会话完全一样。
 * - 另发一张同样由 lock 私钥签名的钥匙票 sgx-tk（id.exp.sig），middleware 对 visitor 会话
 *   额外要求这张票有效且 KV 里这把钥匙还在：钥匙到期或被作废，访客下一个请求就进不来。
 *   没有钥匙票的 visitor 会话（以前 Turnstile 签的）一律当作无效。
 *   钥匙票的到期时间不晚于钥匙本身，所以 middleware 只需查「有没有被作废」（lock-temp-revoked:<id>），一次 KV 读。
 *
 * 临时码：12 位 Crockford Base32（60 位随机，不含 I L O U），显示成 XXXX-XXXX-XXXX；
 * 输入时忽略大小写、空格和连字符，O→0、I/L→1。服务端只存 SHA-256(pepper|code)，
 * 临时码只在签发那一刻返回一次。
 *
 * KV（KV_LOCK_DOOR，都带过期时间，到期自动消失）：
 * - lock-temp:<id>          → { id, name, createdAt, expiresAt, h, link? }（h = 临时码哈希，作废时删索引用；
 *                             link = 分享短链自动签的钥匙（styrigx-share 经服务绑定 ShareIssuer 签，src/share-issuer.js）：
 *                             没有临时码、不占 TEMPKEY_MAX、不在钥匙列表里，只能经短链换会话）
 * - lock-temp-code:<hash>   → id
 * - lock-temp-revoked:<id>  → '1'（作废标记，留到钥匙原本的到期时间；middleware 每个访客请求只查这一个键）
 * - lock-temp-fail:<ip>     → { count, lockedUntil }（连错 5 次冷却 15 分钟）
 * - lock-temp-global        → { count, windowStart, pausedUntil }（全站每小时错 30 次暂停 1 小时）
 * 名字只在站长侧保存和显示，访客那边永远拿不到。
 */
import { ed25519Sign, ed25519Verify, b64urlEnc } from './crypto.js';
import { REALM_LOCK, realmPrivateKey, realmPublicKey } from './realms.js';

export const TEMPKEY_PREFIX = 'lock-temp:';
const CODE_PREFIX = 'lock-temp-code:';
const REVOKED_PREFIX = 'lock-temp-revoked:';
const FAIL_PREFIX = 'lock-temp-fail:';
const GLOBAL_KEY = 'lock-temp-global';

/** 钥匙票 cookie（和 sgx-verified 同属性，子站共用） */
export const TK_COOKIE = 'sgx-tk';

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
const GLOBAL_MAX_FAIL = 30;
const GLOBAL_WINDOW_MS = HOUR;
const GLOBAL_PAUSE_MS = HOUR;

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
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('lock-temp|' + pepper + '|' + code));
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

/** KV expiration（秒，绝对时间；KV 要求至少 60 秒后） */
function kvExp(expiresAt) {
  return Math.max(Math.ceil(expiresAt / 1000), Math.ceil(Date.now() / 1000) + 60);
}

/**
 * 列出还有效的临时钥匙（按签发时间新到旧）。KV 出错抛错。
 * @param {any} kv
 * @returns {Promise<Array<{id:string, name:string, createdAt:number, expiresAt:number}>>}
 */
export async function listTempkeys(kv) {
  const out = [];
  let cursor;
  const now = Date.now();
  do {
    const page = await kv.list({ prefix: TEMPKEY_PREFIX, cursor: cursor });
    for (const k of page.keys || []) {
      const v = await kv.get(k.name, 'json');
      if (v && v.id && v.expiresAt > now) {
        const k = { id: v.id, name: v.name || '', createdAt: v.createdAt || 0, expiresAt: v.expiresAt };
        if (v.link) k.link = true;
        out.push(k);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort(function (a, b) { return b.createdAt - a.createdAt; });
  return out;
}

/**
 * 签发一把临时钥匙。返回 { key, code }（code 已格式化，只此一次）。
 * 已满 TEMPKEY_MAX（只数普通钥匙）→ 抛 Error('full')；KV 出错原样抛。
 * p.link：分享短链用的钥匙——不生成临时码（锁屏上输不进来），不占 TEMPKEY_MAX（短链 Worker 自己有上限），返回 code ''。
 * @param {any} kv
 * @param {string} pepper
 * @param {{name:string, ms:number, link?:boolean}} p
 */
export async function createTempkey(kv, pepper, p) {
  if (p.link) {
    const now0 = Date.now();
    const lk = { id: newId(), name: p.name || '', createdAt: now0, expiresAt: now0 + p.ms };
    await kv.put(TEMPKEY_PREFIX + lk.id, JSON.stringify(Object.assign({ link: true }, lk)), { expiration: kvExp(lk.expiresAt) });
    return { key: lk, code: '' };
  }
  const live = (await listTempkeys(kv)).filter(function (k) { return !k.link; });
  if (live.length >= TEMPKEY_MAX) throw new Error('full');
  const code = newCode();
  const h = await hashCode(pepper, code);
  const now = Date.now();
  const key = { id: newId(), name: p.name || '', createdAt: now, expiresAt: now + p.ms };
  const exp = kvExp(key.expiresAt);
  await kv.put(CODE_PREFIX + h, key.id, { expiration: exp });
  await kv.put(TEMPKEY_PREFIX + key.id, JSON.stringify(Object.assign({ h: h }, key)), { expiration: exp });
  return { key: key, code: formatCode(code) };
}

/**
 * 作废：先写作废标记（留到钥匙原本的到期时间），再删钥匙和索引。不存在返回 false。
 * @param {any} kv
 * @param {string} id
 */
export async function revokeTempkey(kv, id) {
  const v = await kv.get(TEMPKEY_PREFIX + id, 'json');
  if (!v) return false;
  await kv.put(REVOKED_PREFIX + id, '1', { expiration: kvExp(v.expiresAt || Date.now()) });
  if (v.h) await kv.delete(CODE_PREFIX + v.h);
  await kv.delete(TEMPKEY_PREFIX + id);
  return true;
}

/**
 * 按临时码找钥匙；找不到或已过期返回 null。KV 出错抛错。
 * @param {any} kv
 * @param {string} pepper
 * @param {string} code 规范化后的临时码
 */
export async function findByCode(kv, pepper, code) {
  const h = await hashCode(pepper, code);
  const id = await kv.get(CODE_PREFIX + h);
  if (!id) return null;
  const v = await kv.get(TEMPKEY_PREFIX + id, 'json');
  if (!v || v.h !== h || !(v.expiresAt > Date.now())) return null;
  return v;
}

/**
 * 钥匙是否已被作废（middleware 用；到期由钥匙票自己的 exp 管）。KV 出错抛错。
 * @param {any} kv
 * @param {string} id
 */
export async function isTempkeyRevoked(kv, id) {
  if (!isTempkeyId(id)) return true;
  return (await kv.get(REVOKED_PREFIX + id)) !== null;
}

/* ---------- 钥匙票 sgx-tk：id.exp.sig（lock 私钥签名，用途前缀 tk|） ---------- */

/** @param {any} env @param {string} id @param {number} exp 毫秒 */
export async function signTk(env, id, exp) {
  const priv = realmPrivateKey(env, REALM_LOCK);
  if (!priv) throw new Error('no-key');
  const payload = id + '.' + exp;
  return payload + '.' + (await ed25519Sign(priv, 'tk|' + payload));
}

/**
 * 验钥匙票签名和时间（不查 KV）。不合法返回 null。
 * @param {any} env
 * @param {string} val
 * @returns {Promise<{id:string, exp:number}|null>}
 */
export async function parseTk(env, val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 3) return null;
  const [id, expStr, sig] = parts;
  if (!isTempkeyId(id)) return null;
  const exp = parseInt(expStr, 10);
  if (!exp || exp < Date.now()) return null;
  const pub = realmPublicKey(env, REALM_LOCK);
  if (!pub) return null;
  try {
    if (!(await ed25519Verify(pub, 'tk|' + id + '.' + expStr, sig))) return null;
  } catch (e) {
    return null;
  }
  return { id: id, exp: exp };
}

/** @param {Headers} headers @param {string} value @param {number} maxAge 秒 */
export function setTkCookie(headers, value, maxAge) {
  headers.append('Set-Cookie', TK_COOKIE + '=' + value + '; ' + REALM_LOCK.cookieAttrs + '; Max-Age=' + maxAge);
}

/** @param {Headers} headers */
export function clearTkCookie(headers) {
  headers.append('Set-Cookie', TK_COOKIE + '=; ' + REALM_LOCK.cookieAttrs + '; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

/** 取请求里的 sgx-tk（多个同名只取第一个） @param {Request} request */
export function readTkCookie(request) {
  const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === TK_COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}

/* ---------- 输错限速 ---------- */

/** 是否在冷却中（本 IP 或全站暂停）。KV 出错抛错。 @param {any} kv @param {string} ip */
export async function isTempkeyLimited(kv, ip) {
  const now = Date.now();
  const g = await kv.get(GLOBAL_KEY, 'json');
  if (g && g.pausedUntil > now) return true;
  const r = await kv.get(FAIL_PREFIX + ip, 'json');
  return !!(r && r.lockedUntil > now);
}

/** 记一次输错；返回这次是否刚进入冷却。KV 出错抛错。 @param {any} kv @param {string} ip */
export async function recordTempkeyFail(kv, ip) {
  const now = Date.now();
  let locked = false;
  const r = (await kv.get(FAIL_PREFIX + ip, 'json')) || { count: 0 };
  r.count = (r.count || 0) + 1;
  if (r.count >= IP_MAX_FAIL) {
    r.lockedUntil = now + IP_LOCK_MS;
    r.count = 0;
    locked = true;
  }
  await kv.put(FAIL_PREFIX + ip, JSON.stringify(r), { expirationTtl: 3600 });
  const g = (await kv.get(GLOBAL_KEY, 'json')) || { count: 0, windowStart: now };
  if (!g.windowStart || g.windowStart + GLOBAL_WINDOW_MS < now) {
    g.count = 0;
    g.windowStart = now;
  }
  g.count = (g.count || 0) + 1;
  if (g.count >= GLOBAL_MAX_FAIL) {
    g.pausedUntil = now + GLOBAL_PAUSE_MS;
    g.count = 0;
    locked = true;
  }
  await kv.put(GLOBAL_KEY, JSON.stringify(g), { expirationTtl: 7200 });
  return locked;
}

/** 输对后清掉这个 IP 的计数（失败不影响） @param {any} kv @param {string} ip */
export async function clearTempkeyFail(kv, ip) {
  try { await kv.delete(FAIL_PREFIX + ip); } catch (e) {}
}
