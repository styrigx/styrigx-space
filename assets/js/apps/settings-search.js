/**
 * @fileoverview B1-6：设置搜索独立页。
 * - 入口：设置主页点搜索框 → /settings/search/（history 推进），自动聚焦。
 * - 内容优先：进页时滚动到标题区底部（标题收起），下拉到底露出大标题。
 * - 历史：sgx-settings-search-history，最多 10 条，去重，新的在前。
 * - 搜索栏：键盘弹起浮在键盘上方；收起后沉到底部。followKeyboard。
 * - 返回：键盘态 popstate 只收键盘；沉底态正常 back。
 */
import { followKeyboard } from '../shell/vk.js';

const HIST_KEY = 'sgx-settings-search-history';
const HIST_MAX = 10;

function $(id) { return document.getElementById(id); }

function getLang() {
  try {
    return document.documentElement.lang === 'en' || location.pathname.startsWith('/en/') ? 'en' : 'zh';
  } catch (e) { return 'zh'; }
}

/* ---------- 历史读写（3 个函数，只在本页使用） ---------- */
function getHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    return Array.isArray(arr) ? arr.slice(0, HIST_MAX) : [];
  } catch (e) { return []; }
}

function addHistory(q) {
  q = (q || '').trim();
  if (!q) return;
  let arr = getHistory().filter(function (x) { return x !== q; });
  arr.unshift(q);
  arr = arr.slice(0, HIST_MAX);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(arr)); } catch (e) {}
  renderHistory();
}

function removeHistory(q) {
  const arr = getHistory().filter(function (x) { return x !== q; });
  try { localStorage.setItem(HIST_KEY, JSON.stringify(arr)); } catch (e) {}
  renderHistory();
}

function clearHistory() {
  try { localStorage.removeItem(HIST_KEY); } catch (e) {}
  renderHistory();
}

/* ---------- 搜索索引（复用 settings-i18n 的 setidx） ---------- */
let SETIDX = [];
function initIndex() {
  try {
    const el = document.getElementById('sgx-i18n-settings');
    const RAW = JSON.parse((el && el.textContent) || '{}');
    const en = getLang() === 'en';
    SETIDX = (RAW.setidx || []).map(function (a) {
      return {
        t: en ? a[1] : a[0],
        d: en ? a[3] : a[2],
        cat: a[4],
        el: a[5],
        u: a[8] || '',
      };
    });
  } catch (e) { SETIDX = []; }
}

/* ---------- 渲染 ---------- */
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function renderHistory() {
  const card = $('search-history-card');
  const list = $('search-history-list');
  if (!card || !list) return;
  const arr = getHistory();
  if (!arr.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  list.innerHTML = arr.map(function (q) {
    return '<span class="sgx-search-hist">' +
      '<button type="button" class="sgx-search-hist-q" data-q="' + esc(q) + '">' + esc(q) + '</button>' +
      '<button type="button" class="sgx-search-hist-x" data-del="' + esc(q) + '" aria-label="×">×</button>' +
      '</span>';
  }).join('');
}

function highlight(text, q) {
  if (!q) return esc(text);
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return esc(text);
  return esc(text.slice(0, idx)) + '<mark>' + esc(text.slice(idx, idx + q.length)) + '</mark>' + esc(text.slice(idx + q.length));
}

function renderResults(q) {
  const sec = $('search-results');
  const titleEl = $('search-results-title');
  const list = $('search-results-list');
  const empty = $('search-empty');
  if (!sec || !list) return;
  q = (q || '').trim();
  if (!q) {
    sec.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  const ql = q.toLowerCase();
  const hits = SETIDX.filter(function (x) {
    return (x.t + ' ' + x.d).toLowerCase().indexOf(ql) >= 0;
  });
  /* 按 cat 分组 */
  const groups = {};
  hits.forEach(function (x) {
    (groups[x.cat] = groups[x.cat] || []).push(x);
  });
  const en = getLang() === 'en';
  titleEl.textContent = (en ? 'Search results (' : '搜索结果（') + hits.length + (en ? ')' : ' 个）');
  list.innerHTML = Object.keys(groups).map(function (cat) {
    const items = groups[cat].map(function (x) {
      const url = x.u || ('/settings/' + x.cat + '/');
      return '<a class="setso-item" href="' + esc(url) + '" data-q="' + esc(q) + '">' +
        '<span class="flex-1 min-w-0"><span class="block font-medium truncate">' + highlight(x.t, q) + '</span>' +
        (x.d ? '<span class="block text-xs text-m-on-surface-variant truncate">' + highlight(x.d, q) + '</span>' : '') +
        '</span></a>';
    }).join('');
    return '<div class="sgx-search-group"><h3 class="sgx-search-group-t">' + esc(cat) + '</h3>' + items + '</div>';
  }).join('') || '<p class="px-4 py-8 text-center text-sm text-m-on-surface-variant">' +
    (en ? 'No results' : '没有找到结果') + '</p>';
  sec.hidden = false;
  if (empty) empty.hidden = true;
}

/* ---------- 主逻辑 ---------- */
export function initSettingsSearch() {
  initIndex();
  renderHistory();

  const input = $('search-input');
  const bar = $('search-bar');
  const micBtn = $('search-mic');
  const moreBtn = $('search-more');
  const clearBtn = $('search-clear');
  if (!input || !bar) return;

  /* 内容优先：进页时滚动到标题区底部 */
  try {
    const head = document.querySelector('[data-subpage-head]');
    if (head) {
      const y = head.offsetTop + head.offsetHeight;
      window.scrollTo(0, y);
    }
  } catch (e) {}

  /* 自动聚焦、弹键盘 */
  try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (e2) {} }

  /* 搜索栏跟随键盘 */
  try { followKeyboard(bar, input); } catch (e) {}

  /* 输入态：⋮ ↔ × 切换 */
  function updateBar() {
    const has = input.value.trim().length > 0;
    if (clearBtn) clearBtn.hidden = !has;
    if (moreBtn) moreBtn.hidden = has;
    if (micBtn) micBtn.hidden = has;
  }
  input.addEventListener('input', function () {
    updateBar();
    renderResults(input.value);
  });
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      input.value = '';
      updateBar();
      renderResults('');
      input.focus();
    });
  }

  /* 搜索键：记历史 */
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      addHistory(input.value);
      renderResults(input.value);
      input.blur();
    }
  });

  /* 点历史胶囊 = 填入并搜索 */
  document.addEventListener('click', function (e) {
    const q = e.target.closest('[data-q]');
    if (q && !e.target.closest('[data-del]')) {
      const query = q.getAttribute('data-q');
      input.value = query;
      updateBar();
      renderResults(query);
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      removeHistory(del.getAttribute('data-del'));
      return;
    }
    /* 点结果：记历史 */
    const item = e.target.closest('.setso-item');
    if (item) {
      addHistory(input.value.trim() || item.textContent.trim());
    }
  });

  const clearAll = $('search-history-clear');
  if (clearAll) {
    clearAll.addEventListener('click', clearHistory);
  }

  /* 返回手势：键盘态只收键盘 */
  let kbSentinel = false;
  input.addEventListener('focus', function () {
    if (!kbSentinel) {
      try {
        history.pushState({ sgxSearchKb: 1 }, '');
        kbSentinel = true;
      } catch (e) {}
    }
  });
  window.addEventListener('popstate', function (e) {
    if (kbSentinel && document.activeElement === input) {
      /* 键盘态：只收键盘，不离页 */
      input.blur();
      kbSentinel = false;
      /* 重新压一条，保持沉底态可正常返回 */
      try { history.pushState({ sgxSearchKb: 0 }, ''); } catch (e2) {}
    }
    /* 沉底态：不拦截，正常 back 回 /settings/ */
  });

  /* 点空白处 = 收键盘沉底 */
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#search-bar') && !e.target.closest('#search-content')) {
      if (document.activeElement === input) input.blur();
    }
  });

  updateBar();
}

/* 自动初始化 */
try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSettingsSearch);
  } else {
    initSettingsSearch();
  }
} catch (e) {}
