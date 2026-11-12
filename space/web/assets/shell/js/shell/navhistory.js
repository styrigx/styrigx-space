/**
 * @fileoverview 返回历史逻辑（旧 sgx-base-a.js 上半；P4-2 起 Ctrl+K 原地搜索层随搜索层删除）。
 * 2026-10-20：顶栏 ‹ 返回按钮已删除（网站始终跑在浏览器里，用浏览器 / 系统返回），
 * 只为 ‹ 服务的上一级表（parentOf）、一级 App 回主页、头像来源页回跳（#142）随之删除；
 * 保留系统返回需要的「直接打开子页插入一条主页历史」和 healRoot()（桌面版 / 移动版切换修复）。
 */
import { on } from '../lib/events.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { langPath } from '../lib/lang-path.js';
import { i18nTable, pageLang } from '../lib/i18n.js';
/** 界面文案：页面字符串表 #sgx-i18n-core（语言包化 2026-11-07；当前语言已叠在英文上） */
const tx = i18nTable('core');

/**
 * 首帧语言跳转（baseof.html）留下的原始来源：sessionStorage sgx-lang-hop = {go, ref}。
 * 只在本文档就是那次跳转的目标时采用（go 等于当前地址），读到就删（用一次）；没有 / 对不上 → null。
 * @returns {string|null}
 */
function langHopReferrer() {
  let raw = null;
  try {
    raw = sessionStorage.getItem('sgx-lang-hop');
    if (raw !== null) sessionStorage.removeItem('sgx-lang-hop');
  } catch (e) {}
  if (raw === null) return null;
  try {
    const hop = JSON.parse(raw);
    const here = location.pathname + location.search + location.hash;
    if (hop && hop.go === here && typeof hop.ref === 'string') return hop.ref;
  } catch (e) {}
  return null;
}

/**
 * 初始化：系统返回的历史管理。
 */
export function initNavHistory() {
  /* baseof 首帧语言跳转已发出（location.replace 到另一语言）：这份文档马上被换掉，不动历史，留给跳过去的那份 */
  if (/** @type {any} */ (window).__sgxLangGo) return;
  const en = document.documentElement.lang === 'en';
  const home = langPath('/', pageLang());
  const hopRef = langHopReferrer();

  /* 直接打开 App 页：最多插入一次主页历史，保证系统返回一次回到主页。 */
  (function () {
    if (!document.body.classList.contains('subpage')) return;
    let ref = '';
    try {
      ref = document.referrer || '';
    } catch (e) {}
    /* 首帧语言跳转过来的（如中文浏览器直接打开 /theme/ → /zh/theme/）：referrer 是跳之前那份同源文档，按跳之前的来源算 */
    if (hopRef !== null) ref = hopRef;
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
     仍是当初打开的子页（如 /theme/）。Chromium 系「请求桌面版/移动版网站」按原始请求地址
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
