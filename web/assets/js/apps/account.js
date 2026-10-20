/**
 * @fileoverview 账号页（原「站长凭证」升级为账号；顶栏右圆头像进入）。
 *
 * - 未登录：账号登录 —— 账号通行密钥 / 账号密码 / 根凭证，设了哪个显示哪个，都没设只显示根凭证
 *   （验证行见 account-methods.js）。任一成功即得到账号会话（sgx-account，400 天，不点退出一直登录；
 *   与锁屏会话无关，但进账号页的前提是锁屏已解锁）。
 * - 已登录：账号总览（三星账号式）—— 账号卡（名字 + 头像，换头像见 avatar-edit.js；点卡片其余地方进
 *   下一页「已登录」/settings/account/profile/，在那里退出账号）、
 *   「安全与隐私」一行（副标题：账号密码或通行密钥任一已设置 → 已保护）→ 子页
 *   /settings/account/security/（apps/account-security.js，每次进都要验签，3 分钟门票）。
 * - ?return=/settings/account/(security|profile)/：子页没有账号会话时跳来，登录后回子页。
 * - 访客：读不到状态，三个入口都显示，服务端一律拒绝（统一显示「不正确 / 验证失败」）。
 */
import { on } from '../lib/events.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';
import { tapFeedback } from '../lib/dialog-behavior.js';
import { ACCOUNT_API, ACCOUNT_RETURN_RE, createT, postJSON, profileUrl, signalAccountName } from './account-common.js';
import { accountSubmitters, renderAccountMethods, visibleKinds } from './account-methods.js';

(function () {
  const en = document.documentElement.lang === 'en';
  const t = createT(en);
  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }
  const loginEl = $('acct-login');
  const mainEl = $('acct-main');
  const methodsEl = $('acct-methods');
  const noticeEl = $('acct-login-notice');
  if (!loginEl || !mainEl || !methodsEl) return;

  /* 账号子页跳来（没有账号会话）：登录后回子页 */
  let acctReturn = '';
  try {
    const ret = new URLSearchParams(window.location.search).get('return') || '';
    if (ACCOUNT_RETURN_RE.test(ret)) acctReturn = ret;
  } catch (e) {}


  /* ================= 登录区 ================= */
  const submitters = accountSubmitters(t);
  /** 当前渲染的验证行（showLogin 时按已设置的凭证重画） */
  let methods = null;

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

  /**
   * 显示登录区。设了哪个凭证显示哪个，都没设只显示根凭证；读不到状态时三个都显示（访客与站长界面一致）。
   * @param {string} [notice]
   * @param {any} [status]
   */
  function showLogin(notice, status) {
    mainEl.hidden = true;
    loginEl.hidden = false;
    if (methods) methods.collapse();
    methods = renderAccountMethods({
      el: methodsEl,
      t: t,
      en: en,
      kinds: visibleKinds(status || null),
      submit: submitters,
      onSuccess: afterLogin,
    });
    if (noticeEl) {
      noticeEl.textContent = notice || '';
      noticeEl.hidden = !notice;
    }
  }

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
    const secSub = $('acct-sec-sub');
    if (secSub) secSub.textContent = (j.password || j.passkey) ? t('secProtected') : t('secUnprotected');
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
        showLogin();
      });
  }
  loadStatus();
})();
