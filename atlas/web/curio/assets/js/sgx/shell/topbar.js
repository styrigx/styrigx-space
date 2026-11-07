/* @sgx-shell:begin styrigx/styrigx-space@tree:1ea51934348e space/web/shared/shell v6bce976ea2c7（space/scripts/curio/sync-shell.mjs 写入，勿手改） */
/* ---- topbar.js ---- */
/**
 * @fileoverview 顶栏的三个弹出窗口：导航面板 #sgx-nav（九宫格）、快捷面板 #sgx-qp（快捷设置）、AI 窗口 #sgx-ai（2026-11-04 P5-1；P4-3 PR-4b Gray 2026-11-07 定稿）。
 * 共享外壳组件：gen-shell 原样复制成 space/web/shared/shell/topbar.js，四个站共用（主站 shell/quick-panel.js 调它，子站入口脚本调它）。
 * 自成一体：不 import 任何东西；状态机（modal-sheet.js）、外观 setter（主站 lib/prefs.js / 子站 prefs-write.js）、AI 内容（ai.js）、
 * 分享（share.js）、键盘高度订阅（vk.js 的 onKeyboardHeight，转给 AI 窗口；P4-3 PR-3）都由调用方传进来。
 *
 * - 三个窗口都是非模态 <dialog>（modalSheet modal:false → show()）：从顶栏下方落下，顶栏留在上面可点；开合 / 系统返回 / Esc / bfcache 走 modalSheet。
 * - 互斥：一个开着时点顶栏上别的东西（另一个窗口的图标、logo、页名），先关这个（等哨兵出栈）再补点那一下。
 * - 点遮罩（面板以外）关闭；焦点打开时进面板，关上时还给图标；Tab / Shift+Tab 圈在「图标 + 面板控件」里。
 * - 导航面板：2×2 站点磁贴（当前站「开」态）；已在当前站首页时点它只关面板，其余（别的站、本站子页点本站）关完再跳（不留哨兵）。
 * - 快捷面板只有一页（PR-4b 去掉「导航 | 快捷设置」分段和双页滑动），四站完全相同：
 *   磁贴 深色 / 跟随系统 / 分享本页（share.js）/ 立即锁定；语言整行（点开行内展开单选 跟随系统 / 中文 / English，选中即保存，
 *   换了语言就去另一种语言的同一页）；调色板；布局（手机 / 自动 / 桌面，模式规则见共享外壳 layout-mode.js；三档任何时候都能选）。
 * - 立即锁定：调用方传 onLock（主站：确认层 auth/lock-now.js）；不传（子站）= 磁贴上点两下确认（第一下状态字变「再点一下锁定」，3 秒内再点），
 *   POST /api/lock-now（同源网关）后回到锁屏 /?lock=1。
 */

const QP_MS = 240;
/** 英文底（源文本，没有页面字符串表时用）；页面上以 #sgx-i18n-shell 的 topbar 节为准——已是「英文 ← 页面语言」的合并，缺键回退英文（语言包化 2026-11-07） */
const STR_EN = {
  on: "On",
  off: "Off",
  auto: "Auto",
  phone: "Phone",
  desktop: "Desktop",
  sys: "Follow system",
  lockArm: "Tap again to lock",
  lockBack: "Back to lock screen",
  lockFail: "Couldn’t lock. Check your connection."
};
/** @param {Document} doc @returns {Record<string, string>} */
function shellStr(doc) {
  /** @type {Record<string, string>} */
  let page = {};
  try {
    const el = doc && doc.getElementById ? doc.getElementById('sgx-i18n-shell') : null;
    const o = el && el.textContent ? JSON.parse(el.textContent) : null;
    if (o && o.topbar && typeof o.topbar === 'object') page = o.topbar;
  } catch (e) {}
  return Object.assign({}, STR_EN, page);
}
/** 第二下确认的时限（子站立即锁定） */
const LOCK_ARM_MS = 3000;

/**
 * 语言偏好 → 实际语言（跟随系统看浏览器语言；语言列表第一项是默认语言 = 英文）
 * @param {string} v @param {string} [nav] @param {string[]} [langs] 本站语言（默认 en、zh；页面上取快捷面板的语言选项）
 */
export function resolveLang(v, nav, langs) {
  const L = langs && langs.length ? langs : ['en', 'zh'];
  if (v && v !== 'system' && L.indexOf(v) >= 0) return v;
  const n = String(nav || '').toLowerCase();
  for (const c of L) if (n === c || n.indexOf(c + '-') === 0) return c;
  return L[0];
}

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
 * @property {(v: 'system'|'zh'|'en') => string} setLang 写语言偏好，返回要去的地址；返回 '' 时按实际语言决定：和本页不同就去语言行的 data-href
 * @property {() => string} [langPref] 当前语言偏好 system / zh / en（不传按本页语言）
 * @property {() => string} [layoutPref]
 * @property {(v: string) => void} [setLayout]
 */

/**
 * @param {{
 *   modalSheet: Function,
 *   prefs: TopbarPrefs,
 *   onLock?: () => void,
 *   fetch?: typeof fetch,
 *   navigate?: (url: string) => void,
 *   replace?: (url: string) => void,
 *   ai?: (dlg: HTMLDialogElement, o: { lang: 'zh'|'en', close: Function, navigate: Function, keyboard?: Function }) => ({ onOpen?: () => void } | void),
 *   keyboard?: (cb: (h: number) => void) => () => void,
 *   share?: (cfg: { button: Element }) => any,
 *   subscribe?: (repaint: () => void) => void,
 *   reload?: () => void,
 *   doc?: Document,
 * }} o
 */
export function mountTopbar(o) {
  const doc = o.doc || document;
  const topbar = doc.querySelector('#site-nav .sgx-topbar');
  const navBtn = /** @type {HTMLElement|null} */ (doc.querySelector('.sgx-tb-grid'));
  const navDlg = /** @type {HTMLDialogElement|null} */ (doc.getElementById('sgx-nav'));
  const qpBtn = /** @type {HTMLElement|null} */ (doc.querySelector('.sgx-tb-quick'));
  const qpDlg = /** @type {HTMLDialogElement|null} */ (doc.getElementById('sgx-qp'));
  const aiBtn = /** @type {HTMLElement|null} */ (doc.querySelector('.sgx-tb-ai'));
  const aiDlg = /** @type {HTMLDialogElement|null} */ (doc.getElementById('sgx-ai'));
  const t = shellStr(doc);
  const navigate = o.navigate || function (/** @type {string} */ u) { location.href = u; };
  const replace = o.replace || function (/** @type {string} */ u) { location.replace(u); };
  /** @type {any[]} */
  const sheets = [];
  const raf = function (/** @type {() => void} */ f) {
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(f);
    else window.setTimeout(f, 16);
  };
  /** 布局重算（各站 __applyLayout：<html data-sgx-layout / data-sgx-device> + layout-* 类），再发 sgx-layout-change（同 __sgxLayoutWatch） */
  function relayout() {
    const w = /** @type {any} */ (window);
    try {
      if (typeof w.__applyLayout === 'function') w.__applyLayout();
      else if (typeof w.__sgxLayout === 'function') doc.documentElement.setAttribute('data-sgx-layout', w.__sgxLayout());
    } catch (e) {}
    try { window.dispatchEvent(new Event('sgx-layout-change')); } catch (e) {}
  }
  /**
   * viewport meta 刚被 __sgxViewportSync 原地改过：逐帧看新视口生效没有（最多约 12 帧——浏览器应用新 meta 是异步的，忙的时候不止两帧），
   * cb(true) = 生效（不用重载），cb(false) = 只能整页重载。
   * 生效 = 布局视口宽对了（固定宽 width=N：innerWidth ≥ 720；还原成 device-width：innerWidth < 720），且整页看得全
   * （visualViewport 宽 ≥ 布局视口 90%，没有停在放大的比例上）。浏览器原地不认新 meta（宽度一直不变）就重载，和以前一样。
   * 等满了宽度对了但停在放大比例上：临时补一次 initial-scale = maximum-scale = 屏宽 / N 把比例压回「整页适配」，两帧后去掉，再等一轮。
   * Chromium 手机模式（e2e）原地改 meta 直接生效；三星浏览器 / X 应用内浏览器（Android WebView）真机未验，所以留着重载兜底。
   * @param {(ok: boolean) => void} cb
   */
  function viewportInPlace(cb) {
    const w = window;
    const m = doc.querySelector('meta[name="viewport"]');
    const c = m ? m.getAttribute('content') || '' : '';
    const fx = /^width=(\d+)$/.exec(c);
    const widthOk = function () {
      const iw = w.innerWidth;
      return fx ? iw >= 720 : iw < 720;
    };
    const good = function () {
      const vv = w.visualViewport;
      return widthOk() && (!vv || vv.width >= w.innerWidth * 0.9);
    };
    /** @param {number} n @param {(ok: boolean) => void} done */
    const wait = function (n, done) {
      raf(function () {
        if (good()) return done(true);
        if (n <= 1) return done(false);
        wait(n - 1, done);
      });
    };
    wait(12, function (ok) {
      if (ok) return cb(true);
      let sw = 0;
      try { sw = w.screen.width; } catch (e) {}
      if (!fx || !m || !(sw > 0) || !widthOk()) return cb(false);
      const s = Math.round((sw / +fx[1]) * 1000) / 1000;
      m.setAttribute('content', c + ',initial-scale=' + s + ',maximum-scale=' + s);
      raf(function () {
        raf(function () {
          m.setAttribute('content', c);
          wait(12, cb);
        });
      });
    });
  }

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
      /* 点的东西在 click 处理里被重画掉了（AI 窗口的重试 / 历史条目会 render 掉自己）：已脱离文档，不算点在面板外 */
      if (tg && tg.isConnected && (!sheet || !sheet.contains(tg))) ms.close();
    });
    /* Tab 圈在「图标 + 面板控件」里（非模态不会 inert 页面，自己圈住）；
       不在 Tab 顺序里的不算：inert / 收起（hidden）的、tabindex=-1 的 */
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

  /* ---------------- 导航面板（九宫格） ---------------- */
  let nav = null;
  if (navBtn && navDlg) {
    nav = wire(navBtn, navDlg, 'sgxNav', function () {});
    if (nav) {
      const ms = nav.ms;
      navDlg.addEventListener('click', function (e) {
        const tg = /** @type {Element|null} */ (e.target);
        const a = /** @type {HTMLAnchorElement|null} */ (tg && tg.closest('a.sgx-nav-tile'));
        if (!a) return;
        if (e.defaultPrevented || /** @type {MouseEvent} */ (e).button !== 0 || /** @type {MouseEvent} */ (e).metaKey || /** @type {MouseEvent} */ (e).ctrlKey || /** @type {MouseEvent} */ (e).shiftKey || /** @type {MouseEvent} */ (e).altKey) return;
        e.preventDefault();
        /* 已经在这个站的首页：只关面板；在本站子页点本站 = 回本站首页 */
        if (a.getAttribute('aria-current') === 'page' && a.pathname === location.pathname) ms.close();
        else {
          const href = a.href;
          ms.close(function () { navigate(href); });
        }
      });
    }
  }

  /* ---------------- 快捷面板 ---------------- */
  let qp = null;
  let paint = function () {};
  if (qpBtn && qpDlg) {
    const P = o.prefs;
    const pageLang = doc.documentElement.lang || 'en';
    /** @param {string} id */
    const tile = function (id) { return /** @type {HTMLElement|null} */ (qpDlg.querySelector('[data-qp="' + id + '"]')); };
    const langBtn = tile('lang');
    const langOpts = /** @type {HTMLElement|null} */ (qpDlg.querySelector('#sgx-qp-lang-opts'));
    const langVal = /** @type {HTMLElement|null} */ (qpDlg.querySelector('[data-qp-lang-val]'));
    const lockTile = tile('lock');
    const lockState = /** @type {HTMLElement|null} */ (qpDlg.querySelector('[data-qp-lock-state]'));
    let lockArmed = 0;
    const disarm = function () {
      if (lockArmed) { clearTimeout(lockArmed); lockArmed = 0; }
      if (lockTile) lockTile.removeAttribute('data-armed');
      if (lockState) lockState.textContent = t.lockBack;
    };
    /** 语言偏好：快捷面板里列出的某种语言（hugo.yaml languages）；其他（'' / system / 没传 langPref 时的未知）= 跟随系统 */
    /** @param {string} v */
    const langOpt = function (v) {
      return v && v !== 'system' ? qpDlg.querySelector('[data-qp-lang="' + String(v).replace(/[^a-z-]/gi, '') + '"]') : null;
    };
    const langPref = function () {
      const v = P.langPref ? P.langPref() : pageLang;
      return langOpt(v) ? v : 'system';
    };
    /** @param {boolean} open */
    const setLangOpen = function (open) {
      if (!langBtn || !langOpts) return;
      langBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      langOpts.hidden = !open;
    };
    /** @param {string} id @param {boolean} on */
    const paintToggle = function (id, on) {
      const el = tile(id);
      if (!el) return;
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      const st = el.querySelector('[data-qp-state]');
      if (st) st.textContent = on ? t.on : t.off;
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
      /* 布局：手机 / 自动 / 桌面（P4-3 PR-4b）；旧偏好 mobile / dex 按 phone / desktop 亮。三档任何时候都能选（不再按视口置灰） */
      const lp = P.layoutPref ? P.layoutPref() : 'auto';
      const v = lp === 'mobile' ? 'phone' : lp === 'dex' ? 'desktop' : lp;
      /* 「自动」上写出自动此刻会给什么：「自动 · 桌面」/「自动 · 手机」（共享外壳 layout-mode.js __sgxLayoutAuto；没有就看 <html data-sgx-layout>） */
      const w = /** @type {any} */ (window);
      const autoRes = typeof w.__sgxLayoutAuto === 'function' ? w.__sgxLayoutAuto() : doc.documentElement.getAttribute('data-sgx-layout');
      qpDlg.querySelectorAll('[data-qp-seg="layout"] button').forEach(function (b) {
        const bv = b.getAttribute('data-v');
        b.setAttribute('aria-pressed', bv === v ? 'true' : 'false');
        if (bv === 'auto') b.textContent = t.auto + ' · ' + (autoRes === 'phone' ? t.phone : t.desktop);
      });
      const lv = langPref();
      /* 语言名用选项上它自己的写法（模板来自 hugo.yaml languageName，不翻译） */
      const lo = langOpt(lv);
      if (langVal) langVal.textContent = lv === 'system' ? t.sys : (lo && lo.textContent ? lo.textContent.trim() : lv);
      qpDlg.querySelectorAll('[data-qp-lang]').forEach(function (b) {
        b.setAttribute('aria-checked', b.getAttribute('data-qp-lang') === lv ? 'true' : 'false');
        b.setAttribute('tabindex', b.getAttribute('data-qp-lang') === lv ? '0' : '-1');
      });
    };

    /** 子站默认的立即锁定：POST /api/lock-now（同源网关清会话）→ 锁屏 */
    const lockNow = function () {
      const f = o.fetch || (typeof fetch === 'function' ? fetch : null);
      if (!f) return;
      f('/api/lock-now', { method: 'POST', credentials: 'include' }).then(function (r) {
        if (r && r.ok) replace('/?lock=1');
        else if (lockState) lockState.textContent = t.lockFail;
      }, function () { if (lockState) lockState.textContent = t.lockFail; });
    };

    qp = wire(qpBtn, qpDlg, 'sgxQp', function () {
      setLangOpen(false);
      disarm();
      paint();
    });
    if (qp) {
      const ms = qp.ms;
      const shareTile = tile('share');
      if (shareTile && o.share) o.share({ button: shareTile });
      /** 选了一种语言偏好：保存；实际语言和本页不同就关面板去另一种语言的同一页 @param {string} v */
      const pickLang = function (v) {
        const url = P.setLang(/** @type {any} */ (v)) || '';
        setLangOpen(false);
        paint();
        const target = resolveLang(v, (typeof navigator !== 'undefined' && navigator.language) || '', Array.prototype.map.call(qpDlg.querySelectorAll('[data-qp-lang]'), function (/** @type {Element} */ x) { return x.getAttribute('data-qp-lang') || ''; }).filter(function (/** @type {string} */ c) { return c && c !== 'system'; }));
        const here = location.pathname + location.search + location.hash;
        const go = url ? (url !== here ? url : '') : target !== pageLang ? (langBtn && langBtn.getAttribute('data-href')) || '' : '';
        if (go) ms.close(function () { replace(go); });
        else if (langBtn) { try { langBtn.focus(); } catch (e) {} }
      };
      qpDlg.addEventListener('click', function (e) {
        const tg = /** @type {Element|null} */ (e.target);
        if (!tg) return;
        const opt = /** @type {HTMLElement|null} */ (tg.closest('[data-qp-lang]'));
        if (opt) { pickLang(opt.getAttribute('data-qp-lang') || 'system'); return; }
        const tl = /** @type {HTMLElement|null} */ (tg.closest('[data-qp]'));
        if (tl) {
          const id = tl.getAttribute('data-qp');
          if (id === 'share') return; /* share.js 自己接这一下 */
          if (id !== 'lock') disarm();
          if (id === 'dark') P.setTheme(P.isDark() ? 'light' : 'dark');
          else if (id === 'system') P.toggleFollowSystem();
          else if (id === 'lang') { setLangOpen(!!(langOpts && langOpts.hidden)); return; }
          else if (id === 'lock') {
            if (o.onLock) { ms.close(o.onLock); return; }
            if (lockArmed) { disarm(); ms.close(lockNow); return; }
            if (lockTile) lockTile.setAttribute('data-armed', '');
            if (lockState) lockState.textContent = t.lockArm;
            lockArmed = window.setTimeout(disarm, LOCK_ARM_MS);
            return;
          }
          paint();
          return;
        }
        disarm();
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
          if (P.setLayout) P.setLayout(sb.getAttribute('data-v') || '');
          /* 手机屏切进 / 切出「桌面」：共享外壳 layout-mode.js 把 viewport 换成 980 宽（或还原）。
             2026-11-07 Gray 真机：以前一律整页重载，三星浏览器 / X 应用内浏览器都白闪一下。现在先原地生效（viewportInPlace），
             新视口真的没生效（宽度没变 / 停在放大的比例上）才退回整页重载：先关面板（退掉历史哨兵，返回键不多一步），再重载 */
          const vw = /** @type {any} */ (window).__sgxViewportSync;
          if (typeof vw === 'function' && vw()) {
            viewportInPlace(function (ok) {
              if (ok) {
                relayout();
                paint();
                return;
              }
              /* 重载兜底：把此刻页面底色交给下一页首帧（layout-mode.js __sgxFirstPaint 读 sessionStorage sgx-fp-bg），不露浏览器白底 */
              try { sessionStorage.setItem('sgx-fp-bg', getComputedStyle(doc.documentElement).backgroundColor); } catch (e) {}
              const go = o.reload || function () { location.reload(); };
              if (qp && qp.ms.isOpen()) qp.ms.close(go);
              else go();
            });
            return;
          }
          paint();
        }
      });
      /* 语言单选：↑ ↓ ← → 在选项间移动（不立即保存），Esc 收起回到语言行 */
      if (langOpts) {
        langOpts.addEventListener('keydown', function (e) {
          const opts = /** @type {HTMLElement[]} */ (Array.from(langOpts.querySelectorAll('[data-qp-lang]')));
          const i = opts.indexOf(/** @type {HTMLElement} */ (doc.activeElement));
          let n = -1;
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % opts.length;
          else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + opts.length) % opts.length;
          else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setLangOpen(false);
            if (langBtn) langBtn.focus();
            return;
          }
          if (n < 0) return;
          e.preventDefault();
          opts[n].focus();
        });
      }
      const repaint = function () { if (ms.isOpen()) paint(); };
      if (o.subscribe) o.subscribe(repaint);
      window.addEventListener('sgx-theme-changed', repaint);
      /* 拖窗口 / 分屏 / 转屏后布局重算（layout-mode.js __sgxLayoutWatch 发 sgx-layout-change）：「自动 · …」跟着变 */
      window.addEventListener('sgx-layout-change', repaint);
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
      if (!chat && o.ai) chat = o.ai(aiDlg, { lang: doc.documentElement.lang || 'en', close: function (/** @type {any} */ after) { if (ai) ai.ms.close(after); }, navigate: navigate, keyboard: o.keyboard }) || {};
      if (chat && chat.onOpen) chat.onOpen();
    });
  }

  return { nav: nav && nav.ms, qp: qp && qp.ms, ai: ai && ai.ms, paint: paint };
}
/* @sgx-shell:end */
