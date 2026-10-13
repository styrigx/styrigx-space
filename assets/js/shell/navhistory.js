/**
 * @fileoverview 全站搜索快捷键 + 返回/Dock 历史逻辑（旧 sgx-base-a.js 上半）。
 */
import { on, delegate } from '../lib/events.js';
import { sgxNavigate, sgxReplace, sgxGoBack } from '../lib/diag-jumptrace.js';

/**
 * 初始化：Cmd/Ctrl+K 跳浏览器页搜索；返回键与 Dock 的历史管理。
 */
export function initNavHistory() {
  const en = document.documentElement.lang === 'en';
  const bUrl = en ? '/en/browser/' : '/browser/';
  const home = en ? '/en/' : '/';

  /* Cmd/Ctrl+K → 浏览器页搜索 */
  on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      const t = /** @type {HTMLElement|null} */ (e.target);
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      sgxNavigate(bUrl + '#focus', 'navhistory.js:21', 'cmdk-search');
    }
  });

  /* ===== 返回逻辑：一级 App 一次回主页，二级回一级；Dock 切换不累积历史 ===== */
  const PRIMARY = {
    '/browser/': 1, '/en/browser/': 1, '/files/': 1, '/en/files/': 1,
    '/settings/': 1, '/en/settings/': 1, '/books/': 1, '/en/books/': 1,
    '/music/': 1, '/en/music/': 1, '/goodlock/': 1, '/en/goodlock/': 1,
  };
  function isFilesType() {
    const p = location.pathname;
    return (p === '/files/' || p === '/en/files/') && location.search.indexOf('type=') !== -1;
  }
  function parentOf() {
    const p = location.pathname;
    if (p === '/files/' || p === '/en/files/') return en ? '/en/files/' : '/files/';
    /* C2：管理凭证区三级返回（定稿第 31、33 条）：
       Book 详情 → 应用；应用/锁屏 → 管理凭证索引页；索引页 → 安全与隐私。 */
    if (p === '/settings/security/apps/book/' || p === '/en/settings/security/apps/book/') {
      return en ? '/en/settings/security/apps/' : '/settings/security/apps/';
    }
    if (p === '/settings/security/apps/' || p === '/en/settings/security/apps/' ||
        p === '/settings/security/lock/' || p === '/en/settings/security/lock/') {
      return en ? '/en/settings/security/mgmt/' : '/settings/security/mgmt/';
    }
    if (p === '/settings/security/mgmt/' || p === '/en/settings/security/mgmt/') {
      return en ? '/en/settings/security/' : '/settings/security/';
    }
    /* 2.6.0：设置子页的上一级是设置首页 */
    if (p !== '/settings/' && p.indexOf('/settings/') === 0) return '/settings/';
    if (p !== '/en/settings/' && p.indexOf('/en/settings/') === 0) return '/en/settings/';
    return home;
  }
  function goBack() {
    if (isFilesType()) {
      sgxReplace(en ? '/en/files/' : '/files/', 'navhistory.js:54', 'goback-files');
      return;
    }
    const p = location.pathname;
    if (PRIMARY[p]) {
      sgxReplace(home, 'navhistory.js:59', 'goback-primary');
      return;
    }
    sgxReplace(parentOf(), 'navhistory.js:62', 'goback-parent');
  }
  /* 事件委托：按钮在 <main> 里，脚本可能先执行 */
  delegate(document, 'click', '[data-go-back]', function (e) {
    e.preventDefault();
    goBack();
  });
  /* Dock 在 App 之间切换：子页面用 replace 不累积历史；主页用普通跳转保留历史。 */
  delegate(document, 'click', '#mobile-dock a[href],#dex-dock a[href]', function (e, a) {
    const p = location.pathname;
    const isHome = p === '/' || p === '/en' || p === '/en/';
    if (isHome) return; /* 主页：不拦截，普通跳转 */
    e.preventDefault();
    sgxReplace(a.getAttribute('href') || home, 'navhistory.js:75', 'dock-switch');
  });
  /* 直接打开 App 页：最多插入一次主页历史，保证系统返回一次回到主页。 */
  (function () {
    if (!document.body.classList.contains('subpage')) return;
    let ref = '';
    try {
      ref = document.referrer || '';
    } catch (e) {}
    let ext = true;
    try {
      ext = !ref || new URL(ref).origin !== location.origin;
    } catch (e) {}
    let done = false;
    try {
      done = sessionStorage.getItem('sgx-hist-root') === '1';
    } catch (e) {}
    if (!ext || done) return;
    try {
      const p = location.pathname;
      const isFT = (p === '/files/' || p === '/en/files/') && location.search.indexOf('type=') !== -1;
      const parent = isFT ? (en ? '/en/files/' : '/files/') : home;
      const curUrl = location.pathname + location.search + location.hash;
      history.replaceState({ sgxRoot: 1 }, '', parent);
      history.pushState({ sgxHere: 1 }, '', curUrl);
      sessionStorage.setItem('sgx-hist-root', '1');
    } catch (e) {}
  })();

  /* 一级页折叠态返回键：有站内上一页就 history.back()，否则回对应语言首页 */
  delegate(document, 'click', '[data-back-top]', function (e) {
    e.preventDefault();
    let same = false;
    try {
      const r = document.referrer;
      same = !!r && new URL(r).origin === location.origin;
    } catch (_) {}
    if (same) sgxGoBack('navhistory.js:111', 'back-top');
    else sgxNavigate(document.documentElement.lang === 'en' ? '/en/' : '/', 'navhistory.js:112', 'back-top-home');
  });

  /* 双击顶栏回顶部（One UI 习惯） */
  (function () {
    const nav = document.getElementById('site-nav');
    if (!nav) return;
    let lastTap = 0;
    on(nav, 'dblclick', function (/** @type {MouseEvent} */ e) {
      const t = /** @type {HTMLElement|null} */ (e.target);
      if ((t && t.closest('button')) || (t && t.closest('a'))) return;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    on(
      nav,
      'touchend',
      function (/** @type {TouchEvent} */ e) {
        const t = /** @type {HTMLElement|null} */ (e.target);
        if ((t && t.closest('button')) || (t && t.closest('a'))) return;
        const now = Date.now();
        if (now - lastTap < 350) {
          e.preventDefault();
          window.scrollTo({ top: 0, behavior: 'smooth' });
          lastTap = 0;
        } else {
          lastTap = now;
        }
      },
      { passive: false }
    );
  })();
}
