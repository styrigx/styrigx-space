/**
 * @fileoverview 顶栏 v4（2026-10-20，全站同一套）：左圆九宫格（导航抽屉）+ 长条（居中 Styrigx / 小标题）+ 右圆头像。
 * - 没有 ‹ 返回和页面 ⋮：页面操作都在正文里（baseof.html 注释里有 PR② 快捷面板图标的预留位置）。
 * - 小标题 .subpage-mini-title 搬进长条，水平垂直居中。
 * - 滚过标题区高度 × 0.55：body 加 sgx-stuck（头像不动，居中的 Styrigx 淡出、小标题淡入）。
 * - 导航抽屉（#sgx-drawer，Gmail Android 式左侧抽屉，<dialog> 模态）：九宫格打开；
 *   点遮罩 / 系统返回 / Esc 关闭。打开时 push 一条同 URL 的历史哨兵，系统返回只关抽屉不离开页面。
 * @param {import('../lib/scheduler.js').Scheduler} [S]
 */
import { getScheduler } from '../lib/scheduler.js';
import { reducedMotion, visibleSubHead } from '../lib/util.js';
import { sgxNavigate } from '../lib/diag-jumptrace.js';

const currentHead = visibleSubHead;

/** 把当前页的小标题同步进顶栏长条 */
function syncTopbar() {
  const pill = document.querySelector('.sgx-tb-pill');
  if (!pill) return;
  /* 小标题：先清掉上一页的，再搬当前页的 */
  pill.querySelectorAll('.subpage-mini-title').forEach(function (m) {
    m.remove();
  });
  const head = currentHead();
  const scope = head && head.parentElement ? head.parentElement : document;
  const mini = scope.querySelector(':scope > .subpage-mini-title') || document.querySelector('main .subpage-mini-title');
  if (mini) pill.appendChild(mini);
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

/** 抽屉滑入 / 滑出时长（与 input.css .sgx-drawer-sheet 的 transition 一致） */
const DRAWER_MS = 220;

function initDrawer() {
  const btn = document.querySelector('.sgx-tb-nav');
  const dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('sgx-drawer'));
  if (!btn || !dlg || typeof dlg.showModal !== 'function') return;
  const sheet = dlg.querySelector('.sgx-drawer-sheet');
  /* 历史里是否有本抽屉的哨兵；关闭时退掉它 */
  let pushed = false;
  /* 正在等哨兵出栈的 popstate：'' = 不在等；'-' = 只关闭；其他 = 关闭后要去的地址 */
  let awaiting = '';
  /** @type {number|null} */ let closeTimer = null;

  function open() {
    if (dlg.open) return;
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    dlg.classList.remove('is-open');
    try {
      dlg.showModal();
    } catch (e) {
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    /* 下一帧再加 is-open，让滑入过渡生效 */
    if (reducedMotion()) dlg.classList.add('is-open');
    else requestAnimationFrame(function () { requestAnimationFrame(function () { dlg.classList.add('is-open'); }); });
    try {
      history.pushState({ sgxDrawer: 1 }, '', location.href);
      pushed = true;
    } catch (e) {
      pushed = false;
    }
  }
  /** 只收界面（滑出后关 <dialog>），不动历史 */
  function hide() {
    btn.setAttribute('aria-expanded', 'false');
    dlg.classList.remove('is-open');
    const done = function () {
      closeTimer = null;
      if (dlg.open && !dlg.classList.contains('is-open')) dlg.close();
    };
    if (closeTimer) clearTimeout(closeTimer);
    if (reducedMotion()) done();
    else closeTimer = window.setTimeout(done, DRAWER_MS);
  }
  /**
   * 关闭抽屉；go 有值时关完再跳转（先退掉哨兵，免得目标页的返回多一步）。
   * @param {string} [go]
   */
  function close(go) {
    if (!dlg.open) {
      if (go) sgxNavigate(go);
      return;
    }
    hide();
    if (pushed) {
      pushed = false;
      awaiting = go || '-';
      history.back();
    } else if (go) {
      sgxNavigate(go);
    }
  }

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (dlg.open) close();
    else open();
  });
  /* 点遮罩（<dialog> 本身、抽屉面板以外的区域）关闭 */
  dlg.addEventListener('click', function (e) {
    const t = /** @type {Element|null} */ (e.target);
    if (!t) return;
    if (sheet && sheet.contains(t)) {
      const a = /** @type {HTMLAnchorElement|null} */ (t.closest ? t.closest('a.sgx-drawer-item') : null);
      if (!a) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      /* 当前页只关闭抽屉 */
      if (a.getAttribute('aria-current') === 'page') close();
      else close(a.href);
      return;
    }
    close();
  });
  /* Esc（原生 cancel）：自己关，带滑出动画并退掉哨兵 */
  dlg.addEventListener('cancel', function (e) {
    e.preventDefault();
    close();
  });
  /* 系统返回：哨兵出栈 → 只关抽屉，停在本页 */
  window.addEventListener('popstate', function () {
    if (awaiting) {
      const go = awaiting;
      awaiting = '';
      if (go !== '-') sgxNavigate(go);
      return;
    }
    if (dlg.open) {
      pushed = false;
      hide();
    }
  });
  /* bfcache 恢复：抽屉一律收起 */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && dlg.open) {
      pushed = false;
      awaiting = '';
      dlg.classList.remove('is-open');
      dlg.close();
      btn.setAttribute('aria-expanded', 'false');
    }
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
  initDrawer();
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
