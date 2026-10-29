/**
 * /api/account（账号 Worker，单入口 + action；账号拆分 PR2b，方案第 5.1 节）。
 *
 * 从网关 functions/api/account.js 复制改写：action 名、请求 / 响应字段、错误码、cookie、票都和网关一样，
 * 切换时前端不用改（账号页其余调用地址不变）。由命名入口 AccountService（src/entrypoints.js）把网关转发的请求交进来（PR2 暗上线，PR3 网关才开始转发）。
 *
 * 身份：不验锁屏会话，只读网关写的规范身份头（workers/shared/lock-identity.js）：
 * - X-Styrigx-Lock-Role 必须是 admin（logout / reauth-clear 除外）；没有 / 不认识的值 / visitor → 401 session（同网关无 admin 会话）。
 *   白名单校验：role ∈ admin | visitor，by ∈ password | passkey | tempkey，其它值一律当作没有身份。
 * - X-Styrigx-Client-Address：输错限速分桶、审计 IP 前缀（没有 → 'unknown'）；不读 CF-Connecting-IP。
 * - X-Styrigx-Client-Country / City：设备「上次活动地点」（account-devices.js）。
 * 这些头只能由网关写：本接口只挂在命名入口 AccountService（src/entrypoints.js）的路由表里，默认 fetch（公开路由）没有 /api/account、
 * 也不读这些头；PR3 起默认 fetch 一律 404、删公开路由（方案第 3 节三道保险）。
 *
 * GET /api/account → { ok, password, passkey, ready, configured, session, reauth, reset }
 *   configured（新）= password || passkey（账号是否已有任一凭证；没有就只能 root-reset 设第一把）。其余字段同网关。
 *
 * POST /api/account { action, ... }（同源）
 * 与网关相同：login-challenge、login-passkey、login-password、logout、reauth-clear、passkey-list、passkey-register-challenge、
 *   passkey-register、passkey-delete、passkey-rename、password-change、device-list、device-revoke
 * 新增：
 * - device-revoke-all：要账号会话 + AccountReauthTicket（只有 reset 票不行，403 reauth）。Account 纪元 +1、当前设备重签、
 *   其他设备的行全部删除（票随纪元失效）、短票按原到期时间重签。
 * - root-reauth / root-reset / audit-list：见 account-root.js。
 *
 * 与网关原行为的有意差别（方案第 2 节「两边不再互相影响」）：
 * - 首次配置账号凭证不再推 Lock 纪元、不再重签锁屏会话（删 markConfigured；这里读不到锁屏）。
 * - password-change 不再检查「不得与锁屏密码相同」（不再有 403 same-as-lock）。
 * - passkey-register 不再查这把凭据是否已是锁屏通行密钥（不再有 403 class）。
 * - login-passkey 的 userHandle 兼容：账号 handle 或本库 user_handle.legacy_handle（网关原来去读锁屏域的 handle）。
 * - 账号库只有 D1_ACCOUNT_AUTH 一个绑定（网关要 D1_LOCK_AUTH + D1_ACCOUNT_AUTH 都在）。
 * - 另记安全事件（account-root.js writeSecurityEvent，30 天）。
 *
 * 只 import workers/shared/ 和本目录。
 */
import { b64urlEnc } from '../../../shared/crypto.js';
import {
  b64urlDec,
  randB64,
  cborDecode,
  parseRegAuthData,
  coseToJwk,
  verifyAssertion,
  rpIdHashOf,
  consumeChallenge,
  issueChallenge,
  findStoredKey,
} from '../../../shared/passkey-verify.js';
import { getPepper, makePasswordRecord, verifyRealmPassword, hasPassword, savePassword } from '../../../shared/password.js';
import { passwordLimiter } from '../../../shared/password-limit.js';
import { isSameOrigin, originDenied, json, apiError } from '../../../shared/http.js';
import { LOCK_IDENTITY_HEADERS, CLIENT_CONTEXT_HEADERS } from '../../../shared/lock-identity.js';
import {
  BY_PASSKEY,
  BY_PASSWORD,
  ACCOUNT_REAUTH_TICKET,
  ACCOUNT_RESET_TICKET,
  KEY_ACCOUNT,
  REALM_ACCOUNT,
  rpConfig,
  rpConfigMissing,
} from './realm.js';
import {
  ACCOUNT_DB_REALM,
  storeReady,
  getPasskeys,
  countPasskeys,
  getPasskey,
  savePasskey,
  updatePasskey,
  deletePasskey,
  getUserHandle,
  peekUserHandle,
  peekLegacyHandle,
  providerOf,
  PASSKEY_DISPLAY_NAME,
} from './account-store.js';
import {
  verifyAccountSession,
  issueAccountSession,
  clearAccountSession,
  bumpAccountEpoch,
  accountKeysReady,
  accountConfigMissing,
  accountSessionOpts,
  verifyTicket,
  issueTicket,
  reissueTicketWithEpoch,
  clearTicket,
} from './account-session.js';
import { listDevices, revokeDevice, pruneOtherDevices, deviceView, getDevice, isDeviceId } from './account-devices.js';
import { handleRootAction, handleAuditList, writeSecurityEvent, ROOT_ACTIONS } from './account-root.js';

const CH = REALM_ACCOUNT.challenge; /* challenge 表的 purpose：login / register */
const CHALLENGE_TTL = CH.ttl; /* 5 分钟 */

/* ---------------- 身份头 ---------------- */

export const ROLE_ADMIN = 'admin';
export const ROLE_VISITOR = 'visitor';
const ROLES = Object.freeze([ROLE_ADMIN, ROLE_VISITOR]);
const LOCK_BYS = Object.freeze(['password', 'passkey', 'tempkey']);

/**
 * 网关写的锁屏身份（白名单校验）。没有 / 不认识的值 → null（= 无会话）。
 * @param {any} request
 * @returns {{role:string, by:string, tempkeyId:string}|null}
 */
export function readLockIdentity(request) {
  const h = request && request.headers;
  if (!h) return null;
  const role = String(h.get(LOCK_IDENTITY_HEADERS.role) || '').trim();
  if (ROLES.indexOf(role) === -1) return null;
  const byRaw = String(h.get(LOCK_IDENTITY_HEADERS.by) || '').trim();
  const by = LOCK_BYS.indexOf(byRaw) !== -1 ? byRaw : '';
  const tk = String(h.get(LOCK_IDENTITY_HEADERS.tempkeyId) || '').trim();
  const tempkeyId = role === ROLE_VISITOR && /^[A-Za-z0-9_-]{1,64}$/.test(tk) ? tk : '';
  return { role, by, tempkeyId };
}

/** 身份头是 admin 吗 @param {any} request */
export function isAdmin(request) {
  const id = readLockIdentity(request);
  return !!(id && id.role === ROLE_ADMIN);
}

/**
 * 客户端 IP：网关写的 X-Styrigx-Client-Address；没有 → 'unknown'（同 shared clientIp 的缺省）。
 * @param {any} request
 */
export function clientAddress(request) {
  const v = request && request.headers ? String(request.headers.get(CLIENT_CONTEXT_HEADERS.address) || '').trim() : '';
  return v && v.length <= 64 && /^[0-9A-Fa-f:.]+$/.test(v) ? v : 'unknown';
}

/* ---------------- GET ---------------- */

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    if (!isAdmin(request)) return apiError(401, 'session');
    if (!storeReady(env)) return apiError(500, 'config');
    let password = false;
    let passkey = false;
    try {
      password = await hasPassword(env, ACCOUNT_DB_REALM);
      passkey = (await countPasskeys(env)) > 0;
    } catch (e) {
      return apiError(503, 'server');
    }
    const acc = await verifyAccountSession(request, env);
    const rv = acc.ok ? await verifyTicket(request, env, ACCOUNT_REAUTH_TICKET) : { ok: false };
    const xv = await verifyTicket(request, env, ACCOUNT_RESET_TICKET);
    let devName = '';
    if (acc.ok && acc.deviceId) {
      try {
        const d = await getDevice(env, acc.deviceId);
        if (d) devName = deviceView(d, acc.deviceId).name;
      } catch (e) {}
    }
    return json(200, {
      ok: true,
      password: password,
      passkey: passkey,
      ready: accountKeysReady(env),
      configured: password || passkey,
      session: acc.ok ? { by: acc.by, authAt: acc.authAt, expiresAt: acc.exp, device: devName } : null,
      reauth: rv.ok ? { by: rv.by, expiresAt: rv.exp } : null,
      reset: xv.ok ? { by: xv.by, expiresAt: xv.exp } : null,
    });
  } catch (e) {
    return apiError(500, 'server');
  }
}

/* ---------------- POST ---------------- */

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return apiError(500, 'server');
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return apiError(405, 'method');
  if (!isSameOrigin(request)) return originDenied();

  let body;
  try { body = await request.json(); } catch (e) {
    return apiError(400, 'body');
  }
  const action = (body && body.action) || '';
  const wantReauth = !!(body && body.reauth === true);
  const ip = clientAddress(request);

  /* ============ logout（幂等，不需身份 / 会话） ============ */
  if (action === 'logout') {
    const headers = new Headers();
    try {
      const cur = await verifyAccountSession(request, env);
      if (cur.ok && cur.deviceId) await revokeDevice(env, cur.deviceId);
    } catch (e) {}
    clearAccountSession(headers);
    clearTicket(headers, ACCOUNT_REAUTH_TICKET);
    clearTicket(headers, ACCOUNT_RESET_TICKET);
    return json(200, { ok: true }, headers);
  }

  /* ============ reauth-clear（幂等，不需身份 / 会话） ============ */
  if (action === 'reauth-clear') {
    const headers = new Headers();
    clearTicket(headers, ACCOUNT_REAUTH_TICKET);
    clearTicket(headers, ACCOUNT_RESET_TICKET);
    return json(200, { ok: true }, headers);
  }

  /* 其余 action：身份头必须是 admin（前置条件，不是账号认证） */
  if (!isAdmin(request)) return apiError(401, 'session');
  if (!storeReady(env)) return apiError(500, 'config');

  /* ============ 账号根密钥 / 审计 ============ */
  if (Object.prototype.hasOwnProperty.call(ROOT_ACTIONS, action)) {
    return handleRootAction({ request, env, ip, action, body });
  }
  if (action === 'audit-list') return handleAuditList(env);

  /* ============ login-password ============ */
  if (action === 'login-password') {
    if (!accountKeysReady(env)) return accountConfigMissing();
    const password = (body && body.password) || '';
    if (!password || typeof password !== 'string') return apiError(400, 'params');
    const pepper = getPepper(env);
    if (!pepper) return apiError(503, 'config');
    const limiter = passwordLimiter(env, ACCOUNT_DB_REALM, ip);
    try {
      if (await limiter.inCooldown()) return apiError(429, 'cooldown');
    } catch (e) {
      return apiError(503, 'server');
    }
    let vr;
    try {
      vr = await verifyRealmPassword(env, ACCOUNT_DB_REALM, pepper, password);
    } catch (e) {
      return apiError(503, 'server');
    }
    if (!vr.set) return apiError(403, 'not-set');
    if (!vr.ok) {
      let justCooled = false;
      try {
        justCooled = await limiter.recordFail();
      } catch (e) {
        return apiError(503, 'server');
      }
      if (justCooled) {
        await writeSecurityEvent(env, ip, 'login-password-cooldown', false);
        return apiError(429, 'cooldown');
      }
      return apiError(403, 'wrong');
    }
    await limiter.clearFail();
    if (vr.needsRehash) {
      try { await savePassword(env, ACCOUNT_DB_REALM, await makePasswordRecord(password, pepper)); } catch (e) {}
    }
    const headers = new Headers();
    const err = await issueAccountSession(env, headers, BY_PASSWORD, await accountSessionOpts(request, env, body));
    if (err) return json(err.status, err.body);
    if (wantReauth) {
      const dErr = await issueTicket(env, headers, ACCOUNT_REAUTH_TICKET, BY_PASSWORD);
      if (dErr) return json(dErr.status, dErr.body);
    }
    return json(200, { ok: true }, headers);
  }

  const needsRp = action === 'login-challenge' || action === 'login-passkey' || action === 'passkey-register-challenge' || action === 'passkey-register';

  /* ============ login-challenge ============ */
  if (action === 'login-challenge') {
    if (!accountKeysReady(env)) return accountConfigMissing();
    const rp = rpConfig(env);
    if (!rp) return rpConfigMissing();
    const keys = await getPasskeys(env);
    if (keys.length === 0) return apiError(403, 'not-set');
    const challenge = randB64(32);
    let cid;
    try {
      cid = await issueChallenge(env, ACCOUNT_DB_REALM, CH.login, challenge, CHALLENGE_TTL);
    } catch (e) {
      return apiError(500, 'server');
    }
    return json(200, {
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
    const chRec = await consumeChallenge(env, ACCOUNT_DB_REALM, CH.login, cid);
    if (!chRec) return apiError(403, 'challenge');
    const keys = await getPasskeys(env);
    if (keys.length === 0) return apiError(403, 'not-set');
    const stored = findStoredKey(keys, cred.rawId || '');
    if (!stored || !stored.publicKey) return apiError(403, 'unknown-key');
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
      /* userHandle：账号 handle，或 legacy_handle（拆分前锁屏 handle：早期注册的账号通行密钥用的是它，凭据里写死了） */
      const gotUh = cred.response && cred.response.userHandle;
      if (gotUh) {
        const expectUh = await getUserHandle(env);
        if (expectUh && gotUh !== expectUh) {
          const legacyUh = await peekLegacyHandle(env);
          if (!legacyUh || gotUh !== legacyUh) throw new Error('userHandle');
        }
      }
      stored.signCount = checked.signCount;
      stored.lastUsedAt = Date.now();
      try { await updatePasskey(env, stored); } catch (e) {}
    } catch (e) {
      console.error('[account-login]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : 'verify';
      return json(403, { ok: false, error: code });
    }
    const headers = new Headers();
    const err = await issueAccountSession(env, headers, BY_PASSKEY, await accountSessionOpts(request, env, body));
    if (err) return json(err.status, err.body);
    if (wantReauth) {
      const dErr = await issueTicket(env, headers, ACCOUNT_REAUTH_TICKET, BY_PASSKEY);
      if (dErr) return json(dErr.status, dErr.body);
    }
    return json(200, { ok: true }, headers);
  }

  /* ============ 账号页管理 ============ */
  const MGMT = ['passkey-list', 'passkey-register-challenge', 'passkey-register', 'passkey-delete', 'passkey-rename', 'password-change', 'device-list', 'device-revoke', 'device-revoke-all'];
  if (MGMT.indexOf(action) === -1) return apiError(400, 'action');
  const isDeviceAction = action === 'device-list' || action === 'device-revoke' || action === 'device-revoke-all';

  let ticketName = '';
  /** @type {{ok:boolean, by?:string, exp?:number, reason?:string}|null} */
  let tv = null;
  const acc = await verifyAccountSession(request, env);
  if (!acc.ok) {
    const xv = isDeviceAction ? null : await verifyTicket(request, env, ACCOUNT_RESET_TICKET);
    if (!xv || !xv.ok) return apiError(401, 'account', { reason: acc.reason });
    ticketName = ACCOUNT_RESET_TICKET;
    tv = xv;
  }
  if (action === 'device-list') {
    let all;
    try { all = await listDevices(env); } catch (e) { return apiError(503, 'server'); }
    const cur = acc.deviceId || '';
    if (cur && !all.some(function (d) { return d.deviceId === cur; })) {
      let me = null;
      try { me = await getDevice(env, cur); } catch (e) { return apiError(503, 'server'); }
      if (me && me.deviceId) all = [me].concat(all);
    }
    const views = all.map(function (d) { return deviceView(d, cur); });
    views.sort(function (a, b) { return (b.current ? 1 : 0) - (a.current ? 1 : 0); });
    return json(200, { ok: true, devices: views });
  }
  if (action === 'device-revoke') {
    const deviceId = (body && body.deviceId) || '';
    if (!isDeviceId(deviceId)) return apiError(400, 'params');
    if (deviceId === acc.deviceId) return apiError(400, 'current');
    let rec = null;
    try { rec = await getDevice(env, deviceId); } catch (e) { return apiError(503, 'server'); }
    if (!rec) return apiError(404, 'not-found');
    try { await revokeDevice(env, deviceId); } catch (e) { return apiError(503, 'server'); }
    await writeSecurityEvent(env, ip, 'device-revoke');
    return json(200, { ok: true });
  }
  /* 有账号会话：安全操作要 AccountReauthTicket；会话还在时也认 AccountResetTicket（device-revoke-all 只认 reauth 票） */
  if (acc.ok && action !== 'passkey-list') {
    const rv = await verifyTicket(request, env, ACCOUNT_REAUTH_TICKET);
    if (rv.ok) {
      ticketName = ACCOUNT_REAUTH_TICKET;
      tv = rv;
    } else {
      const xv = action === 'device-revoke-all' ? { ok: false } : await verifyTicket(request, env, ACCOUNT_RESET_TICKET);
      if (!xv.ok) return apiError(403, 'reauth', { reason: rv.reason });
      ticketName = ACCOUNT_RESET_TICKET;
      tv = xv;
    }
  }
  const by = tv ? tv.by : acc.by;

  /* 账号凭证变更 / 全部退出：Account 纪元 +1；有账号会话时当前设备保留原 by/authAt 重签；其他设备行删除；短票按原到期重签 */
  async function rotateAccount(headers) {
    const ne = await bumpAccountEpoch(env);
    if (acc.ok) {
      await issueAccountSession(env, headers, acc.by, { authAt: acc.authAt, epoch: ne, deviceId: acc.deviceId, record: false });
    }
    await pruneOtherDevices(env, acc.deviceId || '');
    if (ticketName) await reissueTicketWithEpoch(env, headers, ticketName, tv, ne);
  }

  if (action === 'device-revoke-all') {
    const headers = new Headers();
    try { await rotateAccount(headers); } catch (e) { return apiError(503, 'epoch'); }
    await writeSecurityEvent(env, ip, 'device-revoke-all');
    return json(200, { ok: true }, headers);
  }

  if (action === 'passkey-list') {
    const keys = await getPasskeys(env);
    const userHandle = await peekUserHandle(env);
    return json(200, {
      ok: true,
      by: by,
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
    if (!password || typeof password !== 'string') return apiError(400, 'params');
    if (password.length < 8) return apiError(400, 'short');
    const pepper = getPepper(env);
    if (!pepper) return apiError(503, 'config');
    let existed = false;
    try {
      existed = await hasPassword(env, ACCOUNT_DB_REALM);
      await savePassword(env, ACCOUNT_DB_REALM, await makePasswordRecord(password, pepper));
    } catch (e) {
      return apiError(503, 'server');
    }
    const headers = new Headers();
    if (existed) {
      try { await rotateAccount(headers); } catch (e) { return apiError(503, 'server'); }
    }
    await writeSecurityEvent(env, ip, 'password-change');
    return json(200, { ok: true, changed: existed }, headers);
  }

  if (action === 'passkey-delete') {
    const credId = (body && body.credId) || '';
    if (!credId || typeof credId !== 'string') return apiError(400, 'params');
    const keys = await getPasskeys(env);
    const found = findStoredKey(keys, credId);
    if (!found) return apiError(404, 'not-found');
    const headers = new Headers();
    /* 先推纪元再删（fail closed：纪元推进失败则钥匙仍在） */
    try { await rotateAccount(headers); } catch (e) { return apiError(503, 'epoch'); }
    try { await deletePasskey(env, credId); } catch (e) { return apiError(503, 'server'); }
    await writeSecurityEvent(env, ip, 'passkey-delete');
    return json(200, { ok: true }, headers);
  }

  if (action === 'passkey-rename') {
    const credId = (body && body.credId) || '';
    if (!credId || typeof credId !== 'string') return apiError(400, 'params');
    const name = String((body && body.name) || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
    if (!name) return apiError(400, 'params');
    const keys = await getPasskeys(env);
    const found = findStoredKey(keys, credId);
    if (!found) return apiError(404, 'not-found');
    found.name = name;
    try {
      if (!(await updatePasskey(env, found))) return apiError(404, 'not-found');
    } catch (e) { return apiError(503, 'server'); }
    await writeSecurityEvent(env, ip, 'passkey-rename');
    return json(200, { ok: true, name: name });
  }

  if (needsRp) {
    const rp = rpConfig(env);
    if (!rp) return rpConfigMissing();

    if (action === 'passkey-register-challenge') {
      const keys = await getPasskeys(env);
      const userHandle = await getUserHandle(env);
      if (!userHandle) return apiError(503, 'server');
      const challenge = randB64(32);
      let cid;
      try {
        cid = await issueChallenge(env, ACCOUNT_DB_REALM, CH.register, challenge, CHALLENGE_TTL);
      } catch (e) {
        return apiError(500, 'server');
      }
      return json(200, {
        ok: true,
        cid: cid,
        challenge: challenge,
        rpId: rp.rpId,
        rp: { id: rp.rpId, name: 'Styrigx' },
        user: { id: userHandle, name: KEY_ACCOUNT, displayName: PASSKEY_DISPLAY_NAME },
        excludeCredentials: keys.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
      });
    }

    /* action === 'passkey-register' */
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    const chRec = await consumeChallenge(env, ACCOUNT_DB_REALM, CH.register, cid);
    if (!chRec) return apiError(403, 'challenge');
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
      };
      const dup = await getPasskey(env, credIdB64);
      if (dup) item.createdAt = dup.createdAt || item.createdAt;
      await savePasskey(env, item);
    } catch (e) {
      console.error('[account-register]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : 'verify';
      return json(403, { ok: false, error: code });
    }
    await writeSecurityEvent(env, ip, 'passkey-register');
    return json(200, { ok: true, credId: item.credId });
  }

  return apiError(400, 'action');
}
