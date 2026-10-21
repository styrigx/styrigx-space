/**
 * @fileoverview 主站接入原地搜索层（共享组件 shell/search-layer.js 的宿主，2026-10-22；子站照这个写自己的）。
 *
 * - 搜索层代码单独打包（baseof.html 的 <meta name="sgx-search-src">），不进页面入口：按下九宫格 / 打开抽屉 /
 *   按下抽屉搜索框 / Ctrl+K 时才 import()，点搜索框时一般早就到了。
 * - openSearch(opts) 必须在点击 / 按键事件里同步调用：模块已到 → 直接 open（同步聚焦，安卓弹键盘）；
 *   还没到（极少：刚打开抽屉就点）→ 先同步关抽屉、聚焦一个看不见的临时输入框把键盘叫出来，模块到了再把焦点交给真输入框。
 * - 进页带 ?q=（/search/?q=、/browser/?q=、opensearch 都转到 /?q=）：去掉 q（replaceState，不留历史），打开搜索层并预填。
 */
import { sgxNavigate } from '../lib/diag-jumptrace.js';

/** @typedef {import('./search-layer.js').OpenOptions} OpenOptions */
/** @type {null | ReturnType<typeof import('./search-layer.js').mountSearch>} */
let inst = null;
/** @type {null | Promise<any>} */
let loading = null;
/** @type {null | {mountSearch: typeof import('./search-layer.js').mountSearch}} */
let mod = null;

function src() {
  const m = document.querySelector('meta[name="sgx-search-src"]');
  return m ? m.getAttribute('content') || '' : '';
}

/** 开始加载搜索层（幂等）。 @returns {Promise<any>} */
export function prefetchSearch() {
  if (!loading) {
    const u = src();
    loading = u
      ? import(/* webpackIgnore: true */ u).then(function (m) {
        mod = m;
        /* 到了就先把 DOM 建好（隐藏着），点搜索框时 open() 只剩显示 + 聚焦 */
        instance();
        return m;
      })
      : Promise.reject(new Error('no sgx-search-src'));
    loading.catch(function () { loading = null; });
  }
  return loading;
}

function instance() {
  if (!inst && mod) {
    const en = document.documentElement.lang === 'en';
    inst = mod.mountSearch({
      lang: en ? 'en' : 'zh',
      index: '/files-index.json',
      types: [
        { type: 'post', zh: '博客', en: 'Blog' },
        { type: 'app', zh: '应用', en: 'Apps' },
      ],
      navigate: sgxNavigate,
    });
  }
  return inst;
}

/**
 * 打开搜索层（在用户手势里同步调用）。
 * @param {OpenOptions} [opts]
 */
export function openSearch(opts) {
  opts = opts || {};
  const s = instance();
  if (s) {
    s.open(opts);
    return;
  }
  /* 模块还没到：先同步关掉抽屉、用临时输入框接住键盘 */
  let reuse = false;
  if (opts.handoff) {
    try { reuse = !!opts.handoff(); } catch (e) {}
  }
  const proxy = document.createElement('input');
  proxy.type = 'search';
  proxy.className = 'sgx-srch-proxy';
  proxy.setAttribute('aria-hidden', 'true');
  proxy.style.cssText = 'position:fixed;left:16px;bottom:12px;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;z-index:-1;';
  document.body.appendChild(proxy);
  if (opts.focus !== false) {
    try { proxy.focus({ preventScroll: true }); } catch (e) {}
  }
  prefetchSearch()
    .then(function () {
      const i = instance();
      if (i) {
        i.open({ q: proxy.value || opts.q, focus: opts.focus, handoff: function () { return reuse; } });
      }
    })
    .catch(function () {})
    .then(function () {
      if (proxy.parentNode) proxy.parentNode.removeChild(proxy);
    });
}

/** 进页带 ?q=：打开搜索层并预填（URL 去掉 q） */
export function initSearchHost() {
  let q = null;
  try {
    const u = new URL(location.href);
    q = u.searchParams.get('q');
    if (q === null) return;
    u.searchParams.delete('q');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  } catch (e) {
    return;
  }
  const qq = q;
  prefetchSearch()
    .then(function () { openSearch({ q: qq }); })
    .catch(function () {});
}
