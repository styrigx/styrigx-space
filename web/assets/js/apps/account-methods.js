/**
 * @fileoverview 账号凭证验证行（账号页登录 + 账号 → 安全与隐私的门共用）。
 *
 * 三个入口：账号通行密钥 / 账号密码 / 根凭证。设了哪个显示哪个，都没设只显示根凭证
 * （visibleKinds）；读不到状态（访客 / 网络失败）时三个都显示，界面与站长一致，服务端一律拒绝。
 * - 通行密钥：点行直接调起系统验证（POST /api/account challenge + login-passkey）
 * - 账号密码 / 根凭证：点行在行下展开输入框（login-password；/api/root-auth target=account）
 * door:true 时服务端在账号会话之外另签 3 分钟账号门票（安全与隐私子页用）。
 *
 * 复用 lib/auth-flow.js：bindPwEye / onEnter / focusNoScroll。
 */
import { on } from '../lib/events.js';
import { b64urlToBuf, bufToB64url } from '../lib/b64.js';
import { bindPwEye, onEnter, focusNoScroll } from '../lib/auth-flow.js';
import { bindSubmitButton, tapFeedback, setRowBusy, setRowSelected } from '../lib/dialog-behavior.js';
import { ACCOUNT_API, postJSON, errText as errTextT } from './account-common.js';

const CHEV = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>';
const ICONS = {
  passkey: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3l7.5 3v5.25c0 4.6-3.2 7.9-7.5 9.75-4.3-1.85-7.5-5.15-7.5-9.75V6L12 3z"/><path stroke-linecap="round" stroke-linejoin="round" d="M9.5 12l2 2 3.5-4"/></svg>',
  password: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  root: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="16" r="4"/><path stroke-linecap="round" stroke-linejoin="round" d="M10.8 13.2L20 4m-3 3l3 3"/></svg>',
};

/**
 * 要显示的入口（固定顺序：通行密钥、密码、根凭证）。
 * @param {{password?:boolean, passkey?:boolean}|null} status GET /api/account 的结果；null = 读不到
 * @returns {string[]}
 */
export function visibleKinds(status) {
  if (!status) return ['passkey', 'password', 'root'];
  const out = [];
  if (status.passkey) out.push('passkey');
  if (status.password) out.push('password');
  out.push('root');
  return out;
}

/**
 * 三个入口的提交函数。成功 resolve；失败 reject { message, clear?, cancelled? }。
 * @param {function(string): string} t
 * @param {{door?: boolean}} [opts]
 */
export function accountSubmitters(t, opts) {
  const door = !!(opts && opts.door);
  /** @param {string} [code] @param {number} [status] */
  function errText(code, status) {
    return errTextT(t, code, status);
  }
  /** @param {string} value */
  function password(value) {
    const body = { action: 'login-password', password: value };
    if (door) body.door = true;
    return postJSON(ACCOUNT_API, body).then(function (res) {
      if (res.j && res.j.ok) return;
      throw { message: errText(res.j && res.j.error, res.s), clear: true };
    }, function () {
      throw { message: t('errNetwork') };
    });
  }
  /** @param {string} value */
  function root(value) {
    const body = { key: value, target: 'account' };
    if (door) body.door = true;
    return postJSON('/api/root-auth', body).then(function (res) {
      if (res.j && res.j.ok) return;
      if (res.s === 429) throw { message: t('errLocked') };
      if (res.j && res.j.error === 'config') throw { message: t('errConfig') };
      /* 401（含访客假入口）：统一提示根凭证不正确 */
      throw { message: t('errWrongRoot'), clear: true };
    }, function () {
      throw { message: t('errNetwork') };
    });
  }
  function passkey() {
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
      const body = {
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
      };
      if (door) body.door = true;
      return postJSON(ACCOUNT_API, body).then(function (res) {
        if (res.j && res.j.ok) return;
        throw { message: errText(res.j && res.j.error, res.s) };
      }, function () {
        throw { message: t('errNetwork') };
      });
    });
  }
  return { passkey: passkey, password: password, root: root };
}

/**
 * 在容器里渲染验证行。
 * @param {object} o
 * @param {HTMLElement} o.el 容器（.sgx-door-methods）
 * @param {function(string): string} o.t
 * @param {boolean} o.en
 * @param {string[]} o.kinds visibleKinds() 的结果
 * @param {{passkey:Function, password:Function, root:Function}} o.submit accountSubmitters() 的结果
 * @param {Function} o.onSuccess 任一入口验证通过
 * @returns {{collapse: Function}}
 */
export function renderAccountMethods(o) {
  const methodsEl = o.el;
  const t = o.t;
  const en = o.en;
  methodsEl.textContent = '';

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
        o.onSuccess();
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
          o.onSuccess();
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

  const defs = {
    passkey: { kind: 'passkey', field: 'webauthn', icon: ICONS.passkey, title: t('mPasskey'), sub: t('mPasskeySub'), submit: o.submit.passkey },
    password: { kind: 'password', field: 'password', icon: ICONS.password, title: t('mPassword'), sub: t('mPasswordSub'), submit: o.submit.password },
    root: { kind: 'root', field: 'root', icon: ICONS.root, title: t('mRoot'), sub: t('mRootSub'), submit: o.submit.root },
  };
  o.kinds.forEach(function (k) {
    if (defs[k]) renderMethod(defs[k]);
  });
  return { collapse: collapse };
}
