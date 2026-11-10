/**
 * 代理订阅测试用件：
 * - makeProxyD1()：D1 styrigx-proxy 的 node:sqlite 替身（跑 workers/proxy-rules/migrations/*.sql；接口同 Cloudflare D1）
 * - ageIdentity() / ageDecrypt(armor, identity)：测试里自己解 age armor（X25519），核对 Worker 加密的成品手机能解
 * - DB_KEY：测试用 base64 32 字节钥匙
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import nodeCrypto from 'node:crypto';

const MIG = new URL('../../../workers/proxy-rules/migrations/', import.meta.url).pathname;
const norm = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x));

export const DB_KEY = Buffer.alloc(32, 7).toString('base64');

export function makeProxyD1() {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).filter((n) => n.endsWith('.sql')).sort()) raw.exec(readFileSync(MIG + f, 'utf8'));
  const exec1 = (sql, params) => {
    const st = raw.prepare(sql);
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...params), meta: { changes: 0 } };
    const r = st.run(...params);
    return { results: [], meta: { changes: Number(r.changes) } };
  };
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, norm(p)),
    async all() { return exec1(sql, params); },
    async run() { return exec1(sql, params); },
    async first(col) { const row = exec1(sql, params).results[0]; if (!row) return null; return col ? row[col] : row; },
  });
  /* batch：同 D1，一个事务里按顺序跑，任一条失败整批回滚 */
  const batch = async (list) => {
    raw.exec('BEGIN');
    try { const out = []; for (const s of list) out.push(await s.run()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
  };
  return { raw, prepare: (sql) => stmt(sql), batch, rows: (t) => raw.prepare('SELECT * FROM ' + t).all() };
}

const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Encode(hrp, data) {
  const pm = (v) => { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= G[i]; } return c; };
  const five = []; let acc = 0; let bits = 0;
  for (const b of data) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; five.push((acc >> bits) & 31); } }
  if (bits) five.push((acc << (5 - bits)) & 31);
  const he = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const p = pm(he.concat(five, [0, 0, 0, 0, 0, 0])) ^ 1;
  const cs = [0, 1, 2, 3, 4, 5].map((i) => (p >> (5 * (5 - i))) & 31);
  return hrp + '1' + five.concat(cs).map((v) => CH[v]).join('');
}

/** 测试用 X25519 身份 @returns {Promise<{ recipient: string, privateKey: CryptoKey }>} */
export async function ageIdentity() {
  const kp = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { recipient: bech32Encode('age', pub), privateKey: kp.privateKey, pub };
}

const te = new TextEncoder();
async function hkdf(ikm, salt, info) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, k, 256));
}
const open = (key, nonce, ct) => { const d = nodeCrypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 }); d.setAuthTag(ct.subarray(ct.length - 16)); return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]); };
const unb64 = (s) => Buffer.from(s, 'base64');

/** 解 age armor（只认一个 X25519 收件人），MAC 或 tag 不对抛错 @param {string} armor @param {{privateKey: CryptoKey, pub: Uint8Array}} id */
export async function ageDecrypt(armor, id) {
  const m = /^-----BEGIN AGE ENCRYPTED FILE-----\n([\s\S]+)\n-----END AGE ENCRYPTED FILE-----\n$/.exec(armor);
  if (!m) throw new Error('armor');
  const bin = Buffer.from(m[1].replace(/\n/g, ''), 'base64');
  const end = bin.indexOf('\n---');
  const lineEnd = bin.indexOf('\n', end + 1);
  const hdr = bin.subarray(0, end + 4).toString();
  const mac = bin.subarray(end + 5, lineEnd).toString();
  const lines = hdr.split('\n');
  if (lines[0] !== 'age-encryption.org/v1') throw new Error('version');
  const [, kind, eph] = lines[1].split(' ');
  if (kind !== 'X25519') throw new Error('stanza');
  const ePub = unb64(eph);
  const ek = await crypto.subtle.importKey('raw', ePub, { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: ek }, id.privateKey, 256));
  const salt = new Uint8Array(64); salt.set(ePub); salt.set(id.pub, 32);
  const fileKey = open(await hkdf(shared, salt, 'age-encryption.org/v1/X25519'), Buffer.alloc(12), unb64(lines[2]));
  const mk = await crypto.subtle.importKey('raw', await hkdf(fileKey, new Uint8Array(0), 'header'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('HMAC', mk, unb64(mac), te.encode(hdr)))) throw new Error('mac');
  const rest = bin.subarray(lineEnd + 1);
  const nonce = rest.subarray(0, 16);
  const pk = await hkdf(fileKey, nonce, 'payload');
  const body = rest.subarray(16);
  const out = [];
  const CS = 65536 + 16;
  const n = Math.max(1, Math.ceil(body.length / CS));
  for (let i = 0; i < n; i++) {
    const iv = Buffer.alloc(12); iv.writeUInt32BE(i >>> 0, 7); if (i === n - 1) iv[11] = 1;
    out.push(open(pk, iv, body.subarray(i * CS, (i + 1) * CS)));
  }
  return Buffer.concat(out).toString();
}
