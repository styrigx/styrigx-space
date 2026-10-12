/**
 * @fileoverview 锁屏凭证管理页（2.11 两扇门：「管理凭证 → 锁屏」门内页）。
 * 管理 lockkey（解锁密码、锁屏通行密钥）与 <app>key（应用验证分组，如 Book）。
 * 进门只验一次（安全与隐私页入口，ownerkey 验证）；本页直接渲染，
 * 进门探针确认验证有效，无效则跳验证流程，不弹面板。
 * 门内全部直接调接口；返回离开即退出（返回键先清验证）。
 */
import { initDoor } from './door.js';

(function () {
  const en = document.documentElement.lang === 'en';
  let T = {};
  try {
    T = JSON.parse(document.getElementById('sgx-i18n-lockmgr').textContent || '{}');
  } catch (e) {}
  /** @param {string} k */
  function t(k) {
    const v = T[k];
    if (v && typeof v === 'object') return en ? v.en : v.zh;
    return v || k;
  }

  initDoor({
    t: t,
    en: en,
    statusApi: '/api/lock-status',
    pwKind: 'lock',
    keyClass: 'lock',
    withApps: true,
    homeUrl: en ? '/en/settings/' : '/settings/',
  });
})();
