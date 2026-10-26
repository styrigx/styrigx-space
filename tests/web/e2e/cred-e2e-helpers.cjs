/**
 * 凭证类 API 真请求 e2e 的共享 helper（Item 25）。
 * - makeKV：内存 KV（tests/workers/_harness.cjs，和 Worker 单测同一份，这里转出）。
 * - startCredentialTestServer(port)：启动本地测试服务器，/api/lock-password、
 *   /api/lock-passkey、/api/account、/api/lock-reauth 路由到 functions/api/ 下的真实 handler
 *  （onRequestPost），env 配测试密钥；返回 { kv, env, close, mintAuth }。
 * - makeAttestationCredential：Node 端合成 WebAuthn 注册 attestation
 *   （UV=1；CDP 虚拟认证器开 UV 会抛 NotAllowedError，故不用浏览器仪式）。
 * - mintAuth(by)：按当前 Lock 纪元重签 admin 锁屏会话 + LockReauthTicket（sgx-lock-reauth）
 * - mintAccount(by, authAt)：账号会话（sgx-account-session，by 只能 password|passkey）；mintAccountReauth(by)：AccountReauthTicket（sgx-account-reauth）；
 *   mintAccountReset()：AccountResetTicket（sgx-account-reset，by=root）
 *   （set/change/remove/register 会推进 epoch，每次鉴权操作前重签）。
 */
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
/* 内存 KV、DER→PEM：和 Worker 单测同一份（tests/workers/_harness.cjs） */
const { makeKV, derToPem } = require('../../workers/_harness.cjs');

const REPO = path.join(__dirname, '..', '..', '..');

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

/**
 * 启动凭证测试服务器。
 * @param {number} port 监听端口
 * @returns {Promise<{kv, env, origin, close, mintAuth}>}
 *   mintAuth(reauthBy) → { sessionCookie, reauthCookie }
 */
async function startCredentialTestServer(port) {
  const origin = `http://localhost:${port}`;
  const kv = makeKV();
  const lkp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privPem = derToPem(await crypto.subtle.exportKey('pkcs8', lkp.privateKey), 'PRIVATE KEY');
  const pubPem = derToPem(await crypto.subtle.exportKey('spki', lkp.publicKey), 'PUBLIC KEY');
  const env = {
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
    SGX_PW_PEPPER: 'e2e-test-pepper',
    SGX_LOCK_PRIVATE: privPem,
    SGX_LOCK_PUBLIC: pubPem,
    SGX_ACCOUNT_PRIVATE: privPem,
    SGX_ACCOUNT_PUBLIC: pubPem,
    SGX_RP_ID: 'localhost',
    SGX_ORIGIN: origin,
  };
  // 动态 import 用字符串拼接避开静态分析（Playwright 会误判 'import' 关键字）
  const dynImport = new Function('u', 'return ' + 'im' + 'port(u)');
  const pwMod = await dynImport(pathToFileURL(path.join(REPO, 'workers/auth-gateway/functions/api/lock-password.js')).href);
  const pkMod = await dynImport(pathToFileURL(path.join(REPO, 'workers/auth-gateway/functions/api/lock-passkey.js')).href);
  const sessMod = await dynImport(pathToFileURL(path.join(REPO, 'workers/auth-gateway/functions/_kernel/lock-session.js')).href);
  const doorApi = await dynImport(pathToFileURL(path.join(REPO, 'workers/auth-gateway/functions/api/lock-reauth.js')).href);
  const ticketsMod = await dynImport(pathToFileURL(path.join(REPO, 'workers/auth-gateway/functions/_kernel/tickets.js')).href);
  const acctMod = await dynImport(pathToFileURL(path.join(REPO, 'workers/auth-gateway/functions/api/account.js')).href);
  const acctSess = await dynImport(pathToFileURL(path.join(REPO, 'workers/auth-gateway/functions/_kernel/account-session.js')).href);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>e2e</title></head><body>e2e</body></html>');
        return;
      }
      let handler = null;
      if (req.url.startsWith('/api/lock-password')) handler = pwMod.onRequestPost;
      else if (req.url.startsWith('/api/lock-passkey')) handler = pkMod.onRequestPost;
      else if (req.url.startsWith('/api/account')) handler = req.method === 'GET' ? acctMod.onRequestGet : acctMod.onRequestPost;
      else if (req.url.startsWith('/api/lock-reauth')) handler = doorApi.onRequestPost;
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
        else headers.set(k, v);
      }
      // fetch 同源请求本就带 Origin；兜底补上，保证通过服务端的 Origin 校验
      if (!headers.get('Origin')) headers.set('Origin', origin);
      const request = new Request(origin + req.url, {
        method: req.method,
        headers,
        body: body.length ? body : undefined,
      });
      const resp = await handler({ request, env });
      const outHeaders = {};
      resp.headers.forEach((v, k) => {
        if (k.toLowerCase() !== 'set-cookie') outHeaders[k] = v;
      });
      const setCookies = typeof resp.headers.getSetCookie === 'function'
        ? resp.headers.getSetCookie()
        : [];
      if (setCookies.length) outHeaders['Set-Cookie'] = setCookies;
      const buf = Buffer.from(await resp.arrayBuffer());
      res.writeHead(resp.status, outHeaders);
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('test server error: ' + (e && e.message));
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  async function mintAuth(reauthBy) {
    const epoch = await sessMod.getLockEpoch(kv);
    const sessionCookie = await sessMod.signLockSessionTicket(privPem, { by: 'password', role: 'admin', epoch, exp: Date.now() + 12 * 3600 * 1000, tempkeyId: '' });
    const reauthCookie = await ticketsMod.signTicket(privPem, 'LockReauthTicket', reauthBy || 'password', epoch);
    return { sessionCookie, reauthCookie };
  }

  /* 账号会话（sgx-account-session）：by=passkey|password，authAt 默认现在；epoch 读当前 Account 纪元 */
  async function mintAccount(by, authAt) {
    const epoch = await acctSess.getAccountEpoch(kv);
    return await acctSess.signAccountSessionTicket(privPem, { by, epoch, authAt: authAt || Date.now(), deviceId: 'e2edevicee2edev1' });
  }

  /* AccountReauthTicket（sgx-account-reauth），按当前 Account 纪元签 */
  async function mintAccountReauth(by) {
    const epoch = await acctSess.getAccountEpoch(kv);
    return await ticketsMod.signTicket(privPem, 'AccountReauthTicket', by || 'password', epoch);
  }

  /* AccountResetTicket（sgx-account-reset）：只有 by=root（RootKey 不签账号会话，第一次设账号凭证走重置票） */
  async function mintAccountReset() {
    const epoch = await acctSess.getAccountEpoch(kv);
    return await ticketsMod.signTicket(privPem, 'AccountResetTicket', 'root', epoch);
  }

  return {
    kv,
    env,
    origin,
    mintAuth,
    mintAccount,
    mintAccountReauth,
    mintAccountReset,
    makeAttestationCredential,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { makeKV, startCredentialTestServer, makeAttestationCredential };
