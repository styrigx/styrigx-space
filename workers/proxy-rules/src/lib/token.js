/**
 * 下载令牌：32 字节随机，base64url（43 位）。
 * 库里存两份（meta 表，同一次 batch 写）：
 * - token_hash：SHA-256（hex），下载时只比它，常量时间；下载不读 DB_KEY。
 * - token_sealed：用 SGX_PROXY_DB_KEY 封存的原文（AES-256-GCM，附加数据 TOKEN_AAD），只给 sub show 重印地址用。
 */
const te = new TextEncoder();

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** 封存令牌的附加数据（防止把别处的密文搬来当令牌） */
export const TOKEN_AAD = 'meta:token';

export function newToken() {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/** @param {string} token @returns {Promise<string>} */
export async function hashToken(token) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', te.encode(token));
  return Buffer.from(new Uint8Array(d)).toString('hex');
}

/** 常量时间比较两个同长 hex 串（长度不同直接 false） @param {string} a @param {string} b */
export function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
