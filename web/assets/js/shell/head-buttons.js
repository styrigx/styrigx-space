/**
 * @fileoverview 顶栏 v2.0（与 Book 同一套）：左圆（子页面返回 / 主页搜索）+ 长条（头像 + 居中 Styrigx + ⋮）+ 导航圆。
 * - 子页面标题区不再有 ← 和 ⋮。页面自己的 ⋮（如 #files-more、#sec-more）作为来源隐藏输出，
 *   这里把它搬进长条替换默认 ⋮（同一个节点，页面脚本按 id 绑定的监听不受影响）。
 * - 小标题 .subpage-mini-title 搬进长条，水平垂直居中。
 * - 滚过标题区高度 × 0.55：body 加 sgx-stuck（头像不动，居中的 Styrigx 淡出、小标题淡入）。
 * - 九宫点导航菜单：配置数组，当前站点高亮 + ✓；点外部 / Esc / 返回手势关闭。
 * @param {import('../lib/scheduler.js').Scheduler} [S]
 */
import { getScheduler } from '../lib/scheduler.js';
import { reducedMotion, visibleSubHead } from '../lib/util.js';
import { sgxNavigate } from '../lib/diag-jumptrace.js';

const currentHead = visibleSubHead;

/** 菜单：fixed，锚定在按钮下方 8px、右沿与按钮右沿对齐 */
/** @param {HTMLElement} menu @param {Element} btn */
function anchorMenu(menu, btn) {
  const r = btn.getBoundingClientRect();
  menu.style.top = r.bottom + 8 + 'px';
  /* 按钮在左半边（主页的九宫格）就左对齐，否则右对齐 */
  if (r.left + r.width / 2 < window.innerWidth / 2) {
    menu.style.left = Math.max(16, r.left) + 'px';
    menu.style.right = 'auto';
  } else {
    menu.style.right = Math.max(16, window.innerWidth - r.right) + 'px';
    menu.style.left = 'auto';
  }
}

/** @type {HTMLElement|null} */
let defaultMore = null;

/** 把当前页的 ⋮ 和小标题同步进顶栏长条 */
function syncTopbar() {
  const pill = document.querySelector('.sgx-tb-pill');
  if (!pill) return;
  if (!defaultMore) defaultMore = /** @type {HTMLElement|null} */ (pill.querySelector('.sgx-tb-more'));
  /* 小标题：先清掉上一页的，再搬当前页的 */
  pill.querySelectorAll('.subpage-mini-title').forEach(function (m) {
    m.remove();
  });
  const head = currentHead();
  const scope = head && head.parentElement ? head.parentElement : document;
  const mini = scope.querySelector(':scope > .subpage-mini-title') || document.querySelector('main .subpage-mini-title');
  if (mini) pill.appendChild(mini);
  /* ⋮：页面有自己的按钮就用它，没有就用默认按钮（点了无反应）；主页长条里没有 ⋮ */
  const cur = pill.querySelector('.sgx-tb-more');
  const src = head ? head.querySelector('[data-tb-more] button') : null;
  const want = src || defaultMore;
  if (want && cur !== want) {
    if (cur) cur.replaceWith(want);
    else pill.appendChild(want);
  }
  measureStuck();
  stuck = document.body.classList.contains('sgx-stuck');
  updateStuck();
}

/* 阈值 = 标题区高度 × 0.55：只在换页 / 尺寸变化时量一次，滚动时不再查 DOM、不读布局 */
let stuckAt = Infinity;
let stuck = false;
/** @type {ResizeObserver|null} */ let headRO = null;
/** @type {Element|null} */ let headObserved = null;
function measureStuck() {
  const head = currentHead();
  stuckAt = head ? head.offsetHeight * 0.55 : Infinity;
  /* 标题区高度会在字体加载 / 换行后变化，盯住它，而不是每帧去量 */
  if (head !== headObserved && typeof ResizeObserver === 'function') {
    if (!headRO) {
      headRO = new ResizeObserver(function () {
        const h = currentHead();
        stuckAt = h ? h.offsetHeight * 0.55 : Infinity;
        updateStuck();
      });
    }
    if (headObserved) headRO.unobserve(headObserved);
    if (head) headRO.observe(head);
    headObserved = head;
  }
}
/** @param {number} [y] */
function updateStuck(y) {
  const past = (y == null ? window.scrollY || 0 : y) > stuckAt;
  if (past === stuck) return;
  stuck = past;
  document.body.classList.toggle('sgx-stuck', past);
}

function initNavMenu() {
  const btn = document.querySelector('.sgx-tb-nav');
  const menu = /** @type {HTMLElement|null} */ (document.getElementById('sgx-tb-navmenu'));
  if (!btn || !menu) return;
  const isEn = document.documentElement.lang === 'en';
  const host = location.host;
  /* 菜单项配置：以后新增子站只需加一行 */
  const items = [
    { label: isEn ? 'Main Site' : '主站', url: 'https://styrigx.com' + (isEn ? '/en/' : '/'), match: /^(www\.)?styrigx\.com$|^localhost|^127\.0\.0\.1/ },
    { label: isEn ? 'Library' : '书库', url: 'https://book.styrigx.com' + (isEn ? '/en/' : '/'), match: /(^|\.)book\.styrigx\.com$/ },
    { label: isEn ? 'Blog' : '博客', url: 'https://blog.styrigx.com' + (isEn ? '/en/' : '/'), match: /(^|\.)blog\.styrigx\.com$/ },
  ];
  /** @param {{match: RegExp}} it */
  function isCurrent(it) {
    try {
      return it.match.test(host);
    } catch (e) {
      return false;
    }
  }
  const CHECK =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
  function render() {
    if (!menu) return;
    menu.innerHTML = items
      .map(function (it, i) {
        const cur = isCurrent(it);
        return (
          '<button type="button" class="sgx-tb-menu-item" role="menuitem" data-nav-i="' + i + '"' +
          (cur ? ' aria-current="true"' : '') + '><span>' + it.label + '</span>' + (cur ? CHECK : '') + '</button>'
        );
      })
      .join('');
  }
  function open() {
    if (!menu || !btn) return;
    render();
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    anchorMenu(menu, btn);
  }
  function close() {
    if (!menu || !btn) return;
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) open();
    else close();
  });
  menu.addEventListener('click', function (e) {
    const t = /** @type {Element|null} */ (e.target);
    const el = t && t.closest ? t.closest('[data-nav-i]') : null;
    if (!el) return;
    const it = items[Number(el.getAttribute('data-nav-i'))];
    close();
    if (!it || isCurrent(it)) return; /* 当前站点只关闭菜单 */
    sgxNavigate(it.url);
  });
  document.addEventListener('click', function (e) {
    const t = /** @type {Element|null} */ (e.target);
    if (!menu.classList.contains('hidden') && t && !t.closest('#sgx-tb-navmenu') && !t.closest('.sgx-tb-nav')) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menu.classList.contains('hidden')) close();
  });
  window.addEventListener('popstate', close);
  getScheduler().onScroll(function () {
    if (!menu.classList.contains('hidden')) anchorMenu(menu, btn);
  });
}

/* 头像（#nav-brand）链到主页。已经在主页时再点不重新加载整页（三星浏览器会露出半成品的一帧），
   只平滑回到顶部；在子页面照常跳主页。 */
function initBrand() {
  const brand = /** @type {HTMLAnchorElement|null} */ (document.getElementById('nav-brand'));
  if (!brand) return;
  brand.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    let target;
    try {
      target = new URL(brand.href, location.href);
    } catch (err) {
      return;
    }
    if (target.origin !== location.origin || target.pathname !== location.pathname) return;
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  });
}

export function initHeadButtons(S) {
  const sched = S || getScheduler();
  syncTopbar();
  initNavMenu();
  initBrand();
  sched.onScroll(function (y) {
    updateStuck(y);
  });
  sched.onResize(function () {
    measureStuck();
    updateStuck();
  });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) {
      measureStuck();
      updateStuck();
    }
  });
}
