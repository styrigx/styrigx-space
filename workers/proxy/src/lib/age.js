/**
 * 最小 age v1 加密：只有 X25519 收件人、只输出 ASCII armor（mihomo age-secret-key 认的格式）。
 * X25519 / HKDF-SHA256 / HMAC-SHA256 用 WebCrypto；ChaCha20-Poly1305 用 node:crypto（wrangler.toml 开 nodejs_compat）。
 * 不用 typage：137 KB，CPU 超免费档（P0，2026-11-09）。本实现 1000 节点 p50 约 4 ms。
 * 只加密，不解密：Worker 没有私钥。
 */
import nodeCrypto from 'node:crypto';

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHUNK = 65536;

function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const v of values) {
    const b = c >>> 25;
    c = ((c & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= G[i];
  }
  return c;
}

/**
 * bech32 解码（age 公钥）。格式不对抛错。
 * @param {string} s
 * @returns {{ hrp: string, data: Uint8Array }}
 */
export function bech32Decode(s) {
  if (typeof s !== 'string' || s.length > 200 || s !== s.toLowerCase()) throw new Error('bech32');
  const p = s.lastIndexOf('1');
  if (p < 1 || s.length - p < 7) throw new Error('bech32');
  const hrp = s.slice(0, p);
  const d = [...s.slice(p + 1)].map((ch) => {
    const v = CHARSET.indexOf(ch);
    if (v < 0) throw new Error('bech32');
    return v;
  });
  const he = [...hrp].map((ch) => ch.charCodeAt(0) >> 5).concat([0], [...hrp].map((ch) => ch.charCodeAt(0) & 31));
  if (polymod(he.concat(d)) !== 1) throw new Error('bech32');
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of d.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) throw new Error('bech32');
  return { hrp, data: new Uint8Array(out) };
}

/** 是不是 age X25519 公钥（age1…，32 字节） @param {unknown} s */
export function isX25519Recipient(s) {
  try {
    const { hrp, data } = bech32Decode(/** @type {string} */ (s));
    return hrp === 'age' && data.length === 32;
  } catch (e) {
    return false;
  }
}

const b64raw = (u) => Buffer.from(u).toString('base64').replace(/=+$/, '');
const wrap64 = (s) => (s.match(/.{1,64}/g) || ['']).join('\n');

async function hkdf(ikm, salt, info) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, k, 256));
}

function seal(key, nonce, pt) {
  const c = nodeCrypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}

/**
 * 用 age X25519 公钥加密，回 ASCII armor。
 * @param {string} recipient age1…
 * @param {string | Uint8Array} plaintext
 * @returns {Promise<string>}
 */
export async function encryptArmor(recipient, plaintext) {
  const { hrp, data: R } = bech32Decode(recipient);
  if (hrp !== 'age' || R.length !== 32) throw new Error('recipient');
  const fileKey = nodeCrypto.randomBytes(16);
  const eph = /** @type {CryptoKeyPair} */ (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']));
  const ePub = new Uint8Array(/** @type {ArrayBuffer} */ (await subtle.exportKey('raw', eph.publicKey)));
  const rKey = await subtle.importKey('raw', R, { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: rKey }, eph.privateKey, 256));
  if (shared.every((b) => b === 0)) throw new Error('low-order');
  const salt = new Uint8Array(64);
  salt.set(ePub);
  salt.set(R, 32);
  const wrapKey = await hkdf(shared, salt, 'age-encryption.org/v1/X25519');
  const body = b64raw(seal(wrapKey, Buffer.alloc(12), fileKey));
  let hdr = 'age-encryption.org/v1\n-> X25519 ' + b64raw(ePub) + '\n' + wrap64(body) + (body.length % 64 === 0 ? '\n' : '') + '\n---';
  const macKey = await subtle.importKey('raw', await hkdf(fileKey, new Uint8Array(0), 'header'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  hdr += ' ' + b64raw(new Uint8Array(await subtle.sign('HMAC', macKey, te.encode(hdr)))) + '\n';
  const nonce = nodeCrypto.randomBytes(16);
  const payloadKey = await hkdf(fileKey, nonce, 'payload');
  const pt = typeof plaintext === 'string' ? te.encode(plaintext) : plaintext;
  const n = Math.max(1, Math.ceil(pt.length / CHUNK));
  const parts = [te.encode(hdr), nonce];
  for (let i = 0; i < n; i++) {
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(Math.floor(i / 2 ** 32), 3);
    iv.writeUInt32BE(i >>> 0, 7);
    if (i === n - 1) iv[11] = 1;
    parts.push(seal(payloadKey, iv, pt.subarray(i * CHUNK, (i + 1) * CHUNK)));
  }
  const bin = Buffer.concat(parts);
  return '-----BEGIN AGE ENCRYPTED FILE-----\n' + wrap64(bin.toString('base64')) + '\n-----END AGE ENCRYPTED FILE-----\n';
}
