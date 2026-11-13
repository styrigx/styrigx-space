/**
 * @fileoverview 顶栏的三个弹出窗口（2026-11-04 P5-1；2026-11 UI 重设计 PR-1 顶栏 v3；v5 S6 顶栏 E：盾牌 · 外观 · 四格 | >_ · 头像）：NAVIGATE #sgx-nav（四格按钮）、外观 #sgx-qp（调色盘按钮）、AI 窗口 #sgx-ai（右下角浮钮），
 * 外加顶栏底边的滑页进度条 .sgx-tb-prog 和 tmux 页脚的 CST 时钟。
 * 共享外壳组件：四个站共用这一份（主站 topbar/quick-panel.js 调它，子站入口脚本调它）。
 * 自成一体：不 import 任何东西；状态机（modal-sheet.js）、外观 setter（主站 prefs/prefs.js / 子站 prefs-write.js）、AI 内容（ai.js）、
 * 键盘高度订阅（vk.js 的 onKeyboardHeight，转给 AI 窗口；P4-3 PR-3）都由调用方传进来。
 *
 * - 三个窗口都是非模态 <dialog>（modalSheet modal:false → show()）：从顶栏下方落下，顶栏留在上面可点；开合 / 系统返回 / Esc / bfcache 走 modalSheet。
 * - 互斥：一个开着时点顶栏（含 AI 浮钮）上别的东西，先关这个（等哨兵出栈）再补点那一下。
 * - 点遮罩（面板以外）关闭；焦点打开时进面板，关上时还给按钮；Tab / Shift+Tab 圈在「按钮 + 面板控件」里。
 * - NAVIGATE：01 主页 … 04 日刻（当前项「开」态；05 旷野 2026-11-12 删除）；已在当前项那一页时点它只关面板，其余关完再跳（不留哨兵）。
 *   lang 分段 EN | Auto | 中文（选中即保存；明确的语言和本页不同就去另一种语言的同一页，Auto 只在主站首页换）、layout 分段（Mobile | Auto | DeX，模式规则见共享外壳 layout-mode.js）、
 *   STATUS（v6 P4 起「分享本页」磁贴随分享短链删除，Gray 11-11 17:47）、esc 关闭。
 * - 外观：PALETTE 色板列表 + 恢复默认（2026-11-12 调色板 v4：MODE 三段删除，深浅只由调色板决定）。
 * - 盾牌（v5 S6；v6 P4-3 起 = 身份徽章四档，定稿 v5.5 §七）：不开窗口，打开终端按身份预填——访客 `su `（GUEST_LINE）、普通用户 `exit`、站长 `su root`、root `exit`（只预填、回车才生效）。
 *   旧地址 #sec / [data-sec-open] 同样只打开终端（访客预填）。v6 P4 起旧的「退出进站会话 [y/N]」（钥匙层 lock）随旧会话删除。
 * - 头像 = whoami（定稿 v5.5 §七）：访客点 = 打开终端预填 `su `；站长与 root 点 = 打开账号页；普通用户（uid 1001 起）的头像只作装饰、不可点；头像一份，归站长。
 *   页面没有网关标记（本地 / 测试构建）且没有 v6 身份时点了开账号卡片（只展示，点一行 = 打开终端预填命令）。
 * - >_ 终端按钮（v5 S6）：开合全站终端（同 Ctrl / ⌘ K）。
 * - 终端（v5 S5 终端合一）：调用方传 terminal（term/terminal.js 整个模块）、identityTerm（v6 身份层 identity/layer.js）、accountTerm（终端里的账号层
 *   account/cmd/layer.js mountAccountLayer）、account（账号卡片 account/window.js mountAccountWindow，只展示）；本文件仍不 import。每页一个终端 #sgx-term（桌面居中大窗、手机整块卡片）。
 *   每次打开终端都是干净的新会话（S9：view.fresh()，history 照旧）。页面上的账号入口（[data-acct-open]、旧地址 #acct=…）都去终端：子页 → 预填命令。
 *   顶栏 >_、Ctrl / ⌘ K 与 NAVIGATE 里的「$ terminal」打开它；盾牌也打开它（访客预填 su ）。命令的动作（滚动 / 跳转 / 外观 / AI / 账号窗口）都在这里接。
 * - 上锁的地方（v5 S3：AI 窗口、状态页 status 窗、奇趣音乐的播放，以及各处接口回 401）都只发 document 上的 `sgx:sudo` 事件（SUDO_EVENT），
 *   这里是唯一接它的地方：打开终端、输入行预填 `su `（v6 割接；不替人回车，用户名由人敲）；回车后在终端里验证。
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
/** 关键词搜索（v5 S4，网关 GET /api/find，公开） */
const FIND_API = '/api/find';
/** 上锁的地方要人进站时发的事件（= auth/sudo.js SUDO_EVENT，本文件不 import，抄一份） */
export const SUDO_EVENT = 'sgx:sudo';
/** 页面标记变了的事件（window 上；= auth/guard.js SESSION_EVENT，本文件不 import，抄一份）。detail { ok, live }：
 *  守卫首帧发的没有 live；2c 起 v6 命令就地切标记时发 live: true（云同步、名片、AI 窗口、服务状态页、守卫各自接） */
export const SESSION_EVENT = 'sgx:session';

/**
 * 2c：就地切页面标记 <html data-sgx-lock-session>（v6 su / exit / lock 之后，不整页刷新）。
 * 只在网关注入过标记（valid / locked）时切：没有标记 = 页面没经过网关（本地 / 测试构建），不动；没变不发事件。
 * @param {Document} doc @param {'valid'|'locked'} state @returns {boolean} 切了没有
 */
export function switchPageSession(doc, state) {
  const el = doc.documentElement;
  const cur = el.getAttribute('data-sgx-lock-session');
  if (cur !== 'valid' && cur !== 'locked') return false;
  if (state !== 'valid' && state !== 'locked') return false;
  if (cur === state) return false;
  el.setAttribute('data-sgx-lock-session', state);
  const w = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  try { if (w) w.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: { ok: state === 'valid', live: true } })); } catch (e) {}
  return true;
}
/** 访客入口预填（v6 割接，定稿 §七：访客头像点击预填「su 」；盾牌、上锁的地方、旧锁屏地址同一行；用户名由人敲） */
export const GUEST_LINE = 'su ';

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
 * @property {() => string} palette
 * @property {(p: string) => void} setPalette
 * @property {string} DEFAULT_PALETTE
 * @property {(v: 'system'|'zh'|'en') => string} setLang 写语言偏好，返回要去的地址；返回 '' 时按实际语言决定：和本页不同就去语言行的 data-href
 * @property {() => string} [langPref] 当前语言偏好 system / zh / en（不传按本页语言）
 * @property {() => string} [layoutPref]
 * @property {(v: string) => void} [setLayout]
 */

/**
 * @param {{
 *   modalSheet: Function,
 *   prefs: TopbarPrefs,
 *   fetch?: typeof fetch,
 *   navigate?: (url: string) => void,
 *   replace?: (url: string) => void,
 *   ai?: (dlg: HTMLDialogElement, o: { lang: 'zh'|'en', close: Function, navigate: Function, keyboard?: Function }) => ({ onOpen?: () => void } | void),
 *   keyboard?: (cb: (h: number) => void) => () => void,
 *   terminal?: any,
 *   account?: (o: any) => any,
 *   accountTerm?: (o: any) => any,
 *   accountLayer?: (n: string) => { cmd: string },
 *   identityTerm?: (o: any) => any,
 *   identityWhoami?: () => Promise<any>,
 *   identityMarker?: (d: Document) => boolean,
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
   * 切出「DeX」：viewport meta 刚被 __sgxViewportSync 原地还原成 device-width，逐帧看新视口生效没有
   * （最多约 12 帧——浏览器应用新 meta 是异步的，忙的时候不止两帧）。cb(true) = 生效（不用重载），cb(false) = 只能整页重载。
   * 生效 = 布局视口回到手机宽（innerWidth < 720）且整页看得全（visualViewport 宽 ≥ 布局视口 90%，没停在放大比例上）。
   * 切进 DeX 不走这里，直接重载：2026-11-13 Gray S23 录屏，三星浏览器原地改成 980 宽后先整页适配半秒，
   * 接着把缩放弹回 1 倍（只剩 980 宽页面的左边一截），约 5 秒后才由兜底重载恢复；偶发。
   * @param {(ok: boolean) => void} cb
   */
  function viewportInPlace(cb) {
    const w = window;
    const good = function () {
      const vv = w.visualViewport;
      return w.innerWidth < 720 && (!vv || vv.width >= w.innerWidth * 0.9);
    };
    /** @param {number} n */
    const wait = function (n) {
      raf(function () {
        if (good()) return cb(true);
        if (n <= 1) return cb(false);
        wait(n - 1);
      });
    };
    wait(12);
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
    nav = wire(navBtn, navDlg, 'sgxNav', function () { paintNav(); });
    if (nav) {
      const ms = nav.ms;
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
        if (opt) { pickLang(opt.getAttribute('data-qp-lang') || 'system'); return; }
        const c = /** @type {HTMLElement|null} */ (tg.closest('[data-qp]'));
        if (c) {
          const id = c.getAttribute('data-qp');
          if (id === 'term') { ms.close(function () { window.setTimeout(openTerm, 0); }); return; }
          return;
        }
        const sb = /** @type {HTMLButtonElement|null} */ (tg.closest('[data-qp-seg="layout"] button'));
        if (sb && !sb.disabled) {
          if (P.setLayout) P.setLayout(sb.getAttribute('data-v') || '');
          /* 手机屏切进 / 切出「DeX」：共享外壳 layout-mode.js 把 viewport 换成 980 宽（或还原）。
             切进 DeX（meta 成了 width=N）：整页重载。原地改在三星浏览器上偶发弹回 1 倍缩放（2026-11-13 Gray S23 录屏），重载最稳。
             切出 DeX：先原地生效（viewportInPlace，2026-11-07 Gray 真机：一律重载会白闪），没生效才重载。
             重载前先关面板（退掉历史哨兵，返回键不多一步），并把此刻页面底色交给下一页首帧（layout-mode.js __sgxFirstPaint 读 sessionStorage sgx-fp-bg），不露浏览器白底 */
          const vw = /** @type {any} */ (window).__sgxViewportSync;
          if (typeof vw === 'function' && vw()) {
            const reload = function () {
              try { sessionStorage.setItem('sgx-fp-bg', getComputedStyle(doc.documentElement).backgroundColor); } catch (e) {}
              const go = o.reload || function () { location.reload(); };
              if (nav && nav.ms.isOpen()) nav.ms.close(go);
              else go();
            };
            const vm = doc.querySelector('meta[name="viewport"]');
            if (/^width=\d+$/.test(vm ? vm.getAttribute('content') || '' : '')) { reload(); return; }
            viewportInPlace(function (ok) {
              if (!ok) return reload();
              relayout();
              paintNav();
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

  /* ---------------- 外观（PALETTE；2026-11-12 调色板 v4：深浅模式删除，深浅只由调色板决定） ---------------- */
  let qp = null;
  let paint = function () {};
  if (qpBtn && qpDlg) {
    paint = function () {
      const p = P.palette();
      qpDlg.querySelectorAll('[data-qp-palette]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-qp-palette') === p ? 'true' : 'false');
      });
      const rs = qpDlg.querySelector('[data-qp-reset]');
      if (rs) rs.setAttribute('aria-disabled', p === P.DEFAULT_PALETTE ? 'true' : 'false');
    };
    qp = wire(qpBtn, qpDlg, 'sgxQp', function () { paint(); });
    if (qp) {
      qpDlg.addEventListener('click', function (e) {
        const tg = /** @type {Element|null} */ (e.target);
        if (!tg) return;
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
      const el = doc.getElementById('sgx-i18n-frame');
      const j = el && el.textContent ? JSON.parse(el.textContent) : null;
      return j && j[sec] && typeof j[sec] === 'object' ? j[sec] : {};
    } catch (e) { return {}; }
  };
  /* ---------------- 终端（v5 S5 终端合一：锁屏 tty1、主页 tty2、盾牌 tty3、账号 tty5 合成一个；term/terminal.js） ----------------
     一个会话、一份历史；提示符按身份（nobody / link / styrigx / root，服务端说了算）。桌面是居中大窗、手机整块卡片（#sgx-term）；
     v5 S7 起主页首屏是 neofetch、不再嵌终端，四站都用 #sgx-term（S8 删了主页嵌入终端的代码路径）。v6 身份层（o.identityTerm：identity/layer.js）和账号层（o.accountTerm：account/cmd/layer.js）共用它的输入行。 */
  const T = o.terminal;
  const termDlg = /** @type {HTMLDialogElement|null} */ (doc.getElementById('sgx-term'));
  const acctBtn = /** @type {HTMLElement|null} */ (doc.querySelector('#site-nav .sgx-tb-av'));
  const acctDlg = /** @type {HTMLDialogElement|null} */ (doc.getElementById('sgx-acct'));
  const secBtn = /** @type {HTMLElement|null} */ (doc.querySelector('#site-nav .sgx-tb-shield'));
  /** 顶栏 >_ 终端按钮（v5 S6 顶栏 E） */
  const termBtn = /** @type {HTMLElement|null} */ (doc.querySelector('#site-nav .sgx-tb-term'));
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
  /** 打开终端窗口，然后 f @param {() => void} [f] */
  const showTerm = function (f) {
    const then = function () { if (f) f(); if (view) view.focus(); };
    if (!termSheet) { closeAll(then); return; }
    if (termSheet.isShown() && !sheets.some(function (x) { return x.ms.isOpen(); })) { then(); return; }
    closeAll(function () { openDrawer(); then(); });
  };
  /** NAVIGATE 页脚「Ctrl K 终端 ›」：打开终端窗口 */
  const openTerm = function () { showTerm(); };
  /** 收起终端窗口，然后 after（主页首屏的终端收不起：直接 after） @param {() => void} [after] */
  const closeTerm = function (after) {
    const f = after || function () {};
    if (termSheet && termSheet.isOpen()) termSheet.close(f);
    else f();
  };
  /** 地址参数 @param {string} k */
  const qparam = function (k) { try { return new URLSearchParams(location.search).get(k) || ''; } catch (e) { return ''; } };

  /* 终端身份（v6 P4 起只有 v6）：POST /api/identity whoami；登录标记 cookie sgx-id 在才在首帧问，以回答为准 */
  /** @type {any} */
  const who = T && typeof T.createWho === 'function' ? T.createWho({
    whoami: o.identityWhoami,
    v6Hint: function () { return !!(o.identityMarker && o.identityMarker(doc)); },
  }) : null;
  /** 终端那一头（给终端里的账号层） */
  const termLink = { close: closeTerm, shown: function () { return !!(termSheet && termSheet.isShown()); } };

  /* ---------------- 账号卡片（头像，account/window.js；S9 起只展示）：第一次打开时画 ---------------- */
  /** 入口名（旧地址 #acct=<子页>、[data-acct-open]）→ 在终端里怎么开：o.accountLayer = account/commands.js layerFromPath
   * @param {string} n @returns {{cmd: string}} */
  const acctLayer = function (n) { return o.accountLayer ? o.accountLayer(n) : { cmd: '' }; };
  /** 打开账号卡片 */
  let openAcct = function () {};
  /** 打开终端、输入行预填一条命令（账号卡片的行、页面入口的子页） @type {(cmd: string) => void} */
  let termPrefill = function () {};
  /* 访客（没有 v6 身份）：判断同步看终端身份（首帧 = 网关注入的页面标记，问过服务端以回答为准）；页面没有网关标记（本地 / 测试构建）不当访客。
     捕获阶段挂在头像自己身上：比 wire 的冒泡监听先到，拦下就到此为止 */
  const avGuest = function () {
    if (!who) return false;
    const pg = doc.documentElement.getAttribute('data-sgx-lock-session');
    if (pg !== 'valid' && pg !== 'locked') return false;
    return who.get().indexOf('u:') !== 0;
  };
  /**
   * 徽章四档（定稿 v5.5 §七）：root（含救援）· webmaster 站长 styrigx · user 普通用户 · guest 访客（页面有网关标记、没有 v6 身份）；
   * 都不是（本地 / 测试构建没有网关标记、还没问到身份）→ ''。
   * @returns {''|'guest'|'user'|'webmaster'|'root'}
   */
  const tierOf = function () {
    const u = who && who.v6 ? who.v6() : null;
    if (u) return u.root ? 'root' : u.webmaster === true ? 'webmaster' : 'user';
    return avGuest() ? 'guest' : '';
  };
  /** 徽章点击预填（按还能晋升到哪一档；到顶就 exit） @param {string} t */
  const shieldCmd = function (t) {
    if (t === 'webmaster') return 'su root';
    if (t === 'user' || t === 'root') return 'exit';
    return t === 'guest' || !who || who.get() === 'nobody' ? GUEST_LINE : '';
  };
  /* 头像 = whoami（定稿 v5.5 §七）：全站只有一份配置，头像归站长——谁登录都显示站点头像（不再按 uid 取 /avatar/u<uid>-*），root 叠一个「#」标记；
     站长与 root 点头像打开账号页；普通用户（uid 1001 起）的头像只作装饰、不可点击；访客点头像 = 预填「su 」。 */
  /** 普通用户（不是站长、不是 root）：头像不可点（定稿 v5.5 §七） */
  const avDecor = function () {
    const u = who && who.v6 ? who.v6() : null;
    return !!(u && !u.root && u.webmaster !== true);
  };
  /** 头像该预填的命令：只有访客预填 su （已登录 → ''，交给账号页） */
  const avV6Cmd = function () {
    const u = who && who.v6 ? who.v6() : null;
    if (!u) return avGuest() ? GUEST_LINE : '';
    return '';
  };
  const paintAvV6 = function () {
    if (!acctBtn) return;
    const u = who && who.v6 ? who.v6() : null;
    const img = /** @type {HTMLImageElement|null} */ (acctBtn.querySelector('img.sgx-tb-avatar'));
    if (img) {
      if (!img.hasAttribute('data-sgx-src0')) img.setAttribute('data-sgx-src0', img.getAttribute('src') || '');
      const src0 = img.getAttribute('data-sgx-src0') || '';
      if (img.getAttribute('src') !== src0) img.setAttribute('src', src0);
    }
    /* 头像角标：root「#」、站长「$」（同提示符末字，Gray 11-12 00:33）；普通用户、访客不加 */
    const ch = u ? (u.root ? '#' : u.webmaster === true ? '$' : '') : '';
    let mark = acctBtn.querySelector('.sgx-tb-av-mark');
    if (ch) {
      if (!mark) {
        mark = doc.createElement('span');
        mark.className = 'sgx-tb-av-mark';
        mark.setAttribute('aria-hidden', 'true');
        acctBtn.appendChild(mark);
      }
      if (mark.textContent !== ch) mark.textContent = ch;
    } else if (mark) mark.remove();
    if (u) acctBtn.setAttribute('data-sgx-v6', u.root ? 'root' : 'user');
    else acctBtn.removeAttribute('data-sgx-v6');
  };
  const paintAv = function () {
    if (!acctBtn) return;
    /* 普通用户：纯装饰（同访客时代的死按钮写法 aria-disabled，外观不变） */
    if (avDecor()) acctBtn.setAttribute('aria-disabled', 'true');
    else acctBtn.removeAttribute('aria-disabled');
  };
  if (acctBtn) {
    /* 访客：点头像 = 打开终端预填 su （不开账号卡片）；已登录不拦，冒泡给账号卡片 */
    acctBtn.addEventListener('click', function (e) {
      /* 普通用户的头像不可点（定稿 v5.5 §七）：什么都不开，也不按链接走 */
      if (avDecor()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      const c = avV6Cmd();
      if (!c) return;
      const me2 = /** @type {MouseEvent} */ (e);
      if (me2.button !== 0 || me2.metaKey || me2.ctrlKey || me2.shiftKey || me2.altKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      termPrefill(c);
    }, true);
    /* 访客的中键 / 辅助键点（auxclick）不按链接走（账号卡片只给已进站的人） */
    acctBtn.addEventListener('auxclick', function (e) { if ((avGuest() && !(who && who.v6 && who.v6())) || avDecor()) e.preventDefault(); }, true);
    paintAv();
    paintAvV6();
    if (who) { who.on(paintAv); who.on(paintAvV6); }
  }
  /* 盾牌身份徽章（定稿 v5.5 §七）：四档图形（CSS 按 data-sgx-tier 换部件与颜色，partials/common/icon.html tb-shield）。
     没有 v6 身份且页面不是网关标记的访客（本地 / 测试构建）→ 不写档，原样 */
  const paintShield = function () {
    if (!secBtn) return;
    const t = tierOf();
    if (t) secBtn.setAttribute('data-sgx-tier', t);
    else secBtn.removeAttribute('data-sgx-tier');
  };
  if (secBtn) {
    paintShield();
    if (who) who.on(paintShield);
  }
  /* 环境提示符 / AI 窗提问行（<html data-sgx-account-session>，layout-mode.js 首帧写 nobody / out）：谁登录显示谁，和终端提示符一致（Gray 11-11 22:46）——
     访客 = nobody（nobody@space），普通用户 / 站长 = out（<名>@space：名字写进 .sgx-envps-u 和 --sgx-ps-user），root（u:root）= in（root@space）。
     身份变了就改；首帧有登录标记的，whoami 回答后按回答再画一次（回答是访客时 who.on 不会触发） */
  if (who) {
    const paintEnvPs = function (/** @type {string} */ w) {
      try {
        const de = doc.documentElement;
        const nm = w.indexOf('u:') === 0 ? w.slice(2) : '';
        de.setAttribute('data-sgx-account-session', !nm ? 'nobody' : nm === 'root' ? 'in' : 'out');
        if (nm && nm !== 'root' && /^[a-z][a-z0-9-]{0,31}$/.test(nm)) {
          de.style.setProperty('--sgx-ps-user', '"' + nm + '"');
          doc.querySelectorAll('.sgx-envps-u').forEach(function (el) { el.textContent = nm; });
        } else de.style.removeProperty('--sgx-ps-user');
      } catch (e) {}
    };
    who.on(paintEnvPs);
    if (who.v6Hinted()) who.refresh().then(function () { paintEnvPs(who.get()); }, function () {});
  }
  /* 首帧（AI 窗随页面恢复打开时）：有 v6 登录标记、whoami 还没回答前，AI 窗的消息列表（带 in / out 标签）先不显示，
     免得 root 先看到 out 那组标签；whoami 回答后（上面按结果设好 in / out）再显示，出错也照常显示（Gray 11-11 19:47） */
  if (who && aiDlg && who.v6Hinted()) {
    const aiList = /** @type {HTMLElement|null} */ (aiDlg.querySelector('[data-ai-list]'));
    if (aiList) {
      aiList.style.visibility = 'hidden';
      const showList = function () { aiList.style.visibility = ''; };
      who.refresh().then(showList, showList);
    }
  }
  if (acctBtn && acctDlg && o.account) {
    acct = wire(acctBtn, acctDlg, 'sgxAcct', function () {
      if (!acctWin) acctWin = o.account({ dlg: acctDlg, ms: acct.ms, S: trSec('account'), who: who, run: function (/** @type {string} */ c) { termPrefill(c); } });
      acctWin.onOpen();
    }, undefined, function () { if (acctWin) acctWin.onClose(); });
    if (acct) {
      openAcct = function () {
        if (acct.ms.isOpen()) return;
        closeAll(function () { acct.ms.open(); });
      };
    }
  }
  /** 页面入口 → 终端（子页预填命令）或账号卡片（没指定）。v6 P4 起旧的 reset / reauth / 奇趣日刻授权同意入口删了 @param {string} name */
  const acctEntry = function (name) {
    const lay = acctLayer(name);
    if (lay.cmd) { termPrefill(lay.cmd); return; }
    openAcct();
  };
  /* 页面上的入口：[data-acct-open="<名字>"] */
  doc.addEventListener('click', function (e) {
    const tg = /** @type {Element|null} */ (e.target);
    const a = tg && /** @type {HTMLElement|null} */ (tg.closest('[data-acct-open]'));
    if (!a || (acctDlg && acctDlg.contains(a))) return;
    const me2 = /** @type {MouseEvent} */ (e);
    if (me2.button !== 0 || me2.metaKey || me2.ctrlKey || me2.shiftKey || me2.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    acctEntry(a.getAttribute('data-acct-open') || '');
  });
  /* 旧地址（/account/、/account/devices/ …）跳到这里带 #acct=<名字>：同上，去掉 hash（O1；&app= 随应用授权删除，v6 P4） */
  const fromHash = function () {
    const m = /^#acct(?:=([a-z]*))?$/.exec(location.hash || '');
    if (!m) return;
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) {}
    window.setTimeout(function () { acctEntry(m[1] || ''); }, 0);
  };
  window.setTimeout(fromHash, 0);
  window.addEventListener('hashchange', fromHash);

  if (T && typeof T.createShell === 'function' && termDlg) {
    const tile = function (/** @type {string} */ id) { return /** @type {HTMLAnchorElement|null} */ (navDlg ? navDlg.querySelector('a.sgx-nav-tile[data-nav="' + id + '"]') : null); };
    const hrefOf = function (/** @type {string} */ id, /** @type {string} */ dflt) { const a = tile(id); return a ? a.href : dflt; };
    const cur = navDlg ? navDlg.querySelector('a.sgx-nav-tile[aria-current="page"]') : null;
    const curId = cur ? cur.getAttribute('data-nav') || '' : '';
    /** 命令的动作（终端和 AI 窗口里的 $ 命令共用） @type {any} */
    const act = {
      cd: function (/** @type {string} */ dir) {
        /* 主页上有这一节（[data-term-dir]）就滚过去；~ 回到首屏；其余去那个站。
           v5 S7：主页首屏不再嵌终端，终端是窗口——先收起窗口再滚（窗口开着时页面滚不动） */
        const sec = dir === '~' ? doc.getElementById('home-hero') : doc.querySelector('[data-term-dir="' + dir + '"]');
        if (sec) {
          const scroll = function () { try { sec.scrollIntoView({ behavior: reducedM() ? 'auto' : 'smooth', block: 'start' }); } catch (e) {} };
          if (termSheet && termSheet.isOpen()) termSheet.close(scroll);
          else scroll();
          return { kind: 'scroll', label: dir === '~' ? '' : sec.getAttribute('data-term-label') || dir };
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
      /** theme [调色板 id]：没参数开外观面板；有参数切调色板（id 由终端命令校验） */
      theme: function (/** @type {string} */ id) {
        if (!id) { closeAll(function () { if (qp) qp.ms.open(); }); return; }
        P.setPalette(id);
        paint();
      },
      /** 调色板 id 列表（theme 命令补全 / 校验，顺序 = 面板顺序） @returns {string[]} */
      palettes: function () {
        return qpDlg ? Array.from(qpDlg.querySelectorAll('[data-qp-palette]')).map(function (b) { return b.getAttribute('data-qp-palette') || ''; }).filter(Boolean) : [];
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
      /* open ~/account：打开账号卡片（S9 起只展示，没有层） */
      account: function () {
        return { href: '~/account', go: function () { closeAll(openAcct); } };
      },
      /* exit：收起终端窗口 */
      close: function () { closeTerm(); },
    };
    term = T.createShell({
      str: T.termStrings(doc),
      cwd: ['blog', 'curio', 'daymark'].indexOf(curId) >= 0 ? curId : '~',
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
    const termEl = termDlg ? termDlg.querySelector('[data-sgx-term]') || termDlg : null;
    if (termDlg && typeof termDlg.showModal === 'function') {
      const opener = termBtn || navBtn || /** @type {HTMLElement} */ (doc.body);
      termSheet = o.modalSheet(termDlg, opener, {
        ms: QP_MS,
        stateKey: 'sgxTerm',
        onOpen: function () {
          /* 每次打开都是干净的新会话（S9） */
          if (view) view.fresh();
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
      /* 键盘跟随（Gray 2026-11-12 16:37）：触屏输入框聚焦时把键盘高度写进 --sgx-kb，窗口缩到键盘上方、输入行贴着键盘；收起 / 失焦 / 关窗恢复。桌面不动 */
      /** @type {(() => void)|null} */ let termKbStop = null;
      let termKbSeen = false;
      const termBody = /** @type {HTMLElement|null} */ (termDlg.querySelector('[data-term-body]'));
      const termCard = /** @type {HTMLElement|null} */ (termDlg.querySelector('.sgx-term'));
      /** @type {number} */ let termKbH = 0;
      /** @type {(() => void)|null} */ let termVvStop = null;
      /* 窗口下沿 = min(键盘上沿, 可视区底) − 8px：浏览器平移 / 缩小可视区时（三星真机）也不让窗口越过可视区，
         否则浏览器为露出光标把整页往上推、顶栏出屏（Gray 2026-11-12 真机视频）。直接给 px，不靠百分比解析 */
      const termKbFit = function () {
        if (!(termKbH > 0)) return;
        const vv = window.visualViewport;
        let bottom = window.innerHeight - termKbH;
        if (vv && vv.scale <= 1.01) bottom = Math.min(bottom, vv.offsetTop + vv.height);
        const top = termCard ? termCard.getBoundingClientRect().top : 0;
        termDlg.style.setProperty('--sgx-term-kb-max', Math.max(120, Math.floor(bottom - top - 8)) + 'px');
        if (termBody) termBody.scrollTop = termBody.scrollHeight;
      };
      let termFitRaf = 0;
      const termKbFitSoon = function () {
        if (!termFitRaf) termFitRaf = requestAnimationFrame(function () { termFitRaf = 0; termKbFit(); });
      };
      const termKbSet = function (/** @type {number} */ h) {
        termKbH = h > 0 ? Math.round(h) : 0;
        termDlg.style.setProperty('--sgx-kb', termKbH + 'px');
        termDlg.toggleAttribute('data-kb', termKbH > 0);
        /* 先挂 data-kb 再算、再滚到底：滚动要按收窄后的正文高度算 */
        if (termKbH > 0) termKbFit(); else termDlg.style.setProperty('--sgx-term-kb-max', '');
        /* 键盘弹着时：可视区 resize / scroll、打字、输出变长都重算（VirtualKeyboard API 只在键盘几何变时发 geometrychange） */
        if (termKbH > 0 && !termVvStop) {
          const vv = window.visualViewport;
          /** @type {MutationObserver|null} */ let mo = null;
          if (vv) { vv.addEventListener('resize', termKbFitSoon); vv.addEventListener('scroll', termKbFitSoon); }
          termDlg.addEventListener('input', termKbFitSoon);
          try { if (termBody) { mo = new MutationObserver(termKbFitSoon); mo.observe(termBody, { childList: true, subtree: true }); } } catch (e) { mo = null; }
          termVvStop = function () {
            if (vv) { vv.removeEventListener('resize', termKbFitSoon); vv.removeEventListener('scroll', termKbFitSoon); }
            termDlg.removeEventListener('input', termKbFitSoon);
            if (mo) mo.disconnect();
            if (termFitRaf) { cancelAnimationFrame(termFitRaf); termFitRaf = 0; }
          };
        } else if (!(termKbH > 0) && termVvStop) {
          const st = termVvStop;
          termVvStop = null;
          st();
        }
      };
      const termKbEnd = function () {
        const s = termKbStop;
        termKbStop = null;
        termKbSeen = false;
        if (s) { try { s(); } catch (e) {} }
        termKbSet(0);
      };
      termDlg.addEventListener('focusin', function (e) {
        const t = /** @type {any} */ (e.target);
        if (termKbStop || !o.keyboard || !coarse() || !t || t.tagName !== 'INPUT') return;
        termKbSeen = false;
        try {
          termKbStop = o.keyboard(function (/** @type {number} */ h) {
            if (h > 0) { termKbSeen = true; termKbSet(h); return; }
            /* 键盘升起过、现在收了而输入框还聚焦（系统返回 / 手势收键盘）→ 交出焦点，下次点输入行再弹 */
            const a = /** @type {any} */ (doc.activeElement);
            if (termKbSeen && a && a.tagName === 'INPUT' && termDlg.contains(a)) { a.blur(); return; }
            termKbSet(0);
          }) || null;
        } catch (err) { termKbStop = null; }
      });
      termDlg.addEventListener('focusout', function (e) {
        const n = /** @type {any} */ (e.relatedTarget);
        if (n && n.tagName === 'INPUT' && termDlg.contains(n)) return;
        termKbEnd();
      });
      termDlg.addEventListener('close', termKbEnd);
    }
    if (termEl) {
      view = T.mountTerminal(termEl, term, {
        kh: 'cmdDrawer',
        onBack: function () { if (termSheet) termSheet.close(); },
        isShown: function () { return !!(termSheet && termSheet.isShown()); },
        pmUser: o.pmUser || '',
        layers: function (/** @type {any} */ line) {
          const acctTerm = o.accountTerm && who ? o.accountTerm({ S: trSec('account'), line: line, who: who, term: termLink, replace: replace, reload: o.reload }) : null;
          const ident = o.identityTerm && who ? o.identityTerm({ S: trSec('identity'), line: line, who: who }) : null;
          return { acct: acctTerm, ident: ident };
        },
      });
    }
    termPrefill = function (/** @type {string} */ c) { showTerm(function () { if (view) view.prefill(c); }); };
    /* 首帧有 v6 登录标记（sgx-id）才问 whoami；没有 = 访客，等 su / 盾牌 / 401 时再问 */
    if (who && who.v6Hinted()) who.refresh();
    /* 上锁的地方要进站（SUDO_EVENT，发事件的都是服务端说了没进站：页面标记 locked 或接口 401）：打开终端、预填 su （不替人回车） */
    doc.addEventListener(SUDO_EVENT, function (/** @type {any} */ ev) {
      /* detail.line（auth/sudo.js askSudo 第二个参数，如 /status/ 403 的 su root，#404 未决项第 5 项）：已登录、只是权限不够——只预填这一行，不动页面标记和身份 */
      const want = ev && ev.detail && typeof ev.detail.line === 'string' ? ev.detail.line : '';
      if (want) { showTerm(function () { if (view) view.prefill(want); }); return; }
      /* 页面标记跟着改成 locked（AI 窗口锁、听歌等按它画访客态） */
      doc.documentElement.setAttribute('data-sgx-lock-session', 'locked');
      if (who) who.drop();
      showTerm(function () { if (view) view.prefill(GUEST_LINE); });
    });
    /* 旧地址 ?entry=… / ?lock=…（旧书签；v5 S5 起没有锁屏界面）：没登录就打开终端、预填 su （v6 P4 起 ?entry=sudo 也一样，旧 sudo styrigx 删了） */
    const ent = qparam('entry') || qparam('lock');
    if (ent && view && (!who || who.get() === 'nobody')) {
      window.setTimeout(function () { showTerm(function () { view.prefill(GUEST_LINE); }); }, 0);
    }
    /* 旧地址 #sec[=<层>] / [data-sec-open]：打开终端；没进站预填 su （不问退出） */
    const openShield = function () {
      showTerm(function () {
        if (!view) return;
        /* 身份以服务端为准：问过再决定预填不预填（首帧的页面标记可能还是访客） */
        const w = who ? who.refresh() : Promise.resolve('nobody');
        w.then(function (/** @type {string} */ x) { if (x === 'nobody' && !view.input.value) view.prefill(GUEST_LINE); });
      });
    };
    /* 盾牌 = 身份徽章（定稿 v5.5 §七，Gray 2026-11-11 20:03 / 20:10）：不开窗口，打开终端，按当前身份还能晋升到哪一档预填（只预填、回车才生效）——
       访客「su 」（往上进站）、普通用户「exit」（进站已到顶）、站长「su root」（往上晋升 root）、root「exit」（弹回站长）。身份以服务端为准：问过再决定 */
    const shieldClick = function () {
      showTerm(function () {
        if (!view) return;
        const w = who ? who.refresh() : Promise.resolve('nobody');
        w.then(function () {
          const c = shieldCmd(tierOf());
          if (c && !view.input.value) view.prefill(c);
        });
      });
    };
    if (secBtn) {
      secBtn.addEventListener('click', function (e) {
        const me2 = /** @type {MouseEvent} */ (e);
        if (me2.button !== 0 || me2.metaKey || me2.ctrlKey || me2.shiftKey || me2.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        shieldClick();
      });
    }
    /* >_ 终端按钮（v5 S6）：开合终端（同 Ctrl / ⌘ K） */
    if (termBtn) {
      termBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!termSheet) return;
        if (termSheet.isShown()) termSheet.close();
        else showTerm();
      });
    }
    /* 主页 neofetch（v5 S7）的提示符跟身份：[data-sgx-ps]（nobody@space:~$ / styrigx@space:~$ / root@space:~#，路径 ~） */
    const psEls = Array.prototype.slice.call(doc.querySelectorAll('[data-sgx-ps]'));
    if (psEls.length && who && typeof T.ps1 === 'function') {
      const paintPs = function () { psEls.forEach(function (/** @type {HTMLElement} */ el) { el.textContent = T.ps1(who.get(), '~'); }); };
      paintPs();
      who.on(paintPs);
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
    /* Ctrl / ⌘ K（全站，桌面）：开合终端窗口（输入法组字时不理） */
    doc.addEventListener('keydown', function (e) {
      if (e.isComposing || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || (e.key !== 'k' && e.key !== 'K')) return;
      e.preventDefault();
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
  /* 2c：v6 命令（su / exit / lock / 空闲弹回）之后页面标记就地切；登录了顺手重取 NAVIGATE STATUS（之前 401 是灰的） */
  if (who && typeof who.onV6 === 'function') {
    who.onV6(function (/** @type {'valid'|'locked'} */ st) {
      if (switchPageSession(doc, st) && st === 'valid' && status) status();
    });
  }
  return { nav: nav && nav.ms, qp: qp && qp.ms, ai: ai && ai.ms, acct: acct && acct.ms, openAccount: function () { openAcct(); }, term: termSheet, termShell: term, termView: view, who: who, paint: paint, paintNav: paintNav };
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
    /* 主页首屏胶囊（apps/index.js）接同一份结果，不另取（[04] 旷野 status 小卡 2026-11-12 删除） */
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
  /* CI 静态测试构建（SGX_TEST_NO_WB）没有 /api：加载时不自动问，免得 404 进控制台（Lighthouse errors-in-console）；
     e2e 要测这条时先设 window.__sgxStatusApi = true（只在测试构建里有这个分支，生产构建 define 为 false 整段摇掉；博客测试构建同样定义（partials/blog/script.html，对齐 PR-C1）；奇趣 / 日刻构建没有这个 define，按生产走） */
  const noApi = typeof SGX_TEST_NO_WB !== 'undefined' && SGX_TEST_NO_WB && !(/** @type {any} */ (window).__sgxStatusApi);
  if (noApi) return function () {};
  const idle = /** @type {any} */ (window).requestIdleCallback || function (/** @type {() => void} */ f) { return window.setTimeout(f, 1200); };
  idle(refresh);
  return refresh;
}
