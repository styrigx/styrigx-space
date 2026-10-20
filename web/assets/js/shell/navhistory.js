/**
 * @fileoverview 全站搜索快捷键 + 返回历史逻辑（旧 sgx-base-a.js 上半）。
 * 2026-10-20：顶栏 ‹ 返回按钮已删除（网站始终跑在浏览器里，用浏览器 / 系统返回），
 * 只为 ‹ 服务的上一级表（parentOf）、一级 App 回主页、头像来源页回跳（#142）随之删除；
 * 保留系统返回需要的「直接打开子页插入一条主页历史」和 healRoot()（桌面版 / 移动版切换修复）。
 */
import { on } from '../lib/events.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';

/**
 * 初始化：Cmd/Ctrl+K 跳全网搜索；系统返回的历史管理。
 */
export function initNavHistory() {
  const en = document.documentElement.lang === 'en';
  const searchUrl = en ? '/en/search/' : '/search/';
  const home = en ? '/en/' : '/';

  /* Cmd/Ctrl+K → 全网搜索 */
  on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      const t = /** @type {HTMLElement|null} */ (e.target);
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      sgxNavigate(searchUrl);
    }
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
      const parent = home;
      const curUrl = location.pathname + location.search + location.hash;
      history.replaceState({ sgxRoot: 1 }, '', parent);
      history.pushState({ sgxHere: 1 }, '', curUrl);
      sessionStorage.setItem('sgx-hist-root', '1');
    } catch (e) {}
  })();
  /* 上面插入的那条主页历史是 replaceState 改出来的「假条目」：浏览器里它的原始请求地址
     仍是当初打开的子页（如 /settings/）。Chromium 系「请求桌面版/移动版网站」按原始请求地址
     重载（LoadOriginalRequestURL），停在这条历史上的主页一切换就会跳到设置。
     所以只要发现当前停在这条历史上，就用 location.replace 换成一条真正请求主页的新条目：
     - 同一文档退回（popstate）；
     - 跨文档退回 / 刷新 / 会话恢复（子页已换文档，浏览器直接按 URL 加载主页，不发 popstate）；
     - bfcache 恢复（pageshow persisted）。
     replace 前先清掉标记：同 URL 的 location.replace 会把 history.state 带到新条目，
     不清的话新条目以后再被退回到还会被误判、白白再重载一次。 */
  function healRoot() {
    if (!(history.state && history.state.sgxRoot)) return false;
    try {
      history.replaceState(null, '', location.href);
    } catch (e) {}
    sgxReplace(location.href);
    return true;
  }
  healRoot();
  window.addEventListener('popstate', function (e) {
    if (e.state && e.state.sgxRoot) healRoot();
  });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) healRoot();
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
