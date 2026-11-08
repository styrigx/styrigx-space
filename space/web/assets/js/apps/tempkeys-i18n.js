/**
 * @fileoverview 临时钥匙 / 分享短链页（/security/tempkeys/）取文案的 createT：读 #sgx-i18n-account（partials/account-i18n.html 输出）。
 * 2026-11-08 按 NAMING-V2 改名：原 apps/account-common.js。
 * 2026-11-08 账号 UI 改版：账号整页删了（都在顶栏头像的账号终端里，shell/account/），这里只剩盾牌的临时钥匙 / 分享短链页还在用的 createT。
 */
import { i18nTable } from '../lib/i18n.js';
/** 界面文案：页面字符串表 #sgx-i18n-account（语言包化 2026-11-07；当前语言已叠在英文上） */
const tx = i18nTable('account');

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
