/**
 * 2.4.0 I：Passkey（WebAuthn）注册与验证。
 * fix/hi-owner：
 * - attestationObject 改用完整 CBOR 解析（替代启发式找 authData）。
 * - 支持多个 passkey：KV `owner-passkeys` 存数组；可列出、删除、重命名。
 * - 外层 try/catch：异常一律返回 JSON { ok:false, error:'server' }。
 * 安全与隐私（Hark 方案）：
 * - attestationObject 是文本键 CBOR map（"fmt"/"attStmt"/"authData"），不用整数键；
 * - COSE key 用 cborDecode 严格解析：校验 1(kty)=2、3(alg)=-7、-1(crv)=1，取 -2/-3 为 x/y；
 * - 校验 authData：rpIdHash == SHA-256(RP_ID)，UP 位必须为 1，记录 UV 位与 signCount；
 * - clientData.origin 严格等于期望 origin（不用 endsWith）；RP_ID/origin 优先读环境变量
 *   （SGX_RP_ID / SGX_ORIGIN），回退到请求 host，保证预览站可注册；
 * - auth 断言：DER→raw 签名转换；校验 rpIdHash、UP 位、origin；signCount 非零时必须递增；
 * - catch 写具体原因到控制台日志，前端仍只返回普通错误；
 * - 会话 cookie 改为 SESSION_SECRET HMAC 签名 + 过期时间。
 *
 * POST /api/owner-passkey
 * - { action: 'challenge', type: 'register'|'auth', token? } → 返回 challenge
 *   - register 需要 owner-auth token（管理密钥门禁）
 *   - auth 不需要（用于锁屏解锁）
 * - { action: 'register', token, credential } → 验证并追加存储
 * - { action: 'auth', credential } → 验证断言，通过则设签名会话 cookie + 签发管理 token
 * - { action: 'list', token } → 列出已注册 passkey
 * - { action: 'rename', token, credId, name } → 重命名设备名
 * - { action: 'delete', token, credId } → 删除指定 passkey
 *
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
 * 签发 owner-auth token（与 owner-auth.js 同格式：10 分钟，scope=owner-auth）。
 * 通行密钥验证通过后签发，用于进入管理页。
 * @param {string} secret
 */
async function issueToken(secret) {
  const raw = JSON.stringify({ scope: 'owner-auth', exp: Date.now() + 600000 });
  const payload = b64urlEnc(new TextEncoder().encode(raw));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBits = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return payload + '.' + b64urlEnc(new Uint8Array(sigBits));
}

/**
 * 签名会话 cookie 值：exp.HMAC(SESSION_SECRET, exp)，24 小时有效。
 * @param {string} secret
 */
async function signVerifiedCookie(secret) {
  const exp = String(Date.now() + 86400000);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBits = await crypto.subtle.sign('HMAC', key, enc.encode(exp));
  return exp + '.' + b64urlEnc(new Uint8Array(sigBits));
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
 * 返回 { value, off }：off 是解码结束位置，带扩展数据（ED 位）时可继续解析。
 * @param {Uint8Array} u8
 * @param {number} [start]
 */
function cborDecode(u8, start) {
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
  return decode(start || 0);
}

/**
 * 解析注册时的 authenticatorData，校验 rpIdHash / UP 位，提取 credentialId 与 COSE key。
 * authData: rpIdHash(32) | flags(1) | signCount(4) | attestedCredData | [extensions]
 * @param {Uint8Array} authData
 * @param {Uint8Array} rpIdHash
 */
function parseRegAuthData(authData, rpIdHash) {
  if (authData.length < 37) throw new Error('authData: too short');
  for (let i = 0; i < 32; i++) {
    if (authData[i] !== rpIdHash[i]) throw new Error('authData: rpIdHash mismatch');
  }
  const flags = authData[32];
  if ((flags & 0x01) === 0) throw new Error('authData: UP not set');
  if ((flags & 0x40) === 0) throw new Error('authData: AT not set');
  const signCount = (authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36];
  const uv = (flags & 0x04) !== 0;
  let off = 37 + 16; // skip AAGUID
  if (off + 2 > authData.length) throw new Error('authData: truncated credIdLen');
  const credIdLen = (authData[off] << 8) | authData[off + 1];
  off += 2;
  if (off + credIdLen > authData.length) throw new Error('authData: truncated credId');
  const credId = authData.slice(off, off + credIdLen);
  off += credIdLen;
  /* COSE key 用 CBOR 严格解，返回结束偏移（ED 扩展数据不影响） */
  const coseRes = cborDecode(authData, off);
  if (!(coseRes.value instanceof Map)) throw new Error('cose: not a map');
  return { credId: credId, coseKey: coseRes.value, signCount: signCount, uv: uv };
}

/**
 * 从 COSE_Key 提取 P-256 公钥 x, y（严格校验，不再启发式扫描）。
 * 要求：1(kty)=2, 3(alg)=-7, -1(crv)=1, -2/-3 为 32 字节 x/y。
 * @param {Map} coseKey
 */
function coseToJwk(coseKey) {
  if (coseKey.get(1) !== 2) throw new Error('cose: kty != EC2');
  if (coseKey.get(3) !== -7) throw new Error('cose: alg != ES256');
  if (coseKey.get(-1) !== 1) throw new Error('cose: crv != P-256');
  const x = coseKey.get(-2);
  const y = coseKey.get(-3);
  if (!(x instanceof Uint8Array) || x.length !== 32) throw new Error('cose: bad x');
  if (!(y instanceof Uint8Array) || y.length !== 32) throw new Error('cose: bad y');
  return { kty: 'EC', crv: 'P-256', x: b64urlEnc(x), y: b64urlEnc(y) };
}

/**
 * DER 编码的 ECDSA 签名 → 64 字节 r||s（WebCrypto verify 需要 raw 格式）。
 * 去掉整数前导 0，左右补齐到 32 字节。
 * @param {Uint8Array} der
 */
function derToRaw(der) {
  let off = 0;
  if (der[off++] !== 0x30) throw new Error('sig: not DER sequence');
  let seqLen = der[off++];
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    if (n > 2) throw new Error('sig: bad DER length');
    seqLen = 0;
    for (let i = 0; i < n; i++) seqLen = (seqLen << 8) | der[off++];
  }
  if (der[off++] !== 0x02) throw new Error('sig: no r');
  const rLen = der[off++];
  let r = der.slice(off, off + rLen);
  off += rLen;
  if (der[off++] !== 0x02) throw new Error('sig: no s');
  const sLen = der[off++];
  let s = der.slice(off, off + sLen);
  /** @param {Uint8Array} v */
  function norm(v) {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    v = v.slice(i);
    if (v.length > 32) throw new Error('sig: int too large');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  }
  const raw = new Uint8Array(64);
  raw.set(norm(r), 0);
  raw.set(norm(s), 32);
  return raw;
}

/**
 * 校验断言时的 authenticatorData：rpIdHash、UP 位；返回 signCount 与 UV。
 * @param {Uint8Array} authData
 * @param {Uint8Array} rpIdHash
 */
function checkAssertAuthData(authData, rpIdHash) {
  if (authData.length < 37) throw new Error('authData: too short');
  for (let i = 0; i < 32; i++) {
    if (authData[i] !== rpIdHash[i]) throw new Error('authData: rpIdHash mismatch');
  }
  const flags = authData[32];
  if ((flags & 0x01) === 0) throw new Error('authData: UP not set');
  const signCount = (authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36];
  return { signCount: signCount, uv: (flags & 0x04) !== 0 };
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

  /* RP_ID / 期望 origin：环境变量优先，回退到请求 host（预览站各部署域名不同） */
  let reqHost = '', reqOrigin = '';
  try {
    const u = new URL(request.url);
    reqHost = u.hostname;
    reqOrigin = u.origin;
  } catch (e) {}
  const RP_ID = (env && env.SGX_RP_ID) || reqHost || 'styrigx.com';
  const EXPECT_ORIGIN = (env && env.SGX_ORIGIN) || reqOrigin || 'https://styrigx.com';
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)));

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
    const resp = { ok: true, cid: cid, challenge: challenge, rpId: RP_ID };
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
      /* 验证 clientData：type / challenge / origin 严格等于期望值 */
      const clientData = JSON.parse(new TextDecoder().decode(b64urlDec(cred.response.clientDataJSON)));
      if (clientData.type !== 'webauthn.create') throw new Error('type');
      const expChallenge = chRec.challenge.replace(/=+$/, '');
      const gotChallenge = (clientData.challenge || '').replace(/=+$/, '');
      if (gotChallenge !== expChallenge) throw new Error('challenge');
      if (clientData.origin !== EXPECT_ORIGIN) throw new Error('origin');
      /* attestationObject 是文本键 CBOR map：取 "authData"（整数键 2 是 CTAP 层格式） */
      const attRes = cborDecode(b64urlDec(cred.response.attestationObject));
      const attObj = attRes.value;
      if (!(attObj instanceof Map)) throw new Error('attestationObject');
      const authData = attObj.get('authData');
      if (!(authData instanceof Uint8Array)) throw new Error('authData');
      const parsed = parseRegAuthData(authData, rpIdHash);
      const jwk = coseToJwk(parsed.coseKey);
      const credIdB64 = b64urlEnc(parsed.credId);
      /* 追加存储（同 credId 去重） */
      const keys = await getPasskeys(kv);
      const now = Date.now();
      const devName = String((body && body.name) || '').slice(0, 40);
      let found = false;
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].credId === credIdB64) {
          keys[i].publicKey = jwk;
          keys[i].createdAt = keys[i].createdAt || now;
          keys[i].signCount = parsed.signCount;
          keys[i].uv = parsed.uv;
          if (devName) keys[i].name = devName;
          found = true;
          break;
        }
      }
      if (!found) keys.push({ credId: credIdB64, publicKey: jwk, createdAt: now, name: devName, signCount: parsed.signCount, uv: parsed.uv });
      await savePasskeys(kv, keys);
      return Response.json({ ok: true });
    } catch (e) {
      /* 具体原因只写控制台，前端仍只返回普通错误 */
      console.error('[passkey-register]', e && e.message ? e.message : e);
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
    let storedIdx = -1;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].credId === rawIdB64) { stored = keys[i]; storedIdx = i; break; }
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
      if (clientData.origin !== EXPECT_ORIGIN) throw new Error('origin');
      /* 校验 authenticatorData：rpIdHash、UP 位 */
      const authData = b64urlDec(cred.response.authenticatorData);
      const checked = checkAssertAuthData(authData, rpIdHash);
      /* signCount：双方非零时必须递增（防克隆） */
      const oldCount = stored.signCount || 0;
      if (oldCount !== 0 && checked.signCount !== 0 && checked.signCount <= oldCount) {
        throw new Error('signCount');
      }
      /* 验证签名：WebAuthn ES256 签名是 DER 编码，转 64 字节 r||s */
      const cdBytes = b64urlDec(cred.response.clientDataJSON);
      const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', cdBytes));
      const sigBase = new Uint8Array(authData.length + cdHash.length);
      sigBase.set(authData, 0);
      sigBase.set(cdHash, authData.length);
      const sigRaw = derToRaw(b64urlDec(cred.response.signature));
      const key = await crypto.subtle.importKey('jwk', stored.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigRaw, sigBase);
      if (!ok) throw new Error('sig');
      /* 更新 signCount */
      keys[storedIdx].signCount = checked.signCount;
      try { await savePasskeys(kv, keys); } catch (e2) {}
      /* 通过：设签名会话 cookie，并签发管理 token（用于进入管理页） */
      const headers = new Headers({ 'Content-Type': 'application/json' });
      const secret = (env && env.SESSION_SECRET) || '';
      if (secret) {
        const cv = await signVerifiedCookie(secret);
        headers.append('Set-Cookie', 'sgx-verified=' + cv + '; Path=/; HttpOnly; Secure; SameSite=Lax');
      }
      const mgrToken = secret ? await issueToken(secret) : '';
      return new Response(JSON.stringify({ ok: true, token: mgrToken }), { headers });
    } catch (e) {
      console.error('[passkey-auth]', e && e.message ? e.message : e);
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
      keys: keys.map(function (k) { return { credId: k.credId, name: k.name || '', createdAt: k.createdAt || 0 }; }),
    });
  }

  /* ============ rename：重命名 passkey 设备名（需 owner-auth token） ============ */
  if (action === 'rename') {
    const token = (body && body.token) || '';
    const credId = (body && body.credId) || '';
    let name = (body && body.name) || '';
    const secret = (env && env.SESSION_SECRET) || '';
    if (!secret || !(await verifyToken(token, secret))) {
      return Response.json({ ok: false, error: 'token' }, { status: 403 });
    }
    if (!credId) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    name = String(name).slice(0, 40);
    const keys = await getPasskeys(kv);
    let found = false;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].credId === credId) { keys[i].name = name; found = true; break; }
    }
    if (!found) return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    await savePasskeys(kv, keys);
    return Response.json({ ok: true });
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
