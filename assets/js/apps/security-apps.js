/**
 * @fileoverview 应用列表页（2.11）：安全与隐私 → 应用。
 * - 进门：页面直接渲染；进门探针（app-gate.js）确认验证有效，
 *   无效则跳验证流程（安全与隐私页），不弹面板。
 * - 进门后：按白名单渲染每应用的应用类通行密钥状态（已添加/未添加），
 *   点击行进该应用详情页（settingsPath 由模板注入，不手抄）。
 * - 反馈一律 One UI 轻提示（toast）；localStorage 经 storage.js。
 */
import { enterDoor } from './app-gate.js';

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

  /** 读该应用列表页所需的 app 类钥匙；验证无效时返回 null → 跳验证流程 */
  let lastListErr = null;
  function loadKeys() {
    return fetch('/api/owner-passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      /* 批次 A 验收修复 P0：list 带页面类别，只返回 app 类 */
      body: JSON.stringify({ action: 'list', pkClass: 'app' }),
      credentials: 'include',
    }).then(function (r) {
      return r.json();
    }).then(function (j) {
      if (j && j.ok) return j.keys || [];
      lastListErr = j;
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

  /* 进门探针：验证有效直接渲染，无效跳验证流程（安全与隐私页） */
  let cachedKeys = null;
  enterDoor(
    function () {
      return loadKeys().then(function (keys) {
        cachedKeys = keys;
        /* 探针失败时带上服务端 reason（如 owner-configured），探针面板显示明确文案 */
        if (keys) return true;
        return { ok: false, reason: (lastListErr && lastListErr.reason) || (lastListErr && lastListErr.error) || 'session', status: 0, api: 'POST /api/owner-passkey' };
      });
    },
    function () {
      const mgr = document.getElementById('appmgr');
      if (mgr) mgr.hidden = false;
      render(cachedKeys);
    },
    t
  );
})();
