/**
 * @fileoverview 顶栏的三个弹出窗口（2026-11-04 P5-1；2026-11 UI 重设计 PR-1 顶栏 v3）：NAVIGATE #sgx-nav（>_ 按钮）、外观 #sgx-qp（调色盘按钮）、AI 窗口 #sgx-ai（右下角浮钮），
 * 外加顶栏底边的滑页进度条 .sgx-tb-prog 和 tmux 页脚的 CST 时钟。
 * 共享外壳组件：四个站共用这一份（主站 shell/quick-panel.js 调它，子站入口脚本调它）。
 * 自成一体：不 import 任何东西；状态机（modal-sheet.js）、外观 setter（主站 lib/prefs.js / 子站 prefs-write.js）、AI 内容（ai.js）、
 * 分享（share.js）、键盘高度订阅（vk.js 的 onKeyboardHeight，转给 AI 窗口；P4-3 PR-3）都由调用方传进来。
 *
 * - 三个窗口都是非模态 <dialog>（modalSheet modal:false → show()）：从顶栏下方落下，顶栏留在上面可点；开合 / 系统返回 / Esc / bfcache 走 modalSheet。
 * - 互斥：一个开着时点顶栏（含 AI 浮钮）上别的东西，先关这个（等哨兵出栈）再补点那一下。
 * - 点遮罩（面板以外）关闭；焦点打开时进面板，关上时还给按钮；Tab / Shift+Tab 圈在「按钮 + 面板控件」里。
 * - NAVIGATE：01 主页 … 05 旷野（当前项「开」态）；已在当前项那一页时点它只关面板，其余关完再跳（不留哨兵）。
 *   lang 分段（配置里的每种语言，选中即保存，换了语言就去另一种语言的同一页）、layout 分段（Auto / Mobile / DeX，模式规则见共享外壳 layout-mode.js）、
 *   share（share.js）/ lock（立即锁定）、STATUS（占位）、esc 关闭。
 * - 外观：MODE 三段（跟随系统 / 深 / 浅）、PALETTE 色板列表 + 恢复默认。
 * - 立即锁定：调用方传 onLock（主站：确认层 auth/lock-now.js）；不传（子站）= 按钮点两下确认（第一下字变「再点一下锁定」，3 秒内再点），
 *   POST /api/lock-now（同源网关）后回到锁屏 /?lock=1。
 * - 终端（2026-11 UI 重设计 PR-2）：调用方传 terminal（shell/terminal.js 整个模块；本文件仍不 import）。每页一个引擎实例，接两处视图：
 *   主页首屏嵌入的 [data-sgx-term="home"] 和全站抽屉 #sgx-term（模态 <dialog>，Esc / 点遮罩关）。
 *   Ctrl / ⌘ K 与 NAVIGATE 里的「$ terminal」：主页上聚焦首屏终端，其他页开合抽屉。命令的动作（滚动 / 跳转 / 外观 / 锁屏 / AI）都在这里接。
 */

const QP_MS = 240;
/** 英文底（源文本，没有页面字符串表时用）；页面上以 #sgx-i18n-shell 的 topbar 节为准——已是「英文 ← 页面语言」的合并，缺键回退英文（语言包化 2026-11-07） */
const STR_EN = {
  on: "On",
  off: "Off",
  auto: "Auto",
  phone: "Mobile",
  desktop: "DeX",
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
 *   terminal?: any,
 *   subscribe?: (repaint: () => void) => void,
 *   reload?: () => void,
 *   doc?: Document,
 * }} o
 */
export function mountTopbar(o) {
  const doc = o.doc || document;
  /* 互斥的捕获点：整个 #site-nav（顶栏 + AI 浮钮） */
  const topbar = doc.getElementById('site-nav');
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

  const P = o.prefs;
  const pageLang = doc.documentElement.lang || 'en';

  /* ---------------- NAVIGATE ---------------- */
  let nav = null;
  let paintNav = function () {};
  if (navBtn && navDlg) {
    /** @param {string} id */
    const ctl = function (id) { return /** @type {HTMLElement|null} */ (navDlg.querySelector('[data-qp="' + id + '"]')); };
    const langSeg = /** @type {HTMLElement|null} */ (navDlg.querySelector('[data-qp-langs]'));
    const lockBtn = ctl('lock');
    const lockState = /** @type {HTMLElement|null} */ (navDlg.querySelector('[data-qp-lock-state]'));
    const lockLabel = lockState ? lockState.textContent : '';
    let lockArmed = 0;
    const disarm = function () {
      if (lockArmed) { clearTimeout(lockArmed); lockArmed = 0; }
      if (lockBtn) lockBtn.removeAttribute('data-armed');
      if (lockState) lockState.textContent = lockLabel;
    };
    /** 语言分段上列出的语言（hugo.yaml languages） @returns {string[]} */
    const langCodes = function () {
      return Array.prototype.map.call(navDlg.querySelectorAll('[data-qp-lang]'), function (/** @type {Element} */ x) { return x.getAttribute('data-qp-lang') || ''; }).filter(Boolean);
    };
    /** 当前语言偏好落到哪一段：明确的某种语言 = 那一段；跟随系统 / 没存 = 按浏览器语言算出的那种（resolveLang） */
    const langShown = function () {
      const v = P.langPref ? P.langPref() : pageLang;
      return resolveLang(v, (typeof navigator !== 'undefined' && navigator.language) || '', langCodes());
    };
    paintNav = function () {
      /* 布局：Auto / Mobile / DeX（值 auto / phone / desktop）；旧偏好 mobile / dex 按 phone / desktop 亮 */
      const lp = P.layoutPref ? P.layoutPref() : 'auto';
      const v = lp === 'mobile' ? 'phone' : lp === 'dex' ? 'desktop' : lp;
      navDlg.querySelectorAll('[data-qp-seg="layout"] button').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-v') === v ? 'true' : 'false');
      });
      const lv = langShown();
      navDlg.querySelectorAll('[data-qp-lang]').forEach(function (b) {
        b.setAttribute('aria-checked', b.getAttribute('data-qp-lang') === lv ? 'true' : 'false');
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
    nav = wire(navBtn, navDlg, 'sgxNav', function () { disarm(); paintNav(); });
    if (nav) {
      const ms = nav.ms;
      const shareBtn = ctl('share');
      if (shareBtn && o.share) o.share({ button: shareBtn });
      /** 选了一种语言：保存；实际语言和本页不同就关面板去另一种语言的同一页 @param {string} v */
      const pickLang = function (v) {
        const url = P.setLang(/** @type {any} */ (v)) || '';
        paintNav();
        const here = location.pathname + location.search + location.hash;
        const go = url ? (url !== here ? url : '') : v !== pageLang ? (langSeg && langSeg.getAttribute('data-href')) || '' : '';
        if (go) ms.close(function () { replace(go); });
      };
      navDlg.addEventListener('click', function (e) {
        const tg = /** @type {Element|null} */ (e.target);
        if (!tg) return;
        const a = /** @type {HTMLAnchorElement|null} */ (tg.closest('a.sgx-nav-tile'));
        if (a) {
          if (e.defaultPrevented || /** @type {MouseEvent} */ (e).button !== 0 || /** @type {MouseEvent} */ (e).metaKey || /** @type {MouseEvent} */ (e).ctrlKey || /** @type {MouseEvent} */ (e).shiftKey || /** @type {MouseEvent} */ (e).altKey) return;
          e.preventDefault();
          /* 已经在这一项那一页：只关面板；其余关完再跳 */
          if (a.getAttribute('aria-current') === 'page' && a.pathname === location.pathname) ms.close();
          else {
            const href = a.href;
            ms.close(function () { navigate(href); });
          }
          return;
        }
        if (tg.closest('[data-nav-close]')) { ms.close(); return; }
        const opt = /** @type {HTMLElement|null} */ (tg.closest('[data-qp-lang]'));
        if (opt) { disarm(); pickLang(opt.getAttribute('data-qp-lang') || 'system'); return; }
        const c = /** @type {HTMLElement|null} */ (tg.closest('[data-qp]'));
        if (c) {
          const id = c.getAttribute('data-qp');
          if (id === 'share') return; /* share.js 自己接这一下 */
          if (id === 'term') { ms.close(function () { openTerm(); }); return; }
          if (id === 'lock') {
            if (o.onLock) { ms.close(o.onLock); return; }
            if (lockArmed) { disarm(); ms.close(lockNow); return; }
            if (lockBtn) lockBtn.setAttribute('data-armed', '');
            if (lockState) lockState.textContent = t.lockArm;
            lockArmed = window.setTimeout(disarm, LOCK_ARM_MS);
          }
          return;
        }
        const sb = /** @type {HTMLButtonElement|null} */ (tg.closest('[data-qp-seg="layout"] button'));
        if (sb && !sb.disabled) {
          disarm();
          if (P.setLayout) P.setLayout(sb.getAttribute('data-v') || '');
          /* 手机屏切进 / 切出「DeX」：共享外壳 layout-mode.js 把 viewport 换成 980 宽（或还原）。
             2026-11-07 Gray 真机：以前一律整页重载，三星浏览器 / X 应用内浏览器都白闪一下。现在先原地生效（viewportInPlace），
             新视口真的没生效（宽度没变 / 停在放大的比例上）才退回整页重载：先关面板（退掉历史哨兵，返回键不多一步），再重载 */
          const vw = /** @type {any} */ (window).__sgxViewportSync;
          if (typeof vw === 'function' && vw()) {
            viewportInPlace(function (ok) {
              if (ok) {
                relayout();
                paintNav();
                return;
              }
              /* 重载兜底：把此刻页面底色交给下一页首帧（layout-mode.js __sgxFirstPaint 读 sessionStorage sgx-fp-bg），不露浏览器白底 */
              try { sessionStorage.setItem('sgx-fp-bg', getComputedStyle(doc.documentElement).backgroundColor); } catch (e) {}
              const go = o.reload || function () { location.reload(); };
              if (nav && nav.ms.isOpen()) nav.ms.close(go);
              else go();
            });
            return;
          }
          paintNav();
        }
      });
      /* 语言分段：← → 在选项间移动焦点（不立即保存） */
      if (langSeg) {
        langSeg.addEventListener('keydown', function (e) {
          const opts = /** @type {HTMLElement[]} */ (Array.from(langSeg.querySelectorAll('[data-qp-lang]')));
          const i = opts.indexOf(/** @type {HTMLElement} */ (doc.activeElement));
          let n = -1;
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % opts.length;
          else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + opts.length) % opts.length;
          if (n < 0) return;
          e.preventDefault();
          opts[n].focus();
        });
      }
    }
  }

  /* ---------------- 外观（MODE / PALETTE） ---------------- */
  let qp = null;
  let paint = function () {};
  if (qpBtn && qpDlg) {
    paint = function () {
      const m = P.themeMode();
      const mode = m === 'dark' || m === 'light' ? m : 'system';
      qpDlg.querySelectorAll('[data-qp-mode]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-qp-mode') === mode ? 'true' : 'false');
      });
      const p = P.palette();
      qpDlg.querySelectorAll('[data-qp-palette]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-qp-palette') === p ? 'true' : 'false');
      });
      const rs = qpDlg.querySelector('[data-qp-reset]');
      if (rs) rs.setAttribute('aria-disabled', p === P.DEFAULT_PALETTE && !P.hasAccent() ? 'true' : 'false');
    };
    qp = wire(qpBtn, qpDlg, 'sgxQp', function () { paint(); });
    if (qp) {
      qpDlg.addEventListener('click', function (e) {
        const tg = /** @type {Element|null} */ (e.target);
        if (!tg) return;
        const mb = tg.closest('[data-qp-mode]');
        if (mb) {
          P.setTheme(/** @type {any} */ (mb.getAttribute('data-qp-mode') || 'system'));
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
        }
      });
    }
  }
  const repaint = function () {
    if (qp && qp.ms.isOpen()) paint();
    if (nav && nav.ms.isOpen()) paintNav();
  };
  if (o.subscribe) o.subscribe(repaint);
  window.addEventListener('sgx-theme-changed', repaint);
  window.addEventListener('sgx-layout-change', repaint);
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener || mq.addListener).call(mq, 'change', function () { window.setTimeout(repaint, 0); });
  } catch (e) {}

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

  /* ---------------- 终端（2026-11 PR-2） ---------------- */
  /** @type {any} */
  let termSheet = null;
  /** @type {any} */
  let homeView = null;
  /** @type {any} */
  let drawerView = null;
  /** @type {any} */
  let term = null;
  const T = o.terminal;
  const termDlg = /** @type {HTMLDialogElement|null} */ (doc.getElementById('sgx-term'));
  const homeTerm = doc.querySelector('[data-sgx-term="home"]');
  const reducedM = function () {
    try { return doc.documentElement.classList.contains('reduced-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  };
  /** 先关掉开着的顶栏窗口 / 抽屉，再做 f */
  const closeAll = function (/** @type {() => void} */ f) {
    if (termSheet && termSheet.isOpen()) { termSheet.close(f); return; }
    const open = sheets.find(function (x) { return x.ms.isOpen(); });
    if (open) { open.ms.close(f); return; }
    f();
  };
  /** 打开终端：主页聚焦首屏那个（滚到视野里），其他页开抽屉 */
  const openTerm = function () {
    if (homeView) { homeView.focus({ scroll: true }); return; }
    if (termSheet && !termSheet.isOpen()) termSheet.open();
  };
  if (T && typeof T.createShell === 'function' && (homeTerm || termDlg)) {
    const tile = function (/** @type {string} */ id) { return /** @type {HTMLAnchorElement|null} */ (navDlg ? navDlg.querySelector('a.sgx-nav-tile[data-nav="' + id + '"]') : null); };
    const hrefOf = function (/** @type {string} */ id, /** @type {string} */ dflt) { const a = tile(id); return a ? a.href : dflt; };
    const cur = navDlg ? navDlg.querySelector('a.sgx-nav-tile[aria-current="page"]') : null;
    const curId = cur ? cur.getAttribute('data-nav') || '' : '';
    term = T.createShell({
      str: T.termStrings(doc),
      cwd: homeTerm ? '~' : ['blog', 'curio', 'daymark'].indexOf(curId) >= 0 ? curId : '~',
      act: {
        cd: function (/** @type {string} */ dir) {
          /* 主页上有这一节（[data-term-dir]）就滚过去；~ 回到首屏终端；其余去那个站 */
          if (homeTerm) {
            const sec = dir === '~' ? doc.getElementById('home-hero') : doc.querySelector('[data-term-dir="' + dir + '"]');
            if (sec) {
              try { sec.scrollIntoView({ behavior: reducedM() ? 'auto' : 'smooth', block: 'start' }); } catch (e) {}
              return { kind: 'scroll', label: dir === '~' ? '' : sec.getAttribute('data-term-label') || dir };
            }
          }
          const href = hrefOf(dir === '~' ? 'home' : dir, '/');
          return { kind: 'nav', href: href, go: function () { closeAll(function () { navigate(href); }); } };
        },
        sudo: function (/** @type {string} */ which) {
          const a = /** @type {HTMLAnchorElement|null} */ (doc.querySelector(which === 'account' ? '#site-nav .sgx-tb-av' : '#site-nav .sgx-tb-shield'));
          const href = a ? a.href : which === 'account' ? '/account/' : '/security/';
          return { href: href, go: function () { closeAll(function () { navigate(href); }); } };
        },
        theme: function (/** @type {string} */ mode) {
          if (!mode) { closeAll(function () { if (qp) qp.ms.open(); }); return; }
          P.setTheme(/** @type {any} */ (mode === 'auto' ? 'system' : mode));
          paint();
        },
        lock: function () {
          closeAll(function () {
            if (o.onLock) o.onLock();
            else {
              const f = o.fetch || (typeof fetch === 'function' ? fetch : null);
              if (f) f('/api/lock-now', { method: 'POST', credentials: 'include' }).then(function (r) { if (r && r.ok) replace('/?lock=1'); }, function () {});
            }
          });
        },
        ask: function (/** @type {string} */ q) {
          closeAll(function () {
            if (!ai || !aiDlg) return;
            if (!ai.ms.isOpen()) ai.ms.open();
            if (!q) return;
            window.setTimeout(function () {
              const inp = /** @type {HTMLTextAreaElement|null} */ (aiDlg.querySelector('[data-ai-in]'));
              const fm = /** @type {HTMLFormElement|null} */ (aiDlg.querySelector('[data-ai-form]'));
              if (!inp || !fm) return;
              inp.value = q.slice(0, inp.maxLength > 0 ? inp.maxLength : 200);
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              if (fm.requestSubmit) fm.requestSubmit();
              else fm.dispatchEvent(new Event('submit', { cancelable: true }));
            }, 0);
          });
        },
        today: function () {
          const f = o.fetch || (typeof fetch === 'function' ? fetch : null);
          if (!f) return Promise.reject(new Error('no fetch'));
          return f('/daymark/api/today', { credentials: 'same-origin' }).then(function (r) {
            if (!r || !r.ok) throw new Error('http');
            return r.json();
          }).then(function (/** @type {any} */ j) {
            const q = j && j.quote;
            if (!q || !q.text) return null;
            const by = [q.author, q.source].filter(Boolean).join(' · ');
            return { text: String(q.text), by: by ? '— ' + by : '' };
          });
        },
        daymarkHref: function () { return hrefOf('daymark', '/daymark/'); },
      },
    });
    if (homeTerm) homeView = T.mountTermView(homeTerm, term, { autoHelp: true });
    if (termDlg && !homeTerm && typeof termDlg.showModal === 'function') {
      const opener = navBtn || /** @type {HTMLElement} */ (doc.body);
      const coarse = function () { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } };
      termSheet = o.modalSheet(termDlg, opener, {
        ms: QP_MS,
        stateKey: 'sgxTerm',
        onOpen: function () {
          if (!drawerView) drawerView = T.mountTermView(termDlg.querySelector('[data-sgx-term]') || termDlg, term, {});
          /* 触屏不直接聚焦输入框（会弹键盘 / 桌面版网站下放大），点一下输入行再打字 */
          if (drawerView && !coarse()) drawerView.focus();
        },
        onClosed: function () {
          const a = doc.activeElement;
          if (!a || a === doc.body || termDlg.contains(a)) { try { opener.focus({ preventScroll: true }); } catch (e) {} }
        },
      });
      /* 点遮罩（抽屉外）关 */
      termDlg.addEventListener('click', function (e) { if (e.target === termDlg && termSheet) termSheet.close(); });
    }
    /* Ctrl / ⌘ K：主页聚焦首屏终端；其他页开合抽屉（输入法组字时不理） */
    doc.addEventListener('keydown', function (e) {
      if (e.isComposing || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || (e.key !== 'k' && e.key !== 'K')) return;
      e.preventDefault();
      if (homeView) { closeAll(function () { homeView.focus({ scroll: true }); }); return; }
      if (!termSheet) return;
      if (termSheet.isOpen()) termSheet.close();
      else closeAll(function () { termSheet.open(); });
    });
  }

  mountProgress(doc);
  mountClock(doc);
  return { nav: nav && nav.ms, qp: qp && qp.ms, ai: ai && ai.ms, term: termSheet, termShell: term, paint: paint, paintNav: paintNav };
}

/**
 * 滑页进度条（顶栏 v3 prog-v1）：已滚比例 → .sgx-tb-prog 的 --sgx-prog（0–100%）；页面不够长 / 在顶上 = data-empty（不显示）。
 * 滚动 / 尺寸变化时按帧合并写一次；不支持的环境什么也不做。
 * @param {Document} [d]
 * @returns {(() => void) | null} 立刻重算一次（测试 / 内容变长后用）
 */
export function mountProgress(d) {
  const doc = d || document;
  const bar = /** @type {HTMLElement|null} */ (doc.querySelector('#site-nav .sgx-tb-prog'));
  if (!bar) return null;
  let queued = false;
  const calc = function () {
    queued = false;
    const se = doc.scrollingElement || doc.documentElement;
    const max = Math.max(0, se.scrollHeight - window.innerHeight);
    const y = window.scrollY || se.scrollTop || 0;
    const p = max > 0 ? Math.min(100, Math.max(0, (y / max) * 100)) : 0;
    bar.style.setProperty('--sgx-prog', p.toFixed(2) + '%');
    if (p > 0) bar.removeAttribute('data-empty');
    else bar.setAttribute('data-empty', '');
  };
  const queue = function () {
    if (queued) return;
    queued = true;
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(calc);
    else window.setTimeout(calc, 16);
  };
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue, { passive: true });
  calc();
  return calc;
}

/**
 * tmux 页脚的 CST 时钟（[data-sgx-clock]）：北京时间 HH:MM，每 30 秒写一次；页面藏起来时不跑，回来立刻补一次。
 * @param {Document} [d]
 * @returns {(() => void) | null}
 */
export function mountClock(d) {
  const doc = d || document;
  const els = Array.from(doc.querySelectorAll('[data-sgx-clock]'));
  if (!els.length) return null;
  const tick = function () {
    let s = '';
    try {
      s = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    } catch (e) {
      const t = new Date(Date.now() + 8 * 3600 * 1000);
      s = ('0' + t.getUTCHours()).slice(-2) + ':' + ('0' + t.getUTCMinutes()).slice(-2);
    }
    els.forEach(function (el) { if (el.textContent !== s) el.textContent = s; });
  };
  tick();
  window.setInterval(function () { if (!doc.hidden) tick(); }, 30000);
  doc.addEventListener('visibilitychange', function () { if (!doc.hidden) tick(); });
  return tick;
}
