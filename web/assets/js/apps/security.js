/**
 * @fileoverview 安全与隐私页。
 * - 两个入口（访客与站长看到完全一样）：管理凭证、立即锁定。
 *   原「站长凭证」已升级为账号，入口移到顶栏右圆头像（账号页 /settings/account/）。
 * - 管理凭证 → POST /api/stepup { action:'enter' }：10 分钟内登录过账号 → 直接进管理凭证；
 *   未登录或登录过旧（account / account-stale）→ 去账号登录（?door=1&return=<门内页>），
 *   登录后自动进门。访客也走账号登录（服务端一律拒绝，界面一致）。
 * - 立即锁定：调服务端 /api/lock 清除会话 cookie 后重载，回到锁屏。
 * - 从 GET /api/account（需 owner 会话）读取账号凭证是否已设置，渲染状态卡片（访客不调用）。
 * - localStorage 统一走 storage.js。
 * - 隐私分组（2026-10-20 从浏览器页 ⋮ 搬来）：搜索引擎（engines.js，sgx-search-engine，点行打开同一个选择弹层）、
 *   清除浏览记录（全网搜索的最近搜索 sgx-browser-history）。原顶栏 ⋮（#sec-more = 刷新状态）已删除：进页即读取。
 */
import { on } from '../lib/events.js';
import { get as storeGet, set as storeSet } from '../lib/storage.js';
import { toast } from '../lib/toast.js';
import { openSheet } from '../shell/sheet.js';
import { engines as SE } from '../shell/engines.js';
import { stepupFetch } from '../lib/auth-flow.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';
import { confirmLockNow } from '../lib/lock-now.js';

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

  const mgmtUrl = en ? '/en/settings/security/mgmt/' : '/settings/security/mgmt/';
  const acctUrl = en ? '/en/settings/account/' : '/settings/account/';

  const card = document.getElementById('sec-status');
  /** @type {{mgmt?: (t?: string) => void}} */
  const doorOpeners = {};
  const cardTitle = document.getElementById('sec-status-title');
  const cardSub = document.getElementById('sec-status-sub');

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
  }

  function refresh() {
    /* 访客不调用 /api/account（需 owner 会话，访客 401）；状态卡片保持隐藏。 */
    try {
      if (document.documentElement.dataset.sgxRole === 'visitor') return;
    } catch (e) {}
    fetch('/api/account', { method: 'GET', credentials: 'same-origin' })
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

  /* ============ 管理凭证 ============
     账号体系：门票据由近期（≤10 分钟）账号登录签发（POST /api/stepup enter → by=account, scope=keys）。
     - 成功 → 进管理凭证（或 target 指定的门内页）
     - account / account-stale → 去账号登录（?door=1&return=），登录后账号页自动换票进门
     - session → 会话失效，回锁屏
     访客：直接去账号登录（界面与站长一致，服务端一律拒绝）。 */
  (function () {
    const row = document.getElementById('sec-mgmt-cred');
    if (!row) return;
    let busy = false;
    /** @param {string} dest */
    function goAccountLogin(dest) {
      sgxNavigate(acctUrl + '?door=1&return=' + encodeURIComponent(dest));
    }
    function openMgmtDoor(/** @type {string} [target] */ target) {
      const dest = (typeof target === 'string' && target) ? target : mgmtUrl;
      let isVisitor = false;
      try {
        isVisitor = document.documentElement.dataset.sgxRole === 'visitor';
      } catch (e) {}
      if (isVisitor) {
        goAccountLogin(dest);
        return;
      }
      if (busy) return;
      busy = true;
      stepupFetch('enter', { credentials: 'same-origin' })
        .then(function (r) {
          return r.json().then(function (j) { return { s: r.status, j: j }; }, function () { return { s: r.status, j: null }; });
        })
        .then(function (res) {
          const code = res.j && res.j.error;
          if (res.j && res.j.ok) sgxNavigate(dest);
          else if (code === 'account' || code === 'account-stale') goAccountLogin(dest);
          else if (code === 'session' || res.s === 401) sgxReplace('/?lock=1&return=' + encodeURIComponent(window.location.pathname));
          else toast(en ? 'Something went wrong, please retry' : '出错了，请重试');
        }, function () {
          toast(t('errNetwork'));
        })
        .then(function () { busy = false; });
    }
    on(row, 'click', function () { openMgmtDoor(); });
    on(row, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMgmtDoor();
      }
    });
    doorOpeners.mgmt = openMgmtDoor;

    /* 状态卡片不是直达锁屏门内页的裸链接：先走管理凭证（进门），通过后进锁屏凭证页。 */
    if (card) {
      on(card, 'click', function (/** @type {MouseEvent} */ e) {
        e.preventDefault();
        openMgmtDoor(card.getAttribute('href') || '');
      });
    }
  })();

  /* 门内页验证过期 → 弹框「重新验证」→ 回到本页并带 ?verify=mgmt&return=<门内页>，
     这里自动走管理凭证进门流程，通过后回到原门内页。return 只接受本站安全设置下的门内路径。 */
  (function () {
    let q;
    try { q = new URLSearchParams(window.location.search); } catch (e) { return; }
    const which = q.get('verify');
    if (!which) return;
    const ret = q.get('return') || '';
    const okRet = /^\/(en\/)?settings\/security\/(lock|apps|mgmt)\/[a-z0-9\-\/]*$/.test(ret) ? ret : '';
    try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
    if (doorOpeners.mgmt) doorOpeners.mgmt(okRet);
  })();


  refresh();
})();
