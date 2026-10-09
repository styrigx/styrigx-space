/**
 * 2.4.0 I：Passkey（WebAuthn）注册与验证。
 * fix/hi-owner：
 * - attestationObject 改用完整 CBOR 解析（替代启发式找 authData）。
 * - 支持多个 passkey：KV 每把一个 `owner-passkey:<前12位>`；索引 `owner-passkey-index` 存 credId 数组（避开 list 最终一致）；可列出、删除、重命名。
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
 *
 * P0-3 安全审计：
 * - 注册和解锁都要求 UV=1（userVerification: required）
 * - RP_ID/ORIGIN 必须配环境变量 SGX_RP_ID/SGX_ORIGIN，不回落
 * - 用户信息由服务端下发：displayName=Sloan Gray, name=owner, rp.name=Styrigx
 * - 固定 user handle（KV owner-user-id），auth 时校验 userHandle
 * - register 带 excludeCredentials 防重复注册
 * - KV 结构：每把一个 key（owner-passkey:<credId前12位>），字段顺序固定
 */
import { b64enc, b64dec, b64urlEnc, timingSafeEqual, hmacSign, hmacVerify } from '../_lib/crypto.js';

/* AAGUID → 密码管理器（只用于显示，不参与安全判断） */
const AAGUID_PROVIDERS = {
  'adce0002-35bc-c60a-648b-0b25f5f05522': 'Google 密码管理器',
  'f8a011f3-8c0a-4d15-8006-17111f9edc7d': 'iCloud 钥匙串',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'accced6a-63d0-4ef2-bb6c-7516d463e07f': 'Bitwarden',
  '39a9f8c4-8405-4bc4-8af9-7d616b0df0ab': 'Microsoft',
  /* Samsung Pass AAGUID 需真机确认后填入 */
};

/** @param {number} n */
function randB64(n) {
  const u8 = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} b64url */
/** @param {string} b64url */
function b64urlDec(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/**
 * 签发 owner-auth token（5 分钟，scope=owner-auth，用途前缀 "owner-auth|"）。
 * 通行密钥验证通过后签发，用于进入管理页。
 * @param {string} secret
 */
async function issueToken(secret) {
  const raw = JSON.stringify({ scope: 'owner-auth', exp: Date.now() + 300000 });
  const payload = b64urlEnc(new TextEncoder().encode(raw));
  const sig = await hmacSign(secret, 'owner-auth|', payload);
  return payload + '.' + sig;
}

/**
 * 签名会话 cookie 值：ver.exp.HMAC(SESSION_SECRET, "sess|" + ver.exp)，24 小时有效。
 * @param {string} secret
 * @param {number} ver
 */
async function signVerifiedCookie(secret, ver) {
  const exp = String(Date.now() + 86400000);
  const payload = ver + '.' + exp;
  const sig = await hmacSign(secret, 'sess|', payload);
  return payload + '.' + sig;
}

/**
 * 验证 owner-auth token（用途前缀 "owner-auth|"）。
 * @param {string} token
 * @param {string} secret
 */
async function verifyToken(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const payload = parts[0], sig = parts[1];
    if (!(await hmacVerify(secret, 'owner-auth|', payload, sig))) return false;
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
  const aaguid = authData.slice(37, 53); // 16 字节 AAGUID
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
  return { credId: credId, coseKey: coseRes.value, signCount: signCount, uv: uv, aaguid: aaguid };
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

/**
 * 获取所有通行密钥（新结构：每把一个 key）。
 * @param {any} kv
 */
async function getPasskeys(kv) {
  try {
    const list = await kv.list({ prefix: 'owner-passkey:' });
    const keys = [];
    for (const k of list.keys || []) {
      try {
        const v = await kv.get(k.name, 'json');
        if (v && v.credId) keys.push(v);
      } catch (e) {}
    }
    /* 一次性迁移：旧数组结构 → 新结构 */
    if (keys.length === 0) {
      try {
        const old = await kv.get('owner-passkeys', 'json');
        if (Array.isArray(old) && old.length > 0) {
          for (const item of old) {
            if (item && item.credId) {
              const migrated = {
                name: item.name || '通行密钥',
                provider: item.provider || '',
                aaguid: item.aaguid || '',
                createdAt: item.createdAt || Date.now(),
                lastUsedAt: item.lastUsedAt || 0,
                credId: item.credId,
                publicKey: item.publicKey,
                signCount: item.signCount || 0,
                uv: item.uv ? 1 : 0,
              };
              const keyName = 'owner-passkey:' + String(item.credId).slice(0, 12);
              await kv.put(keyName, JSON.stringify(migrated), {
                metadata: { name: migrated.name, provider: migrated.provider, createdAt: migrated.createdAt },
              });
              keys.push(migrated);
            }
          }
          await kv.delete('owner-passkeys');
        }
      } catch (e) {}
    }
    return keys;
  } catch (e) {
    return [];
  }
}

/**
 * 保存单把通行密钥。
 * @param {any} kv
 * @param {any} item
 */
async function savePasskey(kv, item) {
  const keyName = 'owner-passkey:' + String(item.credId).slice(0, 12);
  /* 字段顺序固定：name 第一位，方便后台预览 */
  const ordered = {
    name: item.name || '通行密钥',
    provider: item.provider || '',
    aaguid: item.aaguid || '',
    createdAt: item.createdAt || Date.now(),
    lastUsedAt: item.lastUsedAt || 0,
    credId: item.credId,
    publicKey: item.publicKey,
    signCount: item.signCount || 0,
    uv: item.uv ? 1 : 0,
  };
  await kv.put(keyName, JSON.stringify(ordered), {
    metadata: { name: ordered.name, provider: ordered.provider, createdAt: ordered.createdAt },
  });
  /* 同步更新索引（避开 kv.list 的最终一致延迟） */
  try {
    let idx = await kv.get('owner-passkey-index', 'json');
    if (!Array.isArray(idx)) idx = [];
    if (!idx.includes(item.credId)) {
      idx.push(item.credId);
      await kv.put('owner-passkey-index', JSON.stringify(idx));
    }
  } catch (e) {}
  return ordered;
}

/**
 * 删除单把通行密钥。
 * @param {any} kv
 * @param {string} credId
 */
async function deletePasskey(kv, credId) {
  const keyName = 'owner-passkey:' + String(credId).slice(0, 12);
  await kv.delete(keyName);
  /* 同步更新索引 */
  try {
    let idx = await kv.get('owner-passkey-index', 'json');
    if (Array.isArray(idx)) {
      idx = idx.filter(id => id !== credId);
      await kv.put('owner-passkey-index', JSON.stringify(idx));
    }
  } catch (e) {}
}

/**
 * 获取或创建固定用户 ID（32 字节随机，存 KV）。
 * @param {any} kv
 */
async function getUserHandle(kv) {
  try {
    let uh = await kv.get('owner-user-id');
    if (!uh) {
      const u8 = crypto.getRandomValues(new Uint8Array(32));
      uh = b64urlEnc(u8);
      await kv.put('owner-user-id', uh);
    }
    return uh;
  } catch (e) {
    return null;
  }
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

  /* RP_ID / 期望 origin：必须设置环境变量，不回落（防配置错误） */
  const RP_ID = env && env.SGX_RP_ID;
  const EXPECT_ORIGIN = env && env.SGX_ORIGIN;
  if (!RP_ID || !EXPECT_ORIGIN) {
    /* 缺变量：返回明确错误（503），前端据此禁用通行密钥入口 */
    return Response.json(
      { ok: false, error: 'config', message: 'SGX_RP_ID / SGX_ORIGIN 未配置' },
      { status: 503 }
    );
  }
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
    if (type === 'register') {
      /* 下发用户信息：displayName/name/rp.name 由服务端配置，前端不硬编码 */
      const userHandle = await getUserHandle(kv);
      resp.user = {
        id: userHandle,
        name: 'owner',
        displayName: 'Sloan Gray',
      };
      resp.rp = {
        id: RP_ID,
        name: 'Styrigx',
      };
      /* excludeCredentials：防重复注册（读索引，不走 kv.list） */
      let idx = [];
      try { idx = await kv.get('owner-passkey-index', 'json') || []; } catch (e) {}
      resp.excludeCredentials = (Array.isArray(idx) ? idx : []).map(function (cid) {
        return { id: cid, type: 'public-key' };
      });
    }
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
      /* P0-3：必须 UV=1（用户验证） */
      if (!parsed.uv) throw new Error('uv-required');
      const jwk = coseToJwk(parsed.coseKey);
      const credIdB64 = b64urlEnc(parsed.credId);
      /* 取 AAGUID（用于显示密码管理器名称） */
      let aaguid = '';
      try {
        if (parsed.aaguid) {
          const h = Array.from(parsed.aaguid, b => b.toString(16).padStart(2, '0')).join('');
          aaguid = h.slice(0,8) + '-' + h.slice(8,12) + '-' + h.slice(12,16) + '-' + h.slice(16,20) + '-' + h.slice(20);
        }
      } catch (e) {}
      /* 存储（同 credId 去重；新结构每把一个 key） */
      const now = Date.now();
      const devName = String((body && body.name) || '').slice(0, 40);
      const keys = await getPasskeys(kv);
      let existing = null;
      for (const k of keys) {
        if (k.credId === credIdB64) { existing = k; break; }
      }
      /* AAGUID 映射 provider，作为默认名 */
      const mappedProvider = (aaguid && AAGUID_PROVIDERS[aaguid.toLowerCase()]) || '';
      const item = {
        name: devName || mappedProvider || (existing && existing.name) || '通行密钥',
        provider: mappedProvider || (body && body.provider) || (existing && existing.provider) || '',
        aaguid: aaguid || (existing && existing.aaguid) || '',
        createdAt: (existing && existing.createdAt) || now,
        lastUsedAt: (existing && existing.lastUsedAt) || 0,
        credId: credIdB64,
        publicKey: jwk,
        signCount: parsed.signCount,
        uv: 1,
      };
      await savePasskey(kv, item);
      return Response.json({ ok: true, credId: credIdB64 });
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
      /* P0-3：必须 UV=1 */
      if (!checked.uv) throw new Error('uv-required');
      /* 校验 userHandle（如果有） */
      try {
        const expectUh = await kv.get('owner-user-id');
        const gotUh = cred.response.userHandle;
        if (expectUh && gotUh && gotUh !== expectUh) throw new Error('userHandle');
      } catch (e) {
        if (e && e.message === 'userHandle') throw e;
      }
      /* 更新 signCount 和 lastUsedAt */
      stored.signCount = checked.signCount;
      stored.lastUsedAt = Date.now();
      try { await savePasskey(kv, stored); } catch (e2) {}
      /* 通过：设签名会话 cookie（含 session-ver），并签发管理 token */
      const headers = new Headers({ 'Content-Type': 'application/json' });
      const secret = (env && env.SESSION_SECRET) || '';
      if (secret) {
        let ver = 0;
        try { ver = parseInt(await kv.get('session-ver') || '0', 10) || 0; } catch (e) {}
        const cv = await signVerifiedCookie(secret, ver);
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
      keys: keys.map(function (k) {
        return {
          credId: k.credId,
          name: k.name || '',
          provider: k.provider || '',
          aaguid: k.aaguid || '',
          createdAt: k.createdAt || 0,
          lastUsedAt: k.lastUsedAt || 0,
        };
      }),
    });
  }

  /* ============ rename：重命名 passkey（需 owner-auth token；1-40 字，去首尾空格和控制字符） ============ */
  if (action === 'rename') {
    const token = (body && body.token) || '';
    const credId = (body && body.credId) || '';
    let name = (body && body.name) || '';
    const secret = (env && env.SESSION_SECRET) || '';
    if (!secret || !(await verifyToken(token, secret))) {
      return Response.json({ ok: false, error: 'token' }, { status: 403 });
    }
    if (!credId) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    /* 清理：去首尾空格和控制字符，限 1-40 字 */
    name = String(name).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
    if (!name) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    /* 直接 kv.get，不走 list（KV list 最终一致，刚写入的 key 约 60 秒内列不出来） */
    const keyName = 'owner-passkey:' + String(credId).slice(0, 12);
    let found = null;
    try { found = await kv.get(keyName, 'json'); } catch (e) {}
    /* 校验 credId 完全相等（防前 12 位碰撞） */
    if (!found || found.credId !== credId) {
      return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    }
    found.name = name;
    await savePasskey(kv, found);
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
    /* 直接 kv.get 校验存在，不走 list（最终一致） */
    const keyName = 'owner-passkey:' + String(credId).slice(0, 12);
    let found = null;
    try { found = await kv.get(keyName, 'json'); } catch (e) {}
    if (!found || found.credId !== credId) {
      return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    }
    await deletePasskey(kv, credId);
    /* 会话吊销：删密钥后 session-ver +1 */
    try {
      const v = parseInt(await kv.get('session-ver') || '0', 10) || 0;
      await kv.put('session-ver', String(v + 1));
    } catch (e) {}
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
