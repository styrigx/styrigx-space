/**
 * @fileoverview 通用 bottom sheet / 居中弹窗（替代旧 window.__openSheet/__closeSheet）。
 */
import { on, delegate } from './events.js';

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
/** @type {HTMLElement|null} */ let wrap = null;
/** @type {HTMLElement|null} */ let panel = null;
/** @type {HTMLElement|null} */ let titleEl = null;
/** @type {HTMLElement|null} */ let bodyEl = null;

function ensure() {
  if (inited) return true;
  wrap = document.getElementById('sheet-wrap');
  panel = document.getElementById('sheet-panel');
  titleEl = document.getElementById('sheet-title');
  bodyEl = document.getElementById('sheet-body');
  if (!wrap || !panel || !titleEl || !bodyEl) return false;
  inited = true;
  delegate(wrap, 'click', '[data-sheet-close]', function () {
    closeSheet();
  });
  on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if (e.key === 'Escape' && wrap && !wrap.classList.contains('hidden')) closeSheet();
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
        closeSheet();
      }
    },
    { passive: true }
  );
  return true;
}

/**
 * 关闭 bottom sheet。
 */
export function closeSheet() {
  if (!ensure() || !wrap) return;
  wrap.classList.remove('open');
  wrap.classList.add('closing');
  window.setTimeout(function () {
    if (wrap && !wrap.classList.contains('open')) {
      wrap.classList.remove('closing');
      wrap.classList.add('hidden');
    }
  }, 260);
}

/**
 * 打开 bottom sheet。
 * @param {SheetOpts} opts
 */
export function openSheet(opts) {
  if (!ensure() || !wrap || !titleEl || !bodyEl) return;
  opts = opts || {};
  const w = wrap,
    te = titleEl,
    be = bodyEl;
  w.classList.remove('closing');
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
        closeSheet();
        if (opts.onPick) opts.onPick(o.value);
      });
      be.appendChild(b);
    });
  }
  w.classList.remove('hidden');
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      w.classList.add('open');
    });
  });
}
