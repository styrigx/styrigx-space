/**
 * 共享加密工具（owner-auth / owner-password / owner-passkey 共用）。
 *
 * timingSafeEqual：先对两边各做一次 SHA-256 再比较，避免长度不等时提前返回泄露长度信息。
 * HMAC 统一加用途前缀（"sess|"、"owner-auth|"、"pk-ch|"），一把密钥只签一种东西。
 */

/** @param {ArrayBuffer|Uint8Array} s */
export function b64enc(s) {
  const u8 = s instanceof Uint8Array ? s : new Uint8Array(s);
  return btoa(String.fromCharCode(...u8));
}

/** @param {string} b64 */
export function b64dec(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

/** @param {string} b64 */
export function b64urlEnc(s) {
  return b64enc(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 恒定时间比较（防时序攻击 + 防长度泄露）。
 * 两边先各做 SHA-256，长度恒为 32 字节，再逐字节比较。
 * @param {string} a
 * @param {string} b
 */
export async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const ba = new Uint8Array(ha);
  const bb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/**
 * HMAC-SHA256 签名，带用途前缀。
 * @param {string} secret
 * @param {string} purpose 用途前缀，如 "sess|", "owner-auth|", "pk-ch|"
 * @param {string} payload
 */
export async function hmacSign(secret, purpose, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const bits = await crypto.subtle.sign('HMAC', key, enc.encode(purpose + payload));
  return b64urlEnc(bits);
}

/**
 * 验证 HMAC 签名。
 * @param {string} secret
 * @param {string} purpose
 * @param {string} payload
 * @param {string} sig
 */
export async function hmacVerify(secret, purpose, payload, sig) {
  const expect = await hmacSign(secret, purpose, payload);
  return timingSafeEqual(sig, expect);
}
