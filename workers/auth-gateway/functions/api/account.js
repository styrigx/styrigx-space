/**
 * 账号体系：账号登录 + 账号页（原「站长凭证」升级为账号）。
 *
 * 账号凭证（ownerkey）= 账号密码（KV owner-pw，SGX_PW_PEPPER）+ 账号通行密钥
 * （KV owner-passkey:<credId12>，class='owner'）。存储沿用原站长凭证，不迁移数据，
 * 旧的站长密码/通行密钥直接就是账号密码/通行密钥（同 RP styrigx.com，不重新注册）。
 *
 * 账号登录三个入口平级，任一成功即签发账号会话 sgx-account（_kernel/account-session.js）：
 * - 账号通行密钥：本接口 challenge + login-passkey
 * - 账号密码：本接口 login-password
 * - 根凭证：/api/root-auth { key, target:'account' }（沿用根凭证的限速/审计/假入口）
 * 账号会话独立验证：lock 会话（sgx-verified）只是前置条件（必须是已解锁的 owner），
 * 从不被当作账号认证。
 *
 * GET /api/account → { ok, password, passkey, ready, session }
 *   - 需 owner lock 会话（访客/无会话 401）；只返回「是否已设置」，无敏感数据
 *   - ready：账号签名钥匙是否已配置（false → 登录会 503 config）
 *   - session：当前账号会话 { by, authAt, expiresAt, recent } 或 null
 *
 * POST /api/account { action, ... }（只接受同源；需 owner lock 会话，logout 除外）
 * 登录：
 * - challenge → 账号通行密钥登录 challenge（purpose=login，KV account-challenge:<cid>）
 * - login-passkey { cid, credential } → 验断言（UV=1、userHandle）→ sgx-account(by=passkey)
 * - login-password { password } → 验账号密码 → sgx-account(by=password)
 * - logout → 清 sgx-account（幂等，不需会话）
 * 账号页管理（需有效账号会话；除只读 list 外还要求 authAt ≤ 10 分钟，过旧 403 account-stale，前端重新登录）：
 * - list → 账号通行密钥列表（只读，不要求近期）
 * - register-challenge → 注册 challenge（user handle 沿用 owner-user-id:owner）
 * - register { cid, credential, name? } → 保存 class=owner 通行密钥
 * - delete { credId } → 删除账号通行密钥（account-epoch +1，当前设备账号会话重签）
 * - password { password } → 设置/修改账号密码（已有时 account-epoch +1 并重签当前会话）。
 *   根凭证登录（by=root）同样可用 → 恢复路径：忘了账号密码/丢了通行密钥用根凭证重置。
 *
 * 首次配置账号凭证（layer:owner 未标记）：标记 + session-epoch +1（废止 root 代管的
 * by=root,scope=keys 票，与原站长凭证一致），并重签当前设备 lock 会话。
 * 删光账号凭证：清 layer:owner（回到根凭证代管）。
 *
 * 缺 SGX_ACCOUNT_PRIVATE/PUBLIC：登录 503 config；管理操作因无法验账号会话返回 401 account。
 */
import { b64urlEnc } from '../_kernel/crypto.js';
import {
  b64urlDec,
  randB64,
  cborDecode,
  parseRegAuthData,
  coseToJwk,
  verifyAssertion,
  rpIdHashOf,
  consumeChallenge,
  findStoredKey,
} from '../_kernel/passkey-verify.js';
import { getPepper, makePasswordRecord, checkPasswordRecord, verifyRealmPassword } from '../_kernel/password.js';
import { bumpSessionEpoch, reissueSessionWithEpoch, ROLE_OWNER } from '../_kernel/session.js';
import {
  verifyAccountCookie,
  issueAccountCookie,
  clearAccountCookie,
  bumpAccountEpoch,
  accountKeysReady,
  accountConfigMissing,
  ACCOUNT_BY_PASSKEY,
  ACCOUNT_BY_PASSWORD,
} from '../_kernel/account-session.js';
import { isLayerConfigured, setLayerConfigured, clearLayerConfigured, LAYER_OWNER } from '../_kernel/layers.js';
import { REALM_ACCOUNT, REALM_LOCK, rpConfig, rpConfigMissing } from '../_kernel/realms.js';
import { KEY_OWNER } from '../_kernel/key-names.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import { verifySessionDetailed } from '../_middleware.js';
import {
  getPasskeys,
  savePasskey,
  deletePasskey,
  getUserHandle,
  providerOf,
  PK_CLASS_OWNER,
  OWNER_DISPLAY_NAME,
} from './owner-passkey.js';

const CHALLENGE_PREFIX = REALM_ACCOUNT.kv.challengePrefix; /* 'account-challenge:' */
const CHALLENGE_TTL = REALM_ACCOUNT.kv.challengeTtl; /* 5 分钟 */

/** @param {any} kv */
async function accountKeys(kv) {
  const keys = await getPasskeys(kv);
  return keys.filter(function (k) { return k.class === PK_CLASS_OWNER; });
}

/** @param {any} kv */
async function hasAccountPassword(kv) {
  const r = await kv.get(REALM_ACCOUNT.kv.password, 'json');
  return !!(r && r.hash);
}

/** @param {object} body @param {number} [status] */
function json(body, status) {
  return Response.json(body, { status: status || 200 });
}

/** owner lock 会话（前置条件，不是账号认证）。返回会话对象或 null */
async function ownerLockSession(request, env) {
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok || sess.role !== ROLE_OWNER) return null;
  return sess;
}

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    const kv = env && env.OWNER_KV;
    if (!(await ownerLockSession(request, env))) return json({ ok: false, error: 'session' }, 401);
    if (!kv) return json({ ok: false, error: 'config' }, 500);
    let password = false;
    let passkey = false;
    try {
      password = await hasAccountPassword(kv);
      passkey = (await accountKeys(kv)).length > 0;
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
    const acc = await verifyAccountCookie(request, env);
    return json({
      ok: true,
      password: password,
      passkey: passkey,
      ready: accountKeysReady(env),
      session: acc.ok ? { by: acc.by, authAt: acc.authAt, expiresAt: acc.exp, recent: !!acc.recent } : null,
    });
  } catch (e) {
    return json({ ok: false, error: 'server' }, 500);
  }
}

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: 'server' }, 500);
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  const kv = env && env.OWNER_KV;
  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (!isSameOrigin(request)) return originDenied();

  let body;
  try { body = await request.json(); } catch (e) {
    return json({ ok: false, error: 'body' }, 400);
  }
  const action = (body && body.action) || '';

  /* ============ logout（幂等，不需会话） ============ */
  if (action === 'logout') {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    clearAccountCookie(headers);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* 其余 action：先要 owner lock 会话（前置条件；visitor 已被 middleware 403） */
  const sess = await ownerLockSession(request, env);
  if (!sess) return json({ ok: false, error: 'session' }, 401);
  if (!kv) return json({ ok: false, error: 'config' }, 500);

  /* ============ login-password ============ */
  if (action === 'login-password') {
    if (!accountKeysReady(env)) return accountConfigMissing();
    const password = (body && body.password) || '';
    if (!password || typeof password !== 'string') return json({ ok: false, error: 'params' }, 400);
    const pepper = getPepper(env);
    if (!pepper) return json({ ok: false, error: 'config' }, 503);
    let vr;
    try {
      vr = await verifyRealmPassword(kv, REALM_ACCOUNT, pepper, password);
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
    if (!vr.set) return json({ ok: false, error: 'not-set' }, 403);
    if (!vr.ok) return json({ ok: false, error: 'wrong' }, 403);
    if (vr.needsRehash) {
      try { await kv.put(REALM_ACCOUNT.kv.password, JSON.stringify(await makePasswordRecord(password, pepper))); } catch (e) {}
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const err = await issueAccountCookie(env, headers, ACCOUNT_BY_PASSWORD);
    if (err) return json(err.body, err.status);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* 通行密钥相关 action 需要 RP 配置 */
  const needsRp = action === 'challenge' || action === 'login-passkey' || action === 'register-challenge' || action === 'register';

  /* ============ challenge（账号通行密钥登录） ============ */
  if (action === 'challenge') {
    if (!accountKeysReady(env)) return accountConfigMissing();
    const rp = rpConfig(env);
    if (!rp) return rpConfigMissing();
    const keys = await accountKeys(kv);
    if (keys.length === 0) return json({ ok: false, error: 'not-set' }, 403);
    const challenge = randB64(32);
    const cid = randB64(16);
    try {
      await kv.put(
        CHALLENGE_PREFIX + cid,
        JSON.stringify({ challenge: challenge, purpose: 'login', exp: Date.now() + CHALLENGE_TTL * 1000 }),
        { expirationTtl: CHALLENGE_TTL }
      );
    } catch (e) {
      return json({ ok: false, error: 'server' }, 500);
    }
    return json({
      ok: true,
      cid: cid,
      challenge: challenge,
      rpId: rp.rpId,
      allowCredentials: keys.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
    });
  }

  /* ============ login-passkey ============ */
  if (action === 'login-passkey') {
    if (!accountKeysReady(env)) return accountConfigMissing();
    const rp = rpConfig(env);
    if (!rp) return rpConfigMissing();
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    const chRec = await consumeChallenge(kv, CHALLENGE_PREFIX + cid);
    if (!chRec || chRec.purpose !== 'login' || chRec.exp < Date.now()) {
      return json({ ok: false, error: 'challenge' }, 403);
    }
    const keys = await accountKeys(kv);
    if (keys.length === 0) return json({ ok: false, error: 'not-set' }, 403);
    const stored = findStoredKey(keys, cred.rawId || '');
    if (!stored || !stored.publicKey) return json({ ok: false, error: 'unknown-key' }, 403);
    if (stored.class !== PK_CLASS_OWNER) return json({ ok: false, error: 'class-mismatch' }, 403);
    try {
      const checked = await verifyAssertion({
        credential: cred,
        challenge: chRec.challenge,
        rpIdHash: await rpIdHashOf(rp.rpId),
        expectOrigin: rp.origin,
        storedPublicKey: stored.publicKey,
        storedSignCount: stored.signCount,
        requireUV: true,
      });
      /* userHandle：接受账号 handle（owner-user-id:owner）或旧 handle（owner-user-id，
         早期注册的站长通行密钥），与原站长凭证规则一致 */
      const gotUh = cred.response && cred.response.userHandle;
      if (gotUh) {
        const expectUh = await getUserHandle(kv, PK_CLASS_OWNER, '');
        if (expectUh && gotUh !== expectUh) {
          let legacyUh = null;
          try { legacyUh = await kv.get('owner-user-id'); } catch (e) {}
          if (!legacyUh || gotUh !== legacyUh) throw new Error('userHandle');
        }
      }
      stored.signCount = checked.signCount;
      stored.lastUsedAt = Date.now();
      try { await savePasskey(kv, stored); } catch (e) {}
    } catch (e) {
      console.error('[account-login]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : 'verify';
      return json({ ok: false, error: code }, 403);
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const err = await issueAccountCookie(env, headers, ACCOUNT_BY_PASSKEY);
    if (err) return json(err.body, err.status);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* ============ 账号页管理：需近期账号会话 ============ */
  const MGMT = ['list', 'register-challenge', 'register', 'delete', 'password'];
  if (MGMT.indexOf(action) === -1) return json({ ok: false, error: 'action' }, 400);

  const acc = await verifyAccountCookie(request, env);
  if (!acc.ok) return json({ ok: false, error: 'account', reason: acc.reason }, 401);
  /* 只读的 list 不要求近期；改动（注册/删除/改密码）要求 10 分钟内登录过 */
  if (!acc.recent && action !== 'list') return json({ ok: false, error: 'account-stale' }, 403);

  /* 首次配置账号层：标记 + session-epoch +1 + 重签当前 lock 会话（失败 503） */
  async function markConfigured(headers) {
    if (await isLayerConfigured(kv, LAYER_OWNER)) return null;
    try {
      await setLayerConfigured(kv, LAYER_OWNER);
      const ne = await bumpSessionEpoch(kv);
      await reissueSessionWithEpoch(env, headers, sess, ne);
    } catch (e) {
      return json({ ok: false, error: 'epoch' }, 503);
    }
    return null;
  }
  /* 账号凭证变更（改密码/删通行密钥）：account-epoch +1，当前设备账号会话保留原 by/authAt 重签 */
  async function rotateAccount(headers) {
    const ne = await bumpAccountEpoch(kv); /* 出错抛 → 外层 500/调用方 503 */
    await issueAccountCookie(env, headers, acc.by, { authAt: acc.authAt, epoch: ne });
  }

  if (action === 'list') {
    const keys = await accountKeys(kv);
    return json({
      ok: true,
      by: acc.by,
      keys: keys.map(function (k) {
        return {
          credId: k.credId,
          name: k.name || '',
          provider: k.provider || '',
          createdAt: k.createdAt || 0,
          lastUsedAt: k.lastUsedAt || 0,
        };
      }),
    });
  }

  if (action === 'password') {
    const pw = (body && body.password) || '';
    if (!pw || typeof pw !== 'string') return json({ ok: false, error: 'params' }, 400);
    if (pw.length < 8) return json({ ok: false, error: 'short' }, 400);
    const pepper = getPepper(env);
    if (!pepper) return json({ ok: false, error: 'config' }, 503);
    let existed = false;
    try {
      existed = await hasAccountPassword(kv);
      /* 账号密码不得与锁屏密码相同（双向检查；锁屏侧见 owner-password.js） */
      const lockRec = await kv.get(REALM_LOCK.kv.password, 'json');
      if (lockRec && lockRec.hash) {
        const cr = await checkPasswordRecord(lockRec, pw, pepper);
        if (cr.ok) return json({ ok: false, error: 'same-as-lock' }, 403);
      }
      await kv.put(REALM_ACCOUNT.kv.password, JSON.stringify(await makePasswordRecord(pw, pepper)));
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const mErr = await markConfigured(headers);
    if (mErr) return mErr;
    if (existed) {
      try { await rotateAccount(headers); } catch (e) { return json({ ok: false, error: 'server' }, 503); }
    }
    return new Response(JSON.stringify({ ok: true, changed: existed }), { headers });
  }

  if (action === 'delete') {
    const credId = (body && body.credId) || '';
    if (!credId || typeof credId !== 'string') return json({ ok: false, error: 'params' }, 400);
    const keys = await accountKeys(kv);
    const found = findStoredKey(keys, credId);
    if (!found) return json({ ok: false, error: 'not-found' }, 404);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    /* 先推纪元再删（fail closed：纪元推进失败则钥匙仍在） */
    try { await rotateAccount(headers); } catch (e) { return json({ ok: false, error: 'epoch' }, 503); }
    try { await deletePasskey(kv, credId); } catch (e) { return json({ ok: false, error: 'server' }, 503); }
    /* 删光账号凭证 → 清 layer:owner（回到根凭证代管；清失败 503，避免标记残留锁死代管） */
    try {
      const left = (await accountKeys(kv)).length;
      if (left === 0 && !(await hasAccountPassword(kv))) {
        await clearLayerConfigured(kv, LAYER_OWNER);
      }
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* register-challenge / register：通行密钥注册 */
  if (needsRp) {
    const rp = rpConfig(env);
    if (!rp) return rpConfigMissing();

    if (action === 'register-challenge') {
      const keys = await accountKeys(kv);
      const userHandle = await getUserHandle(kv, PK_CLASS_OWNER, '');
      if (!userHandle) return json({ ok: false, error: 'server' }, 503);
      const challenge = randB64(32);
      const cid = randB64(16);
      try {
        await kv.put(
          CHALLENGE_PREFIX + cid,
          JSON.stringify({ challenge: challenge, purpose: 'register', exp: Date.now() + CHALLENGE_TTL * 1000 }),
          { expirationTtl: CHALLENGE_TTL }
        );
      } catch (e) {
        return json({ ok: false, error: 'server' }, 500);
      }
      return json({
        ok: true,
        cid: cid,
        challenge: challenge,
        rpId: rp.rpId,
        rp: { id: rp.rpId, name: 'Styrigx' },
        /* 用户信息与原站长通行密钥相同（同 handle），密码管理器里仍是同一条账号 */
        user: { id: userHandle, name: KEY_OWNER, displayName: OWNER_DISPLAY_NAME },
        excludeCredentials: keys.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
      });
    }

    /* action === 'register' */
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    const chRec = await consumeChallenge(kv, CHALLENGE_PREFIX + cid);
    if (!chRec || chRec.purpose !== 'register' || chRec.exp < Date.now()) {
      return json({ ok: false, error: 'challenge' }, 403);
    }
    let item;
    try {
      const clientData = JSON.parse(new TextDecoder().decode(b64urlDec(cred.response.clientDataJSON)));
      if (clientData.type !== 'webauthn.create') throw new Error('type');
      if (String(clientData.challenge || '').replace(/=+$/, '') !== String(chRec.challenge).replace(/=+$/, '')) throw new Error('challenge');
      if (clientData.origin !== rp.origin) throw new Error('origin');
      const attObj = cborDecode(b64urlDec(cred.response.attestationObject)).value;
      if (!(attObj instanceof Map)) throw new Error('attestationObject');
      const authData = attObj.get('authData');
      if (!(authData instanceof Uint8Array)) throw new Error('authData');
      const parsed = parseRegAuthData(authData, await rpIdHashOf(rp.rpId));
      if (!parsed.uv) throw new Error('uv-required');
      const jwk = coseToJwk(parsed.coseKey);
      const credIdB64 = b64urlEnc(parsed.credId);
      let aaguid = '';
      try {
        if (parsed.aaguid) {
          const h = Array.from(parsed.aaguid, b => b.toString(16).padStart(2, '0')).join('');
          aaguid = h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
        }
      } catch (e) {}
      const provider = providerOf(aaguid);
      const name = String((body && body.name) || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
      item = {
        name: name || provider || '通行密钥',
        provider: provider,
        aaguid: aaguid,
        createdAt: Date.now(),
        lastUsedAt: 0,
        credId: credIdB64,
        publicKey: jwk,
        signCount: parsed.signCount,
        uv: 1,
        class: PK_CLASS_OWNER,
      };
      /* 同 credId 已存在且不是账号类 → 拒绝（不改别的类别的钥匙） */
      const all = await getPasskeys(kv);
      const dup = findStoredKey(all, credIdB64);
      if (dup && dup.class !== PK_CLASS_OWNER) throw new Error('class');
      if (dup) item.createdAt = dup.createdAt || item.createdAt;
      await savePasskey(kv, item);
    } catch (e) {
      console.error('[account-register]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : (e && e.message === 'class') ? 'class' : 'verify';
      return json({ ok: false, error: code }, 403);
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const mErr = await markConfigured(headers);
    if (mErr) return mErr;
    return new Response(JSON.stringify({ ok: true, credId: item.credId }), { headers });
  }

  return json({ ok: false, error: 'action' }, 400);
}
