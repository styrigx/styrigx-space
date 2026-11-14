/**
 * 库内字段加密（SGX_PROXY_DB_KEY，AES-256-GCM）：每条随机 12 字节 IV；附加数据 = 行 id + 字段名，防止把密文搬到别的行或别的列。
 * 存成文本 `v1.<iv>.<密文+tag>`（base64url）。钥匙是 base64 的 32 字节（openssl rand -base64 32）；长度不对 → 抛错（fail closed）。
 */
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

const b64u = (u) => Buffer.from(u).toString('base64url');
const unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

/** @param {string} b64 @returns {Promise<CryptoKey>} */
export async function importDbKey(b64) {
  const raw = typeof b64 === 'string' ? new Uint8Array(Buffer.from(b64.trim(), 'base64')) : new Uint8Array(0);
  if (raw.length !== 32) throw new Error('db-key');
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** @param {CryptoKey} key @param {string} aad @param {string} text */
export async function seal(key, aad, text) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, te.encode(text));
  return 'v1.' + b64u(iv) + '.' + b64u(new Uint8Array(ct));
}

/** @param {CryptoKey} key @param {string} aad @param {string} sealed @returns {Promise<string>} */
export async function open(key, aad, sealed) {
  const m = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/.exec(String(sealed || ''));
  if (!m) throw new Error('sealed');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(m[1]), additionalData: te.encode(aad) }, key, unb64u(m[2]));
  return td.decode(pt);
}
