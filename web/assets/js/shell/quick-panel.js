/**
 * @fileoverview 顶栏快捷面板（#sgx-qp）：顶栏长条右端滑块图标 .sgx-tb-quick 在顶栏正下方「内嵌展开」（2026-10-20 起不再是弹层）。
 * - 面板在 <main> 最前面，属于正文流：展开时下面的正文整体下移，收起时移回（CSS grid-template-rows 0fr ↔ 1fr，~250ms；
 *   减弱动效 / 系统减少动态效果时立刻到位）。没有遮罩、没有历史哨兵，点面板外面 / 滚动都不收起。
 * - 收起：再点图标、在面板上上滑（竖直拖动 > 40px）、Esc；离开本页（含 bfcache 恢复）一律收起。
 * - 状态：data-state closed / opening / open / closing；图标 aria-expanded 同步（开着时图标保持按下态）。
 * - 焦点：展开后移到第一个磁贴，用户收起（图标 / Esc / 上滑）后回到图标。
 * - 宽度：展开前量出本页内容列里看得见的内容块的左右缘（与卡片同一左右缘），写进 --sgx-qp-l / --sgx-qp-w；开着时窗口变化重量。
 * - 只放设置里已有的项，写法与设置页完全相同（lib/prefs.js、lib/lock-now.js 是两边共用的 setter），
 *   所以面板和设置页写同一个 localStorage key、互相即时同步（features.on 订阅重绘）。
 * - 语言：切到另一种语言（显式 zh / en），replace 到对应语言的同一页（与设置页选语言一致，不留历史）。
 * - 立即锁定：收起面板后弹出与安全页相同的「立即锁定？」确认层。
 */
import { on as featOn } from '../lib/features.js';
import { loadI18n } from '../lib/i18n.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';
import { confirmLockNow } from '../lib/lock-now.js';
import {
  themeMode,
  isDark,
  setTheme,
  toggleFollowSystem,
  palette,
  setPalette,
  fontSize,
  setFontSize,
  layoutPref,
  layoutNarrow,
  setLayout,
  reducedMotionPref,
  setReducedMotion,
  setLang,
} from '../lib/prefs.js';
import { reducedMotion } from '../lib/util.js';

/** 展开 / 收起时长（与 input.css .sgx-qp 的 grid-template-rows transition 一致） */
const QP_MS = 250;
/** 上滑多少像素算「收起」 */
const SWIPE_PX = 40;

export function initQuickPanel() {
  const btn = /** @type {HTMLElement|null} */ (document.querySelector('.sgx-tb-quick'));
  const dlg = /** @type {HTMLElement|null} */ (document.getElementById('sgx-qp'));
  if (!btn || !dlg) return;
  const sheet = /** @type {HTMLElement|null} */ (dlg.querySelector('.sgx-qp-sheet'));
  const T = loadI18n('sgx-i18n-core');
  const en = document.documentElement.lang === 'en';

  /** @param {string} id */
  function tile(id) {
    return /** @type {HTMLElement|null} */ (dlg.querySelector('[data-qp="' + id + '"]'));
  }
  /** 开关磁贴：aria-pressed + 状态文案（开 / 关） @param {string} id @param {boolean} on */
  function paintToggle(id, on) {
    const el = tile(id);
    if (!el) return;
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    const st = el.querySelector('[data-qp-state]');
    if (st) st.textContent = on ? T.t('qpOn') : T.t('qpOff');
  }
  /** @param {string} id @param {string} v @param {boolean} [narrow] */
  function paintSeg(id, v, narrow) {
    dlg.querySelectorAll('[data-qp-seg="' + id + '"] button').forEach(function (b) {
      const bv = b.getAttribute('data-v');
      b.setAttribute('aria-pressed', bv === v ? 'true' : 'false');
      /* 布局：窄屏（< 840px）时 DeX / PC 置灰（与设置页一致，偏好保留，回到大屏再生效） */
      if (id === 'layout') {
        if ((bv === 'dex' || bv === 'pc') && narrow) {
          b.setAttribute('disabled', 'disabled');
          b.setAttribute('title', T.t('qpLargeOnly'));
        } else {
          b.removeAttribute('disabled');
          b.removeAttribute('title');
        }
      }
    });
  }
  function paint() {
    /* 布局 / 字号变了内容列可能跟着变宽变窄：重量一次 */
    measure();
    paintToggle('dark', isDark());
    paintToggle('system', themeMode() === 'system');
    paintToggle('motion', reducedMotionPref());
    const p = palette();
    dlg.querySelectorAll('[data-qp-palette]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-qp-palette') === p ? 'true' : 'false');
    });
    paintSeg('font-size', fontSize());
    paintSeg('layout', layoutPref(), layoutNarrow());
    const lang = tile('lang');
    if (lang) lang.setAttribute('aria-label', T.t('qpLangTo'));
  }

  /* ---- 开合 ---- */
  let state = 'closed';
  let gen = 0;
  /** @type {number|null} */ let timer = null;
  /** 上滑手势刚收起面板：吞掉随后那次 click（免得松手处的磁贴被点中） */
  let swallowClick = false;
  /** @param {string} st */
  function setState(st) {
    state = st;
    dlg.setAttribute('data-state', st);
  }
  function isOpen() {
    return state === 'open' || state === 'opening';
  }
  /**
   * 宽度对齐本页内容列（卡片左右缘）：<main> 里面板后的第一块内容（页面列）里看得见的直接子块的左右并集；
   * 子块都没尺寸（如全网搜索页结果区还空着）时退回页面列的内容盒（去掉左右内边距）。
   */
  function measure() {
    const main = dlg.parentElement;
    let col = /** @type {Element|null} */ (dlg.nextElementSibling);
    while (col && (col.tagName === 'SCRIPT' || col.tagName === 'STYLE' || col.tagName === 'TEMPLATE')) col = col.nextElementSibling;
    if (!main || !col) return;
    const mr = main.getBoundingClientRect();
    let left = Infinity;
    let right = -Infinity;
    for (let i = 0; i < col.children.length; i++) {
      const cr = col.children[i].getBoundingClientRect();
      if (cr.width > 0 && cr.height > 0) {
        left = Math.min(left, cr.left);
        right = Math.max(right, cr.right);
      }
    }
    if (!(right > left)) {
      const r = col.getBoundingClientRect();
      const cs = getComputedStyle(col);
      left = r.left + (parseFloat(cs.paddingLeft) || 0);
      right = r.right - (parseFloat(cs.paddingRight) || 0);
    }
    if (!(right > left)) return;
    dlg.style.setProperty('--sgx-qp-l', Math.round((left - mr.left) * 100) / 100 + 'px');
    dlg.style.setProperty('--sgx-qp-w', Math.round((right - left) * 100) / 100 + 'px');
  }
  function focusFirst() {
    const first = /** @type {HTMLElement|null} */ (dlg.querySelector('.sgx-qp-tile, button, a[href]'));
    if (first) {
      try {
        first.focus({ preventScroll: true });
      } catch (e) {}
    }
  }
  function open() {
    if (isOpen()) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const my = ++gen;
    try {
      paint();
    } catch (e) {}
    dlg.removeAttribute('inert');
    btn.setAttribute('aria-expanded', 'true');
    /* 已经往下滚过：面板在顶栏下的正文最前面，先回到顶部才看得见 */
    if (window.scrollY > 0) {
      try {
        window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
      } catch (e) {
        window.scrollTo(0, 0);
      }
    }
    if (reducedMotion()) {
      dlg.classList.add('is-open');
      setState('open');
      focusFirst();
      return;
    }
    setState('opening');
    /* 先让 visibility 生效、0fr 落定，再加 is-open 才有过渡 */
    void dlg.offsetHeight;
    dlg.classList.add('is-open');
    focusFirst();
    timer = window.setTimeout(function () {
      timer = null;
      if (my === gen) setState('open');
    }, QP_MS);
  }
  function settleClosed() {
    if (timer) clearTimeout(timer);
    timer = null;
    dlg.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    dlg.setAttribute('inert', '');
    setState('closed');
  }
  /**
   * @param {{ focus?: boolean, instant?: boolean }} [o] focus：焦点回到图标；instant：不播收起动画（离开本页）
   */
  function close(o) {
    const opt = o || {};
    if (state === 'closed') return;
    const hadFocus = dlg.contains(document.activeElement);
    if (timer) clearTimeout(timer);
    timer = null;
    const my = ++gen;
    btn.setAttribute('aria-expanded', 'false');
    if (opt.focus || hadFocus) {
      try {
        btn.focus({ preventScroll: true });
      } catch (e) {}
    }
    if (opt.instant || reducedMotion() || !dlg.classList.contains('is-open')) {
      settleClosed();
      return;
    }
    dlg.setAttribute('inert', '');
    dlg.classList.remove('is-open');
    setState('closing');
    timer = window.setTimeout(function () {
      timer = null;
      if (my === gen) settleClosed();
    }, QP_MS);
  }
  setState('closed');

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (isOpen()) close({ focus: true });
    else open();
  });

  /* Esc 收起（别的模态层开着时让给它） */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || !isOpen()) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    close({ focus: true });
  });

  /* 离开本页：收起（bfcache 恢复回来时是收起的） */
  window.addEventListener('pagehide', function () {
    close({ instant: true });
  });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) close({ instant: true });
  });
  window.addEventListener('resize', function () {
    if (state !== 'closed') measure();
  });

  /* 上滑收起：触摸用 touch 事件（页面竖向滚动时 pointer 会被 pointercancel，touch 事件仍会继续来）；鼠标 / 笔用 pointer 事件 */
  if (sheet) {
    /** @type {null | { x: number, y: number }} */
    let start = null;
    /** @param {number} x @param {number} y */
    const end = function (x, y) {
      if (!start) return;
      const dx = x - start.x;
      const dy = y - start.y;
      start = null;
      if (dy < -SWIPE_PX && Math.abs(dy) > Math.abs(dx) && isOpen()) {
        swallowClick = true;
        window.setTimeout(function () {
          swallowClick = false;
        }, 400);
        close({ focus: true });
      }
    };
    sheet.addEventListener('touchstart', function (e) {
      const t = e.touches[0];
      start = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
    }, { passive: true });
    sheet.addEventListener('touchend', function (e) {
      const t = e.changedTouches[0];
      if (t) end(t.clientX, t.clientY);
    }, { passive: true });
    sheet.addEventListener('touchcancel', function () {
      start = null;
    }, { passive: true });
    sheet.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'touch') return;
      end(e.clientX, e.clientY);
    });
  }

  dlg.addEventListener('click', function (e) {
    const t = /** @type {Element|null} */ (e.target);
    if (!t) return;
    if (swallowClick) {
      swallowClick = false;
      e.preventDefault();
      return;
    }
    const tl = /** @type {HTMLElement|null} */ (t.closest('[data-qp]'));
    if (tl) {
      const id = tl.getAttribute('data-qp');
      if (id === 'dark') setTheme(isDark() ? 'light' : 'dark');
      else if (id === 'system') toggleFollowSystem();
      else if (id === 'motion') setReducedMotion(!reducedMotionPref());
      else if (id === 'lang') {
        const url = setLang(en ? 'zh' : 'en');
        close({ instant: true });
        sgxReplace(url);
        return;
      } else if (id === 'lock') {
        close({ focus: true });
        confirmLockNow();
        return;
      }
      paint();
      return;
    }
    const sw = t.closest('[data-qp-palette]');
    if (sw) {
      setPalette(sw.getAttribute('data-qp-palette') || 'lake');
      paint();
      return;
    }
    const sb = /** @type {HTMLButtonElement|null} */ (t.closest('[data-qp-seg] button'));
    if (sb && !sb.disabled) {
      const seg = sb.closest('[data-qp-seg]');
      const id = seg ? seg.getAttribute('data-qp-seg') : '';
      const v = sb.getAttribute('data-v') || '';
      if (id === 'font-size') setFontSize(v);
      else if (id === 'layout') setLayout(v);
      paint();
      return;
    }
    const all = /** @type {HTMLAnchorElement|null} */ (t.closest('a.sgx-qp-all'));
    if (all) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      const href = all.href;
      /* 已经在设置首页：只收起 */
      if (all.pathname === location.pathname) close({ focus: true });
      else {
        close({ instant: true });
        sgxNavigate(href);
      }
    }
  });

  /* 设置页（或别的标签页）改了同一项：面板开着时即时重绘 */
  const repaint = function () {
    if (state !== 'closed') paint();
  };
  ['theme-mode', 'palette', 'font-size', 'layout', 'reduced-motion'].forEach(function (id) {
    featOn(id, repaint);
  });
  window.addEventListener('sgx-theme-changed', repaint);
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener || mq.addListener).call(mq, 'change', function () {
      /* 跟随系统时系统深浅色变了（theme.js 已重应用），等它应用完再重绘 */
      window.setTimeout(repaint, 0);
    });
  } catch (e) {}
}
