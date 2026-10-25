/**
 * 账号体系：账号登录 + 账号页。
 *
 * 账号凭证（AccountKey）= 账号密码（SGX_PW_PEPPER）+ 账号通行密钥（通行密钥记录 class=账号，
 * 存储见 _kernel/passkey-store.js）。同 RP styrigx.com。
 *
 * 账号登录入口平级，任一成功即签发账号会话（_kernel/account-session.js）：
 * - 账号通行密钥：本接口 login-challenge + login-passkey
 * - 账号密码：本接口 login-password
 * - 根凭证：/api/root-auth { key, purpose:'account' }（「重置登录」：根凭证不是普通登录入口；
 *   沿用根凭证的限速 / 审计 / 假入口，另签账号门票）
 * 账号会话独立验证：锁屏会话只是前置条件（必须是已解锁的站长），从不被当作账号认证。
 *
 * GET /api/account → { ok, password, passkey, ready, session, door }
 *   - 需站长锁屏会话（访客 / 无会话 401）；只返回「是否已设置」，无敏感数据
 *   - ready：账号签名钥匙是否已配置（false → 登录会 503 config）
 *   - session：当前账号会话 { by, authAt, expiresAt, device } 或 null（device = 此设备的名字）
 *   - door：账号门票（账号安全子页）{ by, expiresAt } 或 null；前端 3 分钟倒计时以 expiresAt 为准
 *
 * POST /api/account { action, ... }（只接受同源；需站长锁屏会话，logout / reauth-clear 除外）
 * 登录：
 * - login-challenge → 账号通行密钥登录 challenge（purpose=login）
 * - login-passkey { cid, credential, door? } → 验断言（UV=1、userHandle）→ 账号会话(by=passkey)
 * - login-password { password, door? } → 验账号密码 → 账号会话(by=password)
 *   door:true（账号安全子页的门）→ 另签账号门票(door=account)，3 分钟
 *   （丢了账号凭证走「重置登录」：/api/root-auth { key, purpose:'account' }）
 * - logout → 清账号会话和门票（幂等，不需会话）
 * - reauth-clear → 只清门票（离开账号安全子页时调；幂等，不需会话）
 * 账号页管理（需有效账号会话；除只读的 passkey-list 外还要求有效的账号门票，没有/过期 403 door，前端重新进门）：
 * - passkey-list → 账号通行密钥列表 + userHandle（账号 handle，非机密；前端拿来调
 *   PublicKeyCredential.signalCurrentUserDetails 更新密码管理器里的名字）
 * - passkey-register-challenge → 注册 challenge（账号 user handle）
 * - passkey-register { cid, credential, name? } → 保存账号通行密钥
 * - passkey-delete { credId } → 删除账号通行密钥（account-epoch +1，当前设备账号会话重签）
 * - passkey-rename { credId, name } → 重命名账号通行密钥（名字规则同锁屏 rename：去控制字符、去首尾空格、
 *   1–40 字；只改账号通行密钥，别的域 not-found；不推纪元）
 * - password-change { password } → 设置/修改账号密码（已有时 account-epoch +1 并重签当前会话）。
 *   根凭证重置登录（by=root）同样可用 → 恢复路径。
 * 设备（只要账号会话，不进门；记录见 _kernel/account-devices.js）：
 * - device-list → { devices: [{ deviceId, current, name, model, platform, browser, country, city, by, createdAt, lastSeen }] }，此设备排第一
 * - device-revoke { deviceId } → 单独退出那台设备（删记录 + 拉黑）；不能退出此设备（400 current，用退出账号）
 *
 * 首次配置账号凭证（账号层未标记）：标记 + session-epoch +1，并重签当前设备锁屏会话。
 * 删光账号凭证：清账号层标记（回到根凭证代管）。
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
import { bumpSessionEpoch, reissueSessionWithEpoch, ROLE_OWNER } from '../_kernel/lock-session.js';
import {
  verifyAccountCookie,
  issueAccountCookie,
  clearAccountCookie,
  bumpAccountEpoch,
  accountKeysReady,
  accountConfigMissing,
  accountSessionOpts,
  ACCOUNT_BY_PASSKEY,
  ACCOUNT_BY_PASSWORD,
} from '../_kernel/account-session.js';
import { listDevices, revokeDevice, pruneOtherDevices, deviceView, getDevice, isDeviceId, DEVICE_PREFIX } from '../_kernel/account-devices.js';
import { verifyDoorCookie, issueDoorCookie, reissueDoorWithEpoch, clearDoorCookie, DOOR_ACCOUNT } from '../_kernel/tickets.js';
import { isLayerConfigured, setLayerConfigured, clearLayerConfigured, LAYER_ACCOUNT } from '../_kernel/layers.js';
import { REALM_ACCOUNT, REALM_LOCK, rpConfig, rpConfigMissing } from '../_kernel/realms.js';
import { KEY_ACCOUNT, LOCK_USER_HANDLE_KEY, ACCOUNT_USER_HANDLE_KEY } from '../_kernel/key-names.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import { verifySessionDetailed } from '../_middleware.js';
import {
  getPasskeys,
  savePasskey,
  deletePasskey,
  getUserHandle,
  providerOf,
  PK_CLASS_ACCOUNT,
  PASSKEY_DISPLAY_NAME,
} from '../_kernel/passkey-store.js';

const CHALLENGE_PREFIX = REALM_ACCOUNT.kv.challengePrefix;
const CHALLENGE_TTL = REALM_ACCOUNT.kv.challengeTtl; /* 5 分钟 */

/** @param {any} kv */
async function accountKeys(kv) {
  const keys = await getPasskeys(kv);
  return keys.filter(function (k) { return k.class === PK_CLASS_ACCOUNT; });
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

/** 站长锁屏会话（前置条件，不是账号认证）。返回会话对象或 null */
async function adminLockSession(request, env) {
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok || sess.role !== ROLE_OWNER) return null;
  return sess;
}

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    const kv = env && env.KV_LOCK_DOOR;
    const akv = env && env.KV_ACCOUNT_LOGIN; /* account-* 键（设备记录、challenge、account-epoch） */
    if (!(await adminLockSession(request, env))) return json({ ok: false, error: 'session' }, 401);
    if (!kv || !akv) return json({ ok: false, error: 'config' }, 500);
    let password = false;
    let passkey = false;
    try {
      password = await hasAccountPassword(kv);
      passkey = (await accountKeys(kv)).length > 0;
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
    const acc = await verifyAccountCookie(request, env);
    const dv = acc.ok ? await verifyDoorCookie(request, env, DOOR_ACCOUNT) : { ok: false };
    /* 账号总览「设备」一行的副标题：此设备的名字 */
    let devName = '';
    if (acc.ok && acc.sid) {
      try {
        const d = await getDevice(akv, acc.sid);
        if (d) devName = deviceView(d, acc.sid).name;
      } catch (e) {}
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (acc.ok && !acc.sid) {
      await issueAccountCookie(env, headers, acc.by, { authAt: acc.authAt, epoch: acc.epoch, request: request });
    }
    return new Response(JSON.stringify({
      ok: true,
      password: password,
      passkey: passkey,
      ready: accountKeysReady(env),
      session: acc.ok ? { by: acc.by, authAt: acc.authAt, expiresAt: acc.exp, device: devName } : null,
      door: dv.ok ? { by: dv.by, expiresAt: dv.exp } : null,
    }), { headers });
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
  const kv = env && env.KV_LOCK_DOOR;
  const akv = env && env.KV_ACCOUNT_LOGIN; /* account-* 键（设备记录、challenge、account-epoch） */
  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (!isSameOrigin(request)) return originDenied();

  let body;
  try { body = await request.json(); } catch (e) {
    return json({ ok: false, error: 'body' }, 400);
  }
  const action = (body && body.action) || '';
  /* 登录时顺带进门（账号安全子页的门）：只认布尔 true */
  const wantDoor = !!(body && body.door === true);

  /* ============ logout（幂等，不需会话） ============ */
  if (action === 'logout') {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    /* 本机的设备记录也删掉（并拉黑 sid，防 cookie 被拷走后继续用）；验不过就只清 cookie */
    try {
      const cur = await verifyAccountCookie(request, env);
      if (cur.ok && cur.sid && akv) await revokeDevice(akv, cur.sid);
    } catch (e) {}
    clearAccountCookie(headers);
    clearDoorCookie(headers);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* ============ reauth-clear（离开账号安全子页：门票立即作废；幂等，不需会话） ============ */
  if (action === 'reauth-clear') {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    clearDoorCookie(headers);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* 其余 action：先要站长锁屏会话（前置条件；visitor 已被 middleware 403） */
  const sess = await adminLockSession(request, env);
  if (!sess) return json({ ok: false, error: 'session' }, 401);
  if (!kv || !akv) return json({ ok: false, error: 'config' }, 500);

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
    const err = await issueAccountCookie(env, headers, ACCOUNT_BY_PASSWORD, await accountSessionOpts(request, env, body));
    if (err) return json(err.body, err.status);
    if (wantDoor) {
      const dErr = await issueDoorCookie(env, headers, DOOR_ACCOUNT, ACCOUNT_BY_PASSWORD);
      if (dErr) return json(dErr.body, dErr.status);
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* 通行密钥相关 action 需要 RP 配置 */
  const needsRp = action === 'login-challenge' || action === 'login-passkey' || action === 'passkey-register-challenge' || action === 'passkey-register';

  /* ============ login-challenge（账号通行密钥登录） ============ */
  if (action === 'login-challenge') {
    if (!accountKeysReady(env)) return accountConfigMissing();
    const rp = rpConfig(env);
    if (!rp) return rpConfigMissing();
    const keys = await accountKeys(kv);
    if (keys.length === 0) return json({ ok: false, error: 'not-set' }, 403);
    const challenge = randB64(32);
    const cid = randB64(16);
    try {
      await akv.put(
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
    const chRec = await consumeChallenge(akv, CHALLENGE_PREFIX + cid);
    if (!chRec || chRec.purpose !== 'login' || chRec.exp < Date.now()) {
      return json({ ok: false, error: 'challenge' }, 403);
    }
    const keys = await accountKeys(kv);
    if (keys.length === 0) return json({ ok: false, error: 'not-set' }, 403);
    const stored = findStoredKey(keys, cred.rawId || '');
    if (!stored || !stored.publicKey) return json({ ok: false, error: 'unknown-key' }, 403);
    if (stored.class !== PK_CLASS_ACCOUNT) return json({ ok: false, error: 'class-mismatch' }, 403);
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
      /* userHandle：接受账号 handle，或锁屏 handle（早期注册的账号通行密钥用的是它，
         凭据里写死了，换不掉） */
      const gotUh = cred.response && cred.response.userHandle;
      if (gotUh) {
        const expectUh = await getUserHandle(kv, PK_CLASS_ACCOUNT, '');
        if (expectUh && gotUh !== expectUh) {
          let legacyUh = null;
          try { legacyUh = await kv.get(LOCK_USER_HANDLE_KEY); } catch (e) {}
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
    const err = await issueAccountCookie(env, headers, ACCOUNT_BY_PASSKEY, await accountSessionOpts(request, env, body));
    if (err) return json(err.body, err.status);
    if (wantDoor) {
      const dErr = await issueDoorCookie(env, headers, DOOR_ACCOUNT, ACCOUNT_BY_PASSKEY);
      if (dErr) return json(dErr.body, dErr.status);
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* ============ 账号页管理：需账号会话；改动还要账号门票 ============ */
  const MGMT = ['passkey-list', 'passkey-register-challenge', 'passkey-register', 'passkey-delete', 'passkey-rename', 'password-change', 'device-list', 'device-revoke'];
  if (MGMT.indexOf(action) === -1) return json({ ok: false, error: 'action' }, 400);

  const acc = await verifyAccountCookie(request, env);
  if (!acc.ok) return json({ ok: false, error: 'account', reason: acc.reason }, 401);
  /* 只读的 passkey-list 只要账号会话；改动（注册/删除/重命名/改密码）是安全操作，必须有有效的账号门票
     （进账号安全子页时验过账号凭证，3 分钟，离开即作废） */
  let door = null;
  /* 设备页（列出 / 单独退出别的设备）只要账号会话，不进门 */
  if (action === 'device-list') {
    let all;
    try { all = await listDevices(akv); } catch (e) { return json({ ok: false, error: 'server' }, 503); }
    const cur = acc.sid || '';
    const views = all.map(function (d) { return deviceView(d, cur); });
    views.sort(function (a, b) { return (b.current ? 1 : 0) - (a.current ? 1 : 0); });
    return json({ ok: true, devices: views });
  }
  if (action === 'device-revoke') {
    const deviceId = (body && body.deviceId) || '';
    if (!isDeviceId(deviceId)) return json({ ok: false, error: 'params' }, 400);
    if (deviceId === acc.sid) return json({ ok: false, error: 'current' }, 400);
    let rec = null;
    try { rec = await akv.get(DEVICE_PREFIX + deviceId, 'json'); } catch (e) { return json({ ok: false, error: 'server' }, 503); }
    if (!rec) return json({ ok: false, error: 'not-found' }, 404);
    try { await revokeDevice(akv, deviceId); } catch (e) { return json({ ok: false, error: 'server' }, 503); }
    return json({ ok: true });
  }
  if (action !== 'passkey-list') {
    door = await verifyDoorCookie(request, env, DOOR_ACCOUNT);
    if (!door.ok) return json({ ok: false, error: 'door', reason: door.reason }, 403);
  }

  /* 首次配置账号层：标记 + session-epoch +1 + 重签当前锁屏会话（失败 503） */
  async function markConfigured(headers) {
    if (await isLayerConfigured(kv, LAYER_ACCOUNT)) return null;
    try {
      await setLayerConfigured(kv, LAYER_ACCOUNT);
      const ne = await bumpSessionEpoch(kv);
      await reissueSessionWithEpoch(env, headers, sess, ne);
    } catch (e) {
      return json({ ok: false, error: 'epoch' }, 503);
    }
    return null;
  }
  /* 账号凭证变更（改密码/删通行密钥）：account-epoch +1，当前设备账号会话保留原 by/authAt 重签 */
  async function rotateAccount(headers) {
    const ne = await bumpAccountEpoch(akv); /* 出错抛 → 外层 500/调用方 503 */
    await issueAccountCookie(env, headers, acc.by, { authAt: acc.authAt, epoch: ne, sid: acc.sid, record: false });
    /* 其他设备的票据随纪元失效：设备页上也不再列它们 */
    await pruneOtherDevices(akv, acc.sid || '');
    /* 门票也绑 account-epoch：当前设备的门票按原到期时间重签，门内可以接着操作 */
    await reissueDoorWithEpoch(env, headers, DOOR_ACCOUNT, door, ne);
  }

  if (action === 'passkey-list') {
    const keys = await accountKeys(kv);
    /* 账号 handle（注册用的那个）；读不到就不给，前端不 signal。不新建（list 只读）。 */
    let userHandle = '';
    try { userHandle = (await kv.get(ACCOUNT_USER_HANDLE_KEY)) || ''; } catch (e) {}
    return json({
      ok: true,
      by: acc.by,
      userHandle: userHandle,
      userName: KEY_ACCOUNT,
      displayName: PASSKEY_DISPLAY_NAME,
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

  if (action === 'password-change') {
    const password = (body && body.password) || '';
    if (!password || typeof password !== 'string') return json({ ok: false, error: 'params' }, 400);
    if (password.length < 8) return json({ ok: false, error: 'short' }, 400);
    const pepper = getPepper(env);
    if (!pepper) return json({ ok: false, error: 'config' }, 503);
    let existed = false;
    try {
      existed = await hasAccountPassword(kv);
      /* 账号密码不得与锁屏密码相同（双向检查；锁屏侧见 lock-password.js 的 same-as-account） */
      const lockRec = await kv.get(REALM_LOCK.kv.password, 'json');
      if (lockRec && lockRec.hash) {
        const cr = await checkPasswordRecord(lockRec, password, pepper);
        if (cr.ok) return json({ ok: false, error: 'same-as-lock' }, 403);
      }
      await kv.put(REALM_ACCOUNT.kv.password, JSON.stringify(await makePasswordRecord(password, pepper)));
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

  if (action === 'passkey-delete') {
    const credId = (body && body.credId) || '';
    if (!credId || typeof credId !== 'string') return json({ ok: false, error: 'params' }, 400);
    const keys = await accountKeys(kv);
    const found = findStoredKey(keys, credId);
    if (!found) return json({ ok: false, error: 'not-found' }, 404);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    /* 先推纪元再删（fail closed：纪元推进失败则钥匙仍在） */
    try { await rotateAccount(headers); } catch (e) { return json({ ok: false, error: 'epoch' }, 503); }
    try { await deletePasskey(kv, credId); } catch (e) { return json({ ok: false, error: 'server' }, 503); }
    /* 删光账号凭证 → 清账号层标记（回到根凭证代管；清失败 503，避免标记残留锁死代管） */
    try {
      const left = (await accountKeys(kv)).length;
      if (left === 0 && !(await hasAccountPassword(kv))) {
        await clearLayerConfigured(kv, LAYER_ACCOUNT);
      }
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  if (action === 'passkey-rename') {
    const credId = (body && body.credId) || '';
    if (!credId || typeof credId !== 'string') return json({ ok: false, error: 'params' }, 400);
    /* 名字规则与 lock-passkey.js rename 一致：去控制字符、去首尾空格、限 40 字，空 → params */
    const name = String((body && body.name) || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
    if (!name) return json({ ok: false, error: 'params' }, 400);
    const keys = await accountKeys(kv);
    const found = findStoredKey(keys, credId);
    if (!found) return json({ ok: false, error: 'not-found' }, 404);
    found.name = name;
    try { await savePasskey(kv, found); } catch (e) { return json({ ok: false, error: 'server' }, 503); }
    return json({ ok: true, name: name });
  }

  /* passkey-register-challenge / passkey-register：账号通行密钥注册 */
  if (needsRp) {
    const rp = rpConfig(env);
    if (!rp) return rpConfigMissing();

    if (action === 'passkey-register-challenge') {
      const keys = await accountKeys(kv);
      const userHandle = await getUserHandle(kv, PK_CLASS_ACCOUNT, '');
      if (!userHandle) return json({ ok: false, error: 'server' }, 503);
      const challenge = randB64(32);
      const cid = randB64(16);
      try {
        await akv.put(
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
        /* 账号 user handle，user.name=AccountKey：密码管理器里显示 AccountKey；
           已有条目由前端 signalCurrentUserDetails 改名 */
        user: { id: userHandle, name: KEY_ACCOUNT, displayName: PASSKEY_DISPLAY_NAME },
        excludeCredentials: keys.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
      });
    }

    /* action === 'passkey-register' */
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    const chRec = await consumeChallenge(akv, CHALLENGE_PREFIX + cid);
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
        class: PK_CLASS_ACCOUNT,
      };
      /* 同 credId 已存在且不是账号类 → 拒绝（不改别的类别的钥匙） */
      const all = await getPasskeys(kv);
      const dup = findStoredKey(all, credIdB64);
      if (dup && dup.class !== PK_CLASS_ACCOUNT) throw new Error('class');
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
