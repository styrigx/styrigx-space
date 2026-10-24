/**
 * @fileoverview 主站顶栏三栏（主页 / 聊天 / 设置）页内切换（2026-10-24，手感同子站 珍格 / 日刻 的标签）。
 *
 * 以前每点一栏都是整页导航：重新拉 HTML、重跑整份 core JS、云同步 GET、等数据，药丸先动、内容慢几帧。
 * 现在：
 * - 三个地址照旧都是真页面（/、/chat/、/settings/，英文 /en 前缀）：直接打开 / 刷新 / 分享时服务器直出那一栏的完整 HTML，
 *   网关对这三个路径的判定（锁屏、访客、会话）一点没变，没 JS 也照常能用。
 * - 进来以后，空闲时在后台把另外两栏的 HTML 取回来（同一个网关、同一份 cookie），只抽 <main id="sgx-main"> 里的内容
 *   和几项页面专属的 <head> / <body> 信息，缓存在内存里；点标签 / 左右滑 / 前进后退时在同一个文档里换内容（history.pushState / popstate），
 *   药丸、内容、标题、地址在同一次更新里一起换（document.startViewTransition 包着，效果同跨页过渡；不支持就直接换）。
 * - 取回来的页面必须和当前文档是同一次构建、同一个入口脚本、同一个会话状态 / 角色，否则不用它，退回整页导航
 *   （锁屏态、升级验证态、取回来是跳转 / 锁屏页、构建换了……一律整页导航，交给网关决定）。
 * - 各栏自己的脚本由入口（entries/tabs-boot.js）用 registerTab() 登记；2026-10-24 JS 拆分起，当前栏的模块随入口静态加载（mount），
 *   另外两栏的模块按需 import()（load）：空闲时和 HTML 一起预取，按下标签时还没取到就当场取；
 *   取不到（部署后旧 chunk 404、断网）就整页导航到目标地址（同一地址只自动重试一次，见 baseof 的 sgx-js-retry）。
 *   keep:true（主页、聊天）= 这块 DOM 只挂一次，切走时连 DOM 带状态一起留着，activate / deactivate 只开关全局的东西；
 *   keep:false（设置）= 每次切进来都是服务器那份 HTML 的新拷贝 + 重新挂，切走时 destroy() 拆掉这次挂的全部监听。
 * - 滚动位置按栏记（同一文档里来回切）；整页回来（如从设置子页返回、刷新）按历史条目里记的位置恢复。
 * - 云同步、数字健康上报、锁屏这些全站的东西在 core 里只初始化一次，切栏不会重来；切栏时发 sgx-tab-leave / sgx-tab-enter 两个事件。
 */
import { loadWb } from '../lib/wb-view.js';

/**
 * @typedef {{activate?: () => void, deactivate?: () => void}} TabCtl
 * @typedef {(o: {direct: boolean}) => (TabCtl|(() => void)|null)} MountFn
 * @typedef {{keep: boolean, top?: boolean, mount?: MountFn, load?: () => Promise<MountFn>}} TabDef
 *   mount：已经在手的挂载函数（当前栏）；load：按需取这一栏的模块，返回挂载函数
 *   top：整页加载（刷新 / 退回来）总是从顶部开始（主页，同以前），不恢复记下的位置
 * @typedef {{title: string, desc: string|null, ogTitle: string|null, ogDesc: string|null, ogUrl: string|null, robots: string|null, subpage: boolean, dataPage: string}} PageMeta
 * @typedef {{
 *   id: string, href: string, path: string, def: TabDef, meta: PageMeta|null,
 *   frag: DocumentFragment|null, tpl: DocumentFragment|null, ctl: TabCtl|null, destroy: (() => void)|null,
 *   y: number, seen: boolean, fetchedAt: number, loading: Promise<boolean>|null,
 *   run: MountFn|null, mod: Promise<boolean>|null, modFailed: boolean
 * }} Pane
 */

/** 取回来但一直没打开过的栏，过了这么久再打开就重新取一次（会话可能变了） */
const STALE_MS = 5 * 60 * 1000;
/** 点了还没取回来的栏：最多等这么久，过了退回整页导航 */
const WAIT_MS = 4000;

/** @type {Map<string, TabDef>} */
const defs = new Map();
/** @type {{go: (id: string, o?: {push?: boolean}) => boolean}|null} */
let api = null;

/**
 * 登记一栏的脚本（入口 entry-tab-*.js 调）。
 * @param {string} id data/topbar-tabs.yaml 里的 id（home / chat / settings）
 * @param {TabDef} def
 */
export function registerTab(id, def) {
  defs.set(id, def);
}

/**
 * 切到某一栏（顶栏点击、左右滑都走这里）。
 * @param {string} id
 * @returns {boolean} true = 页内切换接手了（调用方别再整页导航）；false = 用不了页内切换，调用方自己导航
 */
export function goTab(id) {
  return api ? api.go(id) : false;
}

/** @param {string} p */
function normPath(p) {
  if (!p) return '/';
  return p.endsWith('/') ? p : p + '/';
}

/** @param {Document} doc @returns {PageMeta} */
function metaOf(doc) {
  /** @param {string} sel */
  const c = (sel) => {
    const el = doc.head && doc.head.querySelector(sel);
    return el ? el.getAttribute('content') : null;
  };
  return {
    title: doc.title,
    desc: c('meta[name="description"]'),
    ogTitle: c('meta[property="og:title"]'),
    ogDesc: c('meta[property="og:description"]'),
    ogUrl: c('meta[property="og:url"]'),
    robots: c('meta[name="robots"]'),
    subpage: !!doc.body && doc.body.classList.contains('subpage'),
    dataPage: (doc.body && doc.body.getAttribute('data-page')) || '',
  };
}

/** 这次构建的前端脚本签名（baseof 写在入口 <script data-sgx-js>，同一次构建所有页面一样）；取回来的页面必须一致 @param {Document} doc */
function jsSig(doc) {
  const s = doc.querySelector('script[type="module"][data-sgx-js]');
  return s ? s.getAttribute('data-sgx-js') : null;
}

/** 自动重试标记（baseof 内联脚本读同一个键：入口脚本加载失败时同一地址只自动刷新一次） */
const RETRY_KEY = 'sgx-js-retry';

/**
 * 按需模块取不到：整页导航到目标地址，交给新页面（新构建）。同一地址已经自动重试过一次就不再自动跳，免得循环。
 * @param {string} href @param {boolean} push
 * @returns {boolean} 是否已发起整页导航
 */
function hardNav(href, push) {
  let path = href;
  try {
    path = new URL(href, location.href).pathname;
    if (sessionStorage.getItem(RETRY_KEY) === path) return false;
    sessionStorage.setItem(RETRY_KEY, path);
  } catch (e) {}
  if (push) location.assign(href);
  else location.reload();
  return true;
}

/** 会话标记（网关注入在 <html> 上）；取回来的页面必须和当前一致 @param {Document} doc */
function sessionSig(doc) {
  const h = doc.documentElement;
  return ['data-sgx-build', 'data-sgx-session', 'data-sgx-role', 'data-sgx-upgrade', 'lang'].map((a) => a + '=' + (h.getAttribute(a) || '')).join('&');
}

function reduced() {
  return document.documentElement.classList.contains('reduced-motion');
}

/**
 * 启动：挂上当前这一栏（不管能不能页内切换，当前栏的脚本都在这里挂），能页内切换时接管顶栏三个标签。
 * 必须在 initCore() 之前调（设置页要先去掉访客的 data-wb-root，core 再拉数字健康，同以前的顺序）。
 */
export function initInpageTabs() {
  const main = document.getElementById('sgx-main');
  const nav = document.querySelector('.sgx-tb-tabs');
  if (!main || !nav) return;
  const links = /** @type {HTMLAnchorElement[]} */ (Array.from(nav.querySelectorAll('a.sgx-tb-tab')));
  const curLink = links.find((a) => a.getAttribute('aria-current') === 'page');
  if (!curLink) return;
  /** @type {Map<string, Pane>} */
  const panes = new Map();
  for (const a of links) {
    const id = a.getAttribute('data-tab') || '';
    const def = defs.get(id);
    if (!def) continue;
    const href = a.getAttribute('href') || '/';
    panes.set(id, { id, href, path: normPath(new URL(href, location.href).pathname), def, meta: null, frag: null, tpl: null, ctl: null, destroy: null, y: 0, seen: false, fetchedAt: 0, loading: null, run: def.mount || null, mod: null, modFailed: false });
  }
  const curId = curLink.getAttribute('data-tab') || '';
  const cur = panes.get(curId);
  if (!cur) return;
  cur.meta = metaOf(document);
  cur.seen = true;
  /* 每次重新挂的栏（设置）：先留一份服务器原样的 HTML，挂了以后 DOM 会被脚本改 */
  if (!cur.def.keep) {
    const tpl = document.createDocumentFragment();
    main.childNodes.forEach((n) => tpl.appendChild(n.cloneNode(true)));
    stripScripts(tpl);
    cur.tpl = tpl;
  }
  if (cur.run) mountPane(cur, true);
  else {
    /* 入口没带当前这一栏的模块（入口和页面对不上，正常不会发生）：取来再挂 */
    loadMod(cur).then((ok) => {
      if (ok) mountPane(cur, true);
    });
  }

  const html = document.documentElement;
  const st = html.getAttribute('data-sgx-session');
  const enabled =
    panes.size === links.length &&
    links.length > 1 &&
    st !== 'locked' &&
    st !== 'lockreset' &&
    !html.hasAttribute('data-sgx-upgrade') &&
    typeof fetch === 'function' &&
    typeof DOMParser === 'function' &&
    !!(history && history.pushState);
  if (!enabled) return;

  const mySig = sessionSig(document);
  const mySrc = jsSig(document);
  /** 屏幕上现在是哪一栏 */
  let shown = curId;
  /** 正在去 / 已经在的那一栏（连点、取页面时以它为准） */
  let want = curId;
  let seq = 0;
  /** @type {any} */
  let vt = null;

  /* 刷新 / 从别的页面退回来（整页加载）：按这条历史里记的位置恢复（同一文档里切栏由下面自己记，浏览器的自动恢复关掉免得两边打架） */
  try {
    const nt = /** @type {any} */ (performance.getEntriesByType('navigation')[0]);
    const hs = history.state;
    if (!cur.def.top && nt && (nt.type === 'back_forward' || nt.type === 'reload') && hs && typeof hs.sgxY === 'number' && hs.sgxTab === curId) {
      const y0 = hs.sgxY;
      requestAnimationFrame(() => window.scrollTo(0, y0));
    }
  } catch (e) {}
  try {
    history.scrollRestoration = 'manual';
  } catch (e) {}
  /** 把当前栏和滚动位置记进当前历史条目（整页离开、刷新后回来用） */
  function remember() {
    try {
      history.replaceState(Object.assign({}, history.state, { sgxTab: shown, sgxY: Math.round(window.scrollY || 0) }), '');
    } catch (e) {}
  }
  window.addEventListener('pagehide', remember);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') remember();
  });
  /* 从这三栏点进别的页面（设置子页、账号页……）：离开前记一下位置 */
  document.addEventListener('click', (e) => {
    const a = /** @type {Element|null} */ (e.target) && /** @type {Element} */ (e.target).closest ? /** @type {Element} */ (e.target).closest('a[href]') : null;
    if (a && !a.classList.contains('sgx-tb-tab')) remember();
  }, true);

  /**
   * 后台取一栏的 HTML，抽出内容区。
   * @param {Pane} p
   * @returns {Promise<boolean>}
   */
  function load(p) {
    if (p.loading) return p.loading;
    const run = fetch(p.href, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' } })
      .then((r) => {
        const ct = r.headers.get('Content-Type') || '';
        if (!r.ok || r.status !== 200 || r.redirected || ct.indexOf('text/html') === -1) return null;
        try {
          if (normPath(new URL(r.url, location.href).pathname) !== p.path) return null;
        } catch (e) {}
        return r.text();
      })
      .then((text) => {
        if (!text) return false;
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const m = doc.getElementById('sgx-main');
        const curTab = doc.querySelector('.sgx-tb-tabs a.sgx-tb-tab[aria-current="page"]');
        if (!m || !curTab || curTab.getAttribute('data-tab') !== p.id) return false;
        if (sessionSig(doc) !== mySig || jsSig(doc) !== mySrc) return false;
        warmEntry(doc);
        const frag = document.createDocumentFragment();
        while (m.firstChild) frag.appendChild(document.adoptNode(m.firstChild));
        stripScripts(frag);
        p.meta = metaOf(doc);
        if (p.def.keep) p.frag = frag;
        else p.tpl = frag;
        p.fetchedAt = Date.now();
        return true;
      })
      .catch(() => false)
      .then((ok) => {
        p.loading = null;
        return ok;
      });
    p.loading = run;
    return run;
  }

  /** @param {Pane} p */
  function ready(p) {
    if (!p.run) return false;
    if (p.def.keep ? !(p.frag || p.ctl) : !p.tpl) return false;
    /* 取回来很久都没打开过：重新取（会话可能已经过期 / 锁了，交给网关重新判断） */
    if (!p.seen && p.fetchedAt && Date.now() - p.fetchedAt > STALE_MS) {
      p.frag = null;
      p.tpl = null;
      return false;
    }
    return true;
  }

  /** @param {Pane} to @param {boolean} push */
  function swap(to, push) {
    if (shown === to.id) return;
    const from = /** @type {Pane} */ (panes.get(shown));
    /* ---- 离开 ---- */
    from.y = Math.round(window.scrollY || 0);
    try {
      const ae = /** @type {HTMLElement|null} */ (document.activeElement);
      if (ae && main.contains(ae) && ae.blur) ae.blur();
    } catch (e) {}
    if (from.def.keep) {
      if (from.ctl && from.ctl.deactivate) safe(from.ctl.deactivate);
      const keep = document.createDocumentFragment();
      while (main.firstChild) keep.appendChild(main.firstChild);
      from.frag = keep;
    } else {
      if (from.destroy) safe(from.destroy);
      from.destroy = null;
      main.replaceChildren();
    }
    /* 第一次切栏起，入场动画（只在会话第一次进站时播）不再播：同以前第二次进页面一样 */
    html.classList.remove('sgx-first-visit');
    /* ---- 进入 ---- */
    if (to.def.keep) {
      if (to.frag) main.appendChild(to.frag);
      to.frag = null;
    } else if (to.tpl) {
      main.appendChild(to.tpl.cloneNode(true));
    }
    applyMeta(/** @type {PageMeta} */ (to.meta));
    links.forEach((a) => {
      if (a.getAttribute('data-tab') === to.id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const homeItem = document.querySelector('#sgx-drawer [data-nav="home"]');
    if (homeItem) {
      if (to.id === 'home') homeItem.setAttribute('aria-current', 'page');
      else homeItem.removeAttribute('aria-current');
    }
    shown = to.id;
    if (push) {
      try {
        history.pushState({ sgxTab: to.id }, '', to.href);
      } catch (e) {}
    }
    window.scrollTo(0, to.seen ? to.y : 0);
    to.seen = true;
    mountPane(to, false);
    try {
      window.dispatchEvent(new CustomEvent('sgx-tab-enter', { detail: { from: from.id, to: to.id } }));
    } catch (e) {}
  }

  /** @param {Pane} to @param {boolean} push */
  function switchTo(to, push) {
    try {
      window.dispatchEvent(new CustomEvent('sgx-tab-leave', { detail: { from: shown, to: to.id } }));
    } catch (e) {}
    const update = () => swap(to, push);
    const d = /** @type {any} */ (document);
    if (typeof d.startViewTransition === 'function' && !reduced() && document.visibilityState === 'visible') {
      try {
        if (vt) vt.skipTransition();
      } catch (e) {}
      try {
        const t = d.startViewTransition(update);
        vt = t;
        t.finished.catch(() => {}).then(() => {
          if (vt === t) vt = null;
        });
        t.ready.catch(() => {});
        t.updateCallbackDone.catch((err) => safe(() => { throw err; }));
        return;
      } catch (e) {}
    }
    update();
  }

  /** @param {string} id @param {{push?: boolean}} [o] */
  function go(id, o) {
    const push = !(o && o.push === false);
    const p = panes.get(id);
    if (!p) return false;
    /* 会话状态在页面里变了（自动锁屏把 <html> 改成 locked、升级验证……）：不再页内切换，整页导航交给网关 */
    if (sessionSig(document) !== mySig) return false;
    if (id === want) return true;
    /* 预取这一栏的模块失败过（部署后旧 chunk 没了 / 断网）：不再在旧文档里重试，直接整页导航（新构建自己会带上） */
    if (p.modFailed) return hardNav(p.href, push);
    const my = ++seq;
    want = id;
    if (ready(p)) {
      switchTo(p, push);
      return true;
    }
    let done = false;
    const giveUp = () => {
      if (done || my !== seq) return;
      done = true;
      want = shown;
      /* 模块取不到：整页导航（同一地址只自动一次）；取不到能用的页面（跳转到锁屏、构建换了、断网……）：整页导航，交给网关 */
      if (p.modFailed) hardNav(p.href, push);
      else if (push) location.assign(p.href);
      else location.reload();
    };
    const timer = window.setTimeout(giveUp, WAIT_MS);
    Promise.all([load(p), loadMod(p)]).then(([ok, okMod]) => {
      if (done || my !== seq) return;
      if (!ok || !okMod || !ready(p)) {
        window.clearTimeout(timer);
        giveUp();
        return;
      }
      done = true;
      window.clearTimeout(timer);
      switchTo(p, push);
    });
    return true;
  }

  api = { go };

  /* 顶栏三个标签：同一文档里换内容 */
  nav.addEventListener('click', (e) => {
    const me = /** @type {MouseEvent} */ (e);
    const a = /** @type {Element|null} */ (me.target) && /** @type {Element} */ (me.target).closest ? /** @type {Element} */ (me.target).closest('a.sgx-tb-tab') : null;
    if (!a || me.defaultPrevented || me.button !== 0 || me.metaKey || me.ctrlKey || me.shiftKey || me.altKey) return;
    if (go(a.getAttribute('data-tab') || '')) me.preventDefault();
  });
  /* 手指按上去就开始取（还没预取到的话） */
  const warm = (/** @type {Event} */ e) => {
    const a = /** @type {Element|null} */ (e.target) && /** @type {Element} */ (e.target).closest ? /** @type {Element} */ (e.target).closest('a.sgx-tb-tab') : null;
    const p = a && panes.get(a.getAttribute('data-tab') || '');
    if (p && !ready(p)) {
      load(p);
      loadMod(p);
    }
  };
  nav.addEventListener('pointerdown', warm, { passive: true });
  nav.addEventListener('touchstart', warm, { passive: true });
  /* 前进 / 后退：地址已经换了，换内容（不再 push） */
  window.addEventListener('popstate', (e) => {
    /* 直接打开子页时插入的那条主页历史，由 navhistory.js healRoot() 换成真正的主页请求 */
    if (e.state && e.state.sgxRoot) return;
    const path = normPath(location.pathname);
    let id = '';
    panes.forEach((p) => {
      if (p.path === path) id = p.id;
    });
    if (!id || id === want) return;
    /* 用不了页内切换了（会话变了）：地址已经换过，整页载入这个地址 */
    if (!go(id, { push: false })) location.reload();
  });

  /* 空闲时预取另外两栏（省流量模式不预取，按下标签时再取） */
  const prefetch = () => {
    try {
      const cn = /** @type {any} */ (navigator).connection;
      if (cn && cn.saveData) return;
    } catch (e) {}
    panes.forEach((p) => {
      if (p.id !== shown && !ready(p)) {
        load(p);
        loadMod(p);
      }
    });
  };
  const idle = () => {
    const w = /** @type {any} */ (window);
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(prefetch, { timeout: 2500 });
    else window.setTimeout(prefetch, 800);
  };
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });

  /** @param {PageMeta} m */
  function applyMeta(m) {
    if (!m) return;
    document.title = m.title;
    setMeta('meta[name="description"]', m.desc);
    setMeta('meta[property="og:title"]', m.ogTitle);
    setMeta('meta[property="og:description"]', m.ogDesc);
    setMeta('meta[property="og:url"]', m.ogUrl);
    let rb = document.head.querySelector('meta[name="robots"]');
    if (m.robots) {
      if (!rb) {
        rb = document.createElement('meta');
        rb.setAttribute('name', 'robots');
        document.head.appendChild(rb);
      }
      rb.setAttribute('content', m.robots);
    } else if (rb) rb.remove();
    document.body.classList.toggle('subpage', m.subpage);
    document.body.setAttribute('data-page', m.dataPage);
  }
}

/**
 * 预热那一栏自己的入口脚本（几百字节）：以后整页打开它（刷新、从子页返回、页内切换用不了时）不用再等一个来回。
 * 只 modulepreload（下载 + 解析进缓存），不执行，没有副作用；失败也无所谓（error 落在 <link> 上，baseof 的重试只管入口 <script>）。
 * @param {Document} doc 取回来的那一栏的页面
 */
function warmEntry(doc) {
  try {
    const s = doc.querySelector('script[type="module"][data-sgx-js]');
    const src = s && s.getAttribute('src');
    if (!src) return;
    const own = document.querySelector('script[type="module"][data-sgx-js]');
    if (own && own.getAttribute('src') === src) return;
    const links = document.querySelectorAll('link[rel="modulepreload"]');
    for (let i = 0; i < links.length; i++) if (links[i].getAttribute('href') === src) return;
    const l = document.createElement('link');
    l.rel = 'modulepreload';
    l.href = src;
    document.head.appendChild(l);
  } catch (e) {}
}

/**
 * 取一栏的模块（load()，只取一次；失败记下 modFailed，之后点这一栏直接整页导航）。
 * @param {Pane} p
 * @returns {Promise<boolean>}
 */
function loadMod(p) {
  if (p.run) return Promise.resolve(true);
  if (p.modFailed || !p.def.load) return Promise.resolve(false);
  if (p.mod) return p.mod;
  const run = p.def
    .load()
    .then((fn) => {
      p.run = fn;
      return true;
    })
    .catch((e) => {
      p.modFailed = true;
      try {
        console.warn('[sgx-tabs] module', e);
      } catch (e2) {}
      return false;
    })
    .then((ok) => {
      p.mod = null;
      return ok;
    });
  p.mod = run;
  return run;
}

/** @param {string} sel @param {string|null} v */
function setMeta(sel, v) {
  const el = document.head.querySelector(sel);
  if (el && v != null) el.setAttribute('content', v);
}

/** 内容区里的普通脚本（如设置首页的旧 hash 跳转）只在整页加载时有意义，页内换进来不跑；JSON 数据（文案）留着 @param {DocumentFragment} frag */
function stripScripts(frag) {
  frag.querySelectorAll('script').forEach((s) => {
    const t = (s.getAttribute('type') || '').toLowerCase();
    if (!t || t === 'text/javascript' || t === 'module' || t === 'application/javascript') s.remove();
  });
}

/** @param {() => void} fn */
function safe(fn) {
  try {
    fn();
  } catch (e) {
    try {
      console.warn('[sgx-tabs]', e);
    } catch (e2) {}
  }
}

/**
 * 挂 / 激活一栏的脚本。
 * @param {Pane} p
 * @param {boolean} direct 这一栏就是直接打开 / 刷新的那页
 */
function mountPane(p, direct) {
  if (p.def.keep) {
    if (!p.ctl) {
      try {
        p.ctl = /** @type {TabCtl|null} */ (/** @type {MountFn} */ (p.run)({ direct })) || {};
      } catch (e) {
        p.ctl = {};
        safe(() => { throw e; });
      }
    }
    const c = p.ctl;
    if (c && c.activate) safe(c.activate);
  } else {
    try {
      const d = /** @type {MountFn} */ (p.run)({ direct });
      p.destroy = typeof d === 'function' ? d : null;
    } catch (e) {
      safe(() => { throw e; });
    }
  }
  /* 页内切进来的栏：有数字健康卡就画上（同一文档拿到过的先同步画，旧了再拉；直接打开的那页由 core 拉） */
  if (!direct && !SGX_TEST_NO_WB && document.querySelector('#sgx-main [data-wb-root]')) loadWb();
}
