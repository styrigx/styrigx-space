/* assets/curio/js/curio-list.js —— 奇趣分区列表的公共部件（2026-11 对齐 PR-C2，设计稿 tb4.html pg=curio；浏览器 IIFE；node 测试时导出纯函数）。
 *
 * 发现 / 设备 / 游戏 / 电影四个分区页共用，只动页面上已经画好的卡片（.sgx-cc），不碰数据：
 * - tab 计数：页头下划线 tab 上的 finds/ n · devices/ n · games/ n · movies/ n。本页脚本画完自己的数据后调 SgxCurioList.count(分区, n)
 *   （设备页一次把设备、游戏都报上来）；其余分区由这里在页面空下来以后各问一次自己的读接口（/curio/api/links、/items、/movies），拿不到就空着。
 * - grep：tab 行最右「grep _」点开成行内输入（grep -i ▏），按空白切词，每个词都要出现在卡片的 data-q（名字、简介 / 备注、域名、分类、标签）里；Esc / 清空后失焦收起。
 * - 排序：分页条右侧「排序 … ▾」（第一个选项是默认），按卡片上的 data-s-<键> 重排（order / name 升序，其余降序）。
 * - 分页：先显示一页（桌面 12 / 手机 8），分页条滚进视口（或点它）再加一页；左边「-- 已显示 / 共 --」。
 * 卡片重画（本页脚本 innerHTML）时 MutationObserver 接着套用当前的 grep / 排序 / 已加载页数。条目页（?id=）时列表整块藏着，这里不用管。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/* ================= 纯函数 ================= */
/** grep 词：按空白切，转小写，去掉开头的 #（「#三星」也能搜标签） @param {string} q */
function grepWords(q){
  return String(q || '').toLowerCase().split(/\s+/).map(function(w){ return w.replace(/^#+/, ''); }).filter(Boolean);
}
/** 一张卡片的检索文字里是否每个词都有 @param {string} hay @param {string[]} words */
function grepMatch(hay, words){
  var h = String(hay || '').toLowerCase();
  for (var i = 0; i < words.length; i++) if (h.indexOf(words[i]) < 0) return false;
  return true;
}
/** 排序键的方向：order（我的顺序）/ name 升序，其余（recent、bought、rating、watched）降序 @param {string} key */
function sortAsc(key){ return key === 'order' || key === 'name'; }
/**
 * 比较两张卡片的排序值（字符串）：都是数字按数字，否则按 Intl 排序；同值按原来的顺序（ord）。
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
/** 分页条左边那块：「-- 已显示 / 共 --」（文案 js.curioList.count） @param {number} shown @param {number} total @param {string} [tpl] */
function countText(shown, total, tpl){
  return String(tpl || '-- {n} / {total} --').split('{n}').join(String(Math.min(shown, total))).split('{total}').join(String(total));
}
/** 页面大小：桌面 12（3 栏 × 4 行），手机 8（2 栏 × 4 行） @param {boolean} desktop */
function pageSize(desktop){ return desktop ? 12 : 8; }
/** 计数要问哪些接口：本页已经报上来的分区不问（设备 / 游戏同一个接口） @param {string} cur 当前分区 @returns {string[]} */
function countSources(cur){
  var by = { finds: 'links', devices: 'items', games: 'items', movies: 'movies' };
  var mine = by[cur] || '';
  return ['links', 'items', 'movies'].filter(function(s){ return s !== mine; });
}

var pure = { grepWords: grepWords, grepMatch: grepMatch, sortAsc: sortAsc, cmpKey: cmpKey, countText: countText, pageSize: pageSize, countSources: countSources };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

/* ================= 页面 ================= */
var doc = G.document;
var lang = doc.documentElement.lang || 'en';
var T = {};
try { var el0 = doc.getElementById('sgx-i18n-curioList'); T = el0 ? JSON.parse(el0.textContent) || {} : {}; } catch (e) { T = {}; }
var cur = (doc.getElementById('cu-main') || { dataset: {} }).dataset.cuPage || '';
var counted = {};

/** 填 tab 上的计数 @param {string} tab @param {number} n */
function count(tab, n){
  if (typeof n !== 'number' || !isFinite(n)) return;
  counted[tab] = true;
  var i = doc.querySelector('#cu-tabs [data-cu-count="' + tab + '"]');
  if (i) i.textContent = String(n);
}
G.SgxCurioList = { count: count };

/* 其余分区的计数：页面空下来以后各问一次（同源读接口，401 = 锁定交给 sgxLockSync，这里只吞掉） */
function fetchJSON(url){
  return fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
}
function fillCounts(){
  if (!doc.getElementById('cu-tabs') || typeof fetch !== 'function') return;
  /* 测试构建（<html data-sgx-test-no-api>，CI 静态服务器没有接口）不问，免得 404 进控制台；e2e 要测时先设 window.__sgxCurioApi = true */
  if (doc.documentElement.hasAttribute('data-sgx-test-no-api') && !G.__sgxCurioApi) return;
  countSources(cur).forEach(function(src){
    fetchJSON('/curio/api/' + src).then(function(j){
      if (!j || !j.ok) return;
      if (src === 'links') { if (!counted.finds) count('finds', (j.cats || []).reduce(function(n, c){ return n + (c.links || []).length; }, 0)); }
      else if (src === 'items') { if (!counted.devices) count('devices', (j.devices || []).length); if (!counted.games) count('games', (j.games || []).length); }
      else if (src === 'movies') { if (!counted.movies) count('movies', (j.movies || []).length); }
    });
  });
}
if (doc.readyState === 'complete') setTimeout(fillCounts, 300);
else G.addEventListener('load', function(){ setTimeout(fillCounts, 300); });

var grid = doc.querySelector('[data-cu-grid]');
var pager = doc.querySelector('[data-cu-pager]');
if (!grid || !pager) return;
var sortSel = pager.querySelector('[data-cu-sort]');
var countEl = pager.querySelector('[data-pg-count]');
var grepBtn = doc.querySelector('[data-cu-grep]');
var grepBox = doc.getElementById('cu-grep-box');
var grepIn = doc.getElementById('cu-grep');
var nomatch = doc.createElement('p');
nomatch.className = 'cu-note hidden';
nomatch.setAttribute('data-cu-nomatch', '');
nomatch.textContent = T.noMatch || '';
grid.parentNode.insertBefore(nomatch, pager);

var q = [];
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
  var n = 0, total = 0;
  list.forEach(function(c){
    var ok = !q.length || grepMatch(c.getAttribute('data-q') || c.textContent, q);
    if (ok) total++;
    var show = ok && total <= shown;
    if (show) n++;
    c.hidden = !show;
  });
  pager.hidden = list.length === 0;
  if (countEl) countEl.textContent = countText(n, total, T.count);
  /* 封面右上的位置计数「02 / 06」的总数（Gray 2026-11-09 细节 2；序号是 CSS 计数器，见共享外壳 .sgx-cc-im::after） */
  grid.style.setProperty('--sgx-cc-n', '"' + (total < 10 ? '0' : '') + total + '"');
  pager.classList.toggle('is-done', n >= total);
  nomatch.classList.toggle('hidden', !(list.length && q.length && total === 0));
  if (mo) mo.observe(grid, { childList: true });
}
/* 卡片重画：新卡片没有 data-ord，按画出来的顺序记一下（「我的顺序」= 接口给的顺序） */
if (typeof MutationObserver === 'function') {
  mo = new MutationObserver(function(){ apply(); });
  mo.observe(grid, { childList: true });
}
function more(){
  var total = cards().filter(function(c){ return !q.length || grepMatch(c.getAttribute('data-q') || c.textContent, q); }).length;
  if (shown >= total) return;
  shown += pageSize(desktop());
  apply();
}
if (typeof IntersectionObserver === 'function') {
  new IntersectionObserver(function(es){ es.forEach(function(e){ if (e.isIntersecting) more(); }); }, { rootMargin: '0px 0px 200px 0px' }).observe(pager);
}
pager.querySelector('.sgx-pg-l').addEventListener('click', more);
if (sortSel) sortSel.addEventListener('change', function(){
  sortKey = sortSel.value;
  cards().forEach(function(c){ c.removeAttribute('data-ord-x'); });
  shown = pageSize(desktop());
  apply();
});

/* grep：点「grep _」→ 行内输入；输入就过滤；Esc 或清空后失焦 → 收起 */
function openGrep(){
  if (!grepBtn || !grepBox) return;
  grepBtn.hidden = true; grepBtn.setAttribute('aria-expanded', 'true');
  grepBox.hidden = false;
  grepIn.focus();
}
function closeGrep(){
  if (!grepBtn || !grepBox) return;
  grepIn.value = ''; q = []; apply();
  grepBox.hidden = true;
  grepBtn.hidden = false; grepBtn.setAttribute('aria-expanded', 'false');
}
if (grepBtn && grepIn) {
  grepBtn.addEventListener('click', openGrep);
  grepIn.addEventListener('input', function(){ q = grepWords(grepIn.value); shown = pageSize(desktop()); apply(); });
  grepIn.addEventListener('keydown', function(e){ if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeGrep(); grepBtn.focus(); } });
  grepIn.addEventListener('blur', function(){ if (!grepIn.value.trim()) setTimeout(function(){ if (doc.activeElement !== grepIn && !grepIn.value.trim()) closeGrep(); }, 120); });
}
apply();
})();
