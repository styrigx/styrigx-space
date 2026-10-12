/**
 * @fileoverview 应用列表页（2.11）：安全与隐私 → 应用。
 * - 进门：验证身份门（app-gate.js，stepup by=owner）。
 * - 进门后：按白名单渲染每应用的应用类通行密钥状态（已添加/未添加），
 *   点击行进该应用详情页（settingsPath 由模板注入，不手抄）。
 * - 反馈一律 One UI 轻提示（toast）；localStorage 经 storage.js。
 */
import { initAppGate } from './app-gate.js';

(function () {
  const en = document.documentElement.lang === 'en';
  /** @type {any} */
  let T = {};
  try {
    T = JSON.parse(document.getElementById('sgx-i18n-appmgr').textContent || '{}');
  } catch (e) {}
  /** @param {string} k */
  function t(k) {
    const v = T[k];
    if (v && typeof v === 'object') return en ? v.en : v.zh;
    return v || k;
  }
  /** 白名单（模板从 data/app_whitelist.json 注入，不手抄） */
  let WL = [];
  try {
    WL = JSON.parse(document.getElementById('sgx-app-whitelist').textContent || '[]') || [];
  } catch (e) {
    WL = [];
  }

  /** 读全量钥匙列表（普通 fetch，不自动 stepup；失败返回 null → 开验证门） */
  function loadKeys() {
    return fetch('/api/owner-passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list' }),
      credentials: 'include',
    }).then(function (r) {
      return r.json();
    }).then(function (j) {
      if (j && j.ok) return j.keys || [];
      return null;
    }).catch(function () {
      return null;
    });
  }

  /** 按白名单渲染每应用钥匙状态 */
  function render(keys) {
    const audCount = {};
    (keys || []).forEach(function (k) {
      if ((k.class || 'lock') === 'app' && k.aud) {
        audCount[k.aud] = (audCount[k.aud] || 0) + 1;
      }
    });
    WL.forEach(function (app) {
      const el = document.querySelector('[data-appstatus="' + app.aud + '"]');
      if (!el) return;
      const n = audCount[app.aud] || 0;
      el.textContent = n > 0 ? t('keyAdded') + '（' + n + '）' : t('keyNone');
    });
  }

  initAppGate({
    dlg: 'appgate-dlg',
    pkBtn: 'appgate-pk',
    err: 'appgate-err',
    content: 'appmgr',
    t: t,
    load: loadKeys,
    onEnter: render,
  });
})();
