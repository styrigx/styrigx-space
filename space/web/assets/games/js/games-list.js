/* assets/games/js/games-list.js —— 游戏列表的排序 + 分页（奇趣重组 PR 2，2026-11-22；浏览器 IIFE；node 测试时导出纯函数）。
 * 从奇趣的 curio/js/curio-list.js 搬来游戏页用得到的那部分（规则一字不改），不带 tab 计数、grep（游戏子站的页头没有 tab 行和 grep，同 /music/）：
 * - 排序：分页条右侧「排序 … ▾」（[data-gm-sort]，第一个选项「最近添加」是默认），按卡片上的 data-s-<键> 重排（order / name 升序，其余降序）。
 *   键：recent（游戏 id，越新越大）/ order（我的顺序 = 接口给的顺序，game.order 定）/ rating / name。
 * - 分页：先显示一页（桌面 12 / 手机 8），分页条滚进视口（或点它）再加一页；左边「-- 已显示 / 共 --」（文案 js.gamesPage.count）。
 * 只动 games-page.js 画好的卡片（[data-gm-grid] 里的 .sgx-cc），不碰数据；卡片重画（innerHTML）时 MutationObserver 接着套用当前的排序 / 已加载页数。
 * 条目页（?game=）时列表整块藏着，这里不用管。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/* ================= 纯函数（同 curio-list.js） ================= */
/** 排序键的方向：order（我的顺序）/ name 升序，其余（recent、rating）降序 @param {string} key */
function sortAsc(key){ return key === 'order' || key === 'name'; }
/**
 * 比较两张卡片的排序值（字符串）：都是数字按数字，否则按 Intl 排序；空值排最后；同值按原来的顺序（ord）。
 * @param {{v:string, ord:number}} a @param {{v:string, ord:number}} b @param {string} key @param {string} [lang]
 */
function cmpKey(a, b, key, lang){
  var av = a.v == null ? '' : String(a.v), bv = b.v == null ? '' : String(b.v), r;
  var an = av !== '' && !isNaN(Number(av)), bn = bv !== '' && !isNaN(Number(bv));
  if (an && bn) r = Number(av) - Number(bv);
  else if (av === '' || bv === '') r = av === bv ? 0 : (av === '' ? 1 : -1) * (sortAsc(key) ? 1 : -1);
  else r = av.localeCompare(bv, lang || undefined, { numeric: true, sensitivity: 'base' });
  if (!sortAsc(key)) r = -r;
  return r || (a.ord - b.ord);
}
/** 分页条左边那块：「-- 已显示 / 共 --」 @param {number} shown @param {number} total @param {string} [tpl] */
function countText(shown, total, tpl){
  return String(tpl || '-- {n} / {total} --').split('{n}').join(String(Math.min(shown, total))).split('{total}').join(String(total));
}
/** 页面大小：桌面 12（3 栏 × 4 行），手机 8（2 栏 × 4 行） @param {boolean} desktop */
function pageSize(desktop){ return desktop ? 12 : 8; }

var pure = { sortAsc: sortAsc, cmpKey: cmpKey, countText: countText, pageSize: pageSize };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

/* ================= 页面 ================= */
var doc = G.document;
var lang = doc.documentElement.lang || 'en';
var T = {};
try { var el0 = doc.getElementById('sgx-i18n-gamesPage'); T = el0 ? JSON.parse(el0.textContent) || {} : {}; } catch (e) { T = {}; }

var grid = doc.querySelector('[data-gm-grid]');
var pager = doc.querySelector('[data-gm-pager]');
if (!grid || !pager) return;
var sortSel = pager.querySelector('[data-gm-sort]');
var countEl = pager.querySelector('[data-pg-count]');

var sortKey = sortSel ? sortSel.value : '';
function desktop(){ return doc.documentElement.getAttribute('data-sgx-layout') === 'desktop'; }
var shown = pageSize(desktop());
var mo = null;

function cards(){ return Array.prototype.filter.call(grid.children, function(c){ return c.classList && c.classList.contains('sgx-cc'); }); }
function reorder(list){
  if (!sortKey) return list;
  var withKey = list.map(function(c, i){
    var o = Number(c.getAttribute('data-ord'));
    return { el: c, v: c.getAttribute('data-s-' + sortKey), ord: isNaN(o) ? i : o };
  });
  withKey.sort(function(a, b){ return cmpKey(a, b, sortKey, lang); });
  var same = withKey.every(function(x, i){ return x.el === list[i]; });
  if (!same) withKey.forEach(function(x){ grid.appendChild(x.el); });
  return withKey.map(function(x){ return x.el; });
}
function apply(){
  if (mo) mo.disconnect();
  var list = cards();
  list.forEach(function(c, i){ if (!c.hasAttribute('data-ord')) c.setAttribute('data-ord', String(i)); });
  list = reorder(list);
  var n = 0, total = list.length;
  list.forEach(function(c, i){
    var show = i < shown;
    if (show) n++;
    c.hidden = !show;
  });
  pager.hidden = total === 0;
  if (countEl) countEl.textContent = countText(n, total, T.count);
  /* 封面右上的位置计数「02 / 06」的总数（序号是 CSS 计数器，见共享外壳 .sgx-cc-im::after；同 curio-list.js） */
  grid.style.setProperty('--sgx-cc-n', '"' + (total < 10 ? '0' : '') + total + '"');
  pager.classList.toggle('is-done', n >= total);
  if (mo) mo.observe(grid, { childList: true });
}
/* 卡片重画：新卡片没有 data-ord，按画出来的顺序记一下（「我的顺序」= 接口给的顺序） */
if (typeof MutationObserver === 'function') {
  mo = new MutationObserver(function(){ apply(); });
  mo.observe(grid, { childList: true });
}
function more(){
  if (shown >= cards().length) return;
  shown += pageSize(desktop());
  apply();
}
if (typeof IntersectionObserver === 'function') {
  new IntersectionObserver(function(es){ es.forEach(function(e){ if (e.isIntersecting) more(); }); }, { rootMargin: '0px 0px 200px 0px' }).observe(pager);
}
var left = pager.querySelector('.sgx-pg-l');
if (left) left.addEventListener('click', more);
if (sortSel) sortSel.addEventListener('change', function(){
  sortKey = sortSel.value;
  shown = pageSize(desktop());
  apply();
});
/** games-page.js：存好新顺序后切到「我的顺序」（让人看到刚排的结果） */
G.SgxGamesList = {
  sortBy: function(k){
    if (!sortSel || !sortSel.querySelector('option[value="' + k + '"]')) return;
    sortSel.value = k; sortKey = k; shown = pageSize(desktop()); apply();
  },
};
apply();
})();
