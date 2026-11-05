/**
 * @fileoverview 安全页（P4-2c 起标题「安全」，隐私组删除）。
 * - 三个入口（所有进门的人看到完全一样）：锁屏凭证、临时钥匙、立即锁定。
 * - 锁屏凭证 → /settings/security/lock/（门在那一页：锁屏凭证或进站凭证验一次，3 分钟 reauth 票）。点了就进页，进页照旧先复验。
 * - 临时钥匙 → /settings/security/tempkeys/（含分享短链）：列表只要进门；新建 / 作废前在那一页复验（apps/security-tempkeys.js）。
 * - 立即锁定：调服务端 /api/lock-now 清除会话 cookie 后重载，回到锁屏。
 * - 从 GET /api/lock-credentials（进门即可）读取锁屏凭证是否已设置，渲染状态卡片与锁屏凭证行副标题。
 * - 隐私分组（搜索引擎、收录、本地数据）P4-2c 整组删除，engines.js 随搜索层一起删。
 */
import { on } from '../lib/events.js';
import { confirmLockNow } from '../auth/lock-now.js';

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
    if (v) return v;
    /* 批次 A 收尾 #36：兜底不显示内部键名；键名只记诊断 */
    if (typeof console !== 'undefined') console.warn('[i18n] missing key:', k);
    return en ? 'Something went wrong, please retry' : '出错了，请重试';
  }

  const card = document.getElementById('sec-status');
  const lockSub = document.getElementById('sec-lock-sub');
  const cardTitle = document.getElementById('sec-status-title');
  const cardSub = document.getElementById('sec-status-sub');

  /**
   * 渲染状态。
   * @param {boolean} hasPw
   * @param {boolean} hasPk
   */
  function render(hasPw, hasPk) {
    if (lockSub) {
      lockSub.textContent = hasPw && hasPk ? t('lockSubBoth') : hasPw ? t('lockSubPw') : hasPk ? t('lockSubPk') : t('lockSubNone');
    }
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
  }

  function refresh() {
    fetch('/api/lock-credentials', { method: 'GET', credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j && j.ok) {
          render(!!j.password, !!j.passkey);
        } else {
          throw new Error('bad');
        }
      })
      .catch(function () {
        /* 读取失败：保持现状 */
      });
  }

  /* B1-1 立即锁定：确认层 + /api/lock-now 在 auth/lock-now.js（顶栏快捷面板的「立即锁定」磁贴共用同一份） */
  const lockNow = document.getElementById('sec-locknow');
  if (lockNow) {
    const showConfirm = function () {
      confirmLockNow();
    };
    on(lockNow, 'click', showConfirm);
    on(lockNow, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      /* B1-1：只认 Enter，删 Space */
      if (e.key === 'Enter') {
        e.preventDefault();
        showConfirm();
      }
    });
  }

  refresh();
})();
