/**
 * v6 身份统一（P2）：v6 用户的凭据——密码（account_user_password）验证 / 设置、一次性密码、两维限流、防枚举。
 *
 * - 哈希：沿用 core/password.js 的记录格式（PBKDF2-SHA256 + 盐 + pepper，记录里带 iterations）。不用 bcrypt / argon2（Worker CPU）。
 * - pepper 方案 a（ADR-0006 §2.12 (b)）：记录的 pepper_id 决定用哪把 pepper——只剩 'account' = SGX_ACCOUNT_PASSWORD_PEPPER。
 *   v6 P4（定稿 v5.2 §十三）起 'space'（SGX_SPACE_PASSWORD_PEPPER，从进站密码迁来的旧哈希）删除：部署前须核对生产库没有 pepper_id = 'space' 的行
 *   （docs/ops/v6-p4-predeploy-check.sql，只读）。不认识的 id / 缺 pepper → 验不过（fail closed）。
 * - 一次性密码（useradd / passwd <名>）：16 位以上随机，只显示一次，库里只存哈希；must_change = 1，expires_at = 签发 + 24 小时；
 *   过期的一次性密码一律验不过。
 * - 限流两维（定稿 v4 §十）：按 IP 硬上限（每分钟 6 次失败，满了冷却到窗口结束）；按用户名渐进退避（1s → 5s → 30s → 5min），不硬锁。
 *   只有失败才写计数；通行密钥不计入、也不受用户名冷却影响。计数按用户名分桶（不存在的用户名同样计数），所以存在与否看不出来。
 * - 防枚举：用户不存在、没设密码、密码错、一次性密码过期、用户已禁用 / 到期 → 同一个错误（auth），同一条耗时路径（照样算一次哈希）。
 *
 * 只 import lib/ 和 core/。
 */
import { b64enc } from '../lib/crypto.js';
import { onDb } from '../lib/db.js';
import { ipBucket } from '../lib/http.js';
import { readAttempt, recordAttempt, clearAttempt } from '../lib/attempt-limit.js';
import { checkPasswordRecord, makePasswordRecord, ITERATIONS } from './password.js';
import { ROOT_UID } from './groups.js';

/** pepper_id → Secrets Store 名（方案 a） */
export const PEPPERS = Object.freeze({ account: 'SGX_ACCOUNT_PASSWORD_PEPPER' });
/** 新写的哈希一律用这把 */
export const DEFAULT_PEPPER_ID = 'account';
/** 自己设的密码最短长度（同 core/password.js） */
export const USER_PASSWORD_MIN = 8;
/** 一次性密码长度（≥ 16，定稿 v4 §八） */
export const ONE_TIME_LENGTH = 20;
/** 一次性密码有效期：24 小时 */
export const ONE_TIME_TTL_MS = 24 * 3600 * 1000;
/** 一次性密码字母表：去掉 0 O 1 l I 这类易混字符（32 个字符，取模无偏） */
const ONE_TIME_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** IP 维度：每分钟最多 6 次失败 */
export const IP_LIMIT = Object.freeze({ kind: 'v6-ip', max: 6, windowMs: 60 * 1000 });
/** 用户名维度：渐进退避（第 1、2、3、4+ 次失败后的等待） */
export const NAME_BACKOFF_MS = Object.freeze([1000, 5000, 30000, 300000]);
const NAME_KIND = 'v6-name';
const NAME_TTL_MS = 24 * 3600 * 1000;

/** pepper_id 对应的 pepper（不认识 / 缺 → ''） @param {any} env @param {string} id */
export function pepperOf(env, id) {
  const name = Object.prototype.hasOwnProperty.call(PEPPERS, id) ? PEPPERS[/** @type {'account'} */ (id)] : '';
  return (name && env && typeof env[name] === 'string' && env[name]) || '';
}

/** 生成一次性密码（ONE_TIME_LENGTH 位，crypto 随机） */
export function oneTimePassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(ONE_TIME_LENGTH));
  let s = '';
  for (const b of bytes) s += ONE_TIME_ALPHABET[b % ONE_TIME_ALPHABET.length];
  return s;
}

/* 用户不存在 / 没设密码时也算一次哈希（同一条耗时路径） */
let dummyRecord = null;
async function burnHash(password) {
  if (!dummyRecord) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    dummyRecord = { salt: b64enc(salt.buffer), hash: 'x', iterations: ITERATIONS, peppered: true };
  }
  try { await checkPasswordRecord(dummyRecord, String(password || ''), 'dummy-pepper'); } catch (e) {}
}

/**
 * 按名字读用户 + 密码行（一次查询）。没有 → null。出错抛错。
 * @param {any} env @param {string} name
 */
export async function loadUserByName(env, name) {
  return onDb(env, async (d) => d.prepare(
    'SELECT u.uid, u.name, u.expires_at, u.epoch, u.disabled, p.record, p.pepper_id, p.must_change, p.expires_at AS pw_expires' +
    ' FROM account_users u LEFT JOIN account_user_password p ON p.uid = u.uid WHERE u.name = ?'
  ).bind(String(name)).first());
}

/** 按 uid 读同上 @param {any} env @param {number} uid */
export async function loadUserByUid(env, uid) {
  return onDb(env, async (d) => d.prepare(
    'SELECT u.uid, u.name, u.expires_at, u.epoch, u.disabled, p.record, p.pepper_id, p.must_change, p.expires_at AS pw_expires' +
    ' FROM account_users u LEFT JOIN account_user_password p ON p.uid = u.uid WHERE u.uid = ?'
  ).bind(uid).first());
}

/** @param {any} row */
function parseRec(row) {
  if (!row || typeof row.record !== 'string') return null;
  try { return JSON.parse(row.record); } catch (e) { return null; }
}

/**
 * 限流：这次能不能验（不能 → 'cooldown'）。出错抛错（调用方 503）。
 * @param {any} env @param {string} ip @param {string} name
 * @returns {Promise<boolean>} true = 冷却中
 */
export async function inCooldown(env, ip, name) {
  const now = Date.now();
  const byIp = await readAttempt(env, IP_LIMIT.kind, ipBucket(ip));
  if (byIp && byIp.lockedUntil > now) return true;
  const byName = await readAttempt(env, NAME_KIND, 'n:' + String(name));
  return !!(byName && byName.lockedUntil > now);
}

/** 记一次失败（两维）。出错抛错。 @param {any} env @param {string} ip @param {string} name */
export async function recordFailure(env, ip, name) {
  await recordAttempt(env, IP_LIMIT.kind, ipBucket(ip), { max: IP_LIMIT.max, ttlMs: IP_LIMIT.windowMs, lockMs: IP_LIMIT.windowMs });
  await recordAttempt(env, NAME_KIND, 'n:' + String(name), { max: 1, ttlMs: NAME_TTL_MS, lockTable: NAME_BACKOFF_MS.slice() });
}

/** 验对后清用户名维度（IP 维度按窗口自然过期）。尽力而为。 @param {any} env @param {string} name */
export async function clearFailures(env, name) {
  try { await clearAttempt(env, NAME_KIND, 'n:' + String(name)); } catch (e) {}
}

/**
 * 只验一行（不限流、不计数）：用户活着、密码记录对得上、一次性密码没过期。
 * @param {any} env @param {any} row loadUserBy* 的结果 @param {string} password @param {number} now
 * @returns {Promise<{ok:true, uid:number, name:string, mustChange:boolean, pepperId:string}|{ok:false}>}
 */
export async function checkRow(env, row, password, now) {
  const rec = parseRec(row);
  if (!row || !rec) { await burnHash(password); return { ok: false }; }
  const pepper = pepperOf(env, String(row.pepper_id || ''));
  if (!pepper) { await burnHash(password); return { ok: false }; }
  const r = await checkPasswordRecord(rec, String(password || ''), pepper);
  if (!r.ok) return { ok: false };
  const exp = Number(row.expires_at) || 0;
  if (Number(row.disabled) === 1 || (exp > 0 && exp <= now)) return { ok: false };
  const mustChange = Number(row.must_change) === 1;
  const pwExp = Number(row.pw_expires) || 0;
  if (mustChange && pwExp > 0 && pwExp <= now) return { ok: false };
  return { ok: true, uid: Number(row.uid), name: String(row.name), mustChange, pepperId: String(row.pepper_id) };
}

/**
 * 「输一次密码」：冷却 → 读用户 → 验 → 失败两维计数 / 成功清计数 → pepper 不是 account 就重算。
 * 永不抛错：{ ok:true, uid, name, mustChange } | { ok:false, error:'auth'|'cooldown'|'server'|'config' }。
 * @param {any} env @param {{ip:string, name?:string, uid?:number, password:any, now?:number}} q 按名字或 uid 找人
 */
export async function verifyUserPassword(env, q) {
  const now = typeof q.now === 'number' ? q.now : Date.now();
  if (!pepperOf(env, DEFAULT_PEPPER_ID)) return { ok: false, error: 'config' };
  let row = null;
  try {
    if (typeof q.uid === 'number') row = await loadUserByUid(env, q.uid);
    else row = await loadUserByName(env, String(q.name || ''));
  } catch (e) {
    return { ok: false, error: 'server' };
  }
  const bucket = typeof q.uid === 'number' ? (row ? String(row.name) : 'uid:' + q.uid) : String(q.name || '');
  try {
    if (await inCooldown(env, q.ip, bucket)) return { ok: false, error: 'cooldown' };
  } catch (e) {
    return { ok: false, error: 'server' };
  }
  const res = typeof q.password === 'string' && q.password ? await checkRow(env, row, q.password, now) : (await burnHash(''), { ok: false });
  if (!res.ok) {
    try { await recordFailure(env, q.ip, bucket); } catch (e) { return { ok: false, error: 'server' }; }
    return { ok: false, error: 'auth' };
  }
  await clearFailures(env, bucket);
  if (res.pepperId !== DEFAULT_PEPPER_ID && !res.mustChange) {
    try { await savePasswordFor(env, res.uid, /** @type {string} */ (q.password), { mustChange: false }); } catch (e) {
      console.error('[account-v6] pepper rehash failed, sign-in allowed');
    }
  }
  return { ok: true, uid: res.uid, name: res.name, mustChange: res.mustChange };
}

/**
 * 写某人的密码（新记录一律用账号 pepper，pepper_id = account）。opts.mustChange：一次性密码（24 小时到期）。出错抛错。
 * 不动 epoch（调用方用 core/users.js credentialsChanged 一起处理）。
 * @param {any} env @param {number} uid @param {string} password @param {{mustChange?:boolean, now?:number}} [opts]
 */
export async function savePasswordFor(env, uid, password, opts) {
  const pepper = pepperOf(env, DEFAULT_PEPPER_ID);
  if (!pepper) throw new Error('pepper-missing');
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const rec = await makePasswordRecord(password, pepper);
  const must = o.mustChange ? 1 : 0;
  const exp = o.mustChange ? now + ONE_TIME_TTL_MS : 0;
  await onDb(env, (d) => d.prepare(
    'INSERT INTO account_user_password (uid, record, pepper_id, must_change, expires_at) VALUES (?, ?, ?, ?, ?)' +
    ' ON CONFLICT (uid) DO UPDATE SET record = excluded.record, pepper_id = excluded.pepper_id, must_change = excluded.must_change, expires_at = excluded.expires_at'
  ).bind(uid, JSON.stringify(rec), DEFAULT_PEPPER_ID, must, exp).run());
}

/** 自己设的新密码合不合格（≥ 8 位字符串；不许和用户名相同） @param {any} pw @param {string} name */
export function passwordAcceptable(pw, name) {
  return typeof pw === 'string' && pw.length >= USER_PASSWORD_MIN && pw.length <= 512 && pw !== name;
}

/** root 的 uid（再导出给调用方少一次 import） */
export { ROOT_UID };
