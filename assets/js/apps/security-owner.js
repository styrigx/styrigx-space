/**
 * @fileoverview 站长凭证页（2.11 两扇门：「站长凭证」门内页）。
 * 管理 ownerkey（站长密码、站长通行密钥）。
 * 进门只验一次（安全与隐私页入口，rootkey 验证）；本页直接渲染，
 * 进门探针确认验证有效，无效则跳验证流程，不弹面板。
 * 门内全部直接调接口；返回离开即退出（返回键先清验证）。
 */
import { initDoor } from './door.js';
import { STORE_CLASS_OWNERKEY } from '../lib/key-names.js';

(function () {
  const en = document.documentElement.lang === 'en';
  let T = {};
  try {
    T = JSON.parse(document.getElementById('sgx-i18n-ownermgr').textContent || '{}');
  } catch (e) {}
  /** @param {string} k */
  function t(k) {
    const v = T[k];
    if (v && typeof v === 'object') return en ? v.en : v.zh;
    if (v) return v;
    /* 批次 A 收尾 #36：兜底不显示内部键名；键名只记诊断 */
    if (typeof console !== 'undefined') console.warn('[i18n] missing key:', k);
    return en ? 'Something went wrong, please retry' : '出错了，请重试';
  }

  initDoor({
    t: t,
    en: en,
    statusApi: '/api/owner-status',
    pwKind: 'owner',
    keyClass: STORE_CLASS_OWNERKEY,
    withApps: false,
    /* C1：站长凭证门返回 → 安全与隐私页（从哪里进门，就回哪里），不是设置首页 */
    homeUrl: en ? '/en/settings/security/' : '/settings/security/',
  });
})();
