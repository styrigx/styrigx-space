/**
 * 共享加密工具（各凭证接口共用）。
 *
 * timingSafeEqual：先对两边各做一次 SHA-256 再比较，避免长度不等时提前返回泄露长度信息。
 * Ed25519 签名 / 验签：会话票、reauth 票都用它；签名串由调用方带用途前缀做域隔离。
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

/** @param {string} s */
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
