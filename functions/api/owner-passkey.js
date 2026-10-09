/**
 * 2.4.0 I：Passkey（WebAuthn）注册与验证。
 * fix/hi-owner：
 * - attestationObject 改用完整 CBOR 解析（替代启发式找 authData）。
 * - 支持多个 passkey：KV `owner-passkeys` 存数组；/owner/ 可列出、删除。
 * - 外层 try/catch：异常一律返回 JSON { ok:false, error:'server' }。
 *
 * POST /api/owner-passkey
 * - { action: 'challenge', type: 'register'|'auth', token? } → 返回 challenge
 *   - register 需要 owner-auth token（OWNER_KEY 门禁）
 *   - auth 不需要（用于锁屏解锁）
 * - { action: 'register', token, credential } → 验证并追加存储
 * - { action: 'auth', credential } → 验证断言，通过则设会话 cookie
 * - { action: 'list', token } → 列出已注册 passkey（id、创建时间）
 * - { action: 'delete', token, credId } → 删除指定 passkey
 *
 * 存储与 OWNER_KEY 分离：KV `owner-passkeys` 存数组 [{ credId, publicKey, createdAt }]；
 * 轮换 OWNER_KEY（改环境变量）不影响已有 passkey。
 * 只接受 POST；校验 Origin。
 */

/** @param {number} n */
function randB64(n) {
  const u8 = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} b64url */
function b64urlDec(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** @param {Uint8Array} u8 */
function b64urlEnc(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} a @param {string} b */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 验证 owner-auth token（与 owner-password.js 同逻辑）。
 * @param {string} token
 * @param {string} secret
 */
async function verifyToken(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const payload = parts[0], sig = parts[1];
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBits = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
    const expectSig = b64urlEnc(new Uint8Array(sigBits));
    if (!timingSafeEqual(sig, expectSig)) return false;
    const data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return data && data.exp > Date.now() && data.scope === 'owner-auth';
  } catch (e) {
    return false;
  }
}

/**
 * 最小 CBOR 解码器（RFC 7049）：支持 uint/int、bytes、text、array、map、bool/null。
 * attestationObject 顶层是 map {1:fmt, 2:authData(bytes), 3:attStmt}。
 * @param {Uint8Array} u8
 */
function cborDecode(u8) {
  /** @param {number} off @param {number} ai */
  function readUint(off, ai) {
    if (ai < 24) return { value: ai, off: off };
    if (ai === 24) return { value: u8[off], off: off + 1 };
    if (ai === 25) return { value: (u8[off] << 8) | u8[off + 1], off: off + 2 };
    if (ai === 26) {
      const v = u8[off] * 16777216 + ((u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]);
      return { value: v, off: off + 4 };
    }
    throw new Error('cbor: uint too large');
  }
  /** @param {number} off */
  function decode(off) {
    if (off >= u8.length) throw new Error('cbor: truncated');
    const b = u8[off];
    const mt = b >> 5, ai = b & 31;
    if (mt === 0) {
      const r = readUint(off + 1, ai);
      return { value: r.value, off: r.off };
    }
    if (mt === 1) {
      const r = readUint(off + 1, ai);
      return { value: -1 - r.value, off: r.off };
    }
    if (mt === 2 || mt === 3) {
      const r = readUint(off + 1, ai);
      const end = r.off + r.value;
      if (end > u8.length) throw new Error('cbor: truncated str');
      const slice = u8.slice(r.off, end);
      return { value: mt === 2 ? slice : new TextDecoder().decode(slice), off: end };
    }
    if (mt === 4) {
      const r = readUint(off + 1, ai);
      const arr = [];
      let o = r.off;
      for (let i = 0; i < r.value; i++) {
        const d = decode(o);
        arr.push(d.value);
        o = d.off;
      }
      return { value: arr, off: o };
    }
    if (mt === 5) {
      const r = readUint(off + 1, ai);
      const map = new Map();
      let o = r.off;
      for (let i = 0; i < r.value; i++) {
        const k = decode(o); o = k.off;
        const v = decode(o); o = v.off;
        map.set(k.value, v.value);
      }
      return { value: map, off: o };
    }
    if (mt === 7) {
      if (ai === 20) return { value: false, off: off + 1 };
      if (ai === 21) return { value: true, off: off + 1 };
      if (ai === 22) return { value: null, off: off + 1 };
      throw new Error('cbor: unsupported simple');
    }
    throw new Error('cbor: unsupported major type ' + mt);
  }
  return decode(0).value;
}

/**
 * 解析 authenticatorData，提取 credentialId。
 * authData: rpIdHash(32) | flags(1) | signCount(4) | attestedCredData
 * @param {Uint8Array} authData
 */
function parseAuthData(authData) {
  if (authData.length < 37) throw new Error('authData too short');
  const flags = authData[32];
  if ((flags & 0x40) === 0) throw new Error('no attested data');
  let off = 37 + 16; // skip AAGUID
  if (off + 2 > authData.length) throw new Error('authData truncated');
  const credIdLen = (authData[off] << 8) | authData[off + 1];
  off += 2;
  if (off + credIdLen > authData.length) throw new Error('credId truncated');
  const credId = authData.slice(off, off + credIdLen);
  off += credIdLen;
  return { credId, cose: authData.slice(off) };
}

/**
 * 从 COSE 提取 P-256 公钥 x, y（只支持 ES256/-7）。
 * @param {Uint8Array} cose
 */
function coseToJwk(cose) {
  let x = null, y = null;
  for (let i = 0; i < cose.length - 34; i++) {
    if (cose[i] === 0x58 && cose[i + 1] === 0x20) {
      const val = cose.slice(i + 2, i + 34);
      if (!x) x = val;
      else if (!y) { y = val; break; }
    }
  }
  if (!x || !y) throw new Error('no EC key');
  return { kty: 'EC', crv: 'P-256', x: b64urlEnc(x), y: b64urlEnc(y) };
}

/** @param {any} kv */
async function getPasskeys(kv) {
  try {
    const v = await kv.get('owner-passkeys', 'json');
    if (Array.isArray(v)) return v;
    /* 兼容旧单密钥记录 */
    const old = await kv.get('owner-passkey', 'json');
    if (old && old.credId) return [{ credId: old.credId, publicKey: old.publicKey, createdAt: old.createdAt || 0 }];
  } catch (e) {}
  return [];
}

/** @param {any} kv @param {any[]} list */
async function savePasskeys(kv, list) {
  await kv.put('owner-passkeys', JSON.stringify(list));
  try { await kv.delete('owner-passkey'); } catch (e) {}
}

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  const kv = env && env.OWNER_KV;

  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }
  try {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    if (origin && new URL(origin).host !== url.host) {
      return Response.json({ ok: false, error: 'origin' }, { status: 403 });
    }
  } catch (e) {}
  if (!kv) return Response.json({ ok: false, error: 'config' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false, error: 'body' }, { status: 400 });
  }
  const action = (body && body.action) || '';
  const RP_ID = 'styrigx.com';

  /* ============ challenge ============ */
  if (action === 'challenge') {
    const type = (body && body.type) || '';
    if (type !== 'register' && type !== 'auth') {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    /* register 需要 owner-auth token */
    if (type === 'register') {
      const token = (body && body.token) || '';
      const secret = (env && env.SESSION_SECRET) || '';
      if (!secret || !(await verifyToken(token, secret))) {
        return Response.json({ ok: false, error: 'token' }, { status: 403 });
      }
    }
    /* auth 需要已有 passkey */
    const keys = await getPasskeys(kv);
    if (type === 'auth' && keys.length === 0) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    const challenge = randB64(32);
    const cid = randB64(16);
    try {
      await kv.put('pk-challenge:' + cid, JSON.stringify({ challenge, type, exp: Date.now() + 300000 }), { expirationTtl: 300 });
    } catch (e) {}
    const resp = { ok: true, cid, challenge };
    if (type === 'auth') {
      resp.allowCredentials = keys.map(function (k) { return { id: k.credId, type: 'public-key' }; });
    }
    return Response.json(resp);
  }

  /* ============ register ============ */
  if (action === 'register') {
    const token = (body && body.token) || '';
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    const secret = (env && env.SESSION_SECRET) || '';
    if (!secret || !(await verifyToken(token, secret))) {
      return Response.json({ ok: false, error: 'token' }, { status: 403 });
    }
    /* 取 challenge */
    let chRec = null;
    try {
      chRec = await kv.get('pk-challenge:' + cid, 'json');
      await kv.delete('pk-challenge:' + cid);
    } catch (e) {}
    if (!chRec || chRec.type !== 'register' || chRec.exp < Date.now()) {
      return Response.json({ ok: false, error: 'challenge' }, { status: 403 });
    }
    try {
      /* 验证 clientData */
      const clientData = JSON.parse(new TextDecoder().decode(b64urlDec(cred.response.clientDataJSON)));
      if (clientData.type !== 'webauthn.create') throw new Error('type');
      const expChallenge = chRec.challenge.replace(/=+$/, '');
      const gotChallenge = (clientData.challenge || '').replace(/=+$/, '');
      if (gotChallenge !== expChallenge) throw new Error('challenge');
      if (!clientData.origin.endsWith(RP_ID)) throw new Error('origin');
      /* 完整 CBOR 解析 attestationObject → authData */
      const attObj = cborDecode(b64urlDec(cred.response.attestationObject));
      if (!(attObj instanceof Map)) throw new Error('attestationObject');
      const authData = attObj.get(2);
      if (!(authData instanceof Uint8Array)) throw new Error('authData');
      const { credId, cose } = parseAuthData(authData);
      const jwk = coseToJwk(cose);
      const credIdB64 = b64urlEnc(credId);
      /* 追加存储（同 credId 去重） */
      const keys = await getPasskeys(kv);
      const now = Date.now();
      let found = false;
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].credId === credIdB64) {
          keys[i].publicKey = jwk;
          keys[i].createdAt = keys[i].createdAt || now;
          found = true;
          break;
        }
      }
      if (!found) keys.push({ credId: credIdB64, publicKey: jwk, createdAt: now });
      await savePasskeys(kv, keys);
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: 'verify' }, { status: 403 });
    }
  }

  /* ============ auth ============ */
  if (action === 'auth') {
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    let chRec = null;
    try {
      chRec = await kv.get('pk-challenge:' + cid, 'json');
      await kv.delete('pk-challenge:' + cid);
    } catch (e) {}
    if (!chRec || chRec.type !== 'auth' || chRec.exp < Date.now()) {
      return Response.json({ ok: false, error: 'challenge' }, { status: 403 });
    }
    const keys = await getPasskeys(kv);
    if (keys.length === 0) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    /* 按 credential id 找对应公钥 */
    const rawIdB64 = cred.rawId || '';
    let stored = null;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].credId === rawIdB64) { stored = keys[i]; break; }
    }
    if (!stored || !stored.publicKey) {
      return Response.json({ ok: false, error: 'unknown-key' }, { status: 403 });
    }
    try {
      /* 验证 clientData */
      const clientData = JSON.parse(new TextDecoder().decode(b64urlDec(cred.response.clientDataJSON)));
      if (clientData.type !== 'webauthn.get') throw new Error('type');
      const expChallenge = chRec.challenge.replace(/=+$/, '');
      const gotChallenge = (clientData.challenge || '').replace(/=+$/, '');
      if (gotChallenge !== expChallenge) throw new Error('challenge');
      /* 验证签名 */
      const authData = b64urlDec(cred.response.authenticatorData);
      const cdBytes = b64urlDec(cred.response.clientDataJSON);
      const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', cdBytes));
      const sigBase = new Uint8Array(authData.length + cdHash.length);
      sigBase.set(authData, 0);
      sigBase.set(cdHash, authData.length);
      const sig = b64urlDec(cred.response.signature);
      const key = await crypto.subtle.importKey('jwk', stored.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, sigBase);
      if (!ok) throw new Error('sig');
      /* 通过：设会话 cookie */
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', 'sgx-verified=1; Path=/; HttpOnly; Secure; SameSite=Lax');
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch (e) {
      return Response.json({ ok: false, error: 'verify' }, { status: 403 });
    }
  }

  /* ============ list：列出 passkey（需 owner-auth token） ============ */
  if (action === 'list') {
    const token = (body && body.token) || '';
    const secret = (env && env.SESSION_SECRET) || '';
    if (!secret || !(await verifyToken(token, secret))) {
      return Response.json({ ok: false, error: 'token' }, { status: 403 });
    }
    const keys = await getPasskeys(kv);
    return Response.json({
      ok: true,
      keys: keys.map(function (k) { return { credId: k.credId, createdAt: k.createdAt || 0 }; }),
    });
  }

  /* ============ delete：删除 passkey（需 owner-auth token） ============ */
  if (action === 'delete') {
    const token = (body && body.token) || '';
    const credId = (body && body.credId) || '';
    const secret = (env && env.SESSION_SECRET) || '';
    if (!secret || !(await verifyToken(token, secret))) {
      return Response.json({ ok: false, error: 'token' }, { status: 403 });
    }
    if (!credId) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    const keys = await getPasskeys(kv);
    const rest = keys.filter(function (k) { return k.credId !== credId; });
    if (rest.length === keys.length) {
      return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    }
    await savePasskeys(kv, rest);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
