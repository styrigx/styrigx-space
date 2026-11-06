/* assets/js/curio-tabs.js —— 奇趣首页三个页签：发现 / 设备 / 游戏（P4-3 PR-4b 起顶栏没有分段滑块，首页正文的分区入口 + hash 切换，同日刻的写法）。
 *
 * - hash：发现 = 无或 #c/<分类 id>（curio.js 管），#devices，#games。只用 replaceState，切页签不加历史。
 * - 切页签：面板 hidden + inert；顶栏页名胶囊换成分区名（P4-3 PR-4b：顶栏不再有分段滑块，入口在首页正文）；<html data-cu-tab>（CSS 据此只露当前页签的「收藏 / 设备 / 游戏」按钮）。
 *   每个页签记住自己的滚动位置；点当前页签回顶部。键盘 ← → Home End。左右滑（横向 ≥ 70px、明显比竖向多）也能切。
 * - 右下角按钮：发现 = #cu-fab（curio.js 按接口的 canWrite 显示），设备 = #dv-fab，游戏 = #gm-fab（curio-items.js 按 canWrite 标 data-can-write）。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;
var TABS = ['finds', 'devices', 'games'];

/** hash → 页签 */
function tabOf(hash){
  var h = String(hash || '');
  if (h === '#devices' || h.indexOf('#devices/') === 0) return 'devices';
  if (h === '#games' || h.indexOf('#games/') === 0) return 'games';
  return 'finds';
}
/** 切到某个页签时 hash 写成什么：发现保留现有的 #c/<id>，其余固定 */
function hashFor(tab, cur){
  if (tab === 'devices') return '#devices';
  if (tab === 'games') return '#games';
  return /^#c\/\d+$/.test(String(cur || '')) ? cur : '';
}
var pure = { TABS: TABS, tabOf: tabOf, hashFor: hashFor };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

var doc = G.document;
if (!doc.getElementById('cu-panes')) return;
/* 页名胶囊 + 首页分区入口（P4-3 PR-4b：顶栏不再有分区页签）：切到第 i 个分区时胶囊显示 data-sgx-titles[i]（第 0 个 = 站名），
   分区入口（[data-sgx-entries]，首页正文的目录）只在第 0 个分区（首页本身）显示 */
function syncTitle(i){
  var t = doc.querySelector('.sgx-tb-title[data-sgx-titles]');
  if (t) { try { var names = JSON.parse(t.getAttribute('data-sgx-titles')); if (names[i]) t.textContent = names[i]; } catch (e) {} }
  var ents = doc.querySelector('[data-sgx-entries]');
  if (ents) ents.hidden = i !== 0;
}

var btns = TABS.map(function(id){ return doc.querySelector('[data-cu-tab="' + id + '"]'); });
var tab = '';
var scrolls = {};
function reduced(){ return doc.documentElement.classList.contains('reduced-motion') || (G.matchMedia && G.matchMedia('(prefers-reduced-motion: reduce)').matches); }
function fabs(){
  var dv = doc.getElementById('dv-fab'), gm = doc.getElementById('gm-fab');
  if (dv) dv.classList.toggle('hidden', !(tab === 'devices' && dv.dataset.canWrite));
  if (gm) gm.classList.toggle('hidden', !(tab === 'games' && gm.dataset.canWrite));
}
function setTab(next, opts){
  opts = opts || {};
  var i = TABS.indexOf(next);
  if (i < 0) return;
  if (tab) scrolls[tab] = G.scrollY;
  var changed = next !== tab;
  tab = next;
  btns.forEach(function(b, j){ if (!b) return; b.setAttribute('aria-selected', j === i ? 'true' : 'false'); b.tabIndex = j === i ? 0 : -1; });
  TABS.forEach(function(id){
    var p = doc.getElementById('cu-pane-' + id);
    if (!p) return;
    if (id === next) { p.hidden = false; p.removeAttribute('inert'); } else { p.hidden = true; p.setAttribute('inert', ''); }
  });
  syncTitle(i);
  doc.documentElement.setAttribute('data-cu-tab', next);
  fabs();
  var h = hashFor(next, G.location.hash);
  var url = G.location.pathname + G.location.search + h;
  if (url !== G.location.pathname + G.location.search + G.location.hash) { try { G.history.replaceState(G.history.state, '', url); } catch (e) {} }
  if (opts.focus && btns[i]) btns[i].focus();
  if (changed && !opts.initial) G.scrollTo({ top: scrolls[next] || 0, behavior: 'auto' });
}
btns.forEach(function(b, i){
  if (!b) return;
  b.addEventListener('click', function(){
    if (TABS[i] === tab) { G.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); return; }
    setTab(TABS[i]);
  });
});
G.addEventListener('hashchange', function(){ var t = tabOf(G.location.hash); if (t !== tab) setTab(t); });
/* 左右滑切页签（竖着滑照常滚动；分类条自己横向滚，不算） */
(function(){
  var panes = doc.getElementById('cu-panes'), x0 = 0, y0 = 0, t0 = 0, on = false;
  if (!panes) return;
  panes.addEventListener('touchstart', function(e){
    if (e.touches.length !== 1 || (e.target.closest && e.target.closest('.cu-chips'))) { on = false; return; }
    on = true; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  panes.addEventListener('touchend', function(e){
    if (!on) return; on = false;
    var t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6 || Date.now() - t0 > 700) return;
    var i = TABS.indexOf(tab) + (dx < 0 ? 1 : -1);
    if (i >= 0 && i < TABS.length) setTab(TABS[i]);
  }, { passive: true });
})();
G.SgxCurioTabs = { refresh: fabs, current: function(){ return tab; } };
setTab(tabOf(G.location.hash), { initial: true });
})();
