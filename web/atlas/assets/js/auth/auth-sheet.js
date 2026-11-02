/**
 * @fileoverview 锁屏与账号登录共用的两块界面（2026-10-24 从 shell/lock.js 抽出，DOM / class 与原来逐字一致）：
 *
 * 1. 方式选择底部弹层 createMethodSheet()：#sgx-method-sheet（遮罩 + 卡片 + 拖动条 + 标题 + 一行一个方式 + 「无法登录？」小字）。
 *    锁屏（解锁方式）和账号页（登录方式）都用它，所以两边看起来、用起来一样。
 * 2. 验证底部弹层 createVerifyDialog()：<dialog class="sgx-verify-dlg">（× + 拖动条 + 标题 + 内容区 + 错误行）。
 *    锁屏的临时钥匙 / 密码 / 通行密钥三态、账号页的账号密码 / 账号通行密钥都在这一个弹层里切换。
 *
 * 本文件在 lib/ 层：不得 import shell/ 或 apps/（键盘避让 followKeyboard 由调用方传入）。
 */
import { on } from '../lib/events.js';
import { reducedMotion } from '../lib/util.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose } from '../lib/dialog-behavior.js';

/** 方式行图标（28px，与锁屏原来的内联 SVG 相同） */
export const METHOD_ICONS = {
  visitor: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="m16 7 3 3"/><path d="m18 5 2 2"/></svg>',
  passkey: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.9-.8"/></svg>',
  password: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};

/**
 * 弹层里的提交按钮按下时不抢输入框焦点（mousedown preventDefault，同眼睛按钮）：
 * 手机上点「确定 / 登录」软键盘不收起，空密码 / 密码错误的提示出来时输入框仍聚焦（2026-10-24）。
 * 键盘 Tab 到按钮照常可聚焦。
 * @param {HTMLElement|null} btn
 */
export function keepInputFocus(btn) {
  if (!btn) return;
  btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
}

/**
 * @typedef {Object} MethodOpt
 * @property {string} id 按钮 id
 * @property {string} icon METHOD_ICONS 里的 SVG
 * @property {string} name 名称
 * @property {string} desc 一行说明
 * @property {string} [ariaLabel]
 * @property {() => void} onPick 点了之后（弹层已开始关闭）
 */

/**
 * 方式选择底部弹层。打开即显示（两帧后加 .visible 触发过渡），Esc / 点遮罩 / 下滑关闭。
 * @param {object} o
 * @param {string} o.ariaLabel 弹层 aria-label
 * @param {string} o.title 标题
 * @param {MethodOpt[]} o.options
 * @param {{id:string, text:string, href?:string, onClick?:(card:HTMLElement) => void}} [o.cant] 最下面一行小字（「无法登录？」）：
 *   给 href 时是链接；给 onClick 时是按钮，点了不关弹层（由调用方原地换内容）
 * @param {() => void} [o.onClose] 开始关闭时（同步调用，任何关闭入口都会走到）
 * @param {(navigating:boolean) => void} [o.onClosed] 关闭动画结束、节点已移除后
 * @returns {{el: HTMLElement, card: HTMLElement, close: (navigating?: boolean) => void}}
 */
export function createMethodSheet(o) {
  const sheet = document.createElement('div');
  sheet.id = 'sgx-method-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', o.ariaLabel);
  let html =
    '<div class="sgx-sheet-backdrop" data-close></div>' +
    '<div class="sgx-sheet-card" role="document">' +
    '<div class="sheet-handle" aria-hidden="true"></div>' +
    '<h2 class="sgx-sheet-title">' + o.title + '</h2>';
  o.options.forEach(function (m) {
    html +=
      '<button type="button" class="sgx-method-opt" id="' + m.id + '"' + (m.ariaLabel ? ' aria-label="' + m.ariaLabel + '"' : '') + '>' +
      '<span class="sgx-method-ic" aria-hidden="true">' + m.icon + '</span>' +
      '<span class="sgx-method-tx"><span class="sgx-method-name">' + m.name + '</span>' +
      '<span class="sgx-method-desc">' + m.desc + '</span></span>' +
      '</button>';
  });
  if (o.cant) {
    html += o.cant.href
      ? '<a class="sgx-sheet-cant" id="' + o.cant.id + '" href="' + o.cant.href + '">' + o.cant.text + '</a>'
      : '<button type="button" class="sgx-sheet-cant" id="' + o.cant.id + '">' + o.cant.text + '</button>';
  }
  html += '</div>';
  sheet.innerHTML = html;
  document.body.appendChild(sheet);
  const card = /** @type {HTMLElement} */ (sheet.querySelector('.sgx-sheet-card'));
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      sheet.classList.add('visible');
    });
  });
  let closed = false;
  /** @type {Array<() => void>} */ const offs = [];
  /** @param {boolean} [navigating] */
  function close(navigating) {
    if (closed) return;
    closed = true;
    sheet.classList.remove('visible');
    if (o.onClose) { try { o.onClose(); } catch (e) {} }
    offs.forEach(function (f) { try { f(); } catch (e) {} });
    window.setTimeout(function () {
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      if (o.onClosed) o.onClosed(!!navigating);
    }, 250);
  }
  o.options.forEach(function (m) {
    const b = sheet.querySelector('#' + m.id);
    if (b) on(b, 'click', function () { close(); m.onPick(); });
  });
  if (o.cant && o.cant.onClick) {
    const c = sheet.querySelector('#' + o.cant.id);
    const fn = o.cant.onClick;
    if (c) on(c, 'click', function () { fn(card); });
  }
  const backdrop = sheet.querySelector('[data-close]');
  if (backdrop) on(backdrop, 'click', function () { close(); });
  offs.push(on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }));
  /* 下滑关闭（touch） */
  let startY = 0;
  on(card, 'touchstart', function (/** @type {TouchEvent} */ e) {
    if (e.touches.length === 1) startY = e.touches[0].clientY;
  }, { passive: true });
  on(card, 'touchend', function (/** @type {TouchEvent} */ e) {
    if (e.changedTouches.length === 1 && e.changedTouches[0].clientY - startY > 80) close();
  }, { passive: true });
  /* 焦点移到第一个选项，键盘可操作 */
  try {
    const first = /** @type {HTMLElement|null} */ (sheet.querySelector('.sgx-method-opt, .sgx-sheet-cant'));
    if (first) first.focus({ preventScroll: true });
  } catch (e) {}
  return { el: sheet, card: card, close: close };
}

/**
 * 验证底部弹层（<dialog class="sgx-verify-dlg">，懒创建，一页一个）。
 * @param {object} o
 * @param {boolean} o.en
 * @param {string} o.reasonTag recordDialogClose 的来源名
 * @param {(sheetEl: HTMLElement, input: any) => (() => void)} [o.followKeyboard] shell/vk.js 的 followKeyboard
 * @param {string} [o.errId] 错误行 id（默认 sgx-verify-err）
 * @param {(reason: string) => void} [o.onClose] 关闭后
 */
export function createVerifyDialog(o) {
  const errId = o.errId || 'sgx-verify-err';
  /** @type {HTMLDialogElement|null} */ let dlg = null;
  /** @type {(() => void)|null} */ let kbStop = null;
  function ensure() {
    if (dlg) return dlg;
    const d = document.createElement('dialog');
    d.className = 'sgx-verify-dlg';
    d.setAttribute('aria-labelledby', 'sgx-verify-title');
    d.innerHTML =
      '<div class="sgx-verify-card">' +
      '<button type="button" class="sgx-dlg-close" data-dlg-close aria-label="' + (o.en ? 'Close' : '关闭') + '">×</button>' +
      '<div class="sheet-handle" data-dclose aria-hidden="true"></div>' +
      '<h2 id="sgx-verify-title" class="sgx-verify-title"></h2>' +
      '<div id="sgx-verify-body" class="sgx-verify-body"></div>' +
      '<p id="' + errId + '" class="sgx-verify-err" role="alert" hidden></p>' +
      '</div>';
    document.body.appendChild(d);
    dlg = /** @type {HTMLDialogElement} */ (d);
    on(d, 'click', function (/** @type {MouseEvent} */ e) {
      if (onDialogBackdrop(e, d)) return;
      const t = /** @type {Element|null} */ (e.target);
      if (t && t.closest && t.closest('[data-dlg-close]')) close('close-btn');
    });
    on(d, 'cancel', function (/** @type {Event} */ e) {
      onDialogCancel(e, d, function (reason) { close(reason); });
    });
    return dlg;
  }
  function errEl() {
    ensure();
    return document.getElementById(errId);
  }
  /** @param {string} txt */
  function setTitle(txt) {
    ensure();
    const el = document.getElementById('sgx-verify-title');
    if (el) el.textContent = txt;
  }
  /** 换内容区；错误行放回卡片末尾（showError 会按需挪到输入框下面） @param {string} html */
  function setBody(html) {
    ensure();
    const el = document.getElementById('sgx-verify-body');
    if (el) el.innerHTML = html;
    const err = errEl();
    const card = dlg && dlg.querySelector('.sgx-verify-card');
    if (err && card && err.parentNode !== card) card.appendChild(err);
  }
  function clearErr() {
    const err = errEl();
    if (err) err.hidden = true;
    if (dlg) {
      dlg.querySelectorAll('.sgx-pw-input[aria-invalid]').forEach(function (inp) {
        inp.removeAttribute('aria-invalid');
      });
    }
  }
  /**
   * 错误提示。带 input 时（例如空密码）：错误行挪到输入框正下方、输入框标 aria-invalid 并保持聚焦（键盘不收）。
   * @param {string} msg
   * @param {HTMLInputElement|null} [input]
   */
  function showError(msg, input) {
    const err = errEl();
    if (!err) return;
    err.textContent = msg;
    err.hidden = false;
    if (input) {
      const field = input.closest('.sgx-pw-field');
      if (field && field.parentNode && field.nextSibling !== err) field.parentNode.insertBefore(err, field.nextSibling);
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', errId);
      const clear = function () {
        input.removeAttribute('aria-invalid');
        input.removeEventListener('input', clear);
      };
      input.addEventListener('input', clear);
      try { input.focus({ preventScroll: true }); } catch (e) {}
    }
    if (!reducedMotion()) {
      const card = dlg && dlg.querySelector('.sgx-verify-card');
      if (card) {
        card.classList.remove('sgx-shake');
        void /** @type {HTMLElement} */ (card).offsetWidth;
        card.classList.add('sgx-shake');
      }
    }
  }
  /** 键盘避让：内容区新生成的输入框接 followKeyboard（同其他弹层） @param {any} input */
  function armKb(input) {
    disarmKb();
    if (dlg && input && o.followKeyboard) kbStop = o.followKeyboard(dlg, input);
  }
  function disarmKb() {
    if (kbStop) { try { kbStop(); } catch (e) {} kbStop = null; }
  }
  /** @returns {boolean} */
  function open() {
    const d = ensure();
    clearErr();
    if (d.open) return true;
    try {
      d.showModal();
    } catch (e) {
      return false;
    }
    return true;
  }
  /** @param {string} [reason] */
  function close(reason) {
    recordDialogClose(o.reasonTag, reason || 'unknown');
    disarmKb();
    if (dlg && dlg.open) {
      try { dlg.close(); } catch (e) {}
    }
    if (o.onClose) o.onClose(reason || 'unknown');
  }
  return {
    ensure: ensure,
    get el() { return dlg; },
    isOpen: function () { return !!(dlg && dlg.open); },
    setTitle: setTitle,
    setBody: setBody,
    clearErr: clearErr,
    showError: showError,
    armKb: armKb,
    disarmKb: disarmKb,
    open: open,
    close: close,
  };
}
