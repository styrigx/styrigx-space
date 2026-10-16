/**
 * @fileoverview 顶栏与 Dock 系统（旧 sgx-base-b.js）。
 * Mobile 悬浮 Dock、布局 resize 跟随、DeX 应用抽屉。（顶栏时钟/天气/音乐已随顶栏 v2.0 删除）
 */
import { on } from '../lib/events.js';
import { onDexLayoutChange, applyLayout } from './layout.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';

/**
 * @param {import('./scheduler.js').Scheduler} S
 */
export function initNav(S) {
  const en = document.documentElement.lang === 'en';

  /* ===== Mobile 悬浮 Dock：滚动隐藏 + 选中高亮块滑动 ===== */
  (function () {
    const dock = document.getElementById('mobile-dock');
    if (!dock) return;
    const pill = document.getElementById('dock-pill');
    const reduced = function () {
      return document.documentElement.classList.contains('reduced-motion');
    };
    function paintActive() {
      const pg = document.body.getAttribute('data-page');
      const btns = dock.querySelectorAll('.dock-btn');
      /** @type {Element|null} */
      let active = null;
      btns.forEach(function (b) {
        const isOn = b.getAttribute('data-dock') === pg;
        b.classList.toggle('dock-active', isOn);
        if (isOn) active = b;
      });
      if (active && pill) {
        const a = /** @type {HTMLElement} */ (active);
        pill.style.display = '';
        pill.style.left = a.offsetLeft + 6 + 'px';
        pill.style.width = a.offsetWidth - 12 + 'px';
      } else if (pill) {
        pill.style.display = 'none';
      }
    }
    paintActive();
    S.onResize(paintActive);
    /* 滚动时隐藏，停 0.6s 后或滚到底时出现；减弱动效时不隐藏 */
    /** @type {number|null} */
    let t = null;
    const ssBar = document.getElementById('settings-searchbar-wrap');
    function show() {
      dock.classList.remove('dock-hide');
      if (ssBar) ssBar.classList.remove('sgx-hide');
    }
    S.onScroll(function () {
      if (reduced()) return;
      dock.classList.add('dock-hide');
      if (ssBar) ssBar.classList.add('sgx-hide');
      if (t) clearTimeout(t);
      t = window.setTimeout(show, 600);
    });
    /* DeX/PC 模式下确保隐藏（CSS 已处理，这里兜底清状态） */
    onDexLayoutChange(function (m) {
      if (m === 'mobile') paintActive();
    });
  })();

  /* resize 时重算布局（防抖） */
  (function () {
    /** @type {number|null} */
    let rt = null;
    S.onResize(function () {
      if (rt) clearTimeout(rt);
      rt = window.setTimeout(function () {
        applyLayout();
      }, 180);
    });
  })();

  /* ---- 当前页面：DeX Dock 图标下方小圆点 ---- */
  (function () {
    const pg = document.body.getAttribute('data-page');
    if (!pg) return;
    document.querySelectorAll('#dex-dock [data-navpage]').forEach(function (a) {
      if (a.getAttribute('data-navpage') === pg) a.classList.add('dex-dock-active');
    });
  })();

  /* ---- DeX 应用抽屉（底部 Dock 按钮，从 Dock 上方往上展开） ---- */
  (function () {
    const dr = document.getElementById('dex-drawer');
    const btn = document.getElementById('dex-dock-drawer');
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('dex-drawer-search'));
    const grid = document.getElementById('dex-drawer-grid');
    if (!dr || !btn) return;
    function open() {
      dr.classList.remove('hidden');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          dr.classList.add('open');
        });
      });
      window.setTimeout(function () {
        if (input) input.focus();
      }, 80);
    }
    function close() {
      dr.classList.remove('open');
      window.setTimeout(function () {
        if (!dr.classList.contains('open')) dr.classList.add('hidden');
      }, 240);
    }
    on(btn, 'click', function (e) {
      e.stopPropagation();
      if (dr.classList.contains('open')) close();
      else open();
    });
    dr.querySelectorAll('[data-dex-drawer-close]').forEach(function (el) {
      on(el, 'click', close);
    });
    on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Escape' && dr.classList.contains('open')) close();
    });
    if (input)
      on(input, 'input', function () {
        const q = input.value.trim().toLowerCase();
        if (grid)
          grid.querySelectorAll('a').forEach(function (a) {
            a.style.display = !q || (a.dataset.name || '').toLowerCase().indexOf(q) !== -1 ? '' : 'none';
          });
      });
    /* 抽屉内跳转：主页用普通跳转，子页面用 replace（与 Dock 一致） */
    if (grid)
      on(grid, 'click', function (/** @type {MouseEvent} */ e) {
        const t = /** @type {Element|null} */ (e.target);
        const a = t && t.closest ? /** @type {HTMLAnchorElement|null} */ (t.closest('a[href]')) : null;
        if (!a || a.target === '_blank') return;
        const p = location.pathname;
        const isHome = p === '/' || p === '/en' || p === '/en/';
        if (isHome) return;
        e.preventDefault();
        sgxReplace(a.getAttribute('href') || '/', 'nav.js:303', 'home-grid');
      });
    /* 离开 DeX/PC 模式时关闭抽屉 */
    onDexLayoutChange(function (m) {
      if (m !== 'dex' && m !== 'pc') close();
    });
  })();
}
