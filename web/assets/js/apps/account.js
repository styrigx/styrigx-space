/**
 * @fileoverview 账号页（原「站长凭证」升级为账号；顶栏右圆头像进入）。
 *
 * - 未登录：账号登录，三个入口平级 —— 账号通行密钥（POST /api/account challenge + login-passkey）、
 *   账号密码（login-password）、根凭证（POST /api/root-auth { key, target:'account' }）。
 *   任一成功即得到账号会话（服务端独立签发的 sgx-account，与锁屏会话无关）。
 * - 已登录：账号总览（三星账号式）—— 账号卡（名字 + 头像，换头像见 avatar-edit.js）、已登录卡（退出账号）、
 *   「安全与隐私」一行（副标题：账号密码或通行密钥任一已设置 → 已保护）→ 子页
 *   /settings/account/security/（apps/account-security.js）管理账号密码和账号通行密钥。
 * - ?door=1&return=<门内页>：从「管理凭证」过来，登录成功后 POST /api/stepup enter 换门票据再进门。
 * - ?return=/settings/account/security/（[&stale=1]）：子页未登录/过旧时跳来，登录后回子页。
 * - 访客：界面与站长一致，服务端一律拒绝（统一显示「不正确 / 验证失败」）。
 *
 * 复用 lib/auth-flow.js：bindPwEye / onEnter / focusNoScroll（登录输入框）。
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { b64urlToBuf, bufToB64url } from '../lib/b64.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';
import { bindPwEye, onEnter, focusNoScroll, stepupFetch } from '../lib/auth-flow.js';
import { bindSubmitButton, tapFeedback, setRowBusy, setRowSelected } from '../lib/dialog-behavior.js';
import { ACCOUNT_API, ACCOUNT_RETURN_RE, createT, postJSON, errText as errTextT, signalAccountName } from './account-common.js';

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

  /* ---------- 门回跳参数（只接受本站安全设置下的门内路径） ---------- */
  let doorReturn = '';
  let fromDoor = false;
  /* 安全与隐私子页跳来（未登录 / 登录过旧）：登录后回子页 */
  let acctReturn = '';
  let fromStale = false;
  try {
    const q = new URLSearchParams(window.location.search);
    fromDoor = q.get('door') === '1';
    const ret = q.get('return') || '';
    if (fromDoor) {
      if (/^\/(en\/)?settings\/security\/(lock|apps|mgmt)\/[a-z0-9\-/]*$/.test(ret)) doorReturn = ret;
    } else if (ACCOUNT_RETURN_RE.test(ret)) {
      acctReturn = ret;
      fromStale = q.get('stale') === '1';
    }
  } catch (e) {}
  const mgmtUrl = en ? '/en/settings/security/mgmt/' : '/settings/security/mgmt/';

  /** 服务端错误码 → 文案 */
  function errText(code, status) {
    return errTextT(t, code, status);
  }

  /* ================= 登录区 ================= */
  const CHEV = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>';
  const ICONS = {
    passkey: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3l7.5 3v5.25c0 4.6-3.2 7.9-7.5 9.75-4.3-1.85-7.5-5.15-7.5-9.75V6L12 3z"/><path stroke-linecap="round" stroke-linejoin="round" d="M9.5 12l2 2 3.5-4"/></svg>',
    password: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    root: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="16" r="4"/><path stroke-linecap="round" stroke-linejoin="round" d="M10.8 13.2L20 4m-3 3l3 3"/></svg>',
  };

  /** 登录成功：从门来 → 换门票据进门；否则显示账号页 */
  function afterLogin() {
    if (fromDoor) {
      stepupFetch('enter', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.ok) sgxNavigate(doorReturn || mgmtUrl);
          else showLogin(t('errVerify'));
        })
        .catch(function () { showLogin(t('errNetwork')); });
      return;
    }
    if (acctReturn) {
      sgxReplace(acctReturn);
      return;
    }
    loadStatus();
  }

  /** @param {string} value */
  function submitPassword(value) {
    return postJSON(ACCOUNT_API, { action: 'login-password', password: value }).then(function (res) {
      if (res.j && res.j.ok) return;
      throw { message: errText(res.j && res.j.error, res.s), clear: true };
    }, function () {
      throw { message: t('errNetwork') };
    });
  }
  /** @param {string} value */
  function submitRoot(value) {
    return postJSON('/api/root-auth', { key: value, target: 'account' }).then(function (res) {
      if (res.j && res.j.ok) return;
      if (res.s === 429) throw { message: t('errLocked') };
      if (res.j && res.j.error === 'config') throw { message: t('errConfig') };
      /* 401（含访客假入口）：统一提示根凭证不正确 */
      throw { message: t('errWrongRoot'), clear: true };
    }, function () {
      throw { message: t('errNetwork') };
    });
  }
  function doPasskey() {
    if (!window.PublicKeyCredential) return Promise.reject({ message: t('pkNoSupport') });
    return postJSON(ACCOUNT_API, { action: 'challenge' }).then(function (res) {
      const j = res.j;
      if (!j || !j.ok || !j.challenge) throw { message: errText(j && j.error, res.s) };
      const allow = (j.allowCredentials || []).map(function (c) {
        return { type: 'public-key', id: b64urlToBuf(c.id) };
      });
      return navigator.credentials.get({
        publicKey: {
          challenge: b64urlToBuf(j.challenge),
          rpId: j.rpId,
          allowCredentials: allow.length ? allow : undefined,
          userVerification: 'required',
        },
      }).then(function (cred) {
        return { cred: /** @type {any} */ (cred), cid: j.cid };
      }, function (e) {
        if (e && e.name === 'NotAllowedError') throw { cancelled: true };
        throw { message: t('errVerify') };
      });
    }, function () {
      throw { message: t('errNetwork') };
    }).then(function (r) {
      const cred = r.cred;
      return postJSON(ACCOUNT_API, {
        action: 'login-passkey',
        cid: r.cid,
        credential: {
          id: cred.id,
          rawId: bufToB64url(cred.rawId),
          type: cred.type,
          response: {
            authenticatorData: bufToB64url(cred.response.authenticatorData),
            clientDataJSON: bufToB64url(cred.response.clientDataJSON),
            signature: bufToB64url(cred.response.signature),
            userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
          },
        },
      }).then(function (res) {
        if (res.j && res.j.ok) return;
        throw { message: errText(res.j && res.j.error, res.s) };
      }, function () {
        throw { message: t('errNetwork') };
      });
    });
  }

  /** 当前展开的输入区（同一时刻只展开一个） */
  let expanded = null;
  /** @param {HTMLElement} [except] */
  function collapse(except) {
    if (expanded && expanded !== except) {
      const ex = expanded;
      expanded = null;
      try { ex.remove(); } catch (e) {}
      methodsEl.querySelectorAll('.sgx-door-row').forEach(function (row) { setRowSelected(/** @type {HTMLElement} */ (row), false); });
      methodsEl.querySelectorAll('.sgx-door-chev.expanded').forEach(function (c) { c.classList.remove('expanded'); });
    }
  }

  /**
   * @param {{kind:string, field:string, icon:string, title:string, sub:string, submit:Function}} m
   */
  function renderMethod(m) {
    const wrap = document.createElement('div');
    wrap.className = 'sgx-door-method';
    wrap.dataset.kind = m.kind;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sgx-door-row';
    row.innerHTML = '<span class="sgx-door-ic" aria-hidden="true">' + m.icon + '</span>' +
      '<span class="sgx-door-mid"><span class="sgx-door-rowtitle"></span><span class="sgx-door-rowsub"></span></span>' +
      '<span class="sgx-door-chev" aria-hidden="true">' + CHEV + '</span>';
    row.querySelector('.sgx-door-rowtitle').textContent = m.title;
    const subEl = row.querySelector('.sgx-door-rowsub');
    subEl.textContent = m.sub;
    const chev = /** @type {HTMLElement} */ (row.querySelector('.sgx-door-chev'));
    const rowErr = document.createElement('p');
    rowErr.className = 'sgx-door-err';
    rowErr.hidden = true;
    wrap.appendChild(row);
    wrap.appendChild(rowErr);
    methodsEl.appendChild(wrap);

    function startWebauthn() {
      if (row.disabled) return;
      collapse();
      rowErr.hidden = true;
      subEl.textContent = t('passkeyBusy');
      chev.innerHTML = '<span class="sgx-door-spin" aria-hidden="true"></span>';
      setRowBusy(row, true);
      m.submit().then(function () {
        afterLogin();
      }, function (e) {
        if (!(e && e.cancelled)) {
          rowErr.textContent = (e && e.message) || t('errVerify');
          rowErr.hidden = false;
        }
      }).then(function () {
        chev.innerHTML = CHEV;
        setRowBusy(row, false);
        subEl.textContent = m.sub;
      });
    }

    function expandForm() {
      const wasOpen = !!(expanded && expanded.parentNode === wrap);
      collapse();
      rowErr.hidden = true;
      if (wasOpen) return;
      const form = document.createElement('div');
      form.className = 'sgx-door-expand';
      const field = document.createElement('div');
      field.className = 'sgx-pw-field';
      if (m.field === 'root') {
        /* 与原根凭证框一致：隐藏用户名字段（值 root），让 Samsung Pass 能填充 */
        const userField = document.createElement('input');
        userField.type = 'text';
        userField.autocomplete = 'username';
        userField.value = 'root';
        userField.setAttribute('aria-hidden', 'true');
        userField.tabIndex = -1;
        userField.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;';
        field.appendChild(userField);
      }
      const input = document.createElement('input');
      input.type = 'password';
      input.className = 'sgx-pw-input';
      input.autocomplete = 'current-password';
      input.setAttribute('aria-label', m.title);
      input.placeholder = m.sub;
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'sgx-pw-eye';
      bindPwEye(eye, input, en);
      field.appendChild(input);
      field.appendChild(eye);
      const errEl = document.createElement('p');
      errEl.className = 'sgx-door-err';
      errEl.hidden = true;
      const actions = document.createElement('div');
      actions.className = 'sgx-door-actions mt-3';
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'sgx-door-btn sgx-door-btn-primary';
      go.textContent = t('verifyBtn');
      actions.appendChild(go);
      form.appendChild(field);
      form.appendChild(errEl);
      form.appendChild(actions);
      wrap.appendChild(form);
      expanded = form;
      setRowSelected(row, true);
      chev.classList.add('expanded');
      let busy = false;
      const doSubmit = function () {
        if (busy) return;
        const v = input.value;
        errEl.hidden = true;
        if (!v) {
          errEl.textContent = t('enterCred');
          errEl.hidden = false;
          return;
        }
        busy = true;
        m.submit(v).then(function () {
          afterLogin();
        }, function (e) {
          errEl.textContent = (e && e.message) || t('errVerify');
          errEl.hidden = false;
          if (e && e.clear) input.value = '';
        }).then(function () { busy = false; });
      };
      bindSubmitButton(go, doSubmit);
      onEnter(input, doSubmit);
      focusNoScroll(input);
    }

    on(row, 'click', function () {
      tapFeedback();
      if (m.field === 'webauthn') startWebauthn();
      else expandForm();
    });
  }

  /* 三个入口平级（固定顺序，访客与站长一致；未设置的入口提交后提示「尚未设置」） */
  renderMethod({ kind: 'passkey', field: 'webauthn', icon: ICONS.passkey, title: t('mPasskey'), sub: t('mPasskeySub'), submit: doPasskey });
  renderMethod({ kind: 'password', field: 'password', icon: ICONS.password, title: t('mPassword'), sub: t('mPasswordSub'), submit: submitPassword });
  renderMethod({ kind: 'root', field: 'root', icon: ICONS.root, title: t('mRoot'), sub: t('mRootSub'), submit: submitRoot });

  /** @param {string} [notice] */
  function showLogin(notice) {
    mainEl.hidden = true;
    loginEl.hidden = false;
    collapse();
    if (noticeEl) {
      noticeEl.textContent = notice || '';
      noticeEl.hidden = !notice;
    }
  }

  /* ================= 账号总览 ================= */

  /* 退出账号 */
  const logout = $('acct-logout');
  if (logout) {
    on(logout, 'click', function () {
      postJSON(ACCOUNT_API, { action: 'logout' }).then(function () {
        toast(t('loggedOut'));
        showLogin();
      }, function () {
        toast(t('errNetwork'));
      });
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
    const by = (j.session && j.session.by) || '';
    const byEl = $('acct-by');
    if (byEl) byEl.textContent = by === 'root' ? t('byRoot') : by === 'passkey' ? t('byPasskey') : t('byPassword');
    const secSub = $('acct-sec-sub');
    if (secSub) secSub.textContent = (j.password || j.passkey) ? t('secProtected') : t('secUnprotected');
    loginEl.hidden = true;
    mainEl.hidden = false;
    maybeSignalName();
  }

  /* 进页：读状态（访客/读失败 → 登录区，界面一致） */
  function loadStatus() {
    return fetch(ACCOUNT_API, { method: 'GET', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!(j && j.ok)) {
          showLogin();
          return;
        }
        if (j.ready === false) {
          showLogin(t('configNotice'));
          return;
        }
        if (j.session && j.session.recent && fromDoor) {
          afterLogin();
          return;
        }
        if (acctReturn) {
          /* 子页跳来：已有近期会话直接回去；过旧/未登录 → 登录区（过旧给提示） */
          if (j.session && j.session.recent && !fromStale) {
            sgxReplace(acctReturn);
            return;
          }
          showLogin(j.session ? t('staleNotice') : '');
          return;
        }
        if (j.session && !fromDoor) {
          showMain(j);
          return;
        }
        showLogin(fromDoor ? (j.session ? t('staleNotice') : t('doorNotice')) : '');
      })
      .catch(function () { showLogin(); });
  }
  loadStatus();
})();
