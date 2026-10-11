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
import { b64enc, b64dec, b64urlEnc, timingSafeEqual, hmacSign, hmacVerify } from '../_kernel/crypto.js';
import {
  b64urlDec,
  randB64,
  cborDecode,
  parseRegAuthData,
  coseToJwk,
  verifyAssertion,
} from '../_kernel/passkey-verify.js';
import {
  issueSessionCookie,
  ROLE_OWNER,
} from '../_kernel/session.js';

/* AAGUID → 密码管理器（只用于显示，不参与安全判断） */
const AAGUID_PROVIDERS = {
  'adce0002-35bc-c60a-648b-0b25f5f05522': 'Google 密码管理器',
  'f8a011f3-8c0a-4d15-8006-17111f9edc7d': 'iCloud 钥匙串',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'accced6a-63d0-4ef2-bb6c-7516d463e07f': 'Bitwarden',
  '39a9f8c4-8405-4bc4-8af9-7d616b0df0ab': 'Microsoft',
  /* Samsung Pass AAGUID 需真机确认后填入 */
};

/* randB64 / b64urlDec / cborDecode / parseRegAuthData / coseToJwk / derToRaw /
   checkAssertAuthData / verifyAssertion 已抽到 ../_kernel/passkey-verify.js（登录与 stepup 共用） */

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
 * 获取所有通行密钥（新结构：每把一个 key）。
 * 索引补建逻辑见 ensureIndex。
 */
async function ensureIndex(kv) {
  try {
    let idx = await kv.get('owner-passkey-index', 'json');
    if (Array.isArray(idx)) return idx;
  } catch (e) {}
  /* 索引不存在：一次性补建 */
  const idx = [];
  try {
    const list = await kv.list({ prefix: 'owner-passkey:' });
    for (const k of list.keys || []) {
      try {
        const v = await kv.get(k.name, 'json');
        if (v && v.credId && !idx.includes(v.credId)) idx.push(v.credId);
      } catch (e2) {}
    }
    await kv.put('owner-passkey-index', JSON.stringify(idx));
  } catch (e3) {}
  return idx;
}

/** stepup 复用：按索引读取已注册 passkey（不走 kv.list，避开最终一致延迟） */
export async function getPasskeys(kv) {
  try {
    /* 按索引读，不走 kv.list（避开最终一致延迟） */
    const idx = await ensureIndex(kv);
    const keys = [];
    for (const credId of idx) {
      try {
        const keyName = 'owner-passkey:' + String(credId).slice(0, 12);
        const v = await kv.get(keyName, 'json');
        if (v && v.credId === credId) keys.push(v);
      } catch (e) {}
    }
    /* 一次性迁移：旧数组结构 → 新结构（含索引补建） */
    if (keys.length === 0) {
      try {
        const old = await kv.get('owner-passkeys', 'json');
        if (Array.isArray(old) && old.length > 0) {
          const newIdx = [];
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
              newIdx.push(item.credId);
            }
          }
          await kv.put('owner-passkey-index', JSON.stringify(newIdx));
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
      /* excludeCredentials：防重复注册（ensureIndex，不存在时一次性补建） */
      const idx = await ensureIndex(kv);
      resp.excludeCredentials = idx.map(function (cid) {
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
      /* 具体原因只写控制台；UV 失败返回专属错误码，其他仍返回普通错误 */
      console.error('[passkey-register]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : 'verify';
      return Response.json({ ok: false, error: code }, { status: 403 });
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
      /* 共享断言验证（_kernel/passkey-verify.js）：clientData、authData、
         signCount 递增、ES256 签名、UV=1（P0-3）。登录行为不变。 */
      const checked = await verifyAssertion({
        credential: cred,
        challenge: chRec.challenge,
        rpIdHash: rpIdHash,
        expectOrigin: EXPECT_ORIGIN,
        storedPublicKey: stored.publicKey,
        storedSignCount: stored.signCount,
        requireUV: true,
      });
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
      /* 通过：签发 Ed25519 会话 cookie（fail closed），并签发管理 token。
         issueSessionCookie 永不抛错，明确错误码不会被外层 catch 吞成 403。
         2.8.0：通行密钥验证签 owner（12 小时）。 */
      const headers = new Headers({ 'Content-Type': 'application/json' });
      const secret = (env && env.SESSION_SECRET) || '';
      const signErr = await issueSessionCookie(env, headers, ROLE_OWNER);
      if (signErr) {
        return new Response(JSON.stringify(signErr.body), {
          status: signErr.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const mgrToken = secret ? await issueToken(secret) : '';
      return new Response(JSON.stringify({ ok: true, token: mgrToken }), { headers });
    } catch (e) {
      console.error('[passkey-auth]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : 'verify';
      return Response.json({ ok: false, error: code }, { status: 403 });
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
    /* 会话吊销：删密钥后 session-epoch +1 */
    try {
      const v = parseInt(await kv.get('session-epoch') || '0', 10) || 0;
      await kv.put('session-epoch', String(v + 1));
    } catch (e) {}
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
