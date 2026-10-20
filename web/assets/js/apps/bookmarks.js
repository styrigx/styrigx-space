/**
 * @fileoverview 书签页（/bookmarks/，2026-10-20 由浏览器页拆出）：只有书签（分类筛选条 + 分组）。
 * 快捷访问、底部地址栏胶囊、地址栏位置设置、顶栏 ⋮ 都已删除；
 * 搜索是独立的全网搜索页（/search/，web-search.js），搜索引擎和清除浏览记录在 设置 › 安全与隐私 › 隐私。
 */
import { on } from '../lib/events.js';
import { bindFavFallback } from '../shell/fav.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';

(function () {
  'use strict';
  const en = document.documentElement.lang === 'en';
  const SEARCH_URL = en ? '/en/search/' : '/search/';

  /* 旧入口兼容：/browser/?q=… 与 /browser/#focus（旧书签、旧 OpenSearch；/browser/ 已跳到这里）→ 全网搜索 */
  try {
    const q = new URLSearchParams(location.search).get('q');
    if (q || location.hash === '#focus') {
      sgxReplace(SEARCH_URL + (q ? '?q=' + encodeURIComponent(q) : ''));
      return;
    }
  } catch (e) {}

  /* favicon 失败兜底（data-favname 委托） */
  bindFavFallback();

  /* ============ 书签分类筛选 ============ */
  const catBtns = document.querySelectorAll('[data-brw-cat]');
  /** @param {string} key */
  function filterCats(key) {
    for (let k = 0; k < catBtns.length; k++) {
      catBtns[k].classList.toggle('is-active', catBtns[k].getAttribute('data-brw-cat') === key);
    }
    const groups = document.querySelectorAll('[data-brw-catgroup]');
    for (let g = 0; g < groups.length; g++) {
      /** @type {HTMLElement} */ (groups[g]).style.display =
        key === 'all' || groups[g].getAttribute('data-brw-catgroup') === key ? '' : 'none';
    }
  }
  catBtns.forEach(function (btn) {
    on(btn, 'click', function () {
      filterCats(btn.getAttribute('data-brw-cat') || 'all');
    });
  });
})();
