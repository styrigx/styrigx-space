/**
 * @fileoverview 通用 bottom sheet / 居中弹窗（2.4.0 D：<dialog> 实现）。
 * 原生 showModal() 提供 ::backdrop、Esc 关闭、焦点陷阱；打开/关闭动画
 * 用 CSS 过渡；手机下滑关闭保留手写。
 */
import { on, delegate } from '../core/events.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose } from './dialog-behavior.js';
import { showDialog } from './modal-sheet.js';

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
  /* 不经 closeSheet 被关掉（浏览器强制关闭、别的代码直接 close()）：同样清掉开 / 关动画类，关着的弹层不留在页面上 */
  on(dlg, 'close', function () {
    closing = false;
    if (dlg) dlg.classList.remove('sgx-open', 'sgx-closing');
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
  /* 2026-11-07 修：关闭时去掉 sgx-open（以前一直留着）。宽屏 / DeX 版面 dialog#sheet-wrap.sgx-open 有 display:flex，
     盖过浏览器给关着的 <dialog> 的 display:none——关掉后整块弹层（标题「头像」等）以普通元素留在页面顶部、被顶栏压住半截
     （Gray 真机：三星浏览器 S23 Ultra /zh/account/ 换头像后）。去掉 sgx-open 也让退出动画真的生效（面板滑下 / 淡出）。 */
  dlg.classList.remove('sgx-open');
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
  /* 打开时不让浏览器「滚到焦点」（桌面版网站下会平移 / 放大整页，见 modal-sheet.js showDialog）；已打开时什么都不做 */
  if (!dlg.open) showDialog(dlg, true);
  /* 触发进入动画。两帧后弹层可能已经被关掉（打开后立刻 close()，close 事件已清过类）：关着就不再加 sgx-open，免得关着的弹层留在页面上 */
  dlg.classList.remove('sgx-closing');
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      if (dlg && dlg.open) dlg.classList.add('sgx-open');
    });
  });
}
