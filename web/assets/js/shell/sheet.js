/**
 * @fileoverview 通用 bottom sheet / 居中弹窗（2.4.0 D：<dialog> 实现）。
 * 原生 showModal() 提供 ::backdrop、Esc 关闭、焦点陷阱；打开/关闭动画
 * 用 CSS 过渡；手机下滑关闭保留手写。
 */
import { on, delegate } from '../lib/events.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose } from '../lib/dialog-behavior.js';

/**
 * @typedef {Object} SheetOption
 * @property {string} label
 * @property {string} [sub]
 * @property {string} value
 * @property {boolean} [checked]
 */
/**
 * @typedef {Object} SheetOpts
 * @property {string} [title]
 * @property {string} [html]
 * @property {SheetOption[]} [options]
 * @property {(value: string) => void} [onPick]
 */

let inited = false;
/** @type {HTMLDialogElement|null} */ let dlg = null;
/** @type {HTMLElement|null} */ let panel = null;
/** @type {HTMLElement|null} */ let titleEl = null;
/** @type {HTMLElement|null} */ let bodyEl = null;
/** @type {boolean} */ let closing = false;

function ensure() {
  if (inited) return true;
  dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('sheet-wrap'));
  panel = document.getElementById('sheet-panel');
  titleEl = document.getElementById('sheet-title');
  bodyEl = document.getElementById('sheet-body');
  if (!dlg || !panel || !titleEl || !bodyEl) return false;
  inited = true;
  delegate(dlg, 'click', '[data-sheet-close]', function () {
    closeSheet('close-btn');
  });
  /* 批次 A 收尾 A1：点遮罩只失焦不关闭 */
  on(dlg, 'click', function (/** @type {MouseEvent} */ e) {
    onDialogBackdrop(e, dlg);
  });
  /* 批次 A 收尾 A2：原生 cancel（Esc/返回）时，键盘开着先收键盘，键盘收起才关闭 */
  on(dlg, 'cancel', function (/** @type {Event} */ e) {
    onDialogCancel(e, dlg, function (reason) { closeSheet(reason); });
  });
  /* 手机下滑关闭 */
  /** @type {number|null} */
  let sy = null;
  on(
    panel,
    'touchstart',
    function (/** @type {TouchEvent} */ e) {
      if (e.touches.length === 1) sy = e.touches[0].clientY;
    },
    { passive: true }
  );
  on(
    panel,
    'touchmove',
    function (/** @type {TouchEvent} */ e) {
      if (sy === null || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - sy;
      if (dy > 90 && panel && panel.scrollTop <= 0 && window.matchMedia('(max-width:639px)').matches) {
        sy = null;
        closeSheet('swipe');
      }
    },
    { passive: true }
  );
  return true;
}

/**
 * 关闭 bottom sheet（带退出动画）。
 * @param {string} [reason] 关闭原因（close-btn / back / cancel-btn / success）
 */
export function closeSheet(reason) {
  recordDialogClose('sheet', reason || 'unknown');
  if (!ensure() || !dlg || !dlg.open || closing) return;
  closing = true;
  dlg.classList.add('sgx-closing');
  window.setTimeout(function () {
    closing = false;
    if (dlg) {
      dlg.classList.remove('sgx-closing');
      if (dlg.open) dlg.close();
    }
  }, 240);
}

/**
 * 打开 bottom sheet。
 * @param {SheetOpts} opts
 */
export function openSheet(opts) {
  if (!ensure() || !dlg || !titleEl || !bodyEl) return;
  opts = opts || {};
  const te = titleEl,
    be = bodyEl;
  te.textContent = opts.title || '';
  te.style.display = opts.title ? '' : 'none';
  be.innerHTML = '';
  if (opts.html) {
    const d = document.createElement('div');
    d.className = 'px-3 pb-2';
    d.innerHTML = opts.html;
    be.appendChild(d);
  } else {
    (opts.options || []).forEach(function (o) {
      const b = document.createElement('button');
      b.className = 'sheet-opt';
      b.setAttribute('type', 'button');
      b.innerHTML =
        '<span class="flex-1 min-w-0"><span class="block font-medium truncate">' +
        o.label +
        '</span>' +
        (o.sub ? '<span class="block text-xs text-m-on-surface-variant truncate">' + o.sub + '</span>' : '') +
        '</span>' +
        (o.checked ? '<span class="text-m-primary">✓</span>' : '');
      on(b, 'click', function () {
        closeSheet('pick');
        if (opts.onPick) opts.onPick(o.value);
      });
      be.appendChild(b);
    });
  }
  if (!dlg.open) {
    try {
      dlg.showModal();
    } catch (e) {
      /* 已打开时 showModal 抛错，忽略 */
    }
  }
  /* 触发进入动画 */
  dlg.classList.remove('sgx-closing');
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      if (dlg) dlg.classList.add('sgx-open');
    });
  });
}
