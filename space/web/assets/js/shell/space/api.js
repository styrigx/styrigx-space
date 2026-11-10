/**
 * @fileoverview 钥匙层调后端的唯一地方（进站 / reset 层 / 解锁凭据 / 分享；进站 v3 L1，v5 S5 起都在终端里）。
 *
 * 命令流程只用这里导出的对象（按入口分：session / reauth / reset / keys / links，写法照 shell/account/api.js），
 * 不直接写接口地址、action 名、请求字段、密码管理器隐藏用户名。地址在 paths.js。L2 换成 /api/space/* 时只改这里和 paths.js。
 *
 * 每个调用都回 Promise<{ s: number, j: any }>（同 auth/post-json.js postJSON；网络失败 reject）。
 */
import { postJSON } from '../../auth/post-json.js';
import { getPasskeyAssertion, assertionOptions, assertionToJSON, isPasskeyCancel } from '../../auth/passkey-assert.js';
import { KEY_SPACE_PASSWORD, KEY_SPACE_RECOVERY_KEY } from '../../lib/key-names.js';
import { API } from './paths.js';

/** 密码管理器里的隐藏用户名（进站 v3 Q6，L2 换 pepper、重设密码那一次一起换）：解锁密码 SpacePassword、恢复钥匙 SpaceRecoveryKey */
export const PM_USER = Object.freeze({ password: KEY_SPACE_PASSWORD, recoveryKey: KEY_SPACE_RECOVERY_KEY });

/** 服务端错误码（面板按它分支） */
export const ERR = Object.freeze({
  /** 没有进站会话 → 回锁屏 */
  session: 'session',
  /** 要 reauth 票 */
  reauth: 'reauth',
  /** reset 票无效 / 过期 */
  reset: 'reset',
  /** 密码 / 钥匙 / 恢复钥匙不对 */
  wrong: ['wrong', 'auth', 'code'],
  cooldown: 'cooldown',
  notSet: 'not-set',
  lastKey: 'last-key',
  full: 'full',
  config: 'config',
});

/**
 * 服务端 error 码 → 文案键（space.common.*，sgx-shell-i18n）。tests/workers/space-core/error-codes.test.mjs 核对网关每个码都在这里
 * （或在 NEED_VERIFY_CODES / 测试的 KNOWN_FIXED 里）。
 */
export const ERR_KEY = Object.freeze({
  'params': 'errParams',
  'body': 'errParams',
  'method': 'errParams',
  'action': 'errParams',
  'password': 'errParams',
  'return': 'errParams',
  'content-type': 'errParams',
  'not-found': 'errNotFound',
  'last-key': 'errLastKey',
  'epoch': 'errRetry',
  'server': 'errServer',
  'origin': 'errServer',
  'sign-failed': 'errServer',
  'forbidden': 'errServer',
  'role': 'errServer',
  'challenge': 'errVerify',
  'verify': 'errVerify',
  'class': 'errVerify',
  'class-mismatch': 'errVerify',
  'unknown-key': 'errVerify',
  'uv-required': 'errUvRequired',
  'wrong': 'errWrongPw',
  'short': 'errShort',
  'exists': 'errExists',
  'not-set': 'errNotSet',
  'cooldown': 'errLocked',
  'config': 'errConfig',
  'cancelled': 'errCancelled',
  'same-as-lock': 'errSameAsLock',
  'same-as-account': 'errSameAsAccount',
  'reset': 'errReset',
  'full': 'errFull',
  'link': 'errLink',
});
/** 这几个码不进文案：终端按码回锁屏 / 重跑 sudo styrigx reauth */
export const NEED_VERIFY_CODES = ['session', 'reauth', 'scope'];

/**
 * 错误码 → 文案（t 取 space.common.*）
 * @param {(k: string) => string} t @param {string} [code] @param {number} [status]
 */
export function errText(t, code, status) {
  const k = code && /** @type {any} */ (ERR_KEY)[code];
  if (k) return t('common.' + k);
  if (status === 429) return t('common.errLocked');
  return t('common.errUnknown') + (code || status ? ' (' + (code || '') + (status ? '/' + status : '') + ')' : '');
}

/** @param {any} res @param {string|string[]} code */
export function isErr(res, code) {
  const c = res && res.j && res.j.error;
  return Array.isArray(code) ? code.indexOf(c) !== -1 : c === code;
}

/** @param {string} url */
function getJSON(url) {
  return fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
    return r.json().then(function (j) { return { s: r.status, j: j }; }, function () { return { s: r.status, j: null }; });
  });
}

/**
 * 锁屏上该列哪些方式。读失败按都设了（fail closed，同 /api/lock-entry）。
 * @returns {Promise<{password: boolean, passkey: boolean}>}
 */
export function entryConfig() {
  return getJSON(API.entry).then(function (r) {
    const j = r.j;
    if (j && j.ok) return { password: !!j.password, passkey: !!j.passkey };
    return { password: true, passkey: true };
  }, function () { return { password: true, passkey: true }; });
}

/**
 * 通行密钥断言（session / reauth 用同一个 challenge，提交时 reauth 标记不同）。
 * reject：{ cancelled: true } | { message, kind? } ；stale() 为真（^C 过）→ 拿到断言也不再提交。
 * @param {boolean} reauth @param {(k: string) => string} t space.* 取文案 @param {() => boolean} [stale]
 */
function passkeyAssert(reauth, t, stale) {
  let credId = '';
  return postJSON(API.passkey, { action: 'challenge', type: 'auth' }).then(function (res) {
    const j = res.j;
    if (!j || !j.ok || !j.challenge) throw { message: errText(t, j && j.error, res.s), code: j && j.error };
    return getPasskeyAssertion(assertionOptions(j), {}).then(function (cred) {
      return { cred: /** @type {any} */ (cred), cid: j.cid };
    }, function (e) {
      if (isPasskeyCancel(e)) throw { cancelled: true };
      throw { message: t(e && e.kind === 'timeout' ? 'common.pkTimeout' : 'common.errVerify') };
    });
  }, function (e) {
    if (e && (e.message || e.cancelled)) throw e;
    throw { message: t('common.errNetwork') };
  }).then(function (r) {
    if (stale && stale()) throw { cancelled: true };
    credId = r.cred.id;
    const body = { action: 'auth', cid: r.cid, credential: assertionToJSON(r.cred) };
    if (reauth) /** @type {any} */ (body).reauth = true;
    return postJSON(API.passkey, body).then(function (res) {
      if (res.j && res.j.ok) return;
      /* 服务端不认识这把通行密钥 → 通知密码管理器删掉（同原锁屏） */
      try {
        if (res.j && res.j.error === 'unknown-key' && window.PublicKeyCredential &&
            typeof (/** @type {any} */ (PublicKeyCredential)).signalUnknownCredential === 'function') {
          (/** @type {any} */ (PublicKeyCredential)).signalUnknownCredential({ rpId: location.hostname, credentialId: credId }).catch(function () {});
        }
      } catch (e) {}
      throw { message: errText(t, res.j && res.j.error, res.s), code: res.j && res.j.error, s: res.s };
    }, function () {
      throw { message: t('common.errNetwork') };
    });
  });
}

/** sudo styrigx：进站会话 */
export const session = Object.freeze({
  /** @param {string} pw */
  password: function (pw) { return postJSON(API.password, { action: 'verify', password: pw }); },
  /** @param {(k: string) => string} t @param {() => boolean} [stale] */
  passkey: function (t, stale) { return passkeyAssert(false, t, stale); },
  /** 立即锁屏（本机）：清 session + reauth + reset */
  end: function () { return postJSON(API.lockNow, {}); },
  /** 所有设备回锁屏（要 reauth） */
  endAll: function () { return postJSON(API.lockAll, {}); },
});

/** sudo -v：3 分钟再验证（只认解锁密码 / 通行密钥） */
export const reauth = Object.freeze({
  /** @param {string} pw */
  password: function (pw) { return postJSON(API.password, { action: 'verify', password: pw, reauth: true }); },
  /** @param {(k: string) => string} t @param {() => boolean} [stale] */
  passkey: function (t, stale) { return passkeyAssert(true, t, stale); },
  /** { valid, by, expiresAt, password, passkey }（reauth 票；没有会话 → 401 session） */
  status: function () { return postJSON(API.reauth, { action: 'status' }); },
  /** 关终端窗口 / 离开页面（keepalive，不等结果；只清 reauth） */
  end: function () {
    try {
      fetch(API.reauth, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'clear' }), credentials: 'same-origin', keepalive: true }).catch(function () {});
    } catch (e) {}
  },
});

/** 进站凭证的写操作（同一组接口：reauth 票 = lock passwd / lock passkey，reset 票 = reset 层；服务端先认 reauth 再认 reset） */
const keyOps = {
  /** @param {string} pw */
  passwordSet: function (pw) { return postJSON(API.password, { action: 'change', password: pw }); },
  passkeyList: function () { return postJSON(API.passkey, { action: 'list' }); },
  passkeyAddChallenge: function () { return postJSON(API.passkey, { action: 'challenge', type: 'register' }); },
  /** @param {any} body registerPasskey 给的注册结果 { cid, name, credential } */
  passkeyAdd: function (body) { return postJSON(API.passkey, Object.assign({ action: 'register' }, body)); },
  /** @param {string} id */
  passkeyDelete: function (id) { return postJSON(API.passkey, { action: 'delete', credId: id }); },
};

/** sudo styrigx reset：恢复钥匙 → reset 票（不签会话）→ 重设 → finish 两选 */
export const reset = Object.freeze(Object.assign({
  /** @param {string} key */
  recoveryKey: function (key) { return postJSON(API.reset, { action: 'verify', spaceKey: key }); },
  /** @param {'all'|'none'} signOut */
  finish: function (signOut) { return postJSON(API.reset, { action: 'finish', signOut: signOut }); },
  /** 只清 reset 票 */
  end: function () { return postJSON(API.reset, { action: 'end' }); },
}, keyOps));

/** 解锁凭据（reauth 票） */
export const keys = Object.freeze(Object.assign({
  passwordRemove: function () { return postJSON(API.password, { action: 'remove' }); },
  /** @param {string} id @param {string} name */
  passkeyRename: function (id, name) { return postJSON(API.passkey, { action: 'rename', credId: id, name: name }); },
}, keyOps));

/** 分享链接（share Worker）：新建只要进站会话；列表 / 作废要 reauth（Q3 定稿）；分享链接进来的会话都不行（403 link） */
export const links = Object.freeze({
  list: function () { return postJSON(API.share, { action: 'list' }); },
  /** @param {{name?: string, to?: string, session?: number, hours?: number, days?: number}} p */
  create: function (p) { return postJSON(API.share, Object.assign({ action: 'create' }, p)); },
  /** @param {string} id */
  revoke: function (id) { return postJSON(API.share, { action: 'revoke', id: id }); },
});
