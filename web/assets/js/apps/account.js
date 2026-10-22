/**
 * @fileoverview 账号页（/account/，抽屉头的头像圆进入）。
 *
 * - 未登录：账号登录（PR3，顶栏页名「登录账号」）—— 头像 + 欢迎回来；主按钮「通行密钥登录」、
 *   次按钮「密码登录」（原地展开密码框），设了哪个显示哪个；小字「无法登录？」→ 重置登录页
 *   （/account/reset/，apps/account-reset.js）。根凭证不再是登录入口。
 *   成功即得到账号会话（sgx-account，400 天，不点退出一直登录；与锁屏会话无关，但进账号页的前提是锁屏已解锁）。
 * - 已登录：账号总览（三星账号式）—— 账号卡（名字 + 头像，换头像见 avatar-edit.js；点卡片其余地方进
 *   下一页「已登录」/account/profile/，在那里退出账号）、
 *   「安全与隐私」一行（副标题：账号密码或通行密钥任一已设置 → 已保护）→ 子页
 *   /account/security/（apps/account-security.js，每次进都要验签，3 分钟门票）。
 * - ?return=/account/(security|profile)/：子页没有账号会话时跳来，登录后回子页。
 * - 访客：读不到状态，两个按钮都显示，服务端一律拒绝（统一显示「不正确 / 验证失败」）。
 * - 首帧（2026-10-21）：页面默认两块都隐藏；网关在 <html data-sgx-account="in|out"> 注入服务端验过的账号会话，
 *   这里同步按它显示总览或登录区。没有这个属性（中性态）就等 /api/account。
 *   「欢迎回来」只在服务端说未登录时出现：属性 out、或 /api/account 明确 session=null。
 *   属性 in 而 /api/account 读不到（访客 401 / 网络）→ 保持总览，不退回登录区。
 */
import { initCloudSync, syncEnabled, SWITCH_KEY, LAST_KEY, AUTH_KEY } from '../lib/cloud-sync.js';
import { get as sget, set as sset } from '../lib/storage.js';
import { on } from '../lib/events.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';
import { tapFeedback, bindSubmitButton } from '../lib/dialog-behavior.js';
import { bindPwEye, onEnter, focusNoScroll } from '../lib/auth-flow.js';
import { ACCOUNT_RETURN_RE, createT, profileUrl, signalAccountName } from './account-common.js';
import { ACCOUNT_API, postJSON } from '../lib/account-api.js';
import { accountSubmitters, visibleKinds } from '../lib/account-methods.js';

(function () {
  const en = document.documentElement.lang === 'en';
  const t = createT(en);
  /** 总览「设备」一行的副标题：此设备的名字（服务端 session.device；没有就「此设备」） @param {any} j */
  function fillDevSub(j) {
    const el = document.getElementById('acct-dev-sub');
    if (el) el.textContent = (j && j.session && j.session.device) || t('devThis');
  }

  /* ===== 云同步一行（开关；lib/cloud-sync.js 做实际同步） ===== */
  function fillSync() {
    const sw = document.getElementById('acct-sync-sw');
    const sub = document.getElementById('acct-sync-sub');
    const on = syncEnabled();
    if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
    if (!sub) return;
    if (!on) { sub.textContent = t('syncOff'); return; }
    const last = parseInt(sget(LAST_KEY) || '0', 10) || 0;
    if (!last) { sub.textContent = t('syncOn'); return; }
    const d = new Date(last);
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    const today = new Date().toDateString() === d.toDateString();
    const when = (today ? '' : (d.getMonth() + 1) + (en ? '/' : '月') + d.getDate() + (en ? ' ' : '日 ')) + pad(d.getHours()) + ':' + pad(d.getMinutes());
    sub.textContent = t('syncLast') + when;
  }
  /** 登录了账号的总览：清掉「没登录账号」标记，立刻同步一次 */
  function startSync() {
    sset(AUTH_KEY, 'in');
    fillSync();
    if (syncEnabled()) initCloudSync({ force: true }).then(fillSync, fillSync);
  }
  (function bindSync() {
    const row = document.getElementById('acct-sync-row');
    if (!row) return;
    const toggle = function () {
      const on = !syncEnabled();
      sset(SWITCH_KEY, on ? null : '0');
      fillSync();
      if (on) initCloudSync({ force: true }).then(fillSync, fillSync);
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  })();
  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }
  const loginEl = $('acct-login');
  const mainEl = $('acct-main');
  const noticeEl = $('acct-login-notice');
  const pkBtn = /** @type {HTMLButtonElement|null} */ ($('acct-pk-btn'));
  const pkErr = $('acct-pk-err');
  const pwBtn = /** @type {HTMLButtonElement|null} */ ($('acct-pw-btn'));
  const pwForm = $('acct-pw-form');
  const pwInput = /** @type {HTMLInputElement|null} */ ($('acct-pw-input'));
  const pwErr = $('acct-pw-err');
  const pwGo = /** @type {HTMLButtonElement|null} */ ($('acct-pw-go'));
  const noneEl = $('acct-login-none');
  const hint0 = document.documentElement.dataset.sgxAccount || '';
  if (!loginEl && mainEl && hint0 === 'in') {
    /* 服务端说已登录，登录区没下发：只填总览；/api/account 明确说没有账号会话（刚过期 / 别处退出）
       → 重新取页面，由服务端画登录区。读不到（访客 401 / 网络）→ 保持总览。 */
    mainEl.hidden = false;
    let ret0 = '';
    try {
      const r = new URLSearchParams(window.location.search).get('return') || '';
      if (ACCOUNT_RETURN_RE.test(r)) ret0 = r;
    } catch (e) {}
    if (ret0) {
      sgxReplace(ret0);
      return;
    }
    fetch(ACCOUNT_API, { method: 'GET', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!(j && j.ok)) return;
        if (!j.session) {
          window.location.reload();
          return;
        }
        const secSub = $('acct-sec-sub');
        if (secSub) secSub.textContent = (j.password || j.passkey) ? t('secProtected') : t('secUnprotected');
        fillDevSub(j);
        startSync();
        const PKC = /** @type {any} */ (window).PublicKeyCredential;
        if (PKC && typeof PKC.signalCurrentUserDetails === 'function') {
          postJSON(ACCOUNT_API, { action: 'list' }).then(function (res) {
            if (res.j && res.j.ok) signalAccountName(res.j);
          }, function () {});
        }
      })
      .catch(function () {});
    return;
  }
  if (!loginEl || !mainEl || !pkBtn || !pwBtn || !pwForm || !pwInput || !pwGo) return;

  /* 账号子页跳来（没有账号会话）：登录后回子页 */
  let acctReturn = '';
  try {
    const ret = new URLSearchParams(window.location.search).get('return') || '';
    if (ACCOUNT_RETURN_RE.test(ret)) acctReturn = ret;
  } catch (e) {}

  /* 顶栏长条的页名：登录区「登录账号」，总览「账号」（正文不再放大标题） */
  function setPageTitle(key) {
    const txt = t(key);
    const tb = document.querySelector('.sgx-tb-title');
    if (tb) tb.textContent = txt;
    try { document.title = txt + ' | Styrigx'; } catch (e) {}
  }

  /* ================= 登录区 ================= */
  const submitters = accountSubmitters(t);

  /** 登录成功：子页跳来 → 回子页；否则显示账号页 */
  function afterLogin() {
    if (acctReturn) {
      sgxReplace(acctReturn);
      return;
    }
    loadStatus();
  }

  /** GET /api/account 的最近一次结果（访客 / 读失败为 null） */
  let lastStatus = null;
  /** 网关注入的账号会话提示：'in' | 'out' | ''（中性） */
  const hint = document.documentElement.dataset.sgxAccount || '';

  function collapsePw() {
    pwForm.hidden = true;
    pwBtn.setAttribute('aria-expanded', 'false');
    pwBtn.classList.remove('is-open');
    if (pwErr) pwErr.hidden = true;
    pwInput.value = '';
  }

  /**
   * 显示登录区。设了哪个凭证显示哪个；读不到状态时两个都显示（访客与站长界面一致）。
   * 都没设 → 只留提示和「无法登录？」。
   * @param {string} [notice]
   * @param {any} [status]
   */
  function showLogin(notice, status) {
    mainEl.hidden = true;
    loginEl.hidden = false;
    setPageTitle('loginTitle');
    collapsePw();
    const kinds = visibleKinds(status || null);
    pkBtn.hidden = kinds.indexOf('passkey') === -1;
    pwBtn.hidden = kinds.indexOf('password') === -1;
    if (pkErr) pkErr.hidden = true;
    if (noneEl) noneEl.hidden = kinds.length > 0;
    if (noticeEl) {
      noticeEl.textContent = notice || '';
      noticeEl.hidden = !notice;
    }
  }

  /* 主按钮：通行密钥登录（点了立刻 busy，只发一次 challenge；取消系统验证不报错） */
  let pkBusy = false;
  const pkTx = pkBtn.querySelector('.acct-login-btn-tx');
  const pkLabel = pkTx ? pkTx.textContent : '';
  on(pkBtn, 'click', function () {
    if (pkBusy) return;
    tapFeedback();
    collapsePw();
    if (pkErr) pkErr.hidden = true;
    pkBusy = true;
    pkBtn.disabled = true;
    pkBtn.setAttribute('aria-busy', 'true');
    if (pkTx) pkTx.textContent = t('passkeyBusy');
    submitters.passkey().then(function () {
      afterLogin();
    }, function (e) {
      if (!(e && e.cancelled) && pkErr) {
        pkErr.textContent = (e && e.message) || t('errVerify');
        pkErr.hidden = false;
      }
    }).then(function () {
      pkBusy = false;
      pkBtn.disabled = false;
      pkBtn.removeAttribute('aria-busy');
      if (pkTx) pkTx.textContent = pkLabel;
    });
  });

  /* 次按钮：密码登录 → 原地展开 / 收起密码框 */
  const eye = $('acct-pw-eye');
  if (eye) bindPwEye(eye, pwInput, en);
  on(pwBtn, 'click', function () {
    tapFeedback();
    if (!pwForm.hidden) {
      collapsePw();
      return;
    }
    if (pkErr) pkErr.hidden = true;
    pwForm.hidden = false;
    pwBtn.setAttribute('aria-expanded', 'true');
    pwBtn.classList.add('is-open');
    focusNoScroll(pwInput);
  });
  let pwBusy = false;
  const submitPw = function () {
    if (pwBusy) return;
    const v = pwInput.value;
    if (pwErr) pwErr.hidden = true;
    if (!v) {
      if (pwErr) {
        pwErr.textContent = t('enterCred');
        pwErr.hidden = false;
      }
      return;
    }
    pwBusy = true;
    submitters.password(v).then(function () {
      afterLogin();
    }, function (e) {
      if (pwErr) {
        pwErr.textContent = (e && e.message) || t('errVerify');
        pwErr.hidden = false;
      }
      if (e && e.clear) pwInput.value = '';
    }).then(function () { pwBusy = false; });
  };
  bindSubmitButton(pwGo, submitPw);
  onEnter(pwInput, submitPw);

  /* ================= 账号总览 ================= */

  /* 点账号卡（头像以外的地方）→ 下一页「已登录」（账号信息、退出账号）。头像按钮自己管换照片。 */
  const card = mainEl.querySelector('[data-acct-card]');
  if (card) {
    card.setAttribute('role', 'link');
    card.setAttribute('tabindex', '0');
    const go = function () { sgxNavigate(profileUrl(en)); };
    on(card, 'click', function (e) {
      const target = /** @type {HTMLElement} */ (e.target);
      if (target && target.closest && target.closest('[data-avatar-edit]')) return;
      tapFeedback();
      go();
    });
    on(card, 'keydown', function (e) {
      const ev = /** @type {KeyboardEvent} */ (e);
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        go();
      }
    });
  }

  /**
   * 密码管理器改名（ownerkey → accountkey）：支持 signalCurrentUserDetails 时才拉一次 list 拿账号 handle。
   * 用通行密钥登录后、或进总览时都会走到这里；每页只发一次（account-common.js）。
   */
  function maybeSignalName() {
    const PKC = /** @type {any} */ (window.PublicKeyCredential);
    if (!PKC || typeof PKC.signalCurrentUserDetails !== 'function') return;
    postJSON(ACCOUNT_API, { action: 'list' }).then(function (res) {
      if (res.j && res.j.ok) signalAccountName(res.j);
    }, function () {});
  }

  function showMain(j) {
    setPageTitle('acctTitle');
    const secSub = $('acct-sec-sub');
    if (secSub) secSub.textContent = (j.password || j.passkey) ? t('secProtected') : t('secUnprotected');
    fillDevSub(j);
    startSync();
    loginEl.hidden = true;
    mainEl.hidden = false;
    maybeSignalName();
  }

  /* 进页：读状态（访客/读失败 → 登录区，三个入口都显示，界面一致） */
  function loadStatus() {
    return fetch(ACCOUNT_API, { method: 'GET', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!(j && j.ok)) {
          lastStatus = null;
          if (hint === 'in') return; /* 服务端已说已登录：读不到细节也不退回登录区 */
          showLogin();
          return;
        }
        lastStatus = j;
        if (j.ready === false) {
          showLogin(t('configNotice'), j);
          return;
        }
        if (acctReturn) {
          /* 安全与隐私子页跳来（没有账号会话）：已登录直接回去，否则登录后回去 */
          if (j.session) {
            sgxReplace(acctReturn);
            return;
          }
          showLogin('', j);
          return;
        }
        if (j.session) {
          showMain(j);
          return;
        }
        showLogin('', j);
      })
      .catch(function () {
        lastStatus = null;
        if (hint === 'in') return;
        showLogin();
      });
  }
  /* 首帧：照服务端提示同步显示（总览的副标题等 /api/account 回来再填） */
  if (hint === 'in' && !acctReturn) {
    setPageTitle('acctTitle');
    loginEl.hidden = true;
    mainEl.hidden = false;
  } else if (hint === 'out') {
    showLogin();
  }
  loadStatus();
})();
