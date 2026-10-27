/**
 * 账号体系：账号登录 + 账号页。
 *
 * 账号凭证（AccountKey）= 账号密码（SGX_PW_PEPPER）+ 账号通行密钥（存储见 _kernel/passkey-store.js）。同 RP styrigx.com。
 * 存储全部在 D1（强一致；绑定 D1_LOCK_AUTH / D1_ACCOUNT_AUTH）：账号密码、账号通行密钥、两个纪元（_kernel/d1-state.js）、
 * 设备（account-devices.js）、challenge（passkey-verify.js，DELETE ... RETURNING 单次使用）、输错计数（password-limit.js）。
 *
 * 账号登录入口平级，任一成功即签发账号会话（_kernel/account-session.js）：
 * - 账号通行密钥：本接口 login-challenge + login-passkey
 * - 账号密码：本接口 login-password
 * 根凭证不签账号会话：丢了账号凭证走「重置登录」/api/root-auth { key, purpose:'account-reset' }，
 * 拿 AccountResetTicket（sgx-account-reset，3 分钟）重设账号凭证，再正常登录。
 * 账号会话独立验证：锁屏会话只是前置条件（必须是已解锁的管理员），从不被当作账号认证。
 *
 * GET /api/account → { ok, password, passkey, ready, session, reauth, reset }
 *   - 需管理员锁屏会话（访客 / 无会话 401）；只返回「是否已设置」，无敏感数据
 *   - ready：账号签名钥匙是否已配置（false → 登录会 503 config）
 *   - session：当前账号会话 { by, authAt, expiresAt, device } 或 null（device = 此设备的名字）
 *   - reauth：AccountReauthTicket（账号安全子页，要配账号会话）{ by, expiresAt } 或 null；前端 3 分钟倒计时以 expiresAt 为准
 *   - reset：AccountResetTicket（重置登录，不要账号会话）{ by, expiresAt } 或 null
 *
 * POST /api/account { action, ... }（只接受同源；需 admin 锁屏会话，logout / reauth-clear 除外）
 * 登录：
 * - login-challenge → 账号通行密钥登录 challenge（purpose=login）
 * - login-passkey { cid, credential, reauth? } → 验断言（UV=1、userHandle）→ 账号会话(by=passkey)
 * - login-password { password, reauth? } → 验账号密码 → 账号会话(by=password)；
 *   规则同锁屏密码：同 IP 每连错 5 次冷却一轮，30 秒起逐轮翻倍、封顶 1 小时（429 cooldown）；全局只减速（_kernel/password-limit.js）
 *   reauth:true（进账号安全子页前再验一次）→ 另签 AccountReauthTicket，3 分钟
 * - logout → 清账号会话和 reauth / reset 票（幂等，不需会话）
 * - reauth-clear → 只清 reauth / reset 票（离开账号安全子页时调；幂等，不需会话）
 * 账号页管理：有效账号会话 + AccountReauthTicket（只读的 passkey-list 只要账号会话），
 * 或有效的 AccountResetTicket（重置登录：没有账号会话也行，只能管账号凭证，不能管设备）；
 * 都没有：无账号会话 401 account，有会话没票 403 reauth（前端重新验证）：
 * - passkey-list → 账号通行密钥列表 + userHandle（账号 handle，非机密；前端拿来调
 *   PublicKeyCredential.signalCurrentUserDetails 更新密码管理器里的名字）
 * - passkey-register-challenge → 注册 challenge（账号 user handle）
 * - passkey-register { cid, credential, name? } → 保存账号通行密钥
 * - passkey-delete { credId } → 删除账号通行密钥（account-epoch +1，当前设备账号会话重签）
 * - passkey-rename { credId, name } → 重命名账号通行密钥（名字规则同锁屏 rename：去控制字符、去首尾空格、
 *   1–40 字；只改账号通行密钥，别的域 not-found；不推纪元）
 * - password-change { password } → 设置/修改账号密码（已有时 account-epoch +1 并重签当前会话）。
 *   AccountResetTicket 同样可用 → 恢复路径。
 * 设备（只要账号会话，不进门；记录见 _kernel/account-devices.js）：
 * - device-list → { devices: [{ deviceId, current, name, model, platform, browser, country, city, by, createdAt, lastSeen }] }，此设备排第一
 * - device-revoke { deviceId } → 单独退出那台设备（删记录 + 拉黑）；不能退出此设备（400 current，用退出账号）
 *
 * 首次配置账号凭证（写之前 D1 里还没有账号凭证）：Lock 纪元（lock-epoch）+1，并重签当前设备锁屏会话。
 * 删光账号凭证：账号层自然回到「未配置」（由真实凭证推出，_kernel/layers.js；根凭证代管）。
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
  issueChallenge,
  findStoredKey,
} from '../_kernel/passkey-verify.js';
import { getPepper, makePasswordRecord, checkPasswordRecord, verifyRealmPassword, getPassword, hasPassword, savePassword } from '../_kernel/password.js';
import { bumpLockEpoch, reissueLockSessionWithEpoch, ROLE_ADMIN } from '../_kernel/lock-session.js';
import { BY_PASSKEY, BY_PASSWORD, ACCOUNT_REAUTH_TICKET, ACCOUNT_RESET_TICKET } from '../_kernel/realms.js';
import {
  verifyAccountSession,
  issueAccountSession,
  clearAccountSession,
  bumpAccountEpoch,
  accountKeysReady,
  accountConfigMissing,
  accountSessionOpts,
} from '../_kernel/account-session.js';
import { listDevices, revokeDevice, pruneOtherDevices, deviceView, getDevice, isDeviceId } from '../_kernel/account-devices.js';
import { verifyTicket, issueTicket, reissueTicketWithEpoch, clearTicket } from '../_kernel/tickets.js';
import { isAccountEffectivelyConfigured } from '../_kernel/layers.js';
import { REALM_ACCOUNT, REALM_LOCK, rpConfig, rpConfigMissing } from '../_kernel/realms.js';
import { KEY_ACCOUNT } from '../_kernel/realms.js';
import { passwordLimiter } from '../_kernel/password-limit.js';
import { isSameOrigin, originDenied, json, apiError, clientIp } from '../_kernel/http.js';
import { verifyLockSession } from '../_kernel/lock-session.js';
import {
  getPasskeys,
  getPasskey,
  savePasskey,
  updatePasskey,
  deletePasskey,
  getUserHandle,
  peekUserHandle,
  providerOf,
  PASSKEY_ACCOUNT,
  PASSKEY_LOCK,
  PASSKEY_DISPLAY_NAME,
} from '../_kernel/passkey-store.js';

const CH = REALM_ACCOUNT.challenge; /* challenge 表的 purpose：login / register */
const CHALLENGE_TTL = CH.ttl; /* 5 分钟 */

/** 两个 D1 绑定都在（缺了 → 500 config） @param {any} env */
function storesReady(env) {
  return !!(env && env[REALM_LOCK.d1Binding] && env[REALM_ACCOUNT.d1Binding]);
}

/** @param {any} env */
async function accountKeys(env) {
  return await getPasskeys(env, PASSKEY_ACCOUNT);
}

/** @param {any} env */
async function hasAccountPassword(env) {
  return await hasPassword(env, REALM_ACCOUNT);
}

/** @param {object} body @param {number} [status] */
/** admin 锁屏会话（前置条件，不是账号认证）。返回会话对象或 null */
async function adminLockSession(request, env) {
  const sess = await verifyLockSession(request, env);
  if (!sess.ok || sess.role !== ROLE_ADMIN) return null;
  return sess;
}

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    if (!(await adminLockSession(request, env))) return apiError(401, 'session');
    if (!storesReady(env)) return apiError(500, 'config');
    let password = false;
    let passkey = false;
    try {
      password = await hasAccountPassword(env);
      passkey = (await accountKeys(env)).length > 0;
    } catch (e) {
      return apiError(503, 'server');
    }
    const acc = await verifyAccountSession(request, env);
    const rv = acc.ok ? await verifyTicket(request, env, ACCOUNT_REAUTH_TICKET) : { ok: false };
    const xv = await verifyTicket(request, env, ACCOUNT_RESET_TICKET);
    /* 账号总览「设备」一行的副标题：此设备的名字 */
    let devName = '';
    if (acc.ok && acc.deviceId) {
      try {
        const d = await getDevice(env, acc.deviceId);
        if (d) devName = deviceView(d, acc.deviceId).name;
      } catch (e) {}
    }
    const headers = new Headers();
    return json(200, {
      ok: true,
      password: password,
      passkey: passkey,
      ready: accountKeysReady(env),
      session: acc.ok ? { by: acc.by, authAt: acc.authAt, expiresAt: acc.exp, device: devName } : null,
      reauth: rv.ok ? { by: rv.by, expiresAt: rv.exp } : null,
      reset: xv.ok ? { by: xv.by, expiresAt: xv.exp } : null,
    }, headers);
  } catch (e) {
    return apiError(500, 'server');
  }
}

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
  /* 登录时顺带签 AccountReauthTicket（进账号安全子页前再验一次）：只认布尔 true */
  const wantReauth = !!(body && body.reauth === true);

  /* ============ logout（幂等，不需会话） ============ */
  if (action === 'logout') {
    const headers = new Headers();
    /* 本机的设备记录也删掉（并拉黑 deviceId，防 cookie 被拷走后继续用）；验不过就只清 cookie */
    try {
      const cur = await verifyAccountSession(request, env);
      if (cur.ok && cur.deviceId) await revokeDevice(env, cur.deviceId);
    } catch (e) {}
    clearAccountSession(headers);
    clearTicket(headers, ACCOUNT_REAUTH_TICKET);
    clearTicket(headers, ACCOUNT_RESET_TICKET);
    return json(200, { ok: true }, headers);
  }

  /* ============ reauth-clear（离开账号安全子页：reauth / reset 票立即作废；幂等，不需会话） ============ */
  if (action === 'reauth-clear') {
    const headers = new Headers();
    clearTicket(headers, ACCOUNT_REAUTH_TICKET);
    clearTicket(headers, ACCOUNT_RESET_TICKET);
    return json(200, { ok: true }, headers);
  }

  /* 其余 action：先要 admin 锁屏会话（前置条件；visitor 已被 middleware 403） */
  const sess = await adminLockSession(request, env);
  if (!sess) return apiError(401, 'session');
  if (!storesReady(env)) return apiError(500, 'config');

  /* ============ login-password ============ */
  if (action === 'login-password') {
    if (!accountKeysReady(env)) return accountConfigMissing();
    const password = (body && body.password) || '';
    if (!password || typeof password !== 'string') return apiError(400, 'params');
    const pepper = getPepper(env);
    if (!pepper) return apiError(503, 'config');
    /* 账号密码输错限速：规则同锁屏密码（_kernel/password-limit.js），按 IP 各域各自计数 */
    const limiter = passwordLimiter(env, REALM_ACCOUNT, clientIp(request));
    try {
      if (await limiter.inCooldown()) return apiError(429, 'cooldown');
    } catch (e) {
      return apiError(503, 'server');
    }
    let vr;
    try {
      vr = await verifyRealmPassword(env, REALM_ACCOUNT, pepper, password);
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
      return justCooled ? apiError(429, 'cooldown') : apiError(403, 'wrong');
    }
    await limiter.clearFail();
    if (vr.needsRehash) {
      try { await savePassword(env, REALM_ACCOUNT, await makePasswordRecord(password, pepper)); } catch (e) {}
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

  /* 通行密钥相关 action 需要 RP 配置 */
  const needsRp = action === 'login-challenge' || action === 'login-passkey' || action === 'passkey-register-challenge' || action === 'passkey-register';

  /* ============ login-challenge（账号通行密钥登录） ============ */
  if (action === 'login-challenge') {
    if (!accountKeysReady(env)) return accountConfigMissing();
    const rp = rpConfig(env);
    if (!rp) return rpConfigMissing();
    const keys = await accountKeys(env);
    if (keys.length === 0) return apiError(403, 'not-set');
    const challenge = randB64(32);
    let cid;
    try {
      cid = await issueChallenge(env, REALM_ACCOUNT, CH.login, challenge, CHALLENGE_TTL);
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
    /* 单次使用：一条 DELETE ... RETURNING（purpose 与过期都在 WHERE 里）；验过断言才签会话 */
    const chRec = await consumeChallenge(env, REALM_ACCOUNT, CH.login, cid);
    if (!chRec) {
      return apiError(403, 'challenge');
    }
    const keys = await accountKeys(env);
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
      /* userHandle：接受账号 handle，或锁屏 handle（早期注册的账号通行密钥用的是它，
         凭据里写死了，换不掉） */
      const gotUh = cred.response && cred.response.userHandle;
      if (gotUh) {
        const expectUh = await getUserHandle(env, PASSKEY_ACCOUNT);
        if (expectUh && gotUh !== expectUh) {
          const legacyUh = await peekUserHandle(env, PASSKEY_LOCK);
          if (!legacyUh || gotUh !== legacyUh) throw new Error('userHandle');
        }
      }
      stored.signCount = checked.signCount;
      stored.lastUsedAt = Date.now();
      try { await updatePasskey(env, PASSKEY_ACCOUNT, stored); } catch (e) {}
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

  /* ============ 账号页管理 ============
     - 有效账号会话 + AccountReauthTicket（只读的 passkey-list 只要账号会话；设备页只要账号会话）
     - 或有效 AccountResetTicket（重置登录：没有账号会话，只能管账号凭证，不能管设备） */
  const MGMT = ['passkey-list', 'passkey-register-challenge', 'passkey-register', 'passkey-delete', 'passkey-rename', 'password-change', 'device-list', 'device-revoke'];
  if (MGMT.indexOf(action) === -1) return apiError(400, 'action');
  const isDeviceAction = action === 'device-list' || action === 'device-revoke';

  /** 这次管理操作凭哪张票：AccountReauthTicket（配账号会话）或 AccountResetTicket */
  let ticketName = '';
  /** @type {{ok:boolean, by?:string, exp?:number}|null} */
  let tv = null;
  const acc = await verifyAccountSession(request, env);
  if (!acc.ok) {
    const xv = isDeviceAction ? null : await verifyTicket(request, env, ACCOUNT_RESET_TICKET);
    if (!xv || !xv.ok) return apiError(401, 'account', { reason: acc.reason });
    ticketName = ACCOUNT_RESET_TICKET;
    tv = xv;
  }
  /* 设备页（列出 / 单独退出别的设备）只要账号会话 */
  if (action === 'device-list') {
    let all;
    try { all = await listDevices(env); } catch (e) { return apiError(503, 'server'); }
    const cur = acc.deviceId || '';
    /* 列表有上限（DEVICE_LIST_MAX，按最近活跃）：当前设备没排进去就单独取来补上，保证它一定在、排第一 */
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
    return json(200, { ok: true });
  }
  /* 有账号会话：改动（注册/删除/重命名/改密码）是安全操作，必须有有效的 AccountReauthTicket
     （进账号安全子页时再验过账号凭证，3 分钟，离开即作废）；会话还在时也认 AccountResetTicket */
  if (acc.ok && action !== 'passkey-list') {
    const rv = await verifyTicket(request, env, ACCOUNT_REAUTH_TICKET);
    if (rv.ok) {
      ticketName = ACCOUNT_REAUTH_TICKET;
      tv = rv;
    } else {
      const xv = await verifyTicket(request, env, ACCOUNT_RESET_TICKET);
      if (!xv.ok) return apiError(403, 'reauth', { reason: rv.reason });
      ticketName = ACCOUNT_RESET_TICKET;
      tv = xv;
    }
  }
  /* 前端标题用：用什么验的（重置登录 = root） */
  const by = tv ? tv.by : acc.by;

  /* 首次配置账号层：Lock 纪元 +1 + 重签当前锁屏会话（失败 503）。
     wasConfigured 是写凭证「之前」的 isAccountEffectivelyConfigured（D1 里已有账号凭证；读失败按已配置）。 */
  async function markConfigured(headers, wasConfigured) {
    if (wasConfigured) return null;
    try {
      const ne = await bumpLockEpoch(env);
      await reissueLockSessionWithEpoch(env, headers, sess, ne);
    } catch (e) {
      return apiError(503, 'epoch');
    }
    return null;
  }
  /* 账号凭证变更（改密码/删通行密钥）：Account 纪元 +1；有账号会话时当前设备保留原 by/authAt 重签 */
  async function rotateAccount(headers) {
    const ne = await bumpAccountEpoch(env); /* 出错抛 → 外层 500/调用方 503 */
    if (acc.ok) {
      await issueAccountSession(env, headers, acc.by, { authAt: acc.authAt, epoch: ne, deviceId: acc.deviceId, record: false });
    }
    /* 其他设备的票据随纪元失效：设备页上也不再列它们（重置登录时一台不留） */
    await pruneOtherDevices(env, acc.deviceId || '');
    /* reauth / reset 票也绑 Account 纪元：按原到期时间重签，可以接着操作 */
    if (ticketName) await reissueTicketWithEpoch(env, headers, ticketName, tv, ne);
  }

  if (action === 'passkey-list') {
    const keys = await accountKeys(env);
    /* 账号 handle（注册用的那个）；读不到就不给，前端不 signal。不新建（list 只读）。 */
    let userHandle = '';
    userHandle = await peekUserHandle(env, PASSKEY_ACCOUNT);
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
    const accountWasConfigured = await isAccountEffectivelyConfigured(env);
    try {
      existed = await hasAccountPassword(env);
      /* 账号密码不得与锁屏密码相同（双向检查；锁屏侧见 lock-password.js 的 same-as-account） */
      const lockRec = await getPassword(env, REALM_LOCK);
      if (lockRec && lockRec.hash) {
        const cr = await checkPasswordRecord(lockRec, password, pepper);
        if (cr.ok) return apiError(403, 'same-as-lock');
      }
      await savePassword(env, REALM_ACCOUNT, await makePasswordRecord(password, pepper));
    } catch (e) {
      return apiError(503, 'server');
    }
    const headers = new Headers();
    const mErr = await markConfigured(headers, accountWasConfigured);
    if (mErr) return mErr;
    if (existed) {
      try { await rotateAccount(headers); } catch (e) { return apiError(503, 'server'); }
    }
    return json(200, { ok: true, changed: existed }, headers);
  }

  if (action === 'passkey-delete') {
    const credId = (body && body.credId) || '';
    if (!credId || typeof credId !== 'string') return apiError(400, 'params');
    const keys = await accountKeys(env);
    const found = findStoredKey(keys, credId);
    if (!found) return apiError(404, 'not-found');
    const headers = new Headers();
    /* 先推纪元再删（fail closed：纪元推进失败则钥匙仍在） */
    try { await rotateAccount(headers); } catch (e) { return apiError(503, 'epoch'); }
    try { await deletePasskey(env, PASSKEY_ACCOUNT, credId); } catch (e) { return apiError(503, 'server'); }
    /* 删光账号凭证 → 账号层自然回到未配置（由真实凭证推出，不另存标记） */
    return json(200, { ok: true }, headers);
  }

  if (action === 'passkey-rename') {
    const credId = (body && body.credId) || '';
    if (!credId || typeof credId !== 'string') return apiError(400, 'params');
    /* 名字规则与 lock-passkey.js rename 一致：去控制字符、去首尾空格、限 40 字，空 → params */
    const name = String((body && body.name) || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
    if (!name) return apiError(400, 'params');
    const keys = await accountKeys(env);
    const found = findStoredKey(keys, credId);
    if (!found) return apiError(404, 'not-found');
    found.name = name;
    try {
      if (!(await updatePasskey(env, PASSKEY_ACCOUNT, found))) return apiError(404, 'not-found');
    } catch (e) { return apiError(503, 'server'); }
    return json(200, { ok: true, name: name });
  }

  /* passkey-register-challenge / passkey-register：账号通行密钥注册 */
  if (needsRp) {
    const rp = rpConfig(env);
    if (!rp) return rpConfigMissing();

    if (action === 'passkey-register-challenge') {
      const keys = await accountKeys(env);
      const userHandle = await getUserHandle(env, PASSKEY_ACCOUNT);
      if (!userHandle) return apiError(503, 'server');
      const challenge = randB64(32);
      let cid;
      try {
        cid = await issueChallenge(env, REALM_ACCOUNT, CH.register, challenge, CHALLENGE_TTL);
      } catch (e) {
        return apiError(500, 'server');
      }
      return json(200, {
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
    const chRec = await consumeChallenge(env, REALM_ACCOUNT, CH.register, cid);
    if (!chRec) {
      return apiError(403, 'challenge');
    }
    let item;
    const accountWasConfigured = await isAccountEffectivelyConfigured(env);
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
      /* 同一把凭据已登记为锁屏通行密钥 → 拒绝（一把凭据只属于一个域） */
      if (await getPasskey(env, PASSKEY_LOCK, credIdB64)) throw new Error('class');
      const dup = await getPasskey(env, PASSKEY_ACCOUNT, credIdB64);
      if (dup) item.createdAt = dup.createdAt || item.createdAt;
      await savePasskey(env, PASSKEY_ACCOUNT, item);
    } catch (e) {
      console.error('[account-register]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : (e && e.message === 'class') ? 'class' : 'verify';
      return json(403, { ok: false, error: code });
    }
    const headers = new Headers();
    const mErr = await markConfigured(headers, accountWasConfigured);
    if (mErr) return mErr;
    return json(200, { ok: true, credId: item.credId }, headers);
  }

  return apiError(400, 'action');
}
