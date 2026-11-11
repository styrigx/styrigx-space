/**
 * WebAuthn 注册凭据的 Node 端合成（Item 25 起的共享 helper）。
 * - makeKV：内存 KV（tests/workers/_harness.cjs，和 Worker 单测同一份，这里转出）。
 * - makeAttestationCredential：Node 端合成 WebAuthn 注册 attestation
 *   （UV=1；CDP 虚拟认证器开 UV 会抛 NotAllowedError，故不用浏览器仪式）。
 * v6 P4（定稿 v5.3 §十三）：凭证类 API 真请求 e2e（api-credential.spec.js：lock-password / lock-passkey / lock-reauth、
 *   旧账号 /api/account/reset / keys / session）只测已删接口，随后端删旧删除；它的测试服务器 startCredentialTestServer 一并拿掉。
 */
/* 内存 KV：和 Worker 单测同一份（tests/workers/_harness.cjs） */
const { makeKV } = require('../../../workers/_harness.cjs');

/* ---------------- 最小 CBOR 编码器 ---------------- */
function concatU8(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function cborHead(major, len) {
  if (len < 24) return Uint8Array.of((major << 5) | len);
  if (len < 256) return Uint8Array.of((major << 5) | 24, len);
  return Uint8Array.of((major << 5) | 25, (len >> 8) & 0xff, len & 0xff);
}
function cborInt(n) {
  if (n >= 0) {
    if (n < 24) return Uint8Array.of(n);
    if (n < 256) return Uint8Array.of(0x18, n);
    return Uint8Array.of(0x19, (n >> 8) & 0xff, n & 0xff);
  }
  const v = -1 - n; // major 1：-1-n 编码
  if (v < 24) return Uint8Array.of(0x20 | v);
  if (v < 256) return Uint8Array.of(0x38, v);
  return Uint8Array.of(0x39, (v >> 8) & 0xff, v & 0xff);
}
function cborTstr(s) {
  const b = new TextEncoder().encode(s);
  return concatU8(cborHead(3, b.length), b);
}
function cborBstr(b) {
  return concatU8(cborHead(2, b.length), b);
}
function cborMap(pairs) {
  const parts = [cborHead(5, pairs.length)];
  for (const [k, v] of pairs) {
    parts.push(typeof k === 'string' ? cborTstr(k) : cborInt(k));
    if (typeof v === 'string') parts.push(cborTstr(v));
    else if (typeof v === 'number') parts.push(cborInt(v));
    else if (v instanceof Uint8Array) parts.push(cborBstr(v));
    else if (v instanceof Map) parts.push(cborMap([...v]));
    else throw new Error('cbor: unsupported value');
  }
  return concatU8(...parts);
}

/* ---------------- 合成 WebAuthn 注册 attestation（UV=1） ---------------- */
function u8ToB64url(u8) {
  return Buffer.from(u8).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToU8(s) {
  return Uint8Array.from(Buffer.from(
    s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

async function makeAttestationCredential(challengeB64url, rpId, origin) {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const x = b64urlToU8(jwk.x);
  const y = b64urlToU8(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error('bad P-256 key');
  const credId = crypto.getRandomValues(new Uint8Array(32));
  // COSE_Key：{1: kty=EC2(2), 3: alg=ES256(-7), -1: crv=P-256(1), -2: x, -3: y}
  const coseKey = cborMap([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]);
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  const flags = 0x45; // UP(0x01) | UV(0x04) | AT(0x40)，服务端要求 UV=1
  const aaguid = new Uint8Array(16); // 全 0（测试用）
  const authData = concatU8(
    rpIdHash,
    Uint8Array.of(flags, 0, 0, 0, 0), // flags + signCount(0)
    aaguid,
    Uint8Array.of((credId.length >> 8) & 0xff, credId.length & 0xff),
    credId,
    coseKey
  );
  // attestationObject 是文本键 CBOR map（服务端按文本键 "authData" 取）
  const attestationObject = cborMap([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authData],
  ]);
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: 'webauthn.create',
    challenge: challengeB64url,
    origin,
  }));
  return {
    id: u8ToB64url(credId),
    rawId: u8ToB64url(credId),
    type: 'public-key',
    response: {
      clientDataJSON: u8ToB64url(clientDataJSON),
      attestationObject: u8ToB64url(attestationObject),
    },
  };
}

module.exports = { makeKV, makeAttestationCredential };
