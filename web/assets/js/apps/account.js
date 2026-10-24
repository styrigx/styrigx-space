/**
 * @fileoverview 账号页（/account/，抽屉头的头像圆进入）。
 *
 * - 未登录：账号登录（顶栏页名「登录账号」，2026-10-24 与锁屏同一套界面）—— 头像 + 欢迎回来 + 「登录」；
 *   点「登录」（或头像）→ 与锁屏同一个底部弹层（lib/auth-sheet.js）选 通行密钥 / 密码，设了哪个显示哪个；
 *   最下面小字「无法登录？」→ 重置登录页（/account/reset/，apps/account-reset.js）。根凭证不再是登录入口。
 *   密码 → 与锁屏同一个密码弹层；通行密钥 → 同一弹层里的「正在验证」态，失败给 重试 / 使用密码。
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
import { bindPwEye, onEnter, focusNoScroll, pwFieldHtml } from '../lib/auth-flow.js';
import { createMethodSheet, createVerifyDialog, METHOD_ICONS, keepInputFocus } from '../lib/auth-sheet.js';
import { KEY_ACCOUNT } from '../lib/key-names.js';
import { followKeyboard } from '../shell/vk.js';
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
  const goBtn = /** @type {HTMLButtonElement|null} */ ($('acct-login-go'));
  const avBtn = $('acct-login-avatar');
  const noneEl = $('acct-login-none');
  const hint0 = document.documentElement.dataset.sgxAccount || '';
  /* 2026-10-23 修：服务端已登录、没下发登录区的分支（下面 hint0 === 'in'）提前 return，原来走不到这里，线上账号卡点了没反应。
     抽成函数，两个分支都绑。
     点账号卡（头像以外的地方）→ 下一页「已登录」（账号信息、退出账号）。头像按钮自己管换照片。 */
  function bindAccountCard() {
    const card = mainEl ? mainEl.querySelector('[data-acct-card]') : null;
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
  }

  if (!loginEl && mainEl && hint0 === 'in') {
    bindAccountCard();
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
  if (!loginEl || !mainEl || !goBtn) return;

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

  /** 当前可用的登录方式（showLogin 时按状态算） @type {string[]} */
  let kinds = visibleKinds(null);

  /* ---------- 登录方式弹层 + 验证弹层（与锁屏同一组件，lib/auth-sheet.js） ---------- */
  /** @type {{el: HTMLElement, card: HTMLElement, close: (navigating?: boolean) => void}|null} */
  let sheet = null;
  /** @type {string|null} */ let vState = null;
  const vd = createVerifyDialog({
    en: en,
    reasonTag: 'acct-login',
    followKeyboard: followKeyboard,
    errId: 'acct-pw-err',
    onClose: function () { vState = null; document.body.classList.remove('sgx-dlg-open'); },
  });
  /** 验证弹层打开：头像那组淡出避让（与锁屏同一个 body.sgx-dlg-open） */
  function openVd() {
    if (!vd.open()) return false;
    document.body.classList.add('sgx-dlg-open');
    return true;
  }

  function closeAll() {
    if (sheet) sheet.close(true);
    if (vd.isOpen()) vd.close('success');
  }

  function openSheet() {
    if (sheet) return;
    tapFeedback();
    /** @type {import('../lib/auth-sheet.js').MethodOpt[]} */
    const opts = [];
    if (kinds.indexOf('passkey') !== -1) {
      opts.push({ id: 'acct-pk-btn', icon: METHOD_ICONS.passkey, name: en ? 'Passkey' : '通行密钥',
        desc: t('mPasskeySub'), ariaLabel: en ? 'Sign in with passkey' : '使用通行密钥登录',
        onPick: function () { tapFeedback(); openPk(); } });
    }
    if (kinds.indexOf('password') !== -1) {
      opts.push({ id: 'acct-pw-btn', icon: METHOD_ICONS.password, name: en ? 'Password' : '密码',
        desc: t('mPasswordSub'), ariaLabel: en ? 'Sign in with password' : '使用密码登录',
        onPick: function () { tapFeedback(); openPw(); } });
    }
    const ms = createMethodSheet({
      ariaLabel: en ? 'Choose sign-in method' : '选择登录方式',
      title: en ? 'Sign in' : '登录',
      options: opts,
      cant: { id: 'acct-cant', text: en ? 'Can’t sign in?' : '无法登录？', href: en ? '/en/account/reset/' : '/account/reset/' },
      onClose: function () { if (sheet === ms) sheet = null; },
      onClosed: function (navigating) {
        if (navigating || vd.isOpen()) return;
        try { goBtn.focus({ preventScroll: true }); } catch (e) {}
      },
    });
    sheet = ms;
  }
  on(goBtn, 'click', openSheet);
  if (avBtn) on(avBtn, 'click', openSheet);

  /* 密码态 */
  let pwBusy = false;
  function openPw() {
    vState = 'password';
    vd.setTitle(en ? 'Enter password' : '输入密码');
    vd.setBody(
      pwFieldHtml({ id: 'acct-pw-input', eyeId: 'acct-pw-eye', autocomplete: 'current-password', pmUser: KEY_ACCOUNT, ariaLabel: t('mPassword'), placeholder: t('mPassword'), en: en }) +
        '<button type="button" class="sgx-verify-skip" id="acct-pw-go">' + t('verifyBtn') + '</button>'
    );
    vd.clearErr();
    if (!openVd()) return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('acct-pw-input'));
    const eye = document.getElementById('acct-pw-eye');
    const go = document.getElementById('acct-pw-go');
    if (!input || !go) return;
    if (eye) bindPwEye(eye, input, en);
    vd.armKb(input);
    const submit = function () { submitPw(input); };
    onEnter(input, submit);
    bindSubmitButton(go, submit);
    keepInputFocus(go);
    focusNoScroll(input);
  }
  /** @param {HTMLInputElement} input */
  function submitPw(input) {
    if (pwBusy || vState !== 'password') return;
    const v = input.value;
    vd.clearErr();
    if (!v) {
      /* 空密码：输入框正下方提示，输入框标 aria-invalid 并保持聚焦（2026-10-24） */
      vd.showError(t('enterPw'), input);
      return;
    }
    pwBusy = true;
    submitters.password(v).then(function () {
      closeAll();
      afterLogin();
    }, function (e) {
      if (vState !== 'password') return;
      if (e && e.clear) input.value = '';
      vd.showError((e && e.message) || t('errVerify'), input);
    }).then(function () { pwBusy = false; });
  }

  /* 通行密钥态（点了立刻进「正在验证」，只发一次 challenge；取消系统验证不报错，直接收起弹层） */
  let pkBusy = false;
  function openPk() {
    if (pkBusy) return;
    vState = 'passkey';
    vd.setTitle(en ? 'Use passkey' : '使用通行密钥');
    vd.setBody(
      '<div class="sgx-verify-loading"><div class="sgx-spinner" role="progressbar" aria-label="' + t('passkeyBusy') + '"></div>' +
        '<p class="sgx-verify-loading-tx" id="acct-pk-busy">' + t('passkeyBusy') + '</p></div>'
    );
    vd.clearErr();
    if (!openVd()) return;
    pkBusy = true;
    submitters.passkey().then(function () {
      closeAll();
      afterLogin();
    }, function (e) {
      if (vState !== 'passkey') return;
      if (e && e.cancelled) {
        vd.close('cancel');
        return;
      }
      pkFailed((e && e.message) || t('errVerify'));
    }).then(function () { pkBusy = false; });
  }
  /** @param {string} msg */
  function pkFailed(msg) {
    vd.setBody(
      '<div class="sgx-verify-loading"><p class="sgx-verify-failtx" id="acct-pk-err">' + msg + '</p><div class="sgx-verify-actions">' +
        '<button type="button" class="sgx-verify-skip" id="acct-pk-retry">' + (en ? 'Retry' : '重试') + '</button>' +
        (kinds.indexOf('password') !== -1 ? '<button type="button" class="sgx-verify-ghost" id="acct-pk-topw">' + (en ? 'Use password' : '使用密码') + '</button>' : '') +
        '</div></div>'
    );
    const retry = document.getElementById('acct-pk-retry');
    const topw = document.getElementById('acct-pk-topw');
    if (retry) on(retry, 'click', openPk);
    if (topw) on(topw, 'click', openPw);
  }

  /**
   * 显示登录区。设了哪个凭证显示哪个；读不到状态时两个都显示（访客与站长界面一致）。
   * 都没设 → 提示，「登录」弹层里只剩「无法登录？」。
   * @param {string} [notice]
   * @param {any} [status]
   */
  function showLogin(notice, status) {
    mainEl.hidden = true;
    loginEl.hidden = false;
    setPageTitle('loginTitle');
    kinds = visibleKinds(status || null);
    if (noneEl) noneEl.hidden = kinds.length > 0;
    if (noticeEl) {
      noticeEl.textContent = notice || '';
      noticeEl.hidden = !notice;
    }
  }

  /* ================= 账号总览 ================= */

  bindAccountCard();

  /**
   * 密码管理器改名（OwnerKey → AccountKey）：支持 signalCurrentUserDetails 时才拉一次 list 拿账号 handle。
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
