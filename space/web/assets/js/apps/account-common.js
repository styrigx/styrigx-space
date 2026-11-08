/**
 * @fileoverview 账号页共用：账号总览（/account/，含登录区）和各子页
 * （设备 /account/devices/、安全与隐私 /account/security/、应用授权 /account/apps/、个人资料 /account/profile/）。
 * 设置里的临时钥匙页（/security/tempkeys/）也用这里的 createT（同一份 #sgx-i18n-account 文案），不问账号会话。
 * 2026-10-24 PR4：「账号信息」子页删除，登录方式和「退出账号」挪进设备页「此设备」卡；2026-11-07 同一地址 /account/profile/ 改作「个人资料」子页（内容是新的）。
 *
 * - i18n：各页模板都输出同一份 #sgx-i18n-account（partials/account-i18n.html）
 * - requireAccountSession：子页进页查一次账号会话，明确没有 → 回账号页登录，登录后回子页
 * - /api/account 调用与错误码 → 文案在 auth/account-api.js（锁屏凭证页也用）
 * - signalAccountName：PublicKeyCredential.signalCurrentUserDetails 让密码管理器
 *   （Samsung Pass / Google 密码管理器）把已有账号通行密钥条目的名字更新为 AccountPasskey（2026-11-08 起；原 AccountKey）。
 *   只对「当前账号 handle」（account-user-id）发；旧 handle（lock-user-id）与锁屏
 *   LockKey 共用，绝不能对它发，否则会把 LockKey 条目改名。
 */
import { KEY_ACCOUNT_PASSKEY } from '../lib/key-names.js';
import { ACCOUNT_API } from '../auth/account-api.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { langPath } from '../lib/lang-path.js';
import { i18nTable, pageLang } from '../lib/i18n.js';
/** 界面文案：页面字符串表 #sgx-i18n-account（语言包化 2026-11-07；当前语言已叠在英文上） */
const tx = i18nTable('account');

/** @param {boolean} en */
export function accountUrl(en) {
  return langPath('/account/', pageLang());
}
/** @param {boolean} en */
export function securityUrl(en) {
  return langPath('/account/security/', pageLang());
}
/** 账号总览登录后可回跳的本站路径（只接受账号的子页：安全与隐私、设备、应用授权、个人资料；云同步子页 2026-11-08 删除） */
export const ACCOUNT_RETURN_RE = /^\/(zh\/)?account\/(security|devices|apps|profile)\/$/;

/** 回账号页登录，登录后回当前子页 @param {boolean} en */
export function goAccountLogin(en) {
  sgxReplace(accountUrl(en) + '?return=' + encodeURIComponent(location.pathname));
}

/**
 * 账号子页进页查一次账号会话（GET /api/account）：服务端明确说没有账号会话（ok 且 session=null）→ 回账号页登录。
 * 读不到（网络 / 401 / 非 JSON）不跳，返回 null；有会话返回那份状态。
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
 * #sgx-i18n-account 的取文案函数：扁平字典（模板已叠好「英文表 ← 页面语言表」，缺键回退英文），不再按语言二选一。
 * @returns {function(string): string}
 */
export function createT() {
  /** @type {any} */
  let T = {};
  try {
    T = JSON.parse((document.getElementById('sgx-i18n-account') || {}).textContent || '{}');
  } catch (e) {}
  return function t(k) {
    const v = T[k];
    if (v) return v;
    if (typeof console !== 'undefined') console.warn('[i18n] missing key:', k);
    return tx('accounSomethingWentWrongPlease');
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
      name: (info && info.userName) || KEY_ACCOUNT_PASSKEY,
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
