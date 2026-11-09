/**
 * 密码哈希与校验（网关只有锁屏域；账号 Worker 自己一份代码）。
 *
 * - PBKDF2-SHA256 + 随机 salt + pepper（SGX_SPACE_PASSWORD_PEPPER），恒定时间比较
 * - 迭代次数 100000（Cloudflare Workers PBKDF2 上限，超过抛 NotSupportedError）；
 *   校验按记录里的 iterations
 * - 旧记录（无 peppered 标记）按无 pepper 校验，成功则 needsRehash=true
 * - 记录存在 D1 password 表（每个凭证域一行，d1-state.js；2026-10-27 从 KV 搬来：改密码后下一个请求就认新密码、不再认旧密码）
 */
import { b64enc, b64dec, timingSafeEqual } from '../lib/crypto.js';
import { getPasswordRecord, putPasswordRecord, deletePasswordRecord } from './d1-state.js';

export const ITERATIONS = 100000; // Workers PBKDF2 上限（实测：超过抛 NotSupportedError）
const SALT_LEN = 16;
const KEY_LEN = 32; // 256 bit

/**
 * 2.11：密码哈希加 pepper（SGX_SPACE_PASSWORD_PEPPER）。
 * pepper 为空时按无 pepper 哈希（仅用于校验旧 hash；新 hash 必须有 pepper，
 * 调用方负责 fail closed）。
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @param {string} pepper
 */
async function hashPassword(password, salt, iterations, pepper) {
  const enc = new TextEncoder();
  const pwd = pepper ? password + pepper : password;
  const key = await crypto.subtle.importKey('raw', enc.encode(pwd), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
    key,
    KEY_LEN * 8
  );
  return bits;
}

/**
 * pepper 的 Secrets Store 密钥名（不改名）。只给锁屏密码和临时钥匙码用，网关 core/realms.js 的 REALM_LOCK.pepper 同值；
 * 账号命名 v2 起账号密码用账号 Worker 自己的 pepper，不再共用这个密值。
 */
export const PEPPER_SECRET = 'SGX_SPACE_PASSWORD_PEPPER';

/**
 * 获取 pepper（SGX_SPACE_PASSWORD_PEPPER，锁屏专用）；缺失时返回空（调用方 fail closed）。
 * @param {any} env
 */
export function getPepper(env) {
  return (env && env[PEPPER_SECRET]) || '';
}

/**
 * 校验一把密码（供解锁和 /api/lock-reset 复用）。
 * - stored 为空 → { ok:false, set:false }
 * - peppered 记录：带 pepper 校验
 * - 旧记录（无 peppered 标记）：按无 pepper 校验，成功则 needsRehash=true
 * @param {object|null} stored getPassword 的结果（D1 password 表的记录）
 * @param {string} password
 * @param {string} pepper
 * @returns {Promise<{ok:boolean, set:boolean, needsRehash:boolean}>}
 */
export async function checkPasswordRecord(stored, password, pepper) {
  if (!stored || !stored.salt || !stored.hash) {
    return { ok: false, set: false, needsRehash: false };
  }
  const iters = (stored.iterations && Number(stored.iterations)) || ITERATIONS;
  const salt = new Uint8Array(b64dec(stored.salt));
  if (stored.peppered) {
    const bits = await hashPassword(password, salt, iters, pepper);
    const ok = await timingSafeEqual(b64enc(bits), stored.hash);
    return { ok, set: true, needsRehash: false };
  }
  const bits = await hashPassword(password, salt, iters, '');
  const ok = await timingSafeEqual(b64enc(bits), stored.hash);
  return { ok, set: true, needsRehash: ok };
}

/**
 * 生成一条新的 peppered 密码记录。
 * @param {string} password
 * @param {string} pepper
 */
export async function makePasswordRecord(password, pepper) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const bits = await hashPassword(password, salt, ITERATIONS, pepper);
  return {
    salt: b64enc(salt.buffer),
    hash: b64enc(bits),
    iterations: ITERATIONS,
    peppered: true,
    updatedAt: Date.now(),
  };
}

/**
 * 读某个凭证域的密码记录（没设置 → null）。出错抛错（调用方返回 503）。
 * @param {any} env
 * @param {{id:string}} realm REALM_LOCK（账号拆分 PR3 起网关只有锁屏域）
 */
export async function getPassword(env, realm) {
  return getPasswordRecord(env, realm);
}

/**
 * 某个凭证域是否设置了密码（记录里有 hash）。出错抛错。
 * @param {any} env @param {{id:string}} realm
 * @returns {Promise<boolean>}
 */
export async function hasPassword(env, realm) {
  const r = await getPasswordRecord(env, realm);
  return !!(r && r.hash);
}

/**
 * 写某个凭证域的密码记录（makePasswordRecord 的结果）。出错抛错。
 * @param {any} env @param {{id:string}} realm @param {any} rec
 */
export async function savePassword(env, realm, rec) {
  await putPasswordRecord(env, realm, rec);
}

/**
 * 删某个凭证域的密码。出错抛错。
 * @param {any} env @param {{id:string}} realm
 */
export async function deletePassword(env, realm) {
  await deletePasswordRecord(env, realm);
}

/**
 * 校验某个凭证域的密码。读出错时抛错（调用方返回 503）。
 * @param {any} env
 * @param {{id:string}} realm REALM_LOCK（账号拆分 PR3 起网关只有锁屏域）
 * @param {string} pepper
 * @param {string} password
 * @returns {Promise<{ok:boolean, set:boolean, needsRehash:boolean}>}
 */
export async function verifyRealmPassword(env, realm, pepper, password) {
  const stored = await getPasswordRecord(env, realm); /* 出错直接抛 */
  return checkPasswordRecord(stored, password, pepper);
}
