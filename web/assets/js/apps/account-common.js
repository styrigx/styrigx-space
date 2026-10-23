/**
 * @fileoverview 账号页共用：账号总览（/account/，含登录区）和各子页
 * （设备 /account/devices/、临时钥匙、安全与隐私 /account/security/、云同步 /account/sync/、服务状态 /account/status/）。
 * 2026-10-24 PR4：「账号信息」子页（/account/profile/）删除，登录方式和「退出账号」挪进设备页「此设备」卡。
 *
 * - i18n：各页模板都输出同一份 #sgx-i18n-account（partials/account-i18n.html）
 * - requireAccountSession：子页进页查一次账号会话，明确没有 → 回账号页登录，登录后回子页
 * - syncSubText：云同步一行 / 云同步页总开关的副标题（已开启 / 已关闭 / 上次同步 hh:mm）
 * - /api/account 调用与错误码 → 文案在 lib/account-api.js（锁屏凭证页也用）
 * - signalAccountName：PublicKeyCredential.signalCurrentUserDetails 让密码管理器
 *   （Samsung Pass / Google 密码管理器）把已有账号通行密钥条目的名字更新为 AccountKey。
 *   只对「当前账号 handle」（owner-user-id:owner）发；旧 handle（owner-user-id）与锁屏
 *   LockKey 共用，绝不能对它发，否则会把 LockKey 条目改名。
 */
import { KEY_ACCOUNT } from '../lib/key-names.js';
import { ACCOUNT_API } from '../lib/account-api.js';
import { syncEnabled, LAST_KEY } from '../lib/cloud-sync.js';
import { get as sget } from '../lib/storage.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';

/** @param {boolean} en */
export function accountUrl(en) {
  return en ? '/en/account/' : '/account/';
}
/** @param {boolean} en */
export function securityUrl(en) {
  return en ? '/en/account/security/' : '/account/security/';
}
/** 账号总览登录后可回跳的本站路径（只接受账号的子页：安全与隐私、设备、云同步、服务状态） */
export const ACCOUNT_RETURN_RE = /^\/(en\/)?account\/(security|devices|sync|status)\/$/;

/** 回账号页登录，登录后回当前子页 @param {boolean} en */
export function goAccountLogin(en) {
  sgxReplace(accountUrl(en) + '?return=' + encodeURIComponent(location.pathname));
}

/**
 * 账号子页进页查一次账号会话（GET /api/account）：服务端明确说没有账号会话（ok 且 session=null）→ 回账号页登录。
 * 读不到（网络 / 访客 401 / 非 JSON）不跳，返回 null；有会话返回那份状态。
 * @param {boolean} en
 * @returns {Promise<any|null>}
 */
export function requireAccountSession(en) {
  return fetch(ACCOUNT_API, { method: 'GET', credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.ok && !j.session) {
        goAccountLogin(en);
        return null;
      }
      return j && j.ok ? j : null;
    }, function () { return null; });
}

/**
 * 云同步副标题：关 → 「已关闭…」；开、没同步过 → 「已开启…」；开、同步过 → 「上次同步 [M月D日 ]hh:mm」。
 * @param {function(string): string} t
 * @param {boolean} en
 * @param {number} [now]
 */
export function syncSubText(t, en, now) {
  if (!syncEnabled()) return t('syncOff');
  const last = parseInt(sget(LAST_KEY) || '0', 10) || 0;
  if (!last) return t('syncOn');
  const d = new Date(last);
  const pad = function (/** @type {number} */ n) { return (n < 10 ? '0' : '') + n; };
  const today = new Date(now || Date.now()).toDateString() === d.toDateString();
  const when = (today ? '' : (d.getMonth() + 1) + (en ? '/' : '月') + d.getDate() + (en ? ' ' : '日 ')) + pad(d.getHours()) + ':' + pad(d.getMinutes());
  return t('syncLast') + when;
}

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
