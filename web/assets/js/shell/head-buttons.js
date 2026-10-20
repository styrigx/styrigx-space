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

/*
 * 抽屉状态机（dlg.dataset.state）：closed → opening → open → closing → closed。
 * 开合只靠我们自己的计时器推进（不等 transitionend：减弱动效 / 后台标签页 / 过渡被打断时它可能永远不来），
 * 每次开 / 关都换一代 gen，上一代没跑完的 rAF / 计时器一律作废——
 * 以前「刚点开（is-open 还在等两帧 rAF）就按 Esc」时，迟到的 rAF 会把 is-open 加回去，
 * 关闭计时器看到 is-open 就不关 <dialog>，抽屉卡在打开状态（CI 偶发）。
 */
function initDrawer() {
  const btn = document.querySelector('.sgx-tb-nav');
  const dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('sgx-drawer'));
  if (!btn || !dlg || typeof dlg.showModal !== 'function') return;
  const sheet = dlg.querySelector('.sgx-drawer-sheet');
  /* 历史里是否有本抽屉的哨兵；关闭时退掉它 */
  let pushed = false;
  /* 正在等哨兵出栈的 popstate：'' = 不在等；'-' = 只关闭；其他 = 关闭后要去的地址 */
  let awaiting = '';
  /* 开合代数：每次 open / hide 加一，旧代的回调看到代数变了就什么都不做 */
  let gen = 0;
  /** @type {number[]} */ let rafs = [];
  /** @type {number|null} */ let timer = null;

  /** @param {string} st */
  function setState(st) {
    dlg.setAttribute('data-state', st);
  }
  function cancelPending() {
    for (let i = 0; i < rafs.length; i++) cancelAnimationFrame(rafs[i]);
    rafs = [];
    if (timer) clearTimeout(timer);
    timer = null;
  }
  /** 收尾成「已关」：同步 class / aria / 状态；<dialog> 还开着就关掉 */
  function settleClosed() {
    cancelPending();
    dlg.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    setState('closed');
    if (dlg.open) dlg.close();
  }
  setState('closed');

  function open() {
    if (dlg.open) return;
    cancelPending();
    const my = ++gen;
    dlg.classList.remove('is-open');
    try {
      dlg.showModal();
    } catch (e) {
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    const shown = function () {
      if (my !== gen) return;
      dlg.classList.add('is-open');
      if (reducedMotion()) {
        setState('open');
        return;
      }
      timer = window.setTimeout(function () {
        timer = null;
        if (my === gen) setState('open');
      }, DRAWER_MS);
    };
    setState('opening');
    /* 下一帧再加 is-open，让滑入过渡生效；减弱动效直接到位 */
    if (reducedMotion()) shown();
    else rafs.push(requestAnimationFrame(function () { rafs.push(requestAnimationFrame(shown)); }));
    try {
      history.pushState({ sgxDrawer: 1 }, '', location.href);
      pushed = true;
    } catch (e) {
      pushed = false;
    }
  }
  /** 只收界面（滑出后关 <dialog>），不动历史 */
  function hide() {
    cancelPending();
    const my = ++gen;
    btn.setAttribute('aria-expanded', 'false');
    /* 还没真正滑出来（opening 且 is-open 没加上）或减弱动效：没有可等的滑出，直接关 */
    const slid = dlg.classList.contains('is-open');
    dlg.classList.remove('is-open');
    if (!dlg.open || !slid || reducedMotion()) {
      settleClosed();
      return;
    }
    setState('closing');
    timer = window.setTimeout(function () {
      timer = null;
      if (my === gen) settleClosed();
    }, DRAWER_MS);
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
  /* <dialog> 被我们以外的途径关掉（浏览器连按 Esc 时可能无视 preventDefault 强关）：同步状态并退掉哨兵 */
  dlg.addEventListener('close', function () {
    if (dlg.getAttribute('data-state') === 'closed') return;
    gen++;
    settleClosed();
    if (pushed) {
      pushed = false;
      awaiting = '-';
      history.back();
    }
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
      gen++;
      settleClosed();
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
