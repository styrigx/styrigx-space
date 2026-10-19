/**
 * 密码哈希与校验（纯重构：从 api/owner-password.js 原样搬到内核，供各凭证域共用）。
 *
 * - PBKDF2-SHA256 + 随机 salt + pepper（SGX_PW_PEPPER），恒定时间比较
 * - fix/hi-owner：迭代次数 100000（Cloudflare Workers PBKDF2 上限，超过抛 NotSupportedError）；
 *   校验按记录里的 iterations
 * - 旧记录（无 peppered 标记）按无 pepper 校验，成功则 needsRehash=true
 * - 每个凭证域的密码存在哪个 KV 键，见 realms.js 的 realm.kv.password
 *   （lock → 'lock-pw'，owner → 'owner-pw'）
 */
import { b64enc, b64dec, timingSafeEqual } from './crypto.js';
import { REALM_ACCOUNT } from './realms.js';

export const ITERATIONS = 100000; // Workers PBKDF2 上限（实测：超过抛 NotSupportedError）
const SALT_LEN = 16;
const KEY_LEN = 32; // 256 bit

/**
 * 2.11：密码哈希加 pepper（SGX_PW_PEPPER）。
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
 * 获取 pepper（SGX_PW_PEPPER，锁屏密码与站长密码共用）；缺失时返回空（调用方 fail closed）。
 * @param {any} env
 */
export function getPepper(env) {
  return (env && env[REALM_ACCOUNT.pepper]) || '';
}

/**
 * 校验一把密码（2.11 定稿抽出，供 /api/stepup verify-password 和 /api/lockreset 复用）。
 * - stored 为空 → { ok:false, set:false }
 * - peppered 记录：带 pepper 校验
 * - 旧记录（无 peppered 标记）：按无 pepper 校验，成功则 needsRehash=true
 * @param {object|null} stored kv.get(key,'json') 的结果
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
 * 校验某个凭证域的密码（读 realm.kv.password）。KV 出错时抛错（调用方返回 503）。
 * @param {any} kv
 * @param {{kv:{password:string}}} realm REALM_LOCK / REALM_ACCOUNT
 * @param {string} pepper
 * @param {string} password
 * @returns {Promise<{ok:boolean, set:boolean, needsRehash:boolean}>}
 */
export async function verifyRealmPassword(kv, realm, pepper, password) {
  const stored = await kv.get(realm.kv.password, 'json'); /* 出错直接抛 */
  return checkPasswordRecord(stored, password, pepper);
}
