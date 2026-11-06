/* @sgx-shell:begin styrigx/styrigx-space@tree:32a9f7169288 space/web/shared/shell va5bce8668afd（space/scripts/daymark/sync-shell.mjs 写入，勿手改） */
/* ---- topbar.js ---- */
/**
 * @fileoverview 顶栏的两个弹出窗口：快捷面板 #sgx-qp（两页：导航 / 快捷设置）和 AI 窗口 #sgx-ai（2026-11-04 P5-1，方案 5.5 / 6.3–6.5）。
 * 共享外壳组件：gen-shell 原样复制成 space/web/shared/shell/topbar.js，四个站共用（主站 shell/quick-panel.js 调它，子站入口脚本调它）。
 * 自成一体：不 import 任何东西；状态机（modal-sheet.js）、外观 setter（主站 lib/prefs.js / 子站 prefs-write.js）、AI 内容（ai.js）、
 * 分享（share.js）、键盘高度订阅（vk.js 的 onKeyboardHeight，转给 AI 窗口；P4-3 PR-3）都由调用方传进来。
 *
 * - 两个窗口都是非模态 <dialog>（modalSheet modal:false → show()）：从顶栏下方落下，顶栏留在上面可点；开合 / 系统返回 / Esc / bfcache 走 modalSheet。
 * - 互斥：一个开着时点顶栏上别的东西（另一个窗口的图标、logo、头像、标签），先关这个（等哨兵出栈）再补点那一下。
 * - 点遮罩（面板以外）关闭；焦点打开时进面板，关上时还给图标；Tab / Shift+Tab 圈在「图标 + 面板控件」里。
 * - 快捷面板两页：顶部两个页签（role=tablist，点 / 左右键 / Home / End 切），下面横向 scroll-snap 左右滑；不在当前页的那页 inert（不进 Tab、读屏）。
 *   每次打开默认在第 1 页「导航」（它取代九宫格）。导航项：当前站只关面板，别的站关完再跳（不留哨兵）。
 * - 快捷设置页磁贴：深色 / 跟随系统 / 语言 / 立即锁定（主站）/ 分享本页（子站内容页）+ 调色板 + 布局（主站）；哪些有由模板决定（tiles 参数）。
 */

const QP_MS = 240;
const STR = {
  zh: { on: '开', off: '关', langTo: '语言：中文。点按切换为 English', largeOnly: '仅在大屏生效' },
  en: { on: 'On', off: 'Off', langTo: 'Language: English. Tap to switch to 中文', largeOnly: 'Large screens only' },
};

/**
 * @typedef {Object} TopbarPrefs
 * @property {() => boolean} isDark
 * @property {() => string} themeMode
 * @property {(m: 'light'|'dark'|'system') => void} setTheme
 * @property {() => void} toggleFollowSystem
 * @property {() => string} palette
 * @property {(p: string) => void} setPalette
 * @property {string} DEFAULT_PALETTE
 * @property {() => boolean} hasAccent
 * @property {(v: 'zh'|'en') => string} setLang 写语言偏好，返回要去的地址；返回 '' 时用磁贴 data-href
 * @property {() => string} [layoutPref]
 * @property {() => boolean} [layoutNarrow]
 * @property {(v: string) => void} [setLayout]
 */

/**
 * @param {{
 *   modalSheet: Function,
 *   prefs: TopbarPrefs,
 *   onLock?: () => void,
 *   navigate?: (url: string) => void,
 *   replace?: (url: string) => void,
 *   ai?: (dlg: HTMLDialogElement, o: { lang: 'zh'|'en', close: Function, navigate: Function, keyboard?: Function }) => ({ onOpen?: () => void } | void),
 *   keyboard?: (cb: (h: number) => void) => () => void,
 *   share?: (cfg: { button: Element }) => any,
 *   subscribe?: (repaint: () => void) => void,
 *   doc?: Document,
 * }} o
 */
export function mountTopbar(o) {
  const doc = o.doc || document;
  const topbar = doc.querySelector('#site-nav .sgx-topbar');
  const qpBtn = /** @type {HTMLElement|null} */ (doc.querySelector('.sgx-tb-quick'));
  const qpDlg = /** @type {HTMLDialogElement|null} */ (doc.getElementById('sgx-qp'));
  const aiBtn = /** @type {HTMLElement|null} */ (doc.querySelector('.sgx-tb-ai'));
  const aiDlg = /** @type {HTMLDialogElement|null} */ (doc.getElementById('sgx-ai'));
  const en = doc.documentElement.lang === 'en';
  const t = en ? STR.en : STR.zh;
  const navigate = o.navigate || function (/** @type {string} */ u) { location.href = u; };
  const replace = o.replace || function (/** @type {string} */ u) { location.replace(u); };
  /** @type {any[]} */
  const sheets = [];

  /** 一个顶栏窗口的通用接线：开合、互斥、遮罩、Tab 圈、焦点归还 @param {HTMLElement} btn @param {HTMLDialogElement} dlg @param {string} key @param {() => void} onOpen */
  function wire(btn, dlg, key, onOpen) {
    if (typeof dlg.show !== 'function') return null;
    const sheet = /** @type {HTMLElement|null} */ (dlg.querySelector('.sgx-qp-sheet'));
    const ms = o.modalSheet(dlg, btn, {
      ms: QP_MS,
      stateKey: key,
      modal: false,
      onOpen: onOpen,
      onClosed: function () {
        const a = doc.activeElement;
        if (!a || a === doc.body || dlg.contains(a)) {
          try { btn.focus({ preventScroll: true }); } catch (e) {}
        }
      },
    });
    const me = { btn, dlg, ms };
    sheets.push(me);
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (ms.isOpen()) ms.close();
      else ms.open();
    });
    dlg.addEventListener('click', function (e) {
      const tg = /** @type {Element|null} */ (e.target);
      if (tg && (!sheet || !sheet.contains(tg))) ms.close();
    });
    /* Tab 圈在「图标 + 面板控件」里（非模态不会 inert 页面，自己圈住）；
       不在 Tab 顺序里的不算：inert 的那页、tabindex=-1 的（两页的页签是 roving tabindex，只有当前页签可 Tab 到） */
    doc.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || !ms.isShown()) return;
      const list = [btn].concat(Array.from(dlg.querySelectorAll('a[href], button:not([disabled]), textarea, input')).filter(function (el) {
        return /** @type {HTMLElement} */ (el).offsetParent !== null && !el.closest('[inert]') && /** @type {HTMLElement} */ (el).tabIndex >= 0;
      }));
      const i = list.indexOf(/** @type {HTMLElement} */ (doc.activeElement));
      const n = list.length;
      const next = i < 0 ? (e.shiftKey ? n - 1 : 1 % n) : (i + (e.shiftKey ? n - 1 : 1)) % n;
      e.preventDefault();
      try { /** @type {HTMLElement} */ (list[next]).focus(); } catch (err) {}
    });
    return me;
  }

  /* 开着时点顶栏上别的东西（另一个窗口的图标也算）：先关，等哨兵出栈再补点一下，免得跳转和 history.back() 打架。
     补点放到下一个任务里：哨兵出栈的 popstate 还要派给另一个窗口的 modalSheet 监听，同一个事件里先把另一个窗口打开，
     它自己的 popstate 监听会把刚打开的窗口当成「系统返回」立刻关掉 */
  if (topbar) {
    topbar.addEventListener('click', function (e) {
      const open = sheets.find(function (s) { return s.ms.isShown(); });
      if (!open) return;
      const tg = /** @type {Element|null} */ (e.target);
      if (!tg || open.btn.contains(tg)) return;
      e.preventDefault();
      e.stopPropagation();
      const act = /** @type {HTMLElement|null} */ (tg.closest('a[href], button'));
      open.ms.close(act ? function () { window.setTimeout(function () { act.click(); }, 0); } : undefined);
    }, true);
  }

  /* ---------------- 快捷面板 ---------------- */
  let qp = null;
  let paint = function () {};
  if (qpBtn && qpDlg) {
    const tabs = /** @type {HTMLElement[]} */ (Array.from(qpDlg.querySelectorAll('[data-qp-tab]')));
    const pages = /** @type {HTMLElement[]} */ (Array.from(qpDlg.querySelectorAll('[data-qp-page]')));
    const pager = /** @type {HTMLElement|null} */ (qpDlg.querySelector('[data-qp-pages]'));
    let cur = 0;
    const reduce = function () {
      return doc.documentElement.classList.contains('reduced-motion') || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    };
    /** @param {number} i @param {{scroll?: boolean, smooth?: boolean, focus?: boolean}} [opt] */
    const select = function (i, opt) {
      const op = opt || {};
      cur = Math.max(0, Math.min(pages.length - 1, i));
      tabs.forEach(function (b, k) {
        b.setAttribute('aria-selected', k === cur ? 'true' : 'false');
        b.setAttribute('tabindex', k === cur ? '0' : '-1');
      });
      pages.forEach(function (p, k) {
        if (k === cur) p.removeAttribute('inert');
        else p.setAttribute('inert', '');
      });
      if (op.scroll !== false && pager) {
        const left = cur * pager.clientWidth;
        try { pager.scrollTo({ left: left, behavior: op.smooth && !reduce() ? 'smooth' : 'auto' }); } catch (e) { pager.scrollLeft = left; }
      }
      if (op.focus && tabs[cur]) { try { tabs[cur].focus(); } catch (e) {} }
    };
    tabs.forEach(function (b, k) {
      b.addEventListener('click', function () { select(k, { smooth: true }); });
      b.addEventListener('keydown', function (e) {
        let n = -1;
        if (e.key === 'ArrowRight') n = (k + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') n = (k - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = tabs.length - 1;
        if (n < 0) return;
        e.preventDefault();
        select(n, { smooth: true, focus: true });
      });
    });
    /* 手指滑：滑停后按位置定页（scrollend；不支持的浏览器用 scroll + 短延时） */
    if (pager) {
      let st = 0;
      const settle = function () {
        const w = pager.clientWidth || 1;
        const i = Math.round(pager.scrollLeft / w);
        if (i !== cur) select(i, { scroll: false });
      };
      pager.addEventListener('scroll', function () { clearTimeout(st); st = window.setTimeout(settle, 120); }, { passive: true });
      pager.addEventListener('scrollend', settle);
    }

    const P = o.prefs;
    /** @param {string} id */
    const tile = function (id) { return /** @type {HTMLElement|null} */ (qpDlg.querySelector('[data-qp="' + id + '"]')); };
    /** @param {string} id @param {boolean} on */
    const paintToggle = function (id, on) {
      const el = tile(id);
      if (!el) return;
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      const s = el.querySelector('[data-qp-state]');
      if (s) s.textContent = on ? t.on : t.off;
    };
    paint = function () {
      paintToggle('dark', P.isDark());
      paintToggle('system', P.themeMode() === 'system');
      const p = P.palette();
      qpDlg.querySelectorAll('[data-qp-palette]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-qp-palette') === p ? 'true' : 'false');
      });
      const rs = qpDlg.querySelector('[data-qp-reset]');
      if (rs) rs.setAttribute('aria-disabled', p === P.DEFAULT_PALETTE && !P.hasAccent() ? 'true' : 'false');
      if (P.layoutPref) {
        const v = P.layoutPref();
        const narrow = P.layoutNarrow ? P.layoutNarrow() : false;
        qpDlg.querySelectorAll('[data-qp-seg="layout"] button').forEach(function (b) {
          const bv = b.getAttribute('data-v');
          b.setAttribute('aria-pressed', bv === v ? 'true' : 'false');
          /* 不够 DeX（宽 < 840 或高 < 500）时 DeX 置灰（与设置页一致，偏好保留，回到大屏再生效） */
          if (bv === 'dex' && narrow) { b.setAttribute('disabled', 'disabled'); b.setAttribute('title', t.largeOnly); }
          else { b.removeAttribute('disabled'); b.removeAttribute('title'); }
        });
      }
      const lang = tile('lang');
      if (lang) lang.setAttribute('aria-label', t.langTo);
    };

    qp = wire(qpBtn, qpDlg, 'sgxQp', function () {
      select(0, { scroll: true });
      paint();
    });
    if (qp) {
      const ms = qp.ms;
      const shareTile = tile('share');
      if (shareTile && o.share) o.share({ button: shareTile });
      qpDlg.addEventListener('click', function (e) {
        const tg = /** @type {Element|null} */ (e.target);
        if (!tg) return;
        const nav = /** @type {HTMLAnchorElement|null} */ (tg.closest('a.sgx-qp-nav-item'));
        if (nav) {
          if (e.defaultPrevented || /** @type {MouseEvent} */ (e).button !== 0 || /** @type {MouseEvent} */ (e).metaKey || /** @type {MouseEvent} */ (e).ctrlKey || /** @type {MouseEvent} */ (e).shiftKey || /** @type {MouseEvent} */ (e).altKey) return;
          e.preventDefault();
          if (nav.getAttribute('aria-current') === 'page') ms.close();
          else {
            const href = nav.href;
            ms.close(function () { navigate(href); });
          }
          return;
        }
        const tl = /** @type {HTMLElement|null} */ (tg.closest('[data-qp]'));
        if (tl) {
          const id = tl.getAttribute('data-qp');
          if (id === 'share') return; /* share.js 自己接这一下 */
          if (id === 'dark') P.setTheme(P.isDark() ? 'light' : 'dark');
          else if (id === 'system') P.toggleFollowSystem();
          else if (id === 'lang') {
            const url = P.setLang(en ? 'zh' : 'en') || tl.getAttribute('data-href') || '';
            ms.close(function () { if (url) replace(url); });
            return;
          } else if (id === 'lock') {
            ms.close(o.onLock);
            return;
          }
          paint();
          return;
        }
        const rs = tg.closest('[data-qp-reset]');
        if (rs) {
          if (rs.getAttribute('aria-disabled') !== 'true') P.setPalette(P.DEFAULT_PALETTE);
          paint();
          return;
        }
        const sw = tg.closest('[data-qp-palette]');
        if (sw) {
          P.setPalette(sw.getAttribute('data-qp-palette') || P.DEFAULT_PALETTE);
          paint();
          return;
        }
        const sb = /** @type {HTMLButtonElement|null} */ (tg.closest('[data-qp-seg] button'));
        if (sb && !sb.disabled) {
          const seg = sb.closest('[data-qp-seg]');
          if (seg && seg.getAttribute('data-qp-seg') === 'layout' && P.setLayout) P.setLayout(sb.getAttribute('data-v') || '');
          paint();
        }
      });
      const repaint = function () { if (ms.isOpen()) paint(); };
      if (o.subscribe) o.subscribe(repaint);
      window.addEventListener('sgx-theme-changed', repaint);
      try {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        (mq.addEventListener || mq.addListener).call(mq, 'change', function () { window.setTimeout(repaint, 0); });
      } catch (e) {}
    }
  }

  /* ---------------- AI 窗口 ---------------- */
  let ai = null;
  if (aiBtn && aiDlg) {
    /** @type {any} */
    let chat = null;
    ai = wire(aiBtn, aiDlg, 'sgxAi', function () {
      if (!chat && o.ai) chat = o.ai(aiDlg, { lang: en ? 'en' : 'zh', close: function (/** @type {any} */ after) { if (ai) ai.ms.close(after); }, navigate: navigate, keyboard: o.keyboard }) || {};
      if (chat && chat.onOpen) chat.onOpen();
    });
  }

  return { qp: qp && qp.ms, ai: ai && ai.ms, paint: paint };
}
/* @sgx-shell:end */
