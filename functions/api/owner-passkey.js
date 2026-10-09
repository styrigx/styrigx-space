/**
 * 2.4.0 I：Passkey（WebAuthn）注册与验证。
 *
 * POST /api/owner-passkey
 * - { action: 'challenge', type: 'register'|'auth', token? } → 返回 challenge
 *   - register 需要 owner-auth token（OWNER_KEY 门禁）
 *   - auth 不需要（用于锁屏解锁）
 * - { action: 'register', token, credential } → 验证并存储（KV owner-passkey）
 * - { action: 'auth', credential } → 验证断言，通过则设会话 cookie
 *
 * 存储与 OWNER_KEY 分离：KV `owner-passkey` 存 credential ID + 公钥；
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
    let s = '';
    const u8 = new Uint8Array(sigBits);
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    const expectSig = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (!timingSafeEqual(sig, expectSig)) return false;
    const data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return data && data.exp > Date.now() && data.scope === 'owner-auth';
  } catch (e) {
    return false;
  }
}

/**
 * 解析 authenticatorData，提取 credential public key（COSE）。
 * 简化：只支持 ES256（-7）。
 * @param {Uint8Array} authData
 */
function parseAuthData(authData) {
  // authData: rpIdHash(32) | flags(1) | signCount(4) | [attestedCredData]
  if (authData.length < 37) throw new Error('authData too short');
  const flags = authData[32];
  const hasAttested = (flags & 0x40) !== 0;
  if (!hasAttested) throw new Error('no attested data');
  let off = 37;
  // AAGUID (16)
  off += 16;
  // credentialIdLen (2)
  const credIdLen = (authData[off] << 8) | authData[off + 1];
  off += 2;
  const credId = authData.slice(off, off + credIdLen);
  off += credIdLen;
  // COSE key (map)
  // 简化解析：找 -7 (ES256)，提取 x, y
  // COSE: {1:2, 3:-7, -1:1, -2:x(32), -3:y(32)}
  return { credId, coseOff: off };
}

/**
 * 从 COSE 提取 P-256 公钥的 x, y。
 * @param {Uint8Array} cose
 */
function coseToJwk(cose) {
  // 查找 0x5820 (bytes(32)) 标记
  let x = null, y = null;
  for (let i = 0; i < cose.length - 34; i++) {
    if (cose[i] === 0x58 && cose[i + 1] === 0x20) {
      const val = cose.slice(i + 2, i + 34);
      if (!x) x = val;
      else if (!y) { y = val; break; }
    }
  }
  if (!x || !y) throw new Error('no EC key');
  const b64 = (/** @type {Uint8Array} */ u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return { kty: 'EC', crv: 'P-256', x: b64(x), y: b64(y) };
}

/** @param {any} context */
export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env && env.OWNER_KV;

  if (request.method !== 'POST') {
    return Response.json({ ok: false }, { status: 405 });
  }
  try {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    if (origin && new URL(origin).host !== url.host) {
      return Response.json({ ok: false }, { status: 403 });
    }
  } catch (e) {}
  if (!kv) return Response.json({ ok: false }, { status: 500 });

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false }, { status: 400 });
  }
  const action = (body && body.action) || '';
  const rpId = 'styrigx.com';

  /* ============ challenge ============ */
  if (action === 'challenge') {
    const type = (body && body.type) || '';
    if (type !== 'register' && type !== 'auth') {
      return Response.json({ ok: false }, { status: 400 });
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
    if (type === 'auth') {
      let existing = null;
      try { existing = await kv.get('owner-passkey', 'json'); } catch (e) {}
      if (!existing || !existing.credId) {
        return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
      }
    }
    const challenge = randB64(32);
    const cid = randB64(16);
    try {
      await kv.put('pk-challenge:' + cid, JSON.stringify({ challenge, type, exp: Date.now() + 300000 }), { expirationTtl: 300 });
    } catch (e) {}
    const resp = { ok: true, cid, challenge };
    if (type === 'auth') {
      try {
        const existing = await kv.get('owner-passkey', 'json');
        resp.allowCredentials = [{ id: existing.credId, type: 'public-key' }];
      } catch (e) {}
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
      if (!clientData.origin.endsWith('styrigx.com')) throw new Error('origin');
      /* 解析公钥（attestation: none 简化） */
      const authData = b64urlDec(cred.response.attestationObject);
      // attestationObject 是 CBOR，简化：直接找 authData（跳过 CBOR 头）
      // 实际：CBOR map {1:fmt, 2:authData, 3:attStmt}
      // 为简化，我们假设 authData 在固定偏移（生产环境应完整解析 CBOR）
      // 这里用启发式：找 rpIdHash（32 字节）后跟 flags
      let authOff = -1;
      for (let i = 0; i < authData.length - 40; i++) {
        // 找 0x5820 (authData 长度前缀在 CBOR 中)
        if (authData[i] === 0x58) {
          const len = authData[i + 1];
          if (len >= 37 && i + 2 + len <= authData.length) {
            authOff = i + 2;
            break;
          }
        }
      }
      if (authOff < 0) throw new Error('authData');
      const ad = authData.slice(authOff, authOff + 200); // 足够长
      const { credId } = parseAuthData(ad);
      const cose = ad.slice(37 + 16 + 2 + credId.length);
      const jwk = coseToJwk(cose);
      /* 存储（与 OWNER_KEY 分离） */
      const credIdB64 = (() => {
        let s = '';
        for (let i = 0; i < credId.length; i++) s += String.fromCharCode(credId[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      })();
      await kv.put('owner-passkey', JSON.stringify({
        credId: credIdB64,
        publicKey: jwk,
        createdAt: Date.now(),
      }));
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
    let stored = null;
    try { stored = await kv.get('owner-passkey', 'json'); } catch (e) {}
    if (!stored || !stored.publicKey) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
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

  return Response.json({ ok: false }, { status: 400 });
}
