/**
 * @fileoverview 安全与隐私页。
 * - 两个入口（访客与站长看到完全一样）：锁屏凭证、立即锁定。
 *   账号凭证在顶栏右圆头像（账号页 /settings/account/ → 安全与隐私）。
 * - 锁屏凭证 → /settings/security/lock/（门在那一页：锁屏凭证或根凭证验一次，3 分钟门票）。
 *   访客（服务端注入 data-sgx-role="visitor"）点它：不跳页，就地弹站长验证层（shell/upgrade.js
 *   openOwnerVerify：只有通行密钥 / 密码，没有访客入口）；通过 → 进锁屏凭证页；取消 → 原页，访客会话不动。
 *   以前是跳过去由中间件 302 到 /?lock=1&return=…，那一页不过网关 → 整个锁屏闪一下（2026-10-21）。
 * - 立即锁定：调服务端 /api/lock 清除会话 cookie 后重载，回到锁屏。
 * - 从 GET /api/lock-status（需 owner 会话）读取锁屏凭证是否已设置，渲染状态卡片与锁屏凭证行副标题（访客不调用）。
 * - localStorage 统一走 storage.js。
 * - 隐私分组（2026-10-20 从浏览器页 ⋮ 搬来）：搜索引擎（engines.js，sgx-search-engine，点行打开同一个选择弹层）、
 *   清除浏览记录（全网搜索的最近搜索 sgx-browser-history）。原顶栏 ⋮（#sec-more = 刷新状态）已删除：进页即读取。
 */
import { on } from '../lib/events.js';
import { get as storeGet, set as storeSet } from '../lib/storage.js';
import { toast } from '../lib/toast.js';
import { openSheet } from '../shell/sheet.js';
import { engines as SE } from '../shell/engines.js';
import { confirmLockNow } from '../lib/lock-now.js';
import { openOwnerVerify } from '../shell/upgrade.js';

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
    /* 访客不调用 /api/lock-status（需 owner 会话，访客 401）；状态卡片保持隐藏。 */
    try {
      if (document.documentElement.dataset.sgxRole === 'visitor') return;
    } catch (e) {}
    fetch('/api/lock-status', { method: 'GET', credentials: 'same-origin' })
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

  /* 访客点「锁屏凭证」：就地站长验证（见文件头） */
  const lockCred = /** @type {HTMLAnchorElement|null} */ (document.getElementById('sec-lock-cred'));
  if (lockCred) {
    on(lockCred, 'click', function (/** @type {MouseEvent} */ e) {
      if (document.documentElement.dataset.sgxRole !== 'visitor') return;
      e.preventDefault();
      openOwnerVerify(lockCred.getAttribute('href') || (en ? '/en/settings/security/lock/' : '/settings/security/lock/'));
    });
  }

  /* B1-1 立即锁定：确认层 + /api/lock 在 lib/lock-now.js（顶栏快捷面板的「立即锁定」磁贴共用同一份） */
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

  /* ============ 隐私：搜索引擎 / 清除浏览记录 ============ */
  /** @param {Element|null} row @param {() => void} fn */
  function bindRow(row, fn) {
    if (!row) return;
    on(row, 'click', fn);
    on(row, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    });
  }
  const engineVal = document.getElementById('sec-engine-val');
  function syncEngine() {
    if (engineVal) engineVal.textContent = SE.name(SE.cur());
  }
  syncEngine();
  on(window, 'sgx-settings-changed', syncEngine);
  bindRow(document.getElementById('sec-engine'), function () {
    const cur = SE.cur();
    openSheet({
      title: t('engineTitle'),
      options: SE.ORDER.map(function (id) {
        return { label: SE.name(id), value: id, checked: id === cur };
      }),
      onPick: function (v) {
        if (SE.ENGINES[v]) SE.setCur(v);
        syncEngine();
      },
    });
  });
  bindRow(document.getElementById('sec-clearhist'), function () {
    openSheet({
      title: t('clearHistQ'),
      options: [{ label: t('clear'), value: 'yes' }],
      onPick: function (y) {
        if (y !== 'yes') return;
        storeSet('sgx-browser-history', '[]');
        toast(t('clearedToast'));
      },
    });
  });

  /* 重置所有设置入口：跳回设置页关于分组（由设置页处理二次确认） */
  const resetLink = document.getElementById('sec-reset-link');
  if (resetLink) {
    on(resetLink, 'click', function () {
      try {
        storeGet('sgx-set-recent');
      } catch (e) {}
    });
  }

  refresh();
})();
