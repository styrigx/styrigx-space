/**
 * @fileoverview 2.9.0 页内导航（In-Page Navigation）。
 *
 * Dock 四个入口（browser / files / store / settings）点击时只替换内容区，
 * 顶栏和 Dock 的 DOM 节点始终不替换。
 *
 * 流程：
 * 1. fetch 目标 URL 的完整 HTML（credentials: 'include', cache: 'no-store', redirect: 'manual'）
 * 2. 检查是否已锁：opaqueredirect / 401 / HTML 含 data-sgx-session="locked" → location.assign 整页跳转
 * 3. DOMParser 解析，取出 <main> 内容替换当前页的 <main>，更新 document.title 和 <html lang>
 * 4. 旧页 unmount()（清定时器/监听），新页 mount()
 * 5. history.pushState，滚动到顶，焦点移到内容区标题
 * 6. popstate 时走同一套流程，恢复滚动位置
 *
 * 动画：document.startViewTransition 可用则用，否则 CSS transform/opacity；
 * prefers-reduced-motion 时只做显隐。
 *
 * 只拦截 Dock 四个入口和同源链接；带修饰键、target=_blank、外部链接走原生跳转。
 * 不使用 BroadcastChannel、storage 或前端内存作为锁屏状态——每次 fetch 都经过
 * middleware 验签，等于每次切页都问了一次服务端。
 */

const CONTENT_SELECTOR = 'main';
const TITLE_SELECTOR = 'main h1, main h2, [data-page-title]';

/** Dock 四个入口的基础路径（不含语言前缀） */
const DOCK_BASE_PATHS = ['/files/', '/store/', '/browser/', '/settings/'];

/**
 * 判断 pathname 是否是 Dock 页（含 /en/ 前缀）。
 * @param {string} pathname
 * @returns {boolean}
 */
function isDockPage(pathname) {
  // 去掉 /en 前缀
  const p = pathname.startsWith('/en/') ? pathname.slice(3) : pathname;
  return DOCK_BASE_PATHS.some(base => p === base || p.startsWith(base));
}

/** 当前页面的 mount/unmount 注册表，由各 page-*.js 提供 */
const pageModules = new Map();

/**
 * 注册页面的 mount/unmount。
 * @param {string} page - data-page 的值（如 'browser'）
 * @param {{mount?: () => void, unmount?: () => void}} mod
 */
export function registerPage(page, mod) {
  pageModules.set(page, mod || {});
}

function getPageModule(page) {
  return pageModules.get(page) || {};
}

/** 是否减少动画 */
function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 检查响应是否表示已锁定。
 * @param {Response} res
 * @param {string} html - 解析出的 HTML 文本（可选）
 * @returns {boolean}
 */
function isLockedResponse(res, html) {
  if (res.type === 'opaqueredirect') return true;
  if (res.status === 401) return true;
  if (html && html.includes('data-sgx-session="locked"')) return true;
  return false;
}

/**
 * 拉取目标页面的 HTML。
 * @param {string} url
 * @returns {Promise<{html: string, url: string} | {locked: true}>}
 */
async function fetchPage(url) {
  // 先查预取缓存
  const cached = getPrefetchCache(url);
  if (cached) {
    prefetchCache.delete(url); // 用一次就删，避免显示过期内容
    if (cached.includes('data-sgx-session="locked"')) {
      return { locked: true };
    }
    return { html: cached, url };
  }

  let res;
  try {
    res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch (e) {
    // 网络错误：退回整页跳转（不当作已锁）
    return { networkError: true };
  }

  if (res.type === 'opaqueredirect' || res.status === 401) {
    return { locked: true };
  }

  if (!res.ok) {
    return { networkError: true };
  }

  let html;
  try {
    html = await res.text();
  } catch (e) {
    return { networkError: true };
  }

  if (isLockedResponse(res, html)) {
    return { locked: true };
  }

  return { html, url: res.url || url };
}

/**
 * 从 HTML 文本中提取内容区。
 * @param {string} html
 * @returns {{content: string, title: string, lang: string, page: string} | null}
 */
function extractContent(html) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch (e) {
    return null;
  }

  const main = doc.querySelector(CONTENT_SELECTOR);
  if (!main) return null;

  return {
    content: main.innerHTML,
    title: doc.title || document.title,
    lang: doc.documentElement.getAttribute('lang') || document.documentElement.getAttribute('lang'),
    page: doc.body ? doc.body.getAttribute('data-page') : '',
  };
}

/**
 * 执行内容切换（带动画）。
 * @param {string} newContent - 新的 main innerHTML
 * @param {string} newTitle
 * @param {string} newLang
 * @param {string} newPage
 */
/* 2.9.2⑦：更新顶栏 data-route（天气只在主页显示，顶栏节点不动） */
function updateNavRoute(url) {
  try {
    const nav = document.getElementById('site-nav');
    if (!nav) return;
    const u = new URL(url, location.origin);
    const p = u.pathname;
    const isHome = (p === '/' || p === '/en/' || p === '/index.html');
    nav.setAttribute('data-route', isHome ? 'home' : 'app');
  } catch (e) {}
}

function swapContent(newContent, newTitle, newLang, newPage) {
  const main = document.querySelector(CONTENT_SELECTOR);
  if (!main) return;
  // 2.9.2⑦：popstate 时也更新（navigateTo 可能不经过 pushState 分支）
  if (newPage) {
    try {
      const nav = document.getElementById('site-nav');
      if (nav) {
        // newPage 是页面标识，主页为 'home' 或空
        const isHome = !newPage || newPage === 'home' || newPage === 'index';
        nav.setAttribute('data-route', isHome ? 'home' : 'app');
      }
    } catch (e) {}
  }

  const doSwap = () => {
    // 1. unmount 旧页
    const oldPage = document.body.getAttribute('data-page');
    const oldMod = getPageModule(oldPage);
    if (oldMod.unmount) {
      try { oldMod.unmount(); } catch (e) { /* 忽略 */ }
    }

    // 2. 替换内容
    main.innerHTML = newContent;
    document.title = newTitle;
    if (newLang) document.documentElement.setAttribute('lang', newLang);
    if (newPage) document.body.setAttribute('data-page', newPage);

    // 3. mount 新页
    const newMod = getPageModule(newPage);
    if (newMod.mount) {
      try { newMod.mount(); } catch (e) { /* 忽略 */ }
    }
  };

  if (reducedMotion()) {
    doSwap();
    return;
  }

  if (document.startViewTransition) {
    document.startViewTransition(doSwap);
  } else {
    // 2.9.2：旧页先完全隐藏，再换内容、新页淡入（避免两页叠加半透明）
    main.style.transition = 'opacity 0.15s ease';
    main.style.opacity = '0';
    setTimeout(() => {
      doSwap();
      // 内容已换，淡入新页
      requestAnimationFrame(() => {
        main.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        main.style.opacity = '1';
        main.style.transform = 'translateY(0)';
        setTimeout(() => {
          main.style.transition = '';
          main.style.opacity = '';
          main.style.transform = '';
        }, 250);
      });
    }, 160);
  }
}

/**
 * 导航到指定 URL（页内切换）。
 * @param {string} url - 目标 URL
 * @param {object} opts - {push: boolean, scrollY: number}
 */
export async function navigateTo(url, opts = {}) {
  const { push = true, scrollY = 0 } = opts;

  // 只处理同源 URL
  let targetUrl;
  try {
    targetUrl = new URL(url, window.location.href);
  } catch (e) {
    window.location.assign(url);
    return;
  }
  if (targetUrl.origin !== window.location.origin) {
    window.location.assign(url);
    return;
  }

  const result = await fetchPage(targetUrl.href);

  // 已锁：整页跳转，让 middleware 302 到锁屏
  if (result.locked) {
    window.location.assign(targetUrl.href);
    return;
  }

  // 网络错误或解析失败：退回整页跳转
  if (result.networkError || !result.html) {
    window.location.assign(targetUrl.href);
    return;
  }

  const extracted = extractContent(result.html);
  if (!extracted) {
    window.location.assign(targetUrl.href);
    return;
  }

  // 未注册的页面退回整页跳转
  if (extracted.page && !pageModules.has(extracted.page)) {
    window.location.assign(targetUrl.href);
    return;
  }

  // 切换内容
  swapContent(extracted.content, extracted.title, extracted.lang, extracted.page);

  // pushState
  if (push) {
    history.pushState({ url: targetUrl.href, scrollY: window.scrollY }, '', targetUrl.href);
  }
  // 2.9.2⑦：更新顶栏路由状态
  updateNavRoute(targetUrl.href);

  // 滚动到顶，焦点移到内容区标题
  if (push) {
    window.scrollTo(0, 0);
  } else {
    window.scrollTo(0, scrollY);
  }

  const titleEl = document.querySelector(TITLE_SELECTOR);
  if (titleEl) {
    titleEl.setAttribute('tabindex', '-1');
    titleEl.focus({ preventScroll: true });
  }
}

/** 预取缓存：URL -> {html, timestamp}，只缓存非受保护页 */
const prefetchCache = new Map();
const PREFETCH_TTL = 30000; // 30 秒

/** 预取：在 Dock 图标 pointerdown 时提前发请求并缓存结果 */
let prefetchController = null;
export function prefetch(url) {
  if (prefetchController) {
    prefetchController.abort();
  }
  prefetchController = new AbortController();
  fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'manual',
    signal: prefetchController.signal,
  }).then(async (res) => {
    // 只缓存成功的、非锁定的响应
    if (res.ok && res.type !== 'opaqueredirect' && res.status !== 401) {
      try {
        const html = await res.text();
        // 不缓存含锁屏标记的页面
        if (!html.includes('data-sgx-session="locked"')) {
          prefetchCache.set(url, { html, timestamp: Date.now() });
        }
      } catch (e) { /* 忽略 */ }
    }
  }).catch(() => { /* 忽略预取错误 */ });
}

/** 获取预取缓存（未过期才返回） */
function getPrefetchCache(url) {
  const entry = prefetchCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > PREFETCH_TTL) {
    prefetchCache.delete(url);
    return null;
  }
  return entry.html;
}

/**
 * 判断点击是否应该被拦截做页内导航。
 * @param {MouseEvent} e
 * @param {HTMLAnchorElement} a
 * @returns {boolean}
 */
function shouldIntercept(e, a) {
  // 只拦截 Dock 图标本身（data-dock 属性），不拦截页面内的其他链接
  // （如设置页内部的 data-cat 左栏切换，那是页内 JS 逻辑，不是 Dock 导航）
  if (!a.hasAttribute('data-dock')) return false;

  // 修饰键、非左键、target=_blank 都不拦截
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  if (e.button !== 0) return false;
  if (a.target === '_blank') return false;

  let url;
  try {
    url = new URL(a.href, window.location.href);
  } catch (err) {
    return false;
  }

  // 外部链接不拦截
  if (url.origin !== window.location.origin) return false;

  // 目标必须是 Dock 页
  if (!isDockPage(url.pathname)) return false;

  // 当前页也必须是 Dock 页
  if (!isDockPage(window.location.pathname)) return false;

  return true;
}

/**
 * 初始化页内导航。
 * @param {string[]} dockPaths - Dock 四个入口的路径（如 ['/browser/', '/files/', ...]）
 */
export function initInPageNav() {
  // 拦截 Dock 点击（目标和当前页都必须是 Dock 页）
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || !a.href) return;

    if (!shouldIntercept(e, a)) return;

    e.preventDefault();
    navigateTo(a.href);
  });

  // Dock 图标 pointerdown 预取（只预取 Dock 图标本身）
  document.addEventListener('pointerdown', (e) => {
    const a = e.target.closest('a[data-dock]');
    if (!a || !a.href) return;

    let url;
    try {
      url = new URL(a.href, window.location.href);
    } catch (err) {
      return;
    }
    if (url.origin !== window.location.origin) return;
    if (!isDockPage(url.pathname)) return;
    if (!isDockPage(window.location.pathname)) return;

    prefetch(url.href);
  }, { passive: true });

  // 拦截 Dock 上的长按菜单（contextmenu），不影响正文普通链接
  document.addEventListener('contextmenu', (e) => {
    const dockBtn = e.target.closest('a[data-dock]');
    if (dockBtn) {
      e.preventDefault();
    }
  });

  // popstate：前进/后退（目标不是 Dock 页则整页加载）
  window.addEventListener('popstate', (e) => {
    const state = e.state;
    if (state && state.url) {
      let url;
      try {
        url = new URL(state.url, window.location.href);
      } catch (err) {
        window.location.reload();
        return;
      }
      if (!isDockPage(url.pathname)) {
        window.location.assign(state.url);
        return;
      }
      navigateTo(state.url, { push: false, scrollY: state.scrollY || 0 });
    } else {
      // 没有 state 时整页加载
      window.location.reload();
    }
  });

  // 初始化当前页面的 state
  if (!history.state) {
    history.replaceState(
      { url: window.location.href, scrollY: window.scrollY },
      '',
      window.location.href
    );
  }
}
