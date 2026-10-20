/**
 * @fileoverview 全网搜索页（/search/；2026-10-20 由浏览器搜索 /browser/search/ 改名搬来）。
 * 做法照抄设置搜索：底部通用搜索胶囊（capsule.js 负责跟键盘走、沉底），
 * 页面内容是 最近搜索 / 站内建议（书签、博客、应用）/ 用当前引擎搜索。
 * 搜索引擎选择、清除浏览记录在 设置 › 安全与隐私 › 隐私（security.js），本页不再有顶栏 ⋮。
 */
import { on } from '../lib/events.js';
import { esc } from '../lib/util.js';
import { get, set } from '../lib/storage.js';
import { loadI18n } from '../lib/i18n.js';
import { engines as SE } from '../shell/engines.js';
import { setCapSearchProvider } from '../shell/capsule.js';
import { sgxNavigate, sgxReplace, sgxGoBack } from '../lib/diag-jumptrace.js';

(function () {
  'use strict';
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-cap-input-brwsearch'));
  const page = document.getElementById('brws-page');
  if (!input || !page) return;
  const T = loadI18n('sgx-i18n-brws');

  /* ============ 最近搜索（与旧弹出层同一个 key，历史不丢） ============ */
  const LS_HIST = 'sgx-browser-history';
  /** @returns {Array<string>} */
  function getHist() {
    try {
      const a = JSON.parse(get(LS_HIST) || '[]');
      return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }).slice(0, 12) : [];
    } catch (e) {
      return [];
    }
  }
  /** @param {Array<string>} a */
  function setHist(a) {
    set(LS_HIST, JSON.stringify(a.slice(0, 12)));
  }
  /** @param {string} s */
  function pushHist(s) {
    s = (s || '').trim();
    if (!s) return;
    const a = getHist().filter(function (x) { return x !== s; });
    a.unshift(s);
    setHist(a);
  }

  /* ============ 站内索引（/files-index.json；浏览器页原来的内联兜底 #search-index 已删除） ============ */
  const TYPES = [
    { type: 'link', label: T.t('catLink') },
    { type: 'post', label: T.t('catPost') },
    { type: 'app', label: T.t('catApp') },
  ];
  /** @type {Array<{t:string,d:string,u:string,type:string}>} */
  let INDEX = [];
  (function () {
    const wantLang = document.documentElement.lang === 'en' ? 'en' : 'zh';
    fetch('/files-index.json')
      .then(function (r) {
        if (!r.ok) throw new Error('bad status ' + r.status);
        return r.json();
      })
      .then(function (j) {
        const items = ((j && j.items) || [])
          .filter(function (/** @type {any} */ x) {
            return x && (x.type === 'link' || x.type === 'post' || x.type === 'app') && (x.lang || 'zh') === wantLang;
          })
          .map(function (/** @type {any} */ x) {
            return { t: x.title || '', d: x.subtitle || '', u: x.url || '', type: x.type };
          });
        if (items.length) {
          INDEX = items;
          render(input.value);
        }
      })
      .catch(function () { /* 拿不到索引：只剩引擎搜索 */ });
  })();

  /* ============ 渲染 ============ */
  const XICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';
  const CHEVR =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>';
  /** @param {string} text @param {string} q */
  function hl(text, q) {
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) return esc(text);
    return esc(text.slice(0, idx)) + '<mark class="setso-hl">' + esc(text.slice(idx, idx + q.length)) + '</mark>' + esc(text.slice(idx + q.length));
  }

  /** @type {Array<{t:string,d:string,u:string,type:string}>} 当前列出的站内结果（回车精确匹配用） */
  let hits = [];

  function renderRecent() {
    const a = getHist();
    if (!a.length) {
      page.innerHTML = '';
      return;
    }
    let html =
      '<div class="setso-card setso-recent" role="region" aria-label="' + esc(T.t('recent')) + '">' +
      '<div class="setso-recent-head"><span class="setso-recent-title">' + esc(T.t('recent')) + '</span>' +
      '<button type="button" class="setso-clear" data-brws-clear>' + esc(T.t('clearAll')) + '</button></div>' +
      '<div class="setso-chips">';
    a.forEach(function (s, i) {
      html +=
        '<span class="setso-chip" data-brws-chip="' + i + '"><span class="setso-chip-tx">' + esc(s) + '</span>' +
        '<button type="button" class="setso-chip-x" data-brws-del="' + i + '" aria-label="' + esc(T.t('del') + ' ' + s) + '">' + XICON + '</button></span>';
    });
    page.innerHTML = html + '</div></div>';
  }

  /** @param {string} raw */
  function render(raw) {
    const q = (raw || '').trim();
    hits = [];
    if (!q) {
      renderRecent();
      return;
    }
    const ql = q.toLowerCase();
    let html = '';
    TYPES.forEach(function (c) {
      const hs = INDEX.filter(function (x) {
        return x.type === c.type && (x.t + ' ' + (x.d || '')).toLowerCase().indexOf(ql) !== -1;
      }).slice(0, 5);
      if (!hs.length) return;
      html += '<div class="setso-card"><div class="setso-card-head">' + esc(c.label) + '</div>';
      hs.forEach(function (x) {
        hits.push(x);
        html +=
          '<button type="button" class="setso-item" data-brws-u="' + esc(x.u) + '">' +
          '<span class="flex-1 min-w-0"><span class="block font-medium truncate">' + hl(x.t, ql) + '</span>' +
          (x.d ? '<span class="block text-xs text-m-on-surface-variant truncate">' + hl(x.d, ql) + '</span>' : '') +
          '</span>' + CHEVR + '</button>';
      });
      html += '</div>';
    });
    html +=
      '<div class="setso-card"><button type="button" class="setso-item" data-brws-engine>' +
      '<span class="flex-1 min-w-0"><span class="block font-medium truncate">' +
      esc(T.fmt('searchWith', { n: SE.name(SE.cur()) })) + ' “' + esc(q) + '”</span></span>' + CHEVR + '</button></div>';
    page.innerHTML = html;
  }
  /* 胶囊在聚焦 / 输入 / 回车 / 语音结束时回调；本页 panel 为 false，结果直接画在页面里 */
  setCapSearchProvider(function (pg, q) {
    if (pg === 'brwsearch') {
      render(q);
      syncTools();
    }
    return '';
  });

  /* ============ 打开 / 搜索 ============ */
  /** @param {string} u */
  function openUrl(u) {
    if (!u) return;
    if (/^https?:\/\//i.test(u)) window.open(u, '_blank', 'noopener');
    else sgxNavigate(u);
  }
  const URL_RE = /^[^\s]+\.[^\s]{2,}$/;
  const HAS_CJK = /[一-鿿㐀-䶿豈-﫿]/;
  /** @param {string} q */
  function doSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    pushHist(q);
    if (URL_RE.test(q) && !HAS_CJK.test(q)) {
      window.open(/^https?:\/\//i.test(q) ? q : 'https://' + q, '_blank', 'noopener');
      return;
    }
    window.open(SE.url(SE.cur(), q), '_blank', 'noopener');
  }
  /* 回车：名字和输入完全一样的站内结果（如书签「X」）直接打开；否则按网址 / 引擎搜索 */
  on(input, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const ql = q.toLowerCase();
    const exact = INDEX.find(function (x) { return x.t.toLowerCase() === ql; });
    if (exact) {
      pushHist(q);
      openUrl(exact.u);
    } else {
      doSearch(q);
    }
    input.blur(); /* 收键盘、胶囊沉底 */
    render(input.value);
  });

  /* 点结果 / 最近搜索 */
  page.addEventListener('pointerdown', function (e) {
    const t = /** @type {Element|null} */ (e.target);
    if (t && t.closest && t.closest('.setso-recent')) e.preventDefault(); /* 点最近搜索不抢焦点 */
  });
  on(page, 'click', function (/** @type {MouseEvent} */ e) {
    const t = /** @type {Element|null} */ (e.target);
    if (!t || !t.closest) return;
    const del = t.closest('[data-brws-del]');
    if (del) {
      const a = getHist();
      a.splice(parseInt(del.getAttribute('data-brws-del') || '0', 10), 1);
      setHist(a);
      renderRecent();
      return;
    }
    if (t.closest('[data-brws-clear]')) {
      setHist([]);
      renderRecent();
      return;
    }
    const chip = t.closest('[data-brws-chip]');
    if (chip) {
      const s = getHist()[parseInt(chip.getAttribute('data-brws-chip') || '0', 10)] || '';
      if (s) doSearch(s);
      renderRecent();
      return;
    }
    if (t.closest('[data-brws-engine]')) {
      doSearch(input.value);
      render(input.value);
      return;
    }
    const it = t.closest('[data-brws-u]');
    if (it) {
      pushHist(input.value);
      openUrl(it.getAttribute('data-brws-u') || '');
    }
  });

  /* ============ 胶囊：ⓧ 清空（有输入才出现）+ × 关闭（常驻，退出搜索页） ============ */
  const cap = document.getElementById('sgx-cap-brwsearch');
  const capClose = cap ? cap.querySelector('[data-cap-close]') : null;
  const capClear = cap ? cap.querySelector('[data-cap-clear]') : null;
  /* 键盘哨兵是否已 push（返回手势逻辑见文件末尾） */
  let armed = false;
  function syncTools() {
    if (capClear) /** @type {HTMLElement} */ (capClear).hidden = input.value.length === 0;
  }
  on(input, 'input', syncTools);
  [capClose, capClear].forEach(function (b) {
    if (b) b.addEventListener('pointerdown', function (e) { e.preventDefault(); });
  });
  if (capClear) {
    on(capClear, 'click', function (/** @type {MouseEvent} */ e) {
      e.stopPropagation();
      input.value = '';
      syncTools();
      render('');
      contentFirst();
      try { input.focus({ preventScroll: true }); } catch (err) {}
    });
  }
  if (capClose) {
    /* × = 退出搜索页：站内进来的回到来的那一页（连同键盘哨兵一起退掉）；外部直接打开的回主页 */
    on(capClose, 'click', function (/** @type {MouseEvent} */ e) {
      e.stopPropagation();
      let internal = false;
      try { internal = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch (err) {}
      if (!internal) {
        sgxReplace(document.documentElement.lang === 'en' ? '/en/' : '/');
        return;
      }
      if (armed) {
        armed = false;
        history.go(-2);
      } else {
        sgxGoBack();
      }
    });
  }

  /* ============ 内容置顶（与设置搜索相同）：滚过标题区，内容紧贴顶栏下方；往下拉到顶才露出大标题 ============ */
  function contentFirst() {
    const heads = document.querySelectorAll('[data-subpage-head]');
    let head = null;
    for (let i = 0; i < heads.length; i++) {
      if (heads[i].getClientRects().length) { head = /** @type {HTMLElement} */ (heads[i]); break; }
    }
    if (!head) return;
    const bar = document.querySelector('.sgx-topbar');
    const barBottom = bar ? bar.getBoundingClientRect().bottom : 68;
    const y = Math.max(0, head.getBoundingClientRect().bottom + window.scrollY - barBottom - 16);
    window.scrollTo(0, y);
  }
  try { history.scrollRestoration = 'manual'; } catch (e) {}
  /* 下一帧再置顶：公共初始化会调整标题区高度，模块求值时量的位置会偏 */
  requestAnimationFrame(contentFirst);
  on(input, 'input', function () { window.setTimeout(contentFirst, 170); });

  on(window, 'sgx-settings-changed', function () { render(input.value); });

  /* ============ 进页：?q= 预填；聚焦放下一帧（等胶囊 initCapsule 绑定好 focus） ============ */
  try {
    const q0 = new URLSearchParams(location.search).get('q');
    if (q0) input.value = q0;
  } catch (e) {}
  syncTools();
  render(input.value);
  requestAnimationFrame(function () {
    /* 带 #voice 进来（旧浏览器页地址栏麦克风的约定，保留）：直接开语音（语音弹窗自己收键盘） */
    if (location.hash === '#voice') {
      const mic = cap ? /** @type {HTMLElement|null} */ (cap.querySelector('[data-mic]')) : null;
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) {}
      if (mic && mic.style.display !== 'none') {
        mic.click();
        return;
      }
    }
    try { input.focus({ preventScroll: true }); } catch (e) {}
  });

  /* ============ 返回手势（与设置搜索相同）：键盘态只收键盘；沉底态继续返回上一页 ============ */
  function isKb() {
    return document.activeElement === input || !!(cap && cap.classList.contains('open'));
  }
  function arm() {
    if (armed) return;
    try {
      history.pushState({ url: location.href, scrollY: window.scrollY, sgxBrwsKb: 1 }, '', location.href);
      armed = true;
    } catch (e) {}
  }
  on(input, 'focus', arm);
  window.addEventListener(
    'popstate',
    function () {
      if (!armed) return;
      /* 出栈的是哨兵之上的条目（如导航抽屉的哨兵）：本页哨兵还在，不当作返回 */
      if (history.state && history.state.sgxBrwsKb) return;
      armed = false;
      if (isKb()) {
        try { input.blur(); } catch (e) {}
        return;
      }
      window.setTimeout(function () { sgxGoBack(); }, 0);
    },
    true
  );
})();
