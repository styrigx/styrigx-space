/**
 * 密码哈希与校验（v6：identity-auth.js 按用户存记录）。旧 account_password 单行表的读写、session / reauth 的「输一次密码」与
 * 限速 password-limit.js 随旧账号会话删除（v6 清理 #11/#12：没有调用方）。
 *
 * - PBKDF2-SHA256 + 随机 salt + pepper，恒定时间比较。pepper = SGX_ACCOUNT_PASSWORD_PEPPER（账号独占；
 *   命名 v2 起不再和网关共用 pepper，所以 0005 迁移不搬旧哈希：账号密码要用恢复密钥重设一次）
 * - 迭代次数 100000（Cloudflare Workers PBKDF2 上限，超过抛 NotSupportedError）；校验按记录里的 iterations
 * - 记录：{ salt, hash, iterations, peppered: true, updatedAt }
 *
 * 只 import workers/account/src/lib/ 和本目录。
 */
import { b64enc, b64dec, timingSafeEqual } from '../lib/crypto.js';

export const ITERATIONS = 100000; // Workers PBKDF2 上限（实测：超过抛 NotSupportedError）
const SALT_LEN = 16;
const KEY_LEN = 32; // 256 bit

/** @param {string} password @param {Uint8Array} salt @param {number} iterations @param {string} pepper */
async function hashPassword(password, salt, iterations, pepper) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password + pepper), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, key, KEY_LEN * 8);
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
