/**
 * 锁屏通行密钥（LockKey 的通行密钥）：注册、解锁、进锁屏凭证的门、列表、重命名、删除。
 *
 * 原「管理员通行密钥」接口按域拆分：它只管锁屏通行密钥（账号通行密钥早已只在 /api/account 管理），
 * 所以只拆出本接口，没有另造 /api/account-passkey。请求体不再带 pkClass（路径就是域）。
 *
 * POST /api/lock-passkey
 * - { action: 'challenge', type: 'register'|'auth' } → 返回 challenge
 *   - register 需要 LockReauthTicket + admin 锁屏会话，或 LockResetTicket
 *   - auth 不需要（用于锁屏解锁 / 锁屏凭证的门）
 * - { action: 'register', cid, credential } → 验证并追加存储（再验票）
 * - { action: 'auth', cid, credential, reauth? } → 验证断言；签发会话 cookie；
 *   reauth:true（安全与隐私 → 锁屏凭证，需 admin 锁屏会话）改签 3 分钟 LockReauthTicket，会话不动
 * - { action: 'list' } → 列出锁屏通行密钥（需 LockReauthTicket 或 LockResetTicket）
 * - { action: 'rename', credId, name } → 重命名设备名（需 LockReauthTicket；重置锁屏不可）
 * - { action: 'delete', credId } → 删除指定通行密钥（需 LockReauthTicket 或 LockResetTicket；先推纪元再删，失败 503 且密钥仍在）
 *
 * 只接受 POST；Origin 缺失/解析失败/跨站一律 403。
 *
 * WebAuthn 校验（共享实现 _kernel/passkey-verify.js）：
 * - attestationObject 是文本键 CBOR map；COSE key 严格解析（kty=2、alg=-7、crv=1）
 * - authData：rpIdHash == SHA-256(RP_ID)，UP=1，注册和解锁都要求 UV=1
 * - clientData.origin 严格等于 SGX_ORIGIN；RP_ID/ORIGIN 必须配环境变量，不回落
 * - 断言：DER→raw 签名；signCount 非零时必须递增
 * - 用户信息由服务端下发：displayName=Sloan Gray, name=LockKey, rp.name=Styrigx
 * - 固定 user handle（锁屏域一个，见 _kernel/passkey-store.js），auth 时校验 userHandle
 * - register 带 excludeCredentials 防重复注册
 * 存储读写在 _kernel/passkey-store.js。
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
} from '../_kernel/passkey-verify.js';
import {
  issueLockSession,
  bumpLockEpoch,
  reissueLockSessionWithEpoch,
  ROLE_ADMIN,
} from '../_kernel/lock-session.js';
import { checkLockManage, looksVisitor, TICKET_IDS } from './lock-reauth.js';
import { issueTicket, reissueTicketWithEpoch } from '../_kernel/tickets.js';
import { LOCK_REAUTH_TICKET, BY_PASSKEY } from '../_kernel/realms.js';
import { LAYER_LOCK, setLayerConfigured, clearLayerConfigured, isLayerConfigured, isAccountEffectivelyConfigured } from '../_kernel/layers.js';
import { verifyLockSession } from '../_kernel/lock-session.js';
import { REALM_LOCK, SESSION_EPOCH_KEY, rpConfig, rpConfigMissing } from '../_kernel/realms.js';
import { KEY_LOCK, passkeyKey } from '../_kernel/key-names.js';
import {
  getPasskeys,
  savePasskey,
  deletePasskey,
  getUserHandle,
  providerOf,
  PK_CLASS_LOCK,
  PASSKEY_DISPLAY_NAME,
} from '../_kernel/passkey-store.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';

/* 锁屏通行密钥注册/登录 challenge 的 KV 前缀（与账号 challenge 隔离） */
const CHALLENGE_PREFIX = REALM_LOCK.kv.passkeyChallengePrefix;

/** @param {any} k 通行密钥记录 @returns {boolean} 是否锁屏通行密钥（无 class 的早期记录按锁屏） */
function isLockKey(k) {
  return (k.class || PK_CLASS_LOCK) === PK_CLASS_LOCK;
}

/**
 * 锁屏通行密钥管理门禁：LockReauthTicket + admin 锁屏会话，或 LockResetTicket（
 * 可 list/register/delete，不可 rename）。见 lock-reauth.js checkLockManage。
 * @param {any} request
 * @param {any} env
 * @param {string} op 'list' | 'register' | 'rename' | 'delete'
 */
async function checkPasskeyManage(request, env, op) {
  return checkLockManage(request, env, { allowReset: op !== 'rename' });
}

/**
 * 按 credId 直接读一把锁屏通行密钥（不走索引列表，避开最终一致）；不存在或不是锁屏通行密钥 → null。
 * @param {any} kv @param {string} credId
 */
async function getLockKey(kv, credId) {
  let found = null;
  try { found = await kv.get(passkeyKey(credId), 'json'); } catch (e) {}
  if (!found || found.credId !== credId || !isLockKey(found)) return null;
  return found;
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
  const kv = env && env.KV_LOCK_DOOR;

  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }
  /* Origin 必须与本站同 host（CSRF 防护），缺失或解析失败一律 403 */
  if (!isSameOrigin(request)) return originDenied();
  if (!kv) return Response.json({ ok: false, error: 'config' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false, error: 'body' }, { status: 400 });
  }
  const action = (body && body.action) || '';

  /* RP_ID / 期望 origin：必须设置环境变量，不回落（防配置错误） */
  const rp = rpConfig(env);
  if (!rp) return rpConfigMissing(); /* 缺变量：返回明确错误（503），前端据此禁用通行密钥入口 */
  const RP_ID = rp.rpId;
  const EXPECT_ORIGIN = rp.origin;
  const rpIdHash = await rpIdHashOf(RP_ID);

  /* ============ challenge ============
     - type=register：需 LockReauthTicket / LockResetTicket（checkPasskeyManage）
     - type=auth：challenge 只列锁屏通行密钥（锁屏解锁 / 锁屏凭证的门） */
  if (action === 'challenge') {
    const type = (body && body.type) || '';
    if (type !== 'register' && type !== 'auth') {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    const lockKeys = (await getPasskeys(kv)).filter(isLockKey);
    if (type === 'register') {
      const mg = await checkPasskeyManage(request, env, 'register');
      if (!mg.ok) {
        return Response.json(mg.body, { status: mg.status });
      }
    }
    /* auth 需要已有锁屏通行密钥 */
    if (type === 'auth' && lockKeys.length === 0) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    const challenge = randB64(32);
    const cid = randB64(16);
    try {
      await kv.put(CHALLENGE_PREFIX + cid, JSON.stringify({ challenge, type, exp: Date.now() + 300000 }), { expirationTtl: 300 });
    } catch (e) {}
    const resp = { ok: true, cid: cid, challenge: challenge, rpId: RP_ID };
    if (type === 'register') {
      /* 下发用户信息：全部写死，用户不填。displayName=Sloan Gray；name=LockKey。user.id 存 KV 复用。 */
      const userHandle = await getUserHandle(kv, PK_CLASS_LOCK);
      resp.user = {
        id: userHandle,
        name: KEY_LOCK,
        displayName: PASSKEY_DISPLAY_NAME,
      };
      resp.rp = {
        id: RP_ID,
        name: 'Styrigx',
      };
      /* excludeCredentials：防重复注册 */
      resp.excludeCredentials = lockKeys.map(function (k) {
        return { id: k.credId, type: 'public-key' };
      });
    }
    if (type === 'auth') {
      /* challenge 只列出锁屏通行密钥；服务端 verify 时再次校验分类 */
      resp.allowCredentials = lockKeys.map(function (k) { return { id: k.credId, type: 'public-key' }; });
    }
    return Response.json(resp);
  }

  /* ============ register ============
     门禁已在 challenge 环节执行；这里再验一次（纵深防御）。 */
  if (action === 'register') {
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    /* 取 challenge（单次使用） */
    const chRec = await consumeChallenge(kv, CHALLENGE_PREFIX + cid);
    if (!chRec || chRec.type !== 'register' || chRec.exp < Date.now()) {
      return Response.json({ ok: false, error: 'challenge' }, { status: 403 });
    }
    const mgReg = await checkPasskeyManage(request, env, 'register');
    if (!mgReg.ok) {
      return Response.json(mgReg.body, { status: mgReg.status });
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
      /* 存储（同 credId 去重；每把一个 key）。同 credId 已是账号通行密钥 → 拒绝（不改别的域的钥匙） */
      const now = Date.now();
      const deviceName = String((body && body.name) || '').slice(0, 40);
      const keys = await getPasskeys(kv);
      let existing = null;
      for (const k of keys) {
        if (k.credId === credIdB64) { existing = k; break; }
      }
      if (existing && !isLockKey(existing)) throw new Error('invalid-class');
      /* AAGUID 映射 provider，作为默认名 */
      const mappedProvider = providerOf(aaguid);
      const item = {
        name: deviceName || mappedProvider || (existing && existing.name) || '通行密钥',
        provider: mappedProvider || (body && body.provider) || (existing && existing.provider) || '',
        aaguid: aaguid || (existing && existing.aaguid) || '',
        createdAt: (existing && existing.createdAt) || now,
        lastUsedAt: (existing && existing.lastUsedAt) || 0,
        credId: credIdB64,
        publicKey: jwk,
        signCount: parsed.signCount,
        uv: 1,
        class: PK_CLASS_LOCK,
      };
      await savePasskey(kv, item);
      /* 首次配置锁屏层时标记 + 推进纪元（废止根凭证代开的解锁会话，必修安全项 2；
         纪元推进失败则返回 503）。纪元推进后用新纪元重签 reauth / reset 票 + 当前设备会话，保持当前设备不掉线。 */
      let regNewEpoch = null;
      try {
        const was = await isLayerConfigured(kv, LAYER_LOCK);
        if (!was) {
          await setLayerConfigured(kv, LAYER_LOCK);
          regNewEpoch = await bumpLockEpoch(kv);
        }
      } catch (e) {
        return Response.json({ ok: false, error: 'epoch' }, { status: 503 });
      }
      if (regNewEpoch !== null) {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        await reissueTicketWithEpoch(env, headers, mgReg.ticket, mgReg.tv, regNewEpoch);
        await reissueLockSessionWithEpoch(env, headers, mgReg.sess, regNewEpoch);
        return new Response(JSON.stringify({ ok: true, credId: credIdB64 }), { headers });
      }
      return Response.json({ ok: true, credId: credIdB64 });
    } catch (e) {
      /* 具体原因只写控制台；UV 失败返回专属错误码，其他仍返回普通错误 */
      console.error('[lock-passkey-register]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required'
        : (e && e.message === 'invalid-class') ? 'class' : 'verify';
      return Response.json({ ok: false, error: code }, { status: 403 });
    }
  }

  /* ============ auth ============
     只认锁屏通行密钥；verify 时服务端再次校验分类（浏览器凭据选择器不是安全边界）。
     reauth:true：安全与隐私 → 锁屏凭证，要求 admin 锁屏会话，成功只签 3 分钟 LockReauthTicket（会话不动）；
     访客写死失败，不读存储。 */
  if (action === 'auth') {
    const toReauth = !!(body && body.reauth === true);
    if (toReauth) {
      if (looksVisitor(request)) {
        return Response.json({ ok: false, error: 'verify' }, { status: 403 });
      }
      const ds = await verifyLockSession(request, env);
      if (!ds.ok || ds.role !== ROLE_ADMIN) {
        return Response.json({ ok: false, error: 'session' }, { status: 401 });
      }
    }
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    const chRec = await consumeChallenge(kv, CHALLENGE_PREFIX + cid);
    if (!chRec || chRec.type !== 'auth' || chRec.exp < Date.now()) {
      return Response.json({ ok: false, error: 'challenge' }, { status: 403 });
    }
    const lockKeys = (await getPasskeys(kv)).filter(isLockKey);
    if (lockKeys.length === 0) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    /* 按 credential id 找对应公钥 */
    const rawIdB64 = cred.rawId || '';
    let stored = null;
    for (let i = 0; i < lockKeys.length; i++) {
      if (lockKeys[i].credId === rawIdB64) { stored = lockKeys[i]; break; }
    }
    if (!stored || !stored.publicKey) {
      return Response.json({ ok: false, error: 'unknown-key' }, { status: 403 });
    }
    try {
      /* 共享断言验证（_kernel/passkey-verify.js）：clientData、authData、
         signCount 递增、ES256 签名、UV=1（P0-3）。 */
      const checked = await verifyAssertion({
        credential: cred,
        challenge: chRec.challenge,
        rpIdHash: rpIdHash,
        expectOrigin: EXPECT_ORIGIN,
        storedPublicKey: stored.publicKey,
        storedSignCount: stored.signCount,
        requireUV: true,
      });
      /* 校验 userHandle（如果有）；验证本身仍以凭据公钥签名为准。 */
      try {
        const expectUh = await getUserHandle(kv, PK_CLASS_LOCK);
        const gotUh = cred.response.userHandle;
        if (expectUh && gotUh && gotUh !== expectUh) throw new Error('userHandle');
      } catch (e) {
        if (e && e.message === 'userHandle') throw e;
      }
      /* 更新 signCount 和 lastUsedAt */
      stored.signCount = checked.signCount;
      stored.lastUsedAt = Date.now();
      try { await savePasskey(kv, stored); } catch (e2) {}
      /* 通过：签发 Ed25519 会话 cookie（fail closed；issueLockSession 永不抛错）。
         通行密钥验证签admin 会话（12 小时）。reauth:true：只签 LockReauthTicket（by=passkey）。 */
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (toReauth) {
        const dErr = await issueTicket(env, headers, LOCK_REAUTH_TICKET, BY_PASSKEY);
        if (dErr) return Response.json(dErr.body, { status: dErr.status });
        return new Response(JSON.stringify({ ok: true }), { headers });
      }
      const signErr = await issueLockSession(env, headers, { by: BY_PASSKEY, role: ROLE_ADMIN });
      if (signErr) {
        return new Response(JSON.stringify(signErr.body), {
          status: signErr.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch (e) {
      console.error('[lock-passkey-auth]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : 'verify';
      return Response.json({ ok: false, error: code }, { status: 403 });
    }
  }

  /* ============ list：列出锁屏通行密钥（需 LockReauthTicket 或 LockResetTicket） ============ */
  if (action === 'list') {
    const mg = await checkPasskeyManage(request, env, 'list');
    if (!mg.ok) {
      return Response.json(mg.body, { status: mg.status });
    }
    const keys = (await getPasskeys(kv)).filter(isLockKey);
    return Response.json({
      ok: true,
      ticket: TICKET_IDS[mg.ticket],
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

  /* ============ rename：重命名（统一门禁；重置锁屏不可 rename） ============ */
  if (action === 'rename') {
    const credId = (body && body.credId) || '';
    let name = (body && body.name) || '';
    if (!credId) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    const found0 = await getLockKey(kv, credId);
    if (!found0) {
      return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    }
    const mg = await checkPasskeyManage(request, env, 'rename');
    if (!mg.ok) {
      return Response.json(mg.body, { status: mg.status });
    }
    /* 清理：去首尾空格和控制字符，限 1-40 字 */
    name = String(name).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
    if (!name) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    found0.name = name;
    await savePasskey(kv, found0);
    return Response.json({ ok: true });
  }

  /* ============ delete：删除（需 LockReauthTicket；重置锁屏也可删） ============
     - 先 session-epoch +1（成功才删；失败 503，fail closed），reauth / reset 票与当前设备会话随即重签
     - 账号未配置时，禁止删掉最后一种锁屏凭证 */
  if (action === 'delete') {
    const credId = (body && body.credId) || '';
    if (!credId) return Response.json({ ok: false, error: 'params' }, { status: 400 });
    const found = await getLockKey(kv, credId);
    if (!found) {
      return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
    }
    const mg = await checkPasskeyManage(request, env, 'delete');
    if (!mg.ok) {
      return Response.json(mg.body, { status: mg.status });
    }
    /* A-2：锁屏凭证减到 0 的那次删除，只在账号已有效配置时允许；
       账号未配置时禁止（403 last-key）。判断在任何 mutation 之前。 */
    let hasLockPassword = false;
    try {
      const passwordRec = await kv.get(REALM_LOCK.kv.password, 'json');
      hasLockPassword = !!(passwordRec && passwordRec.hash);
    } catch (e) {}
    const lockKeys = (await getPasskeys(kv)).filter(isLockKey);
    if (!hasLockPassword && lockKeys.length <= 1) {
      let accountCfg = true;
      try {
        accountCfg = await isAccountEffectivelyConfigured(kv);
      } catch (e) {
        accountCfg = true;
      }
      if (!accountCfg) {
        return Response.json({ ok: false, error: 'last-key' }, { status: 403 });
      }
    }
    /* 先推进纪元，成功才删（fail closed；纪元推进失败则密钥仍在）。 */
    let newEpoch = null;
    try {
      const v = parseInt(await kv.get(SESSION_EPOCH_KEY) || '0', 10) || 0;
      newEpoch = v + 1;
      await kv.put(SESSION_EPOCH_KEY, String(newEpoch));
    } catch (e) {
      return Response.json({ ok: false, error: 'epoch' }, { status: 503 });
    }
    await deletePasskey(kv, credId);
    /* 删完后若锁屏层已无凭证：账号已配置 → 保留锁屏层标记；账号未配置（竞态）→ 清标记。 */
    try {
      const hasLockKey = (await getPasskeys(kv)).some(isLockKey);
      let hasLockPassword2 = false;
      try { const r = await kv.get(REALM_LOCK.kv.password, 'json'); hasLockPassword2 = !!(r && r.hash); } catch (e) {}
      if (!hasLockKey && !hasLockPassword2) {
        let accountCfg = true;
        try { accountCfg = await isAccountEffectivelyConfigured(kv); } catch (e) { accountCfg = true; }
        if (!accountCfg) {
          try {
            await clearLayerConfigured(kv, LAYER_LOCK);
          } catch (e) {
            return Response.json({ ok: false, error: 'server' }, { status: 503 });
          }
        }
      }
    } catch (e) {}
    /* 纪元推进后重签 reauth / reset 票 + 当前设备会话，保持门内连续操作不中断、当前设备不掉线。 */
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (newEpoch !== null) {
      await reissueTicketWithEpoch(env, headers, mg.ticket, mg.tv, newEpoch);
      /* 当前设备会话重签（重置锁屏无会话时 mg.sess 为 null，helper 内部跳过） */
      await reissueLockSessionWithEpoch(env, headers, mg.sess, newEpoch);
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
