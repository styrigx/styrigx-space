/* assets/games/js/games-ui.js —— 游戏子站的几样小部件（奇趣重组 PR 2，2026-11-22；浏览器 IIFE，挂 window.SgxGamesUI；node 测试时导出纯函数）。
 * 照 music/js/music-ui.js 的做法：游戏页不加载奇趣的 curio.js，从里面把游戏页真正用到的几样搬过来（行为逐行一致）：
 *   - ask(msg, okLabel, fn)：确认框（#confirm-wrap，标记在 partials/games/common.html，外观同奇趣：bk-overlay / bk-panel，样式在奇趣 main.css）；
 *     取消 / 点遮罩（data-close="confirm"）/ Esc 关，确定先关再调 fn。
 *   - toast(msg)：提示条（#bk-toast），2.4 秒后藏起。
 *   - openOverlay / closeOverlay：bk-overlay 弹层开关（编辑弹层 #gm-edit-wrap）；[data-close="x"] 关 #x-wrap；Esc 关最上面那个。
 *   - sudo()：请人进站，发 sgx:sudo（顶栏终端预填 su ；= common/js/auth/sudo.js SUDO_EVENT）。
 *   - 条目页路由（同 curio.js 的 showItem / showList / goItem / onItemRoute，参数名换成 ?game=<id>，同 music 的 ?album=；旧 ?id= 也认）：
 *     列表（页头、命令链、#cu-pane-games）和条目页（#cu-item）二选一显示；点卡片 pushState，返回键 popstate 回到列表。
 *     面包屑 cat ~/games/<名字>（游戏是自己的子站，不再是 ~/curio/games/）。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/** 提示条停留多久（毫秒，同 curio.js / music-ui.js） */
var TOAST_MS = 2400;

/** 地址里的条目编号：?game=<id>（新）或 ?id=<id>（拆出前 /curio/games/?id= 的旧地址）；没有 / 不对返回 0 @param {string} search */
function gameIdOf(search){
  var s = String(search || '');
  var m = /[?&]game=(\d+)(?:&|$)/.exec(s) || /[?&]id=(\d+)(?:&|$)/.exec(s);
  var n = m ? Number(m[1]) : 0;
  return n > 0 && n < 2147483648 ? n : 0;
}
/** 名字 → 面包屑里的文件名（小写、空白变 -、去掉路径符号；中文原样；同 curio.js slugOf） @param {string} name */
function slugOf(name){ return String(name || '').trim().toLowerCase().replace(/[\/\\?#%*:|"<>]+/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'item'; }
/** 条目页地址：同一路径 + ?game=<id>（0 = 列表，不带查询）+ 原来的 hash @param {string} pathname @param {number} id @param {string} [hash] */
function itemUrl(pathname, id, hash){ return String(pathname || '/') + (id ? '?game=' + id : '') + String(hash || ''); }

var pure = { TOAST_MS: TOAST_MS, gameIdOf: gameIdOf, slugOf: slugOf, itemUrl: itemUrl };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

var doc = G.document;
var $ = function(s){ return doc.querySelector(s); };
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

function sudo(){ try { doc.dispatchEvent(new CustomEvent('sgx:sudo')); } catch (e) {} }

var toastTimer = null;
function toast(msg){
  var el = $('#bk-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.add('hidden'); }, TOAST_MS);
}

/* ---------- 弹层 + 确认框（同 curio.js / music-ui.js 的 openOverlay / closeOverlay / ask） ---------- */
/** 有没有开着的 <dialog class="sgx-qp gm-dlg">（排序窗）：关 bk-overlay 时它还开着就不放开页面滚动 */
function dlgOpen(){ return !!doc.querySelector('dialog.gm-dlg[open]'); }
function openOverlay(id){ var el = doc.getElementById(id); if (!el) return; el.classList.add('open'); doc.body.style.overflow = 'hidden'; }
function closeOverlay(id){
  var el = doc.getElementById(id); if (!el) return;
  el.classList.remove('open');
  if (!doc.querySelector('.bk-overlay.open') && !dlgOpen()) doc.body.style.overflow = '';
}
doc.querySelectorAll('.bk-overlay [data-close]').forEach(function(b){ b.addEventListener('click', function(){ closeOverlay(b.dataset.close + '-wrap'); }); });
doc.addEventListener('keydown', function(e){
  if (e.key !== 'Escape') return;
  var open = doc.querySelectorAll('.bk-overlay.open');
  if (open.length) closeOverlay(open[open.length - 1].id);
});
var confirmFn = null;
function ask(msg, okLabel, fn){
  $('#confirm-msg').textContent = msg;
  $('#confirm-ok').textContent = okLabel;
  confirmFn = fn;
  openOverlay('confirm-wrap');
}
var cancelBtn = $('#confirm-cancel'), okBtn = $('#confirm-ok');
if (cancelBtn) cancelBtn.addEventListener('click', function(){ confirmFn = null; closeOverlay('confirm-wrap'); });
if (okBtn) okBtn.addEventListener('click', function(){ var f = confirmFn; confirmFn = null; closeOverlay('confirm-wrap'); if (f) f(); });

/* ---------- 条目页（?game=<id>；同 curio.js 的条目页，标记类名一字不改：sgx-crumb / sgx-item / sgx-spec / sgx-nx） ---------- */
var ITEM_IMG = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8 8.5"/></svg>';
function listParts(){ return doc.querySelectorAll('#cu-main > .sgx-ph, #cu-cmds, #cu-main > .cu-pane'); }
function showList(){
  var it = $('#cu-item'); if (it) { it.hidden = true; it.innerHTML = ''; }
  listParts().forEach(function(el){ el.hidden = false; });
}
/**
 * 画条目页：o = {name, img（封面 HTML，可空）, meta（「games · 在玩 · Switch」）, spec [[标签, 值 HTML]], prose（评价，纯文字）,
 *   edit {k, d, fn}（能编辑时）, prev / next {href, id?, k, title}（next 为空就不画右卡）}
 */
function showItem(o){
  var it = $('#cu-item'); if (!it) return;
  listParts().forEach(function(el){ el.hidden = true; });
  var nx = function(x, right){
    if (!x) return '<li></li>';
    return '<li><a class="sgx-nx-a' + (right ? ' is-next' : '') + '" href="' + esc(x.href) + '"' + (x.ext ? ' target="_blank" rel="noopener"' : '') + (x.id != null && x.id !== '' && x.href.charAt(0) === '?' ? ' data-item="' + x.id + '"' : '') + '>'
      + (right ? esc(x.k) + ' ›' : '‹ ' + esc(x.k)) + '<b>' + esc(x.title) + '</b></a></li>';
  };
  it.innerHTML = '<p class="sgx-crumb" translate="no"><span class="sgx-pr">$</span>cat ~/games/' + esc(slugOf(o.name)) + '</p>'
    + '<div class="sgx-item"><div class="sgx-item-im">' + (o.img || ITEM_IMG) + '</div><div class="sgx-item-b">'
    + '<p class="sgx-item-m">' + esc(o.meta || '') + '</p><h1 class="sgx-item-t">' + esc(o.name) + '</h1>'
    + (o.spec && o.spec.length ? '<dl class="sgx-spec">' + o.spec.map(function(r){ return '<div><dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd></div>'; }).join('') + '</dl>' : '')
    + (o.prose ? '<p class="sgx-item-p">' + esc(o.prose) + '</p>' : '')
    + (o.edit ? '<div class="sgx-cmds"><button type="button" class="sgx-cmd" data-item-edit><span class="sgx-cmd-k" translate="no">' + esc(o.edit.k) + '</span><i>' + esc(o.edit.d) + '</i></button></div>' : '')
    + '<ul class="sgx-nx">' + nx(o.prev, false) + nx(o.next, true) + '</ul>'
    + '</div></div>';
  it.hidden = false;
  var eb = it.querySelector('[data-item-edit]');
  if (eb && o.edit) eb.addEventListener('click', o.edit.fn);
}
var itemRoute = null;
/** 去某个游戏（0 = 回列表）：改地址（pushState；旧 ?id= 换成 ?game=）并通知 games-page.js 重画 */
function goItem(id, replace){
  var url = itemUrl(G.location.pathname, id, G.location.hash);
  try { G.history[replace ? 'replaceState' : 'pushState']({ gmItem: id }, '', url); } catch (e) {}
  G.scrollTo({ top: 0, behavior: 'auto' });
  if (itemRoute) itemRoute(id);
}
/** games-page.js 登记路由：fn(id)（id = 0 时回列表）；卡片 / 条目页里带 data-item 的链接点了走这里（新标签页 / 修饰键照常） */
function onItemRoute(fn){
  itemRoute = fn;
  G.addEventListener('popstate', function(){ fn(gameIdOf(G.location.search)); });
  doc.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a[data-item]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    goItem(Number(a.getAttribute('data-item')) || 0);
  });
}
/* 直接打开 / 刷新条目页：列表先藏起来，等 games-page.js 拿到数据再画条目（免得先闪一下列表） */
if (gameIdOf(G.location.search) && doc.getElementById('cu-item')) listParts().forEach(function(el){ el.hidden = true; });
/* 旧地址 ?id=<n>（拆出前 /curio/games/?id= 经 _redirects 过来会带着查询）：就地换成 ?game=<n>，不留历史 */
if (/[?&]id=\d+/.test(G.location.search) && !/[?&]game=/.test(G.location.search)) {
  try { G.history.replaceState(null, '', itemUrl(G.location.pathname, gameIdOf(G.location.search), G.location.hash)); } catch (e) {}
}

G.SgxGamesUI = {
  ask: function(m, l, f){ ask(m, l, f); },
  toast: function(m){ toast(m); },
  sudo: sudo,
  openOverlay: openOverlay, closeOverlay: closeOverlay,
  itemId: function(){ return gameIdOf(G.location.search); },
  showItem: showItem, showList: showList, goItem: goItem, onItemRoute: onItemRoute, slug: slugOf,
};
})();
