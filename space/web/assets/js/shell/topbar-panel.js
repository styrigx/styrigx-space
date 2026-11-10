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
 *   lang 分段 EN | Auto | 中文（选中即保存；明确的语言和本页不同就去另一种语言的同一页，Auto 只在主站首页换）、layout 分段（Mobile | Auto | DeX，模式规则见共享外壳 layout-mode.js）、
 *   share（share.js）/ lock（立即锁定）、STATUS（占位）、esc 关闭。
 * - 外观：MODE 三段（跟随系统 / 深 / 浅）、PALETTE 色板列表 + 恢复默认。
 * - 立即锁屏（NAVIGATE 里的 lock）：只锁本机、不验证、点一下就锁（Gray 2026-11-09 08:03）：调用方传 onLock 就用它，
 *   不传 = POST /api/lock-now（同源网关）后重新取这一页（服务端画访客态）。
 * - 终端（v5 S5 终端合一）：调用方传 terminal（shell/terminal.js 整个模块）、space（钥匙层 shell/space/layer.js mountSpace）、accountTerm（终端里的账号层
 *   shell/account/cmd/layer.js mountAccountLayer）、account（账号窗口 shell/account/window.js mountAccountWindow，照旧）；本文件仍不 import。每页一个终端：主页首屏嵌入的 [data-sgx-term="home"]，其他页 #sgx-term（桌面居中大窗、手机整块卡片）。
 *   Ctrl / ⌘ K 与 NAVIGATE 里的「$ terminal」打开它；盾牌（S6 前）也打开它。命令的动作（滚动 / 跳转 / 外观 / AI / 账号窗口）都在这里接。
 * - 上锁的地方（v5 S3：AI 窗口、旷野 status 卡、奇趣音乐的播放，以及各处接口回 401）都只发 document 上的 `sgx:sudo` 事件（SUDO_EVENT），
 *   这里是唯一接它的地方：打开终端、输入行预填 `sudo styrigx`（不替人回车）；回车后在终端里验证。
 */

const QP_MS = 240;
/** AI 窗口在减弱动效下的淡入淡出（2026-11-08 Gray：从浮钮展开；减弱动效只做短淡入淡出、不缩放） */
const AI_RM_MS = 120;
/**
 * AI 窗口的展开原点（2026-11-08 Gray 16:14：从浮钮往左上长出）：开窗那一刻（<dialog> 已 show、is-open 还没加）量浮钮中心离窗口右缘 / 下缘多远，
 * 写成 --sgx-ai-ox / --sgx-ai-oy，CSS 用 transform-origin: calc(100% - ox) calc(100% - oy)——原点贴着窗口右下，键盘把窗口压矮也不跑。
 * 窗口位置用 offset*（不受正在进行的 scale 影响）+ dialog 的矩形算。量不到就用 CSS 默认（32px）。
 * @param {HTMLElement} btn @param {HTMLElement} dlg @param {HTMLElement|null} sheet
 */
function aiOrigin(btn, dlg, sheet) {
  if (!sheet) return;
  try {
    const b = btn.getBoundingClientRect();
    const d = dlg.getBoundingClientRect();
    if (!b.width || !sheet.offsetWidth) return;
    const right = d.left + sheet.offsetLeft + sheet.offsetWidth;
    const bottom = d.top + sheet.offsetTop + sheet.offsetHeight;
    sheet.style.setProperty('--sgx-ai-ox', Math.round(right - (b.left + b.width / 2)) + 'px');
    sheet.style.setProperty('--sgx-ai-oy', Math.round(bottom - (b.top + b.height / 2)) + 'px');
  } catch (e) {}
}
/** 英文底（源文本，没有页面字符串表时用）；页面上以 #sgx-i18n-shell 的 topbar 节为准——已是「英文 ← 页面语言」的合并，缺键回退英文（语言包化 2026-11-07） */
const STR_EN = {
  on: "On",
  off: "Off",
  auto: "Auto",
  phone: "Mobile",
  desktop: "DeX",
  sys: "Follow system",
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
/** 立即锁屏的接口（同源网关；= shell/space/paths.js API.lockNow，本文件不 import 任何东西，只能抄一份） */
const LOCK_NOW_API = '/api/lock-now';
/** 关键词搜索（v5 S4，网关 GET /api/find，公开） */
const FIND_API = '/api/find';
/** 有没有进站会话（同源网关；= shell/space/paths.js API.sessionCheck）：终端身份的来源 */
const SESSION_CHECK_API = '/api/lock-session-check';
/** 上锁的地方要人进站时发的事件（= lib/sudo.js SUDO_EVENT，本文件不 import，抄一份） */
export const SUDO_EVENT = 'sgx:sudo';
/** 进站的命令（= term/core/parse.js ADMIN_COMMAND，本文件不 import） */
const SUDO_LINE = 'sudo styrigx';

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
 *   space?: (line: any, o: any) => any,
 *   account?: (o: any) => any,
 *   accountTerm?: (o: any) => any,
 *   accountLayer?: (n: string) => { layer: string, reset: boolean, reauth: boolean },
 *   pmUser?: string,
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

  /**
   * 一个顶栏窗口的通用接线：开合、互斥、遮罩、Tab 圈、焦点归还
   * @param {HTMLElement} btn @param {HTMLDialogElement} dlg @param {string} key @param {() => void} onOpen
   * @param {number} [reducedMs] 减弱动效下的短淡入淡出时长（AI 窗口传 AI_RM_MS；不传 = 直接到位）
   */
  function wire(btn, dlg, key, onOpen, reducedMs, onClosedCb) {
    if (typeof dlg.show !== 'function') return null;
    const sheet = /** @type {HTMLElement|null} */ (dlg.querySelector('.sgx-qp-sheet'));
    const ms = o.modalSheet(dlg, btn, {
      ms: QP_MS,
      reducedMs: reducedMs,
      stateKey: key,
      modal: false,
      onOpen: onOpen,
      onClosed: function () {
        if (onClosedCb) onClosedCb();
        const a = doc.activeElement;
        if (!a || a === doc.body || dlg.contains(a)) {
          try { btn.focus({ preventScroll: true }); } catch (e) {}
        }
      },
    });
    const me = { btn, dlg, ms };
    sheets.push(me);
    btn.addEventListener('click', function (e) {
      /* 盾牌 / 头像是链接（PR-5）：中键 / Ctrl / ⌘ / Shift / Alt 点照旧按链接走（新标签页等），只有普通点击开面板 */
      if (btn.tagName === 'A') {
        const me2 = /** @type {MouseEvent} */ (e);
        if (me2.button !== 0 || me2.metaKey || me2.ctrlKey || me2.shiftKey || me2.altKey) return;
        e.preventDefault();
      }
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
      /* 图标被藏起来时（手机上 AI 浮钮开窗时淡出、visibility:hidden）不进圈：焦点给不到看不见的元素 */
      let btnOn = true;
      try { btnOn = getComputedStyle(btn).visibility !== 'hidden'; } catch (err) {}
      const list = (btnOn ? [btn] : []).concat(Array.from(dlg.querySelectorAll('a[href], button:not([disabled]), textarea, input')).filter(function (el) {
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
    const disarm = function () {
      if (lockBtn) lockBtn.removeAttribute('data-armed');
      if (lockState) lockState.textContent = lockLabel;
    };
    /** 语言分段上列出的语言（hugo.yaml languages） @returns {string[]} */
    const langCodes = function () {
      return Array.prototype.map.call(navDlg.querySelectorAll('[data-qp-lang]'), function (/** @type {Element} */ x) { return x.getAttribute('data-qp-lang') || ''; }).filter(function (/** @type {string} */ c) { return !!c && c !== 'system'; });
    };
    /** 当前语言偏好落到哪一段（EN | Auto | 中文，2026-11-09）：明确的某种语言 = 那一段；跟随系统 / 没存 = Auto（data-qp-lang="system"）。
        分段上没有 Auto（旧标记）时退回按浏览器语言算出的那种（resolveLang） */
    const langShown = function () {
      const v = P.langPref ? P.langPref() : pageLang;
      const codes = langCodes();
      if (v && v !== 'system' && codes.indexOf(v) >= 0) return v;
      if (navDlg.querySelector('[data-qp-lang="system"]')) return 'system';
      return resolveLang(v, (typeof navigator !== 'undefined' && navigator.language) || '', codes);
    };
    paintNav = function () {
      /* 布局：Mobile / Auto / DeX（值 phone / auto / desktop）；旧偏好 mobile / dex 按 phone / desktop 亮 */
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
    /** 立即锁屏（只锁本机，不验证；Gray 2026-11-09 08:03）：POST 同源网关清会话 → 锁屏 */
    const lockNow = function () {
      const f = o.fetch || (typeof fetch === 'function' ? fetch : null);
      if (!f) return;
      f(LOCK_NOW_API, { method: 'POST', credentials: 'include' }).then(function (r) {
        if (r && r.ok) replace(cleanHere());
        else if (lockState) lockState.textContent = t.lockFail;
      }, function () { if (lockState) lockState.textContent = t.lockFail; });
    };
    nav = wire(navBtn, navDlg, 'sgxNav', function () { disarm(); paintNav(); });
    if (nav) {
      const ms = nav.ms;
      const shareBtn = ctl('share');
      if (shareBtn && o.share) o.share({ button: shareBtn });
      /** 选了一种语言：保存；实际语言和本页不同就关面板去另一种语言的同一页。
          选 Auto（'system'）：只保存；只有在主站首页（/ ↔ /zh/，isHomePath）才按浏览器语言换过去，深链 / 子页不动（Gray 2026-11-09） @param {string} v */
      const pickLang = function (v) {
        const url = P.setLang(/** @type {any} */ (v)) || '';
        paintNav();
        if (v === 'system') {
          /* 本文件不 import：用首帧 lang-boot.js 挂的 window.SgxLang（四站都有）；没有就只保存不跳 */
          const SL = /** @type {any} */ (window).SgxLang;
          const ag = SL && SL.isHomePath && SL.isHomePath(location.pathname) ? SL.langSwitch(SL.systemLang(), location) || '' : '';
          if (ag) ms.close(function () { replace(ag); });
          return;
        }
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
          if (id === 'term') { ms.close(function () { window.setTimeout(openTerm, 0); }); return; }
          if (id === 'lock') {
            /* 立即锁屏只锁本机、不验证、没有确认层（Gray C / 08:03）：点一下就锁 */
            disarm();
            ms.close(o.onLock || lockNow);
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
  /** tty4 的命令外壳（终端那一段建好后才有；AI 窗口打开时才取） @type {() => any} */
  let term4Of = function () { return null; };
  let ai = null;
  if (aiBtn && aiDlg) {
    /** @type {any} */
    let chat = null;
    const aiSheet = /** @type {HTMLElement|null} */ (aiDlg.querySelector('.sgx-qp-sheet'));
    ai = wire(aiBtn, aiDlg, 'sgxAi', function () {
      aiOrigin(aiBtn, aiDlg, aiSheet);
      if (!chat && o.ai) chat = o.ai(aiDlg, { lang: doc.documentElement.lang || 'en', close: function (/** @type {any} */ after) { if (ai) ai.ms.close(after); }, navigate: navigate, keyboard: o.keyboard, term: function () { return term4Of(); } }) || {};
      if (chat && chat.onOpen) chat.onOpen();
    }, AI_RM_MS);
    /* 头部 ×（2026-11 PR-5 ai-v1）：同 Esc / 点遮罩 */
    if (ai) {
      const aiMs = ai.ms;
      aiDlg.addEventListener('click', function (e) {
        const tg = /** @type {Element|null} */ (e.target);
        if (tg && tg.closest('[data-ai-close]')) aiMs.close();
      });
    }
  }

  /** 外壳字符串表的一节（acct / sec）：{key} 占位由调用方替换 @param {string} sec @returns {Record<string, string>} */
  const trSec = function (sec) {
    try {
      const el = doc.getElementById('sgx-i18n-shell');
      const j = el && el.textContent ? JSON.parse(el.textContent) : null;
      return j && j[sec] && typeof j[sec] === 'object' ? j[sec] : {};
    } catch (e) { return {}; }
  };
  /* ---------------- 终端（v5 S5 终端合一：锁屏 tty1、主页 tty2、盾牌 tty3、账号 tty5 合成一个；shell/terminal.js） ----------------
     一个会话、一份历史；提示符按身份（nobody / link / styrigx / root，服务端说了算）。桌面是居中大窗、手机整块卡片（#sgx-term）；
     主页上首屏嵌入的那一个就是终端（S7 换成 neofetch）。钥匙层（o.space：shell/space/layer.js）和账号层（o.account：shell/account/window.js）共用它的输入行。 */
  const T = o.terminal;
  const termDlg = /** @type {HTMLDialogElement|null} */ (doc.getElementById('sgx-term'));
  const homeTerm = doc.querySelector('[data-sgx-term="home"]');
  const acctBtn = /** @type {HTMLElement|null} */ (doc.querySelector('#site-nav .sgx-tb-av'));
  const acctDlg = /** @type {HTMLDialogElement|null} */ (doc.getElementById('sgx-acct'));
  const secBtn = /** @type {HTMLElement|null} */ (doc.querySelector('#site-nav .sgx-tb-shield'));
  /** @type {any} */
  let termSheet = null;
  /** @type {any} */
  let view = null;
  /** @type {any} */
  let term = null;
  /** @type {any} */
  let acctWin = null;
  /** @type {any} */
  let acct = null;
  const reducedM = function () {
    try { return doc.documentElement.classList.contains('reduced-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  };
  const fetchFn = function () { return o.fetch || (typeof fetch === 'function' ? fetch : null); };
  /** 先关掉开着的顶栏窗口 / 终端，再做 f（放到下一个任务里：哨兵出栈的 popstate 还要派给别的窗口，同一个事件里开新窗口会被当成「系统返回」关掉，同上面的互斥） */
  const closeAll = function (/** @type {() => void} */ f) {
    const later = function () { window.setTimeout(f, 0); };
    if (termSheet && termSheet.isOpen()) { termSheet.close(later); return; }
    const open = sheets.find(function (x) { return x.ms.isOpen(); });
    if (open) { open.ms.close(later); return; }
    f();
  };
  /** 开终端窗口；正在滑出收起（哨兵还没出栈）时等它收完再开（最多约 1 秒） @param {number} [n] */
  const openDrawer = function (n) {
    if (!termSheet) return;
    if (!termSheet.isOpen()) { termSheet.open(); return; }
    const left = typeof n === 'number' ? n : 16;
    if (!termSheet.isShown() && left > 0) window.setTimeout(function () { openDrawer(left - 1); }, 60);
  };
  /** 打开终端（主页：首屏那一个滚进视野；其他页：终端窗口），然后 f @param {() => void} [f] */
  const showTerm = function (f) {
    const then = function () { if (f) f(); if (view) view.focus({ scroll: !!homeTerm }); };
    if (homeTerm || !termSheet) { closeAll(then); return; }
    if (termSheet.isShown() && !sheets.some(function (x) { return x.ms.isOpen(); })) { then(); return; }
    closeAll(function () { openDrawer(); then(); });
  };
  /** NAVIGATE 页脚「Ctrl K 终端 ›」：打开终端（主页聚焦首屏那个，其他页开终端窗口） */
  const openTerm = function () { showTerm(); };
  /** 收起终端窗口，然后 after（主页首屏的终端收不起：直接 after） @param {() => void} [after] */
  const closeTerm = function (after) {
    const f = after || function () {};
    if (termSheet && termSheet.isOpen()) termSheet.close(f);
    else f();
  };
  /** 当前地址去掉锁屏 / 回跳参数（上锁之后重新取这一页，服务端画访客态） */
  const cleanHere = function () {
    try {
      const u = new URL(location.href);
      ['entry', 'lock', 'why', 'return'].forEach(function (k) { u.searchParams.delete(k); });
      return u.pathname + (u.search && u.search !== '?' ? u.search : '') + u.hash;
    } catch (e) { return location.pathname; }
  };
  /** 地址参数 @param {string} k */
  const qparam = function (k) { try { return new URLSearchParams(location.search).get(k) || ''; } catch (e) { return ''; } };

  /* 终端身份：首帧按网关注入的页面标记，问服务端（GET /api/lock-session-check）后以回答为准 */
  /** @type {any} */
  const who = T && typeof T.createWho === 'function' ? T.createWho({
    check: function () {
      const f = fetchFn();
      if (!f) return Promise.resolve(null);
      return f(SESSION_CHECK_API, { credentials: 'same-origin', cache: 'no-store' }).then(function (/** @type {Response} */ r) {
        return r && r.ok ? r.json() : null;
      }).then(function (/** @type {any} */ j) { return j && j.ok === true ? { ok: true, by: String(j.by || '') } : null; }, function () { return null; });
    },
    page: function () { const v = doc.documentElement.getAttribute('data-sgx-lock-session'); return v === 'valid' || v === 'locked' ? v : 'unknown'; },
    accountHint: function () { return doc.documentElement.getAttribute('data-sgx-account-session') === 'in'; },
  }) : null;
  /** 终端那一头（给终端里的账号层：登出后收起终端） */
  const termLink = { close: closeTerm };

  /* ---------------- 账号窗口（头像，shell/account/window.js）：v5 S5 不动，外观 / 各层 / 自带命令行照旧；第一次打开时画 ---------------- */
  /** 层名（旧地址 #acct=<子页>、[data-acct-open]）→ 怎么开：o.accountLayer = shell/account/commands.js layerFromPath
   * @param {string} n @returns {{layer: string, reset: boolean, reauth: boolean}} */
  const acctLayer = function (n) { return o.accountLayer ? o.accountLayer(n) : { layer: '', reset: n === 'reset', reauth: false }; };
  /** 下一次打开要直接进的层（旧地址 #acct=… / 奇趣日刻的 sudo root 入口） @type {any} */
  let acctNext = null;
  /** @type {(x?: any) => void} */
  let openAcct = function () {};
  if (acctBtn && acctDlg && o.account) {
    acct = wire(acctBtn, acctDlg, 'sgxAcct', function () {
      if (!acctWin) acctWin = o.account({ dlg: acctDlg, ms: acct.ms, S: trSec('account'), replace: replace, reload: o.reload, who: who });
      const x = acctNext;
      acctNext = null;
      acctWin.onOpen(x || undefined);
    }, undefined, function () { if (acctWin) acctWin.onClose(); });
    if (acct) {
      /** 打开账号窗口（指定层 / 应用）。已开着就按新参数重来一次 @param {any} x */
      openAcct = function (x) {
        acctNext = x || null;
        if (acct.ms.isOpen()) { if (acctWin) { acctWin.onOpen(acctNext || undefined); acctNext = null; } return; }
        closeAll(function () { acct.ms.open(); });
      };
      /* 页面上的入口：[data-acct-open="<层>"]（可带 data-acct-app="curio|daymark"，奇趣 / 日刻的 sudo root：登录 → 判授权 → [y]/[n]，O1 / O6） */
      doc.addEventListener('click', function (e) {
        const tg = /** @type {Element|null} */ (e.target);
        const a = tg && /** @type {HTMLElement|null} */ (tg.closest('[data-acct-open]'));
        if (!a || acctDlg.contains(a)) return;
        const me2 = /** @type {MouseEvent} */ (e);
        if (me2.button !== 0 || me2.metaKey || me2.ctrlKey || me2.shiftKey || me2.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        const lay = acctLayer(a.getAttribute('data-acct-open') || '');
        openAcct({ layer: lay.layer, reset: lay.reset, reauth: lay.reauth, app: a.getAttribute('data-acct-app') || '' });
      });
      /* 旧地址（/account/、/account/devices/ …）跳到这里带 #acct=<层>[&app=…]：打开对应的那一层，去掉 hash（O1） */
      const fromHash = function () {
        const m = /^#acct(?:=([a-z]*))?(?:&app=([a-z]+))?$/.exec(location.hash || '');
        if (!m) return;
        try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) {}
        const lay = acctLayer(m[1] || '');
        window.setTimeout(function () { openAcct({ layer: lay.layer, reset: lay.reset, reauth: lay.reauth, app: m[2] || '' }); }, 0);
      };
      window.setTimeout(fromHash, 0);
      window.addEventListener('hashchange', fromHash);
    }
  }

  if (T && typeof T.createShell === 'function' && (homeTerm || termDlg)) {
    const tile = function (/** @type {string} */ id) { return /** @type {HTMLAnchorElement|null} */ (navDlg ? navDlg.querySelector('a.sgx-nav-tile[data-nav="' + id + '"]') : null); };
    const hrefOf = function (/** @type {string} */ id, /** @type {string} */ dflt) { const a = tile(id); return a ? a.href : dflt; };
    const cur = navDlg ? navDlg.querySelector('a.sgx-nav-tile[aria-current="page"]') : null;
    const curId = cur ? cur.getAttribute('data-nav') || '' : '';
    /** 命令的动作（终端和 AI 窗口里的 $ 命令共用） @type {any} */
    const act = {
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
      /** ls ~/proxy：来源列表（POST /api/account/proxy status；没登录 / 读不到 → null） @returns {Promise<any[]|null>} */
      proxyList: function () {
        const f = fetchFn();
        if (!f) return Promise.resolve(null);
        return f('/api/account/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status' }), credentials: 'same-origin' })
          .then(function (/** @type {Response} */ r) { return r.ok ? r.json() : null; })
          .then(function (/** @type {any} */ j) { return j && j.ok ? j.sources || [] : null; }, function () { return null; });
      },
      theme: function (/** @type {string} */ mode) {
        if (!mode) { closeAll(function () { if (qp) qp.ms.open(); }); return; }
        P.setTheme(/** @type {any} */ (mode === 'auto' ? 'system' : mode));
        paint();
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
        const f = fetchFn();
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
      /** find <词>（v5 S4）：GET /api/find（公开，不走模型）。429 → { limited }；别的失败 → { degraded }（终端打一行固定文案） */
      find: function (/** @type {string} */ q) {
        const f = fetchFn();
        if (!f) return Promise.resolve({ degraded: true });
        const lang = /^zh/i.test(doc.documentElement.lang || '') ? 'zh' : 'en';
        return f(FIND_API + '?q=' + encodeURIComponent(q) + '&lang=' + lang, { credentials: 'same-origin' }).then(function (/** @type {Response} */ r) {
          if (r && r.status === 429) return { limited: true };
          if (!r || !r.ok) return { degraded: true };
          return r.json();
        }).then(function (/** @type {any} */ j) { return j && (j.ok || j.limited) ? j : { degraded: true }; }, function () { return { degraded: true }; });
      },
      daymarkHref: function () { return hrefOf('daymark', '/daymark/'); },
      /* open ~/account[/层]：打开账号窗口（终端统一 T6） */
      account: function (/** @type {string} */ layer) {
        return { href: '~/account' + (layer ? '/' + layer : ''), go: function () { closeAll(function () { openAcct(layer ? { layer: layer } : {}); }); } };
      },
      /* exit：收起终端窗口 */
      close: function () { closeTerm(); },
    };
    term = T.createShell({
      str: T.termStrings(doc),
      cwd: homeTerm ? '~' : ['blog', 'curio', 'daymark', 'wild'].indexOf(curId) >= 0 ? curId : '~',
      act: act,
      who: who,
    });
    /* tty4：AI 窗口里以 $ 开头的输入走同一张命令表；自己的 cwd、自己的历史 sgx-term-hist-4（终端统一 T6c；要输入 / 验证的命令提示去终端跑） */
    /** @type {any} */
    let t4 = null;
    term4Of = function () {
      if (!t4) t4 = { shell: T.createShell({ str: T.termStrings(doc), act: act, histKey: 'sgx-term-hist-4', who: who }), complete: T.complete };
      return t4;
    };
    const coarse = function () { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } };
    const termEl = homeTerm || (termDlg ? termDlg.querySelector('[data-sgx-term]') || termDlg : null);
    if (termDlg && !homeTerm && typeof termDlg.showModal === 'function') {
      const opener = navBtn || /** @type {HTMLElement} */ (doc.body);
      termSheet = o.modalSheet(termDlg, opener, {
        ms: QP_MS,
        stateKey: 'sgxTerm',
        onOpen: function () {
          if (who) who.refresh();
          /* 触屏不直接聚焦输入框（会弹键盘 / 桌面版网站下放大），点一下输入行再打字 */
          if (view && !coarse()) view.focus();
        },
        onClosed: function () {
          if (view) view.closed();
          const a = doc.activeElement;
          if (!a || a === doc.body || termDlg.contains(a)) { try { opener.focus({ preventScroll: true }); } catch (e) {} }
        },
      });
      /* 点遮罩（窗口外）关 */
      termDlg.addEventListener('click', function (e) { if (e.target === termDlg && termSheet) termSheet.close(); });
    }
    if (termEl) {
      view = T.mountTerminal(termEl, term, {
        kh: homeTerm ? 'cmdHome' : 'cmdDrawer',
        onBack: homeTerm ? undefined : function () { if (termSheet) termSheet.close(); },
        isShown: function () { return homeTerm ? true : !!(termSheet && termSheet.isShown()); },
        pmUser: o.pmUser || '',
        layers: function (/** @type {any} */ line) {
          const space = o.space && who ? o.space(line, { who: who, close: closeTerm, reload: function () { replace(cleanHere()); } }) : null;
          const acctTerm = o.accountTerm && who ? o.accountTerm({ S: trSec('account'), line: line, who: who, term: termLink, replace: replace, reload: o.reload }) : null;
          return { space: space, acct: acctTerm };
        },
      });
    }
    if (who && (homeTerm || who.get() !== 'nobody')) who.refresh();
    /* 上锁的地方要进站（SUDO_EVENT，发事件的都是服务端说了没进站：页面标记 locked 或接口 401）：打开终端、预填 sudo styrigx（不替人回车） */
    doc.addEventListener(SUDO_EVENT, function () {
      if (who) who.drop();
      showTerm(function () { if (view) view.prefill(SUDO_LINE); });
    });
    /* 旧地址 ?entry=…（分享链接失效时网关回的 /?entry=1、旧书签；v5 S5 起没有锁屏界面）：没进站就打开终端、预填 sudo styrigx；?entry=sudo 直接跑 */
    const ent = qparam('entry') || qparam('lock');
    if (ent && view && (!who || who.get() === 'nobody')) {
      window.setTimeout(function () { showTerm(function () { if (ent === 'sudo') view.run(SUDO_LINE); else view.prefill(SUDO_LINE); }); }, 0);
    }
    /* 盾牌：v5 S5 起没有盾牌窗口（S6 改成吉祥物）。点它 = 打开终端；没进站预填 sudo styrigx。旧地址 #sec[=<层>] / [data-sec-open] 同 */
    const openShield = function () {
      showTerm(function () {
        if (!view) return;
        /* 身份以服务端为准：问过再决定预填不预填（首帧的页面标记可能还是访客） */
        const w = who ? who.refresh() : Promise.resolve('nobody');
        w.then(function (/** @type {string} */ x) { if (x === 'nobody' && !view.input.value) view.prefill(SUDO_LINE); });
      });
    };
    if (secBtn) {
      secBtn.addEventListener('click', function (e) {
        const me2 = /** @type {MouseEvent} */ (e);
        if (me2.button !== 0 || me2.metaKey || me2.ctrlKey || me2.shiftKey || me2.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        openShield();
      });
    }
    doc.addEventListener('click', function (e) {
      const tg = /** @type {Element|null} */ (e.target);
      const a = tg && tg.closest('[data-sec-open]');
      if (!a) return;
      const me2 = /** @type {MouseEvent} */ (e);
      if (me2.button !== 0 || me2.metaKey || me2.ctrlKey || me2.shiftKey || me2.altKey) return;
      e.preventDefault();
      openShield();
    });
    const secHash = function () {
      if (!/^#sec(?:=[a-z]*)?$/.test(location.hash || '')) return;
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) {}
      window.setTimeout(openShield, 0);
    };
    secHash();
    window.addEventListener('hashchange', secHash);
    /* Ctrl / ⌘ K（全站，桌面）：主页聚焦首屏终端；其他页开合终端窗口（输入法组字时不理） */
    doc.addEventListener('keydown', function (e) {
      if (e.isComposing || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || (e.key !== 'k' && e.key !== 'K')) return;
      e.preventDefault();
      if (homeTerm) { showTerm(); return; }
      if (!termSheet) return;
      if (termSheet.isShown()) termSheet.close();
      else showTerm();
    });
  }

  mountProgress(doc);
  mountPrefetch(doc);
  mountAvBusy(doc);
  mountFootLift(doc);
  mountClock(doc);
  const status = mountStatus(doc);
  if (status && navBtn) navBtn.addEventListener('click', function () { status(); });
  return { nav: nav && nav.ms, qp: qp && qp.ms, ai: ai && ai.ms, acct: acct && acct.ms, openAccount: function (/** @type {any} */ x) { openAcct(x); }, term: termSheet, termShell: term, termView: view, who: who, paint: paint, paintNav: paintNav };
}

/**
 * 顶栏头像外圈的弧（Gray 2026-11-09，参考 mahmad.me）：平时 2.4 秒一圈；页面还在加载、终端在取数据（› fetching…）、Gray AI 在回答时
 * 头像按钮加 .is-busy，CSS 把一圈改成 0.9 秒。各处发 document 上的 `sgx-busy` 事件（detail = true / false），这里按计数合并（几件事同时等也只算一次忙）。
 * @param {Document} [d]
 */
export function mountAvBusy(d) {
  const doc = d || document;
  let n = 0;
  let loading = doc.readyState !== 'complete';
  function paint() {
    const on = n > 0 || loading;
    doc.querySelectorAll('.sgx-tb-av').forEach(function (a) { a.classList.toggle('is-busy', on); });
  }
  doc.addEventListener('sgx-busy', function (e) {
    n = Math.max(0, n + (/** @type {CustomEvent} */ (e).detail ? 1 : -1));
    paint();
  });
  if (loading) {
    const w = doc.defaultView || window;
    w.addEventListener('load', function () { loading = false; paint(); }, { once: true });
  }
  paint();
}

/**
 * 同源链接预取（Gray 2026-11-09）：鼠标停在链接上 65ms / 手指按下时，往 <head> 插一个 <link rel="prefetch">，点下去时页面多半已在缓存里
 * （配合共享外壳 CSS 的跨页 View Transitions 淡入淡出）。只取同源 http(s) 的页面：不取 /api/、/s/（分享短链会消耗）、带下载 / 新窗口 / data-no-prefetch 的、
 * 只差 #锚点的本页；省流量模式（Save-Data / prefers-reduced-data）不取，减弱动效照取；每个地址只取一次。不写内联脚本（CSP 不变）。
 * @param {Document} [d]
 */
export function mountPrefetch(d) {
  const doc = d || document;
  try {
    const c = /** @type {any} */ (navigator).connection;
    if (c && (c.saveData || /(^|-)2g$/.test(String(c.effectiveType || '')))) return;
    /* 系统「减少数据用量」也不取；「减弱动效」不影响预取 */
    if (window.matchMedia && window.matchMedia('(prefers-reduced-data: reduce)').matches) return;
    const probe = doc.createElement('link');
    if (!probe.relList || !probe.relList.supports || !probe.relList.supports('prefetch')) return;
  } catch (e) { return; }
  /** @type {Set<string>} */
  const done = new Set([location.href.split('#')[0]]);
  /** @type {number} */ let timer = 0;
  /** @param {EventTarget|null} t @returns {HTMLAnchorElement|null} */
  function linkOf(t) {
    const el = /** @type {Element|null} */ (t && /** @type {any} */ (t).closest ? t : null);
    const a = /** @type {HTMLAnchorElement|null} */ (el && el.closest('a[href]'));
    if (!a || a.hasAttribute('download') || a.hasAttribute('data-no-prefetch') || (a.target && a.target !== '_self')) return null;
    if (a.protocol !== location.protocol || a.host !== location.host) return null;
    if (/^\/(api|s)\//.test(a.pathname)) return null;
    return a;
  }
  /** @param {HTMLAnchorElement} a */
  function go(a) {
    const u = a.href.split('#')[0];
    if (done.has(u)) return;
    done.add(u);
    const l = doc.createElement('link');
    l.rel = 'prefetch';
    l.href = u;
    l.setAttribute('data-sgx-prefetch', '');
    doc.head.appendChild(l);
  }
  doc.addEventListener('mouseover', function (e) {
    const a = linkOf(e.target);
    if (!a) return;
    clearTimeout(timer);
    timer = window.setTimeout(function () { go(a); }, 65);
  }, { passive: true });
  doc.addEventListener('mouseout', function () { clearTimeout(timer); }, { passive: true });
  doc.addEventListener('touchstart', function (e) {
    const a = linkOf(e.target);
    if (a) go(a);
  }, { passive: true });
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
 * 浮钮给页脚让位（2026-11-08 PR-A）：tmux 页脚 .sgx-foot 露出视口多高，就把 --sgx-foot-lift 写成多少 px（不露 = 0），
 * 写到 AI 浮钮、博客回顶按钮、AI 窗口（桌面浮窗在浮钮上方）这几个元素自己身上——CSS 的 bottom 用 max(安全区, --sgx-foot-lift) 叠在基准上，
 * 所以滑到底时浮钮停在页脚上沿之上、不压状态栏和「联系」。只写这几个元素、值不变不写，不让整页重算样式；滚动 / 尺寸变化按帧合并。
 * @param {Document} [d]
 * @returns {(() => void) | null} 立刻重算一次（测试 / 内容变长后用）
 */
export function mountFootLift(d) {
  const doc = d || document;
  const foot = /** @type {HTMLElement|null} */ (doc.querySelector('.sgx-foot'));
  if (!foot || typeof foot.getBoundingClientRect !== 'function') return null;
  let queued = false;
  let last = -1;
  const calc = function () {
    queued = false;
    const vh = window.innerHeight || doc.documentElement.clientHeight || 0;
    const top = foot.getBoundingClientRect().top;
    const lift = Math.max(0, Math.round(vh - top));
    if (lift === last) return;
    last = lift;
    const v = lift + 'px';
    doc.querySelectorAll('#site-nav .sgx-tb-ai, [data-scroll-top-button], #sgx-ai').forEach(function (el) {
      /** @type {HTMLElement} */ (el).style.setProperty('--sgx-foot-lift', v);
    });
  };
  const queue = function () {
    if (queued) return;
    queued = true;
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(calc);
    else window.setTimeout(calc, 16);
  };
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue, { passive: true });
  /* 内容晚到（列表、状态卡）把页脚往下推、但没有滚动时也要重算 */
  if (typeof ResizeObserver === 'function' && doc.body) {
    try { new ResizeObserver(queue).observe(doc.body); } catch (e) {}
  }
  calc();
  return function () { last = -1; calc(); };
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

/**
 * 服务状态（2026-11 UI 重设计对齐 PR-A，设计稿 nav-v2 STATUS + foot-v1「● 6/6」）：NAVIGATE 的 STATUS 六格 [data-nav-status] 和 tmux 页脚 [data-sgx-status-count]。
 * 数据 = GET /api/status（同源网关 → styrigx-status 的 /summary，要进门会话；监测项见 workers/status/src/targets.js）：
 *   space / blog / curio / daymark = 主站那一项（四站同一个 Pages、同一条网关链路，子站不单独测）；gray-ai = ai 那一项；
 *   auth = 网关本身（这一问能回 200 就是在线，延迟 = 这一问的往返）。延迟取各项最近一次检查的 last.ms。
 * 页面加载后空闲时取一次；结果在 sessionStorage 存 2 分钟（翻页不重复问）；打开 NAVIGATE 时过期了再取。
 * 取不到（锁着 401 / 出错 / 离线）：点保持灰色、延迟空着，头部维持「待接入」字样，页脚 –/6。
 * @param {Document} [d]
 * @returns {(() => void) | null} 刷新（缓存没过期就不发请求）
 */
export function mountStatus(d) {
  const doc = d || document;
  const box = doc.querySelector('[data-nav-status]');
  const counts = Array.from(doc.querySelectorAll('[data-sgx-status-count]'));
  if (!box && !counts.length) return null;
  const KEY = 'sgx-status-cache', TTL = 120000;
  /** @param {any} v */
  const paint = function (v) {
    if (!v || !v.cells) return;
    let up = 0;
    for (const id of Object.keys(v.cells)) {
      const c = v.cells[id];
      if (c.up) up++;
      const li = box && box.querySelector('[data-st="' + id + '"]');
      if (!li) continue;
      li.setAttribute('data-up', c.up ? '1' : '0');
      const em = li.querySelector('[data-st-ms]');
      if (em) em.textContent = typeof c.ms === 'number' ? Math.round(c.ms) + 'ms' : '';
    }
    const n = Object.keys(v.cells).length;
    if (box) {
      box.setAttribute('data-state', up === n ? 'up' : 'partial');
      const sum = box.querySelector('[data-st-sum]');
      if (sum) sum.textContent = up === n ? (sum.getAttribute('data-up-text') || '● ' + up + '/' + n) : up + '/' + n;
    }
    counts.forEach(function (el) {
      const i = el.querySelector('i');
      el.textContent = ' ' + up + '/' + n;
      if (i) el.insertBefore(i, el.firstChild);
      el.setAttribute('data-up', up === n ? '1' : '0');
    });
    /* 主页 [04] 旷野 status 小卡和首屏胶囊（apps/index.js）接同一份结果，不另取（2026-11 对齐 PR-B） */
    try { doc.dispatchEvent(new CustomEvent('sgx:status-cells', { detail: v })); } catch (e) {}
  };
  /** @param {any} j @param {number|null} rtt */
  const cellsOf = function (j, rtt) {
    /** @type {Record<string, any>} */
    const by = {};
    (j && Array.isArray(j.sites) ? j.sites : []).forEach(function (/** @type {any} */ x) { if (x && x.site) by[x.site] = x; });
    /** @param {any} x */
    const one = function (x) { return x ? { up: !!x.up, ms: x.last && typeof x.last.ms === 'number' ? x.last.ms : null } : { up: false, ms: null }; };
    const sp = one(by.space);
    return { space: sp, blog: sp, curio: sp, daymark: sp, 'gray-ai': one(by.ai), auth: { up: true, ms: rtt } };
  };
  let busy = false;
  /* 服务状态页（/status/，#st-root）自己每 60 秒取 /api/status：外壳不再另问一遍，接它取到的结果（sgx:status 事件）来画、写缓存 */
  const ownPage = !!doc.getElementById('st-root');
  if (ownPage) {
    doc.addEventListener('sgx:status', function (/** @type {any} */ e) {
      const j = e && e.detail;
      if (!j || j.ok === false) return;
      const v = { t: Date.now(), cells: cellsOf(j, null) };
      try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch (err) {}
      paint(v);
    });
  }
  const refresh = function () {
    let cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) {}
    if (cached && cached.t && (ownPage || Date.now() - cached.t < TTL)) { paint(cached); return; }
    if (ownPage || busy || typeof fetch !== 'function') return;
    busy = true;
    const t0 = Date.now();
    fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || j.ok === false) return;
        const v = { t: Date.now(), cells: cellsOf(j, Date.now() - t0) };
        try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {}
        paint(v);
      })
      .catch(function () {})
      .then(function () { busy = false; });
  };
  /* CI 静态测试构建（SGX_TEST_NO_WB，同数字健康）没有 /api：加载时不自动问，免得 404 进控制台（Lighthouse errors-in-console）；
     e2e 要测这条时先设 window.__sgxStatusApi = true（只在测试构建里有这个分支，生产构建 define 为 false 整段摇掉；博客测试构建同样定义（partials/blog/script.html，对齐 PR-C1）；奇趣 / 日刻构建没有这个 define，按生产走） */
  const noApi = typeof SGX_TEST_NO_WB !== 'undefined' && SGX_TEST_NO_WB && !(/** @type {any} */ (window).__sgxStatusApi);
  if (noApi) return function () {};
  const idle = /** @type {any} */ (window).requestIdleCallback || function (/** @type {() => void} */ f) { return window.setTimeout(f, 1200); };
  idle(refresh);
  return refresh;
}
