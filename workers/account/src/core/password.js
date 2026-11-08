/**
 * 账号密码（account_password 表，单行 id = 1）：哈希、校验、读写，以及 session / reauth 共用的「输一次密码」这一步。
 *
 * - PBKDF2-SHA256 + 随机 salt + pepper，恒定时间比较。pepper = SGX_ACCOUNT_PASSWORD_PEPPER（账号独占；
 *   命名 v2 起不再和网关共用 pepper，所以 0005 迁移不搬旧哈希：账号密码要用恢复密钥重设一次）
 * - 迭代次数 100000（Cloudflare Workers PBKDF2 上限，超过抛 NotSupportedError）；校验按记录里的 iterations
 * - 记录：{ salt, hash, iterations, peppered: true, updatedAt }
 * - 限速：core/password-limit.js（kind = password；session 和 reauth 输错的是同一把密码，共用一个计数）
 *
 * 只 import workers/account/src/lib/ 和本目录。
 */
import { b64enc, b64dec, timingSafeEqual } from '../lib/crypto.js';
import { onDb, parseRecord } from '../lib/db.js';
import { apiError } from '../lib/http.js';
import { PASSWORD_PEPPER_SECRET } from './config.js';
import { passwordLimit } from './password-limit.js';
import { writeAudit } from './audit.js';

export { PASSWORD_PEPPER_SECRET };

export const ITERATIONS = 100000; // Workers PBKDF2 上限（实测：超过抛 NotSupportedError）
const SALT_LEN = 16;
const KEY_LEN = 32; // 256 bit
/** 最短长度（设置 / 重设时） */
export const PASSWORD_MIN_LENGTH = 8;

/** @param {string} password @param {Uint8Array} salt @param {number} iterations @param {string} pepper */
async function hashPassword(password, salt, iterations, pepper) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password + pepper), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, key, KEY_LEN * 8);
}

/** pepper（SGX_ACCOUNT_PASSWORD_PEPPER）；缺失返回空（调用方 fail closed：503 config） @param {any} env */
export function getPepper(env) {
  return (env && env[PASSWORD_PEPPER_SECRET]) || '';
}

/**
 * 校验一把密码。stored 为空或不是带 pepper 的记录 → { ok:false, set:false }。
 * @param {any} stored @param {string} password @param {string} pepper
 * @returns {Promise<{ok:boolean, set:boolean}>}
 */
export async function checkPasswordRecord(stored, password, pepper) {
  if (!stored || !stored.salt || !stored.hash || !stored.peppered || !pepper) return { ok: false, set: false };
  const iters = (stored.iterations && Number(stored.iterations)) || ITERATIONS;
  const bits = await hashPassword(password, new Uint8Array(b64dec(stored.salt)), iters, pepper);
  return { ok: await timingSafeEqual(b64enc(bits), stored.hash), set: true };
}

/** 新的密码记录 @param {string} password @param {string} pepper */
export async function makePasswordRecord(password, pepper) {
  if (!pepper) throw new Error('pepper-missing');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const bits = await hashPassword(password, salt, ITERATIONS, pepper);
  return { salt: b64enc(salt.buffer), hash: b64enc(bits), iterations: ITERATIONS, peppered: true, updatedAt: Date.now() };
}

/** 密码记录（没设置 → null）。出错抛错。 @param {any} env */
export async function getPassword(env) {
  return onDb(env, async (d) => parseRecord(await d.prepare('SELECT record FROM account_password WHERE id = 1').first()));
}

/** 是否设置了密码。出错抛错。 @param {any} env */
export async function hasPassword(env) {
  const r = await getPassword(env);
  return !!(r && r.hash && r.peppered);
}

/** 写密码记录（设置 / 重设）。出错抛错。 @param {any} env @param {any} rec */
export async function savePassword(env, rec) {
  await onDb(env, (d) => d.prepare('INSERT INTO account_password (id, record) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record')
    .bind(JSON.stringify(rec)).run());
}

/**
 * 校验账号密码。读出错时抛错（调用方 503）。
 * @param {any} env @param {string} pepper @param {string} password
 */
export async function verifyPassword(env, pepper, password) {
  return checkPasswordRecord(await getPassword(env), password, pepper);
}

/**
 * session / reauth 共用的「输一次密码」：冷却 → 校验 → 输错计数（刚进入冷却写审计 password-cooldown）→ 验对清计数。
 * 成功 { ok:true }；失败 { ok:false, response }（400 params / 503 config / 429 cooldown / 403 not-set / 403 wrong / 503 server）。
 * @param {any} env @param {string} ip @param {any} password
 * @returns {Promise<{ok:true}|{ok:false, response:Response}>}
 */
export async function checkPasswordAttempt(env, ip, password) {
  if (!password || typeof password !== 'string') return { ok: false, response: apiError(400, 'params') };
  const pepper = getPepper(env);
  if (!pepper) return { ok: false, response: apiError(503, 'config') };
  const limiter = passwordLimit(env, ip);
  try {
    if (await limiter.inCooldown()) return { ok: false, response: apiError(429, 'cooldown') };
  } catch (e) {
    return { ok: false, response: apiError(503, 'server') };
  }
  let vr;
  try { vr = await verifyPassword(env, pepper, password); } catch (e) { return { ok: false, response: apiError(503, 'server') }; }
  if (!vr.set) return { ok: false, response: apiError(403, 'not-set') };
  if (!vr.ok) {
    let justCooled = false;
    try { justCooled = await limiter.recordFail(); } catch (e) { return { ok: false, response: apiError(503, 'server') }; }
    if (justCooled) {
      await writeAudit(env, ip, 'password-cooldown', false);
      return { ok: false, response: apiError(429, 'cooldown') };
    }
    return { ok: false, response: apiError(403, 'wrong') };
  }
  await limiter.clearFail();
  return { ok: true };
}

/**
 * keys / reset 共用的「设密码」：校验长度 → 写新记录。成功 { ok:true, changed }（changed = 原来有密码）；失败 { ok:false, response }。
 * @param {any} env @param {any} password
 * @returns {Promise<{ok:true, changed:boolean}|{ok:false, response:Response}>}
 */
export async function setPassword(env, password) {
  if (!password || typeof password !== 'string') return { ok: false, response: apiError(400, 'params') };
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, response: apiError(400, 'short') };
  const pepper = getPepper(env);
  if (!pepper) return { ok: false, response: apiError(503, 'config') };
  let existed = false;
  try {
    existed = await hasPassword(env);
    await savePassword(env, await makePasswordRecord(password, pepper));
  } catch (e) {
    return { ok: false, response: apiError(503, 'server') };
  }
  return { ok: true, changed: existed };
}
