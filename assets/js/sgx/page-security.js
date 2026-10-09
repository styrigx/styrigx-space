/**
 * @fileoverview 安全与隐私页（2.4.0 安全与隐私）。
 * - 从 /api/owner-status 读取只读状态（是否已设置密码/通行密钥），渲染状态卡片与锁定屏幕副标题。
 * - 立即锁定：清除当前会话标记并重载，回到锁屏。
 * - 右上 ⋮：刷新状态。
 * - localStorage 统一走 storage.js。
 */
import { on } from './events.js';
import { get as storeGet } from './storage.js';
import { toast } from './toast.js';

(function () {
  const en = document.documentElement.lang === 'en';
  /** @type {any} */
  let T = {};
  try {
    T = JSON.parse(document.getElementById('sgx-i18n-security').textContent || '{}');
  } catch (e) {}
  /** @param {string} k */
  function t(k) {
    const v = T[k];
    if (v && typeof v === 'object') return en ? v.en : v.zh;
    return v || k;
  }

  const card = document.getElementById('sec-status');
  const cardIc = document.getElementById('sec-status-ic');
  const cardTitle = document.getElementById('sec-status-title');
  const cardSub = document.getElementById('sec-status-sub');
  const lockSub = document.getElementById('sec-lock-sub');

  /**
   * 渲染状态。
   * @param {boolean} hasPw
   * @param {boolean} hasPk
   */
  function render(hasPw, hasPk) {
    if (card) {
      card.hidden = false;
      card.classList.toggle('is-ok', hasPw && hasPk);
      card.classList.toggle('is-warn', !(hasPw && hasPk));
    }
    if (hasPw && hasPk) {
      if (cardTitle) cardTitle.textContent = t('okTitle');
      if (cardSub) cardSub.textContent = t('okSub');
    } else {
      if (cardTitle) cardTitle.textContent = t('warnTitle');
      const miss = [];
      if (!hasPw) miss.push(t('missPw'));
      if (!hasPk) miss.push(t('missPk'));
      if (cardSub) cardSub.textContent = miss.join('，');
    }
    if (lockSub) {
      if (hasPw && hasPk) lockSub.textContent = t('lockSubBoth');
      else if (hasPw) lockSub.textContent = t('lockSubPw');
      else if (hasPk) lockSub.textContent = t('lockSubPk');
      else lockSub.textContent = t('lockSubNone');
    }
  }

  /** @param {boolean} [silent] */
  function refresh(silent) {
    fetch('/api/owner-status', { method: 'GET', credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j && j.ok) {
          render(!!j.password, !!j.passkey);
          if (!silent) toast(t('refreshToast'));
        } else {
          throw new Error('bad');
        }
      })
      .catch(function () {
        if (lockSub) lockSub.textContent = t('statusErr');
      });
  }

  /* 立即锁定：清除会话标记并重载 → 锁屏出现 */
  const lockNow = document.getElementById('sec-locknow');
  if (lockNow) {
    const go = function () {
      try {
        sessionStorage.removeItem('sgx-lock-shown');
      } catch (e) {}
      location.reload();
    };
    on(lockNow, 'click', go);
    on(lockNow, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  }

  /* 右上 ⋮：刷新状态 */
  const more = document.getElementById('sec-more');
  if (more) {
    on(more, 'click', function () {
      refresh(false);
    });
  }

  /* 重置所有设置入口：跳回设置页关于分组（由设置页处理二次确认） */
  const resetLink = document.getElementById('sec-reset-link');
  if (resetLink) {
    on(resetLink, 'click', function () {
      try {
        storeGet('sgx-set-recent');
      } catch (e) {}
    });
  }

  refresh(true);
})();
