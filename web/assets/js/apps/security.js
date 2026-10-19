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
 */
import { on } from '../lib/events.js';
import { get as storeGet } from '../lib/storage.js';
import { toast } from '../lib/toast.js';
import { stepupFetch } from '../lib/auth-flow.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose, shouldIgnorePostDialogClick } from '../lib/dialog-behavior.js';

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

  /** @param {boolean} [silent] */
  function refresh(silent) {
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
          if (!silent) toast(t('refreshToast'));
        } else {
          throw new Error('bad');
        }
      })
      .catch(function () {
        /* 读取失败：保持现状 */
      });
  }

  /* B1-1 立即锁定：先弹确认层，确认后调服务端清除 sgx-verified，
     然后 location.replace('/?lock=1') → 锁屏出现（中间不渲染主页）。
     访客和站长都能用，不设限。 */
  const lockNow = document.getElementById('sec-locknow');
  if (lockNow) {
    const doLock = function () {
      fetch('/api/lock', { method: 'POST', credentials: 'include' })
        .then(function () {
          sgxReplace('/?lock=1');
        })
        .catch(function () {
          sgxReplace('/?lock=1');
        });
    };
    const showConfirm = function () {
      /* B1-1：弹层关闭后 400ms 内忽略点击（防误触） */
      if (shouldIgnorePostDialogClick()) return;
      let dlg = document.getElementById('sec-locknow-confirm');
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.id = 'sec-locknow-confirm';
        dlg.className = 'sgx-verify-dlg';
        const en = document.documentElement.lang === 'en';
        dlg.innerHTML =
          '<div class="sgx-verify-card">' +
            '<div class="sheet-handle"></div>' +
            '<h2 class="sgx-verify-title">' + (en ? 'Lock now?' : '立即锁定？') + '</h2>' +
            '<p class="sgx-verify-desc">' + (en ? 'This device will return to the lock screen.' : '当前设备会回到锁屏。') + '</p>' +
            '<div class="sgx-door-foot" style="gap:12px;width:100%;max-width:400px">' +
              '<button type="button" class="sgx-door-btn sgx-door-btn-secondary" data-act="cancel">' + (en ? 'Cancel' : '取消') + '</button>' +
              '<button type="button" class="sgx-door-btn sgx-door-btn-primary" data-act="ok">' + (en ? 'Lock' : '锁定') + '</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(dlg);
        dlg.addEventListener('click', function (e) {
          if (onDialogBackdrop(e, dlg)) { dlg.close(); recordDialogClose('locknow-confirm', 'backdrop'); }
        });
        dlg.addEventListener('cancel', function (e) {
          onDialogCancel(e, dlg, function () { dlg.close(); recordDialogClose('locknow-confirm', 'cancel'); });
        });
        dlg.querySelector('[data-act="cancel"]').addEventListener('click', function () {
          dlg.close();
          recordDialogClose('locknow-confirm', 'cancel-btn');
        });
        dlg.querySelector('[data-act="ok"]').addEventListener('click', function () {
          dlg.close();
          recordDialogClose('locknow-confirm', 'confirm');
          doLock();
        });
      }
      try { dlg.showModal(); } catch (e) {}
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


  refresh(true);
})();
