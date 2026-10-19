/**
 * @fileoverview 全站搜索快捷键 + 返回历史逻辑（旧 sgx-base-a.js 上半）。
 */
import { on, delegate } from '../lib/events.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';

/**
 * 初始化：Cmd/Ctrl+K 跳浏览器页搜索；返回键的历史管理。
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
      sgxNavigate(bUrl + 'search/');
    }
  });

  /* ===== 返回逻辑：一级 App 一次回主页，二级回一级 ===== */
  const PRIMARY = {
    '/browser/': 1, '/en/browser/': 1,
    '/settings/': 1, '/en/settings/': 1,
  };
  /* ===== 账号页返回（顶栏右圆头像进入）：回到点头像时所在的页面（来源页） =====
     - 点头像（.sgx-tb-me）：记下当前页为来源（sessionStorage sgx-acct-origin），并打 fresh 标记；
     - 进账号总览：fresh 标记 → 沿用；referrer 是本站非账号页 → 记为来源；referrer 是子站
       （blog/book.styrigx.com，跨站时浏览器只给 origin）→ 记为来源；referrer 是账号两页（子页返回、
       登录后回跳、退出后）→ 保留来源；没有 referrer（直接打开）→ 清掉来源，返回落到 /settings/。
     - 总览返回：referrer 就是来源且同源 → history.back()（真返回）；否则 location.replace(来源)；
       没有来源 → parentOf（/settings/）。
     - 安全与隐私子页返回固定回总览（parentOf），来源原样保留，不会在两页之间来回跳。 */
  const ACCT_ORIGIN_KEY = 'sgx-acct-origin';
  const ACCT_FRESH_KEY = 'sgx-acct-fresh';
  const ACCT_RE = /^\/(en\/)?settings\/account\/(security\/)?$/;
  const ACCT_HOME_RE = /^\/(en\/)?settings\/account\/$/;
  const SUBSITE_RE = /^https:\/\/(blog|book)\.styrigx\.com(\/|$)/;
  function ssGet(k) {
    try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; }
  }
  function ssSet(k, v) {
    try {
      if (v) sessionStorage.setItem(k, v);
      else sessionStorage.removeItem(k);
    } catch (e) {}
  }
  /**
   * 把 referrer / 记录值规整成可回跳的地址：本站非账号页 → 路径；子站 → 完整 URL；其他 → ''。
   * @param {string} u
   * @returns {{url:string, same:boolean, acct:boolean}}
   */
  function classifyUrl(u) {
    if (!u) return { url: '', same: false, acct: false };
    try {
      const x = new URL(u, location.href);
      if (x.origin === location.origin) {
        const acct = ACCT_RE.test(x.pathname);
        return { url: acct ? '' : x.pathname + x.search + x.hash, same: true, acct: acct };
      }
      if (SUBSITE_RE.test(x.href)) return { url: x.href, same: false, acct: false };
    } catch (e) {}
    return { url: '', same: false, acct: false };
  }
  /* 点头像：记来源（已在账号页上点则不改） */
  delegate(document, 'click', '.sgx-tb-me', function () {
    if (ACCT_RE.test(location.pathname)) return;
    ssSet(ACCT_ORIGIN_KEY, location.pathname + location.search + location.hash);
    ssSet(ACCT_FRESH_KEY, '1');
  });
  /* 进账号总览：按上面的规则更新来源 */
  if (ACCT_HOME_RE.test(location.pathname)) {
    let ref = '';
    try { ref = document.referrer || ''; } catch (e) {}
    const r = classifyUrl(ref);
    if (ssGet(ACCT_FRESH_KEY)) {
      ssSet(ACCT_FRESH_KEY, '');
    } else if (r.url) {
      ssSet(ACCT_ORIGIN_KEY, r.url);
    } else if (!r.acct) {
      ssSet(ACCT_ORIGIN_KEY, '');
    }
  }
  /** 账号总览的返回目标：{ back:true } 用 history.back()；{ url } 用 replace；null → parentOf */
  function acctBackTarget() {
    const origin = classifyUrl(ssGet(ACCT_ORIGIN_KEY));
    if (!origin.url) return null;
    let ref = '';
    try { ref = document.referrer || ''; } catch (e) {}
    const r = classifyUrl(ref);
    if (r.same && r.url && r.url === origin.url && history.length > 1) return { back: true, url: origin.url };
    return { back: false, url: origin.url };
  }

  function parentOf() {
    const p = location.pathname;
    /* 账号 → 安全与隐私子页的上一级是账号总览 */
    if (p === '/settings/account/security/' || p === '/en/settings/account/security/') {
      return en ? '/en/settings/account/' : '/settings/account/';
    }
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
    /* 浏览器搜索页的上一级是浏览器 */
    if (p === '/browser/search/' || p === '/en/browser/search/') return bUrl;
    /* 2.6.0：设置子页的上一级是设置首页 */
    if (p !== '/settings/' && p.indexOf('/settings/') === 0) return '/settings/';
    if (p !== '/en/settings/' && p.indexOf('/en/settings/') === 0) return '/en/settings/';
    return home;
  }
  function goBack() {
    const p = location.pathname;
    if (PRIMARY[p]) {
      sgxReplace(home);
      return;
    }
    if (ACCT_HOME_RE.test(p)) {
      const tgt = acctBackTarget();
      if (tgt) {
        if (tgt.back) history.back();
        else sgxReplace(tgt.url);
        return;
      }
    }
    sgxReplace(parentOf());
  }
  /* 事件委托：按钮在 <main> 里，脚本可能先执行 */
  delegate(document, 'click', '[data-go-back]', function (e) {
    e.preventDefault();
    goBack();
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
