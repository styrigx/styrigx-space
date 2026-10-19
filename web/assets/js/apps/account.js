/**
 * @fileoverview 账号页（原「站长凭证」升级为账号；顶栏右圆头像进入）。
 *
 * - 未登录：账号登录，三个入口平级 —— 账号通行密钥（POST /api/account challenge + login-passkey）、
 *   账号密码（login-password）、根凭证（POST /api/root-auth { key, target:'account' }）。
 *   任一成功即得到账号会话（服务端独立签发的 sgx-account，与锁屏会话无关）。
 * - 已登录：管理账号密码（设置/修改；根凭证登录时为「重置」）和账号通行密钥（添加/删除）。
 *   管理操作需 10 分钟内登录过；过旧（account-stale）或失效（account）→ 回到登录区重新验证。
 * - ?door=1&return=<门内页>：从「管理凭证」过来，登录成功后 POST /api/stepup enter 换门票据再进门。
 * - 访客：界面与站长一致，服务端一律拒绝（统一显示「不正确 / 验证失败」）。
 *
 * 复用 lib/auth-flow.js：bindPwEye / onEnter / focusNoScroll（登录输入框）、
 * bindDataEyes / createSetPwDialog / newPwError（账号密码弹层）。
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { followKeyboard } from '../shell/vk.js';
import { b64urlToBuf, bufToB64url } from '../lib/b64.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';
import { bindPwEye, onEnter, focusNoScroll, bindDataEyes, createSetPwDialog, newPwError, stepupFetch } from '../lib/auth-flow.js';
import { bindSubmitButton, tapFeedback, setRowBusy, setRowSelected } from '../lib/dialog-behavior.js';

const ACCOUNT_API = '/api/account';

(function () {
  const en = document.documentElement.lang === 'en';
  /** @type {any} */
  let T = {};
  try {
    T = JSON.parse((document.getElementById('sgx-i18n-account') || {}).textContent || '{}');
  } catch (e) {}
  /** @param {string} k */
  function t(k) {
    const v = T[k];
    if (v && typeof v === 'object') return en ? v.en : v.zh;
    if (v) return v;
    if (typeof console !== 'undefined') console.warn('[i18n] missing key:', k);
    return en ? 'Something went wrong, please retry' : '出错了，请重试';
  }
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
  try {
    const q = new URLSearchParams(window.location.search);
    fromDoor = q.get('door') === '1';
    const ret = q.get('return') || '';
    if (/^\/(en\/)?settings\/security\/(lock|apps|mgmt)\/[a-z0-9\-/]*$/.test(ret)) doorReturn = ret;
  } catch (e) {}
  const mgmtUrl = en ? '/en/settings/security/mgmt/' : '/settings/security/mgmt/';

  /**
   * @param {string} url
   * @param {object} body
   * @returns {Promise<{s:number, j:any}>}
   */
  function postJSON(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    }).then(function (r) {
      return r.json().then(function (j) { return { s: r.status, j: j }; }, function () { return { s: r.status, j: null }; });
    });
  }

  /** 服务端错误码 → 文案 */
  function errText(code, status) {
    const map = {
      wrong: 'errWrongPw',
      'not-set': 'errNotSet',
      auth: 'errWrongRoot',
      denied: 'errWrongPw',
      role: 'errWrongPw',
      challenge: 'errVerify',
      verify: 'errVerify',
      'unknown-key': 'errVerify',
      'class-mismatch': 'errVerify',
      'uv-required': 'errUvRequired',
      locked: 'errLocked',
      config: 'errConfig',
      server: 'errServer',
      short: 'errShort',
      'same-as-lock': 'errSameAsLock',
      'not-found': 'errNotFound',
      session: 'sessExp',
    };
    if (code && map[code]) return t(map[code]);
    if (status === 429) return t('errLocked');
    return t('errUnknown');
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

  /* ================= 账号页 ================= */
  let hasPw = false;
  let sessBy = '';
  const eyeResets = bindDataEyes(t);
  const pwDialog = createSetPwDialog({
    $: $,
    t: function (k) {
      /* 根凭证登录时标题为「重置账号密码」（恢复路径） */
      if (k === 'changeTitle' && sessBy === 'root') return t('resetTitle');
      return t(k);
    },
    hideErr: function (id) { const e = $(id); if (e) e.hidden = true; },
    followKeyboard: followKeyboard,
    eyeResets: eyeResets,
    hasPw: function () { return hasPw; },
  });

  /**
   * 管理接口统一错误处理：账号会话失效/过旧 → 回登录区；lock 会话失效 → 去锁屏。
   * @returns {boolean} 已处理
   */
  function handleAuthError(res) {
    const code = res && res.j && res.j.error;
    if (code === 'account' || code === 'account-stale') {
      showLogin(t('staleNotice'));
      return true;
    }
    if (code === 'session') {
      toast(t('sessExp'));
      sgxReplace('/?lock=1&return=' + encodeURIComponent(window.location.pathname));
      return true;
    }
    return false;
  }

  /** @param {number} ts */
  function fmtDate(ts) {
    try {
      const d = new Date(ts);
      const p = function (n) { return String(n).padStart(2, '0'); };
      return en
        ? d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        : d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    } catch (e) {
      return '';
    }
  }

  function renderPwRow() {
    const sub = $('lockmgr-pwsub');
    if (sub) sub.textContent = hasPw ? t('pwSet') : t('pwUnset');
  }

  function refreshKeys() {
    return postJSON(ACCOUNT_API, { action: 'list' }).then(function (res) {
      if (handleAuthError(res)) return;
      if (!(res.j && res.j.ok)) return;
      const ul = $('lockmgr-pklist');
      const empty = $('lockmgr-pkempty');
      const keys = res.j.keys || [];
      if (ul) {
        ul.innerHTML = '';
        keys.forEach(function (k) { ul.appendChild(keyItem(k)); });
        ul.hidden = keys.length === 0;
      }
      if (empty) empty.hidden = keys.length !== 0;
    }, function () {});
  }

  function keyItem(k) {
    const li = document.createElement('li');
    li.className = 'lockmgr-pkitem';
    const nameWrap = document.createElement('div');
    nameWrap.className = 'lockmgr-pkname';
    const name = document.createElement('span');
    name.textContent = k.name || t('pkUnnamed');
    const meta = document.createElement('span');
    meta.className = 'lockmgr-pkdate';
    let metaText = (en ? 'Created ' : '创建于 ') + fmtDate(k.createdAt);
    metaText += ' · ' + (k.lastUsedAt ? (en ? 'Last used ' : '最近使用 ') + fmtDate(k.lastUsedAt) : t('pkNeverUsed'));
    if (k.provider) metaText = k.provider + ' · ' + metaText;
    meta.textContent = metaText;
    nameWrap.appendChild(name);
    nameWrap.appendChild(meta);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'lockmgr-pkdel';
    del.textContent = t('pkDel');
    del.setAttribute('aria-label', t('pkDel') + ' ' + (k.name || t('pkUnnamed')));
    /* 两步确认删除 */
    let armed = false;
    let armTimer = 0;
    on(del, 'click', function (e) {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        del.textContent = t('pkDelAsk');
        del.classList.add('armed');
        armTimer = window.setTimeout(function () {
          armed = false;
          del.textContent = t('pkDel');
          del.classList.remove('armed');
        }, 3000);
        return;
      }
      window.clearTimeout(armTimer);
      armed = false;
      postJSON(ACCOUNT_API, { action: 'delete', credId: k.credId }).then(function (res) {
        if (handleAuthError(res)) return;
        if (res.j && res.j.ok) {
          toast(t('pkDeleted'));
          try {
            const PKC = /** @type {any} */ (window.PublicKeyCredential);
            if (PKC && typeof PKC.signalUnknownCredential === 'function') {
              PKC.signalUnknownCredential({ rpId: location.hostname, credentialId: k.credId }).catch(function () {});
            } else {
              toast(t('pkDelManual'));
            }
          } catch (e2) {}
          refreshKeys();
        } else {
          toast(errText(res.j && res.j.error, res.s));
          del.textContent = t('pkDel');
          del.classList.remove('armed');
        }
      }, function () {
        toast(t('errNetwork'));
      });
    });
    li.appendChild(nameWrap);
    li.appendChild(del);
    return li;
  }

  /* 添加账号通行密钥 */
  const pkAdd = $('lockmgr-pkadd');
  if (pkAdd) {
    on(pkAdd, 'click', function () {
      if (!window.PublicKeyCredential) {
        toast(t('pkNoSupport'));
        return;
      }
      postJSON(ACCOUNT_API, { action: 'register-challenge' }).then(function (res) {
        if (handleAuthError(res)) throw { kind: 'handled' };
        const ch = res.j;
        if (!ch || !ch.ok) throw { kind: 'server', code: ch && ch.error, status: res.s };
        return navigator.credentials.create({
          publicKey: {
            challenge: b64urlToBuf(ch.challenge),
            rp: { name: (ch.rp && ch.rp.name) || 'Styrigx', id: ch.rpId },
            user: { id: b64urlToBuf(ch.user.id), name: ch.user.name, displayName: ch.user.displayName },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
            excludeCredentials: (ch.excludeCredentials || []).map(function (c) {
              return { id: b64urlToBuf(c.id), type: c.type };
            }),
            attestation: 'none',
            timeout: 60000,
          },
        }).then(function (cred) {
          return { cred: /** @type {any} */ (cred), cid: ch.cid };
        }, function (e) {
          if (e && e.name === 'NotAllowedError') throw { kind: 'cancelled' };
          if (e && e.name === 'InvalidStateError') throw { kind: 'already' };
          if (e && e.name === 'NotSupportedError') throw { kind: 'nosupport' };
          throw { kind: 'failed' };
        });
      }).then(function (r) {
        let device = '';
        try {
          const uad = /** @type {any} */ (navigator).userAgentData;
          if (uad && uad.platform) device = uad.platform;
        } catch (e) {}
        return postJSON(ACCOUNT_API, {
          action: 'register',
          cid: r.cid,
          name: device || t('pkUnnamed'),
          credential: {
            id: r.cred.id,
            rawId: bufToB64url(r.cred.rawId),
            type: r.cred.type,
            response: {
              clientDataJSON: bufToB64url(r.cred.response.clientDataJSON),
              attestationObject: bufToB64url(r.cred.response.attestationObject),
            },
          },
        });
      }).then(function (res) {
        if (handleAuthError(res)) return;
        if (res.j && res.j.ok) {
          toast(t('pkRegistered'));
          refreshKeys();
        } else {
          toast(errText(res.j && res.j.error, res.s));
        }
      }).catch(function (e) {
        if (!e || e.kind === 'handled') return;
        if (e.kind === 'cancelled') toast(t('errCancelled'));
        else if (e.kind === 'already') toast(t('pkAlready'));
        else if (e.kind === 'nosupport') toast(t('pkNoSupport'));
        else if (e.kind === 'failed') toast(t('pkFailed'));
        else if (e.kind === 'server') toast(errText(e.code, e.status));
        else toast(t('errNetwork'));
      });
    });
  }

  /* 设置/修改/重置账号密码 */
  function submitPw() {
    const a = /** @type {HTMLInputElement|null} */ ($('lockpw-1'));
    const b = /** @type {HTMLInputElement|null} */ ($('lockpw-2'));
    const va = a ? a.value : '';
    const vb = b ? b.value : '';
    const errEl = $('lockpw-err');
    if (errEl) errEl.hidden = true;
    const showErr = function (msg) {
      if (errEl) {
        errEl.textContent = msg;
        errEl.hidden = false;
      }
    };
    const pe = newPwError(va, vb);
    if (pe) {
      showErr(t(pe));
      return;
    }
    postJSON(ACCOUNT_API, { action: 'password', password: va }).then(function (res) {
      if (res.j && res.j.ok) {
        pwDialog.close('success');
        toast(res.j.changed ? t('pwChanged') : t('pwSaved'));
        hasPw = true;
        renderPwRow();
        return;
      }
      if (handleAuthError(res)) {
        pwDialog.close('reverify');
        return;
      }
      showErr(errText(res.j && res.j.error, res.s));
    }, function () {
      showErr(t('errNetwork'));
    });
  }
  const pwGo = $('lockpw-go');
  if (pwGo) bindSubmitButton(pwGo, submitPw);

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

  function showMain(j) {
    sessBy = (j.session && j.session.by) || '';
    hasPw = !!j.password;
    const byEl = $('acct-by');
    if (byEl) byEl.textContent = sessBy === 'root' ? t('byRoot') : sessBy === 'passkey' ? t('byPasskey') : t('byPassword');
    renderPwRow();
    loginEl.hidden = true;
    mainEl.hidden = false;
    refreshKeys();
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
