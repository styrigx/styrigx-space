/**
 * 测试用：临时 LockKey 的钥匙票（sgx-tk）。
 * 2026-10-23 起访客会话必须带钥匙票，测试里的「访客」都用 withTk() 包一下：
 * 返回值是「会话值; sgx-tk=钥匙票」，拼成 'sgx-verified=' + 返回值 就是带两个 cookie 的 Cookie 头。
 */
import { ed25519Sign } from '../../../workers/auth-gateway/functions/_kernel/crypto.js';

export const TEST_TK_ID = 'tktesttesttest01';

/**
 * @param {string} privPem SGX_LOCK_PRIVATE
 * @param {number} [ttlMs]
 * @param {string} [id]
 */
export async function signTestTk(privPem, ttlMs, id) {
  const tid = id || TEST_TK_ID;
  const exp = Date.now() + (ttlMs || 3600 * 1000);
  const payload = tid + '.' + exp;
  return payload + '.' + (await ed25519Sign(privPem, 'tk|' + payload));
}

/**
 * @param {string} privPem
 * @param {string} sess visitor 会话值
 */
export async function withTk(privPem, sess) {
  return sess + '; sgx-tk=' + (await signTestTk(privPem));
}

/**
 * 按角色签测试会话：visitor 自动带钥匙票，其它原样。
 * @param {Function} signFn signSessionCookie
 * @param {string} privPem
 * @param {number} epoch
 * @param {string} role
 * @param {string} [by]
 */
export async function signRole(signFn, privPem, epoch, role, by) {
  const v = await signFn(privPem, epoch, role, by);
  return role === 'visitor' ? withTk(privPem, v) : v;
}
