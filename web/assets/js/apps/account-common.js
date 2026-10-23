/**
 * @fileoverview 账号页共用：账号总览（/account/，含登录区）、
 * 已登录子页（/account/profile/，退出账号）与
 * 安全与隐私子页（/account/security/，管理账号密码和账号通行密钥）。
 *
 * - i18n：各页模板都输出同一份 #sgx-i18n-account（partials/account-i18n.html）
 * - /api/account 调用与错误码 → 文案在 lib/account-api.js（锁屏凭证页也用）
 * - signalAccountName：PublicKeyCredential.signalCurrentUserDetails 让密码管理器
 *   （Samsung Pass / Google 密码管理器）把已有账号通行密钥条目的名字更新为 AccountKey。
 *   只对「当前账号 handle」（owner-user-id:owner）发；旧 handle（owner-user-id）与锁屏
 *   LockKey 共用，绝不能对它发，否则会把 LockKey 条目改名。
 */
import { KEY_ACCOUNT } from '../lib/key-names.js';

/** @param {boolean} en */
export function accountUrl(en) {
  return en ? '/en/account/' : '/account/';
}
/** @param {boolean} en */
export function securityUrl(en) {
  return en ? '/en/account/security/' : '/account/security/';
}
/** @param {boolean} en */
export function profileUrl(en) {
  return en ? '/en/account/profile/' : '/account/profile/';
}
/** 账号总览登录后可回跳的本站路径（只接受账号的子页：安全与隐私、已登录、设备） */
export const ACCOUNT_RETURN_RE = /^\/(en\/)?account\/(security|profile|devices)\/$/;

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
