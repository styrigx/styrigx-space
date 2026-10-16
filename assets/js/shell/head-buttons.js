/**
 * @fileoverview 顶栏 v2.0（与 Book 同一套）：返回圆 + 长条（品牌组 + ⋮）+ 导航圆。
 * - 子页面标题区不再有 ← 和 ⋮。页面自己的 ⋮（如 #files-more、#sec-more）作为来源隐藏输出，
 *   这里把它搬进长条替换默认 ⋮（同一个节点，页面脚本按 id 绑定的监听不受影响）。
 * - 小标题 .subpage-mini-title 搬进长条，水平垂直居中。
 * - 滚过标题区高度 × 0.55：body 加 sgx-stuck（品牌组淡出）。
 * - 九宫点导航菜单：配置数组，当前站点高亮 + ✓；点外部 / Esc / 返回手势关闭。
 * - 页内导航（inpagenav.js）换完 <main> 后调用 syncTopbar() 重新同步。
 * @param {import('../lib/scheduler.js').Scheduler} [S]
 */
import { getScheduler } from '../lib/scheduler.js';

/** @param {Element} el */
function isVisible(el) {
  try {
    return el.getClientRects().length > 0;
  } catch (e) {
    return false;
  }
}

/** 当前可见的标题区（设置页手机/DeX 各有一份，只取可见那份） */
function currentHead() {
  const heads = document.querySelectorAll('[data-subpage-head]');
  for (let i = 0; i < heads.length; i++) {
    if (isVisible(heads[i])) return /** @type {HTMLElement} */ (heads[i]);
  }
  return heads.length ? /** @type {HTMLElement} */ (heads[0]) : null;
}

/** 菜单：fixed，锚定在按钮下方 8px、右沿与按钮右沿对齐 */
/** @param {HTMLElement} menu @param {Element} btn */
export function anchorMenu(menu, btn) {
  const r = btn.getBoundingClientRect();
  menu.style.top = r.bottom + 8 + 'px';
  menu.style.right = Math.max(16, window.innerWidth - r.right) + 'px';
  menu.style.left = 'auto';
}

/** @type {HTMLElement|null} */
let defaultMore = null;

/** 把当前页的 ⋮ 和小标题同步进顶栏长条 */
export function syncTopbar() {
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
  /* ⋮：页面有自己的按钮就用它，没有就用默认按钮（点了无反应） */
  const cur = pill.querySelector('.sgx-tb-more');
  const src = head ? head.querySelector('[data-tb-more] button') : null;
  const want = src || defaultMore;
  if (want && cur !== want) {
    if (cur) cur.replaceWith(want);
    else pill.appendChild(want);
  }
  updateStuck();
}

function updateStuck() {
  const head = currentHead();
  const y = window.scrollY || 0;
  const past = !!head && y > head.offsetHeight * 0.55;
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
    { label: isEn ? 'Home' : '主页', url: 'https://styrigx.com' + (isEn ? '/en/' : '/'), match: /^(www\.)?styrigx\.com$|^localhost|^127\.0\.0\.1/ },
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
    location.href = it.url;
  });
  document.addEventListener('click', function (e) {
    const t = /** @type {Element|null} */ (e.target);
    if (!menu.classList.contains('hidden') && t && !t.closest('#sgx-tb-navmenu') && !t.closest('.sgx-tb-nav')) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menu.classList.contains('hidden')) close();
  });
  window.addEventListener('popstate', close);
  window.addEventListener('scroll', function () {
    if (!menu.classList.contains('hidden')) anchorMenu(menu, btn);
  }, { passive: true });
}

export function initHeadButtons(S) {
  const sched = S || getScheduler();
  syncTopbar();
  initNavMenu();
  sched.onScroll(updateStuck);
  sched.onResize(updateStuck);
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) updateStuck();
  });
}
