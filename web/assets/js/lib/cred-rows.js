/**
 * @fileoverview 凭证验证行（一行一个凭证：通行密钥点行直接调起系统验证；密码点行在行下展开输入框）。
 *
 * 从 account-methods.js 抽出（PR3）：账号 → 安全与隐私的门、「重置登录」第二步
 * （账号页的 /account/reset/ 与锁屏弹层里的同一个重置界面，lib/reset-flow.js）共用同一套行。
 * 行的内容（图标、标题、提交函数）由调用方给；失败 reject { message, clear?, cancelled? }。
 * 本文件在 lib/ 层：不 import shell/ 或 apps/。
 */
import { on } from './events.js';
import { bindPwEye, onEnter, focusNoScroll, PM_USER_STYLE } from './auth-flow.js';
import { KEY_ROOT } from './key-names.js';
import { bindSubmitButton, tapFeedback, setRowBusy, setRowSelected } from './dialog-behavior.js';

const CHEV = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>';
/** 行图标（通行密钥 / 密码 / 根凭证） */
export const CRED_ICONS = {
  passkey: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3l7.5 3v5.25c0 4.6-3.2 7.9-7.5 9.75-4.3-1.85-7.5-5.15-7.5-9.75V6L12 3z"/><path stroke-linecap="round" stroke-linejoin="round" d="M9.5 12l2 2 3.5-4"/></svg>',
  password: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  root: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="16" r="4"/><path stroke-linecap="round" stroke-linejoin="round" d="M10.8 13.2L20 4m-3 3l3 3"/></svg>',
};

/**
 * 根凭证输入框（全站只有这一个组件：重置登录第一步用）。隐藏用户名字段（值 RootKey）让 Samsung Pass 能填充、按这个名字保存。
 * @param {object} o
 * @param {string} o.id 输入框 id
 * @param {string} o.placeholder
 * @param {boolean} o.en
 * @returns {{field: HTMLElement, input: HTMLInputElement}}
 */
export function createRootField(o) {
  const field = document.createElement('div');
  field.className = 'sgx-pw-field';
  const userField = document.createElement('input');
  userField.type = 'text';
  userField.autocomplete = 'username';
  userField.value = KEY_ROOT;
  userField.setAttribute('aria-hidden', 'true');
  userField.tabIndex = -1;
  userField.style.cssText = PM_USER_STYLE;
  field.appendChild(userField);
  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'sgx-pw-input';
  input.id = o.id;
  input.autocomplete = 'current-password';
  input.setAttribute('aria-label', o.placeholder);
  input.placeholder = o.placeholder;
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'sgx-pw-eye';
  bindPwEye(eye, input, o.en);
  field.appendChild(input);
  field.appendChild(eye);
  return { field: field, input: input };
}

/**
 * 在容器里渲染验证行。
 * @param {object} o
 * @param {HTMLElement} o.el 容器（.sgx-credential-methods）
 * @param {function(string): string} o.t
 * @param {boolean} o.en
 * @param {Array<{kind:string, field:string, icon:string, title:string, sub:string, submit:Function, pmUser?:string}>} o.defs 要画的行（按顺序）
 *   field：webauthn（点行直接调起系统验证）| password | root（点行在行下展开输入框；root 带隐藏用户名 root）
 * @param {Function} o.onSuccess 任一入口验证通过
 * @returns {{collapse: Function}}
 */
export function renderCredRows(o) {
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
      methodsEl.querySelectorAll('.sgx-credential-row').forEach(function (row) { setRowSelected(/** @type {HTMLElement} */ (row), false); });
      methodsEl.querySelectorAll('.sgx-credential-chev.expanded').forEach(function (c) { c.classList.remove('expanded'); });
    }
  }

  /**
   * @param {{kind:string, field:string, icon:string, title:string, sub:string, submit:Function, pmUser?:string}} m
   */
  function renderMethod(m) {
    const wrap = document.createElement('div');
    wrap.className = 'sgx-credential-method';
    wrap.dataset.kind = m.kind;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sgx-credential-row';
    row.innerHTML = '<span class="sgx-credential-ic" aria-hidden="true">' + m.icon + '</span>' +
      '<span class="sgx-credential-mid"><span class="sgx-credential-rowtitle"></span><span class="sgx-credential-rowsub"></span></span>' +
      '<span class="sgx-credential-chev" aria-hidden="true">' + CHEV + '</span>';
    row.querySelector('.sgx-credential-rowtitle').textContent = m.title;
    const subEl = row.querySelector('.sgx-credential-rowsub');
    subEl.textContent = m.sub;
    const chev = /** @type {HTMLElement} */ (row.querySelector('.sgx-credential-chev'));
    const rowErr = document.createElement('p');
    rowErr.className = 'sgx-credential-err';
    rowErr.hidden = true;
    wrap.appendChild(row);
    wrap.appendChild(rowErr);
    methodsEl.appendChild(wrap);

    function startWebauthn() {
      if (row.disabled) return;
      collapse();
      rowErr.hidden = true;
      subEl.textContent = t('passkeyBusy');
      chev.innerHTML = '<span class="sgx-credential-spin" aria-hidden="true"></span>';
      /* 验证中所有行都不可点（防止同时开两个验证） */
      const allRows = Array.prototype.slice.call(methodsEl.querySelectorAll('.sgx-credential-row'));
      allRows.forEach(function (r) { setRowBusy(/** @type {HTMLElement} */ (r), true); });
      m.submit().then(function () {
        o.onSuccess();
      }, function (e) {
        /* 取消系统验证：默认不报错；调用方给了文案（如「已取消验证，可重新选择」）就行内提示 */
        if (!(e && e.cancelled) || (e && e.message)) {
          rowErr.textContent = (e && e.message) || t('errVerify');
          rowErr.hidden = false;
        }
      }).then(function () {
        chev.innerHTML = CHEV;
        allRows.forEach(function (r) { setRowBusy(/** @type {HTMLElement} */ (r), false); });
        subEl.textContent = m.sub;
      });
    }

    function expandForm() {
      const wasOpen = !!(expanded && expanded.parentNode === wrap);
      collapse();
      rowErr.hidden = true;
      if (wasOpen) return;
      const form = document.createElement('div');
      form.className = 'sgx-credential-expand';
      let field, input;
      if (m.field === 'root') {
        const rf = createRootField({ id: 'sgx-cred-root-' + m.kind, placeholder: m.sub, en: en });
        field = rf.field;
        input = rf.input;
        input.setAttribute('aria-label', m.title);
      } else {
        field = document.createElement('div');
        field.className = 'sgx-pw-field';
        if (m.pmUser) {
          /* 隐藏用户名框：密码管理器按这个名字保存 / 填充（AccountKey / LockKey） */
          const u = document.createElement('input');
          u.type = 'text';
          u.autocomplete = 'username';
          u.value = m.pmUser;
          u.setAttribute('aria-hidden', 'true');
          u.tabIndex = -1;
          u.style.cssText = PM_USER_STYLE;
          field.appendChild(u);
        }
        input = document.createElement('input');
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
      }
      const errEl = document.createElement('p');
      errEl.className = 'sgx-credential-err';
      errEl.hidden = true;
      const actions = document.createElement('div');
      actions.className = 'sgx-credential-actions mt-3';
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'sgx-credential-btn sgx-credential-btn-primary';
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

  o.defs.forEach(function (m) {
    if (m) renderMethod(m);
  });
  return { collapse: collapse };
}
