/**
 * @fileoverview 账号页共用：账号总览（/settings/account/，含登录区）、
 * 已登录子页（/settings/account/profile/，退出账号）与
 * 安全与隐私子页（/settings/account/security/，管理账号密码和账号通行密钥）。
 *
 * - i18n：两页模板都输出同一份 #sgx-i18n-account（partials/account-i18n.html）
 * - postJSON / errText：/api/account 调用与错误码 → 文案
 * - signalAccountName：PublicKeyCredential.signalCurrentUserDetails 让密码管理器
 *   （Samsung Pass / Google 密码管理器）把已有账号通行密钥条目的名字更新为 accountkey。
 *   只对「当前账号 handle」（owner-user-id:owner）发；旧 handle（owner-user-id）与锁屏
 *   lockkey 共用，绝不能对它发，否则会把 lockkey 条目改名。
 */
import { KEY_ACCOUNT } from '../lib/key-names.js';

export const ACCOUNT_API = '/api/account';

/** @param {boolean} en */
export function accountUrl(en) {
  return en ? '/en/settings/account/' : '/settings/account/';
}
/** @param {boolean} en */
export function securityUrl(en) {
  return en ? '/en/settings/account/security/' : '/settings/account/security/';
}
/** @param {boolean} en */
export function profileUrl(en) {
  return en ? '/en/settings/account/profile/' : '/settings/account/profile/';
}
/** 账号总览登录后可回跳的本站路径（只接受账号的两个子页：安全与隐私、已登录） */
export const ACCOUNT_RETURN_RE = /^\/(en\/)?settings\/account\/(security|profile)\/$/;

/**
 * @param {boolean} en
 * @returns {function(string): string}
 */
export function createT(en) {
  /** @type {any} */
  let T = {};
  try {
    T = JSON.parse((document.getElementById('sgx-i18n-account') || {}).textContent || '{}');
  } catch (e) {}
  return function t(k) {
    const v = T[k];
    if (v && typeof v === 'object') return en ? v.en : v.zh;
    if (v) return v;
    if (typeof console !== 'undefined') console.warn('[i18n] missing key:', k);
    return en ? 'Something went wrong, please retry' : '出错了，请重试';
  };
}

/**
 * @param {string} url
 * @param {object} body
 * @returns {Promise<{s:number, j:any}>}
 */
export function postJSON(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  }).then(function (r) {
    return r.json().then(function (j) { return { s: r.status, j: j }; }, function () { return { s: r.status, j: null }; });
  });
}

const ERR_KEYS = {
  wrong: 'errWrongPw',
  'not-set': 'errNotSet',
  auth: 'errWrongRoot',
  denied: 'errWrongPw',
  role: 'errWrongPw',
  challenge: 'errVerify',
  verify: 'errVerify',
  'unknown-key': 'errVerify',
  'class-mismatch': 'errVerify',
  'uv-required': 'errUvRequired',
  locked: 'errLocked',
  config: 'errConfig',
  server: 'errServer',
  short: 'errShort',
  'same-as-lock': 'errSameAsLock',
  'not-found': 'errNotFound',
  session: 'sessExp',
  door: 'doorExpired',
};

/**
 * 服务端错误码 → 文案
 * @param {function(string): string} t
 * @param {string} [code]
 * @param {number} [status]
 */
export function errText(t, code, status) {
  if (code && ERR_KEYS[code]) return t(ERR_KEYS[code]);
  if (status === 429) return t('errLocked');
  return t('errUnknown');
}

/** 每页只发一次 */
let signalled = false;

/**
 * 让密码管理器更新已有账号通行密钥条目的名字（Chrome 132+ / Samsung Internet 等支持时）。
 * 特性检测；任何错误都吞掉。只用服务端 list 返回的当前账号 handle。
 * @param {{userHandle?: string, userName?: string, displayName?: string}} info list 响应
 * @returns {boolean} 是否发出
 */
export function signalAccountName(info) {
  try {
    const PKC = /** @type {any} */ (window.PublicKeyCredential);
    if (signalled || !PKC || typeof PKC.signalCurrentUserDetails !== 'function') return false;
    const uh = info && info.userHandle;
    if (!uh || typeof uh !== 'string') return false;
    signalled = true;
    const p = PKC.signalCurrentUserDetails({
      rpId: location.hostname,
      userId: uh,
      name: (info && info.userName) || KEY_ACCOUNT,
      displayName: (info && info.displayName) || 'Sloan Gray',
    });
    if (p && typeof p.catch === 'function') p.catch(function () {});
    return true;
  } catch (e) {
    return false;
  }
}

/** 只供测试：重置「已发过」标记 */
export function _resetSignalForTest() {
  signalled = false;
}
