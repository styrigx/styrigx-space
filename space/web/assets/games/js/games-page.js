/* assets/games/js/games-page.js —— 游戏子站 /games/（中文 /games/zh/）的页面逻辑（奇趣重组 PR 2，2026-11-22；浏览器 IIFE；node 测试时导出纯函数）。
 *
 * 从奇趣的 curio/js/curio-items.js 搬来游戏那一半（规则不变），接口全部换成游戏子站自己的 /games/api/*（PR 1 #503）：
 *   读 GET /games/api/games → {ok, canManage, showPrivate, games:[…]}（按「我的顺序」pos 排好）；
 *   写 POST /games/api/games {op: game.add | game.edit | game.del | game.order} → {ok, games, id?}；
 *   封面 /games/api/cover?id=<n>（GET 图、POST 传、DELETE 删）。写请求回 401 = 没进站 → 发 sgx:sudo（顶栏终端预填 su ）。
 * 列表：状态 chips（全部 / 想玩 / 在玩 / 通关 / 搁置）+ 封面卡（封面、「games · 平台」、名字、状态 · 评分）；排序 / 分页在 games-list.js（只动画好的卡片）。
 * 条目页 = 本页 ?game=<id>（旧 ?id= 也认；路由、画法在 games-ui.js）：spec 表（状态、评分、平台、版本），评价当短评；
 *   底部两卡：‹ cd ../prev（第一个时 cd .. 回列表）│ 相关文章 ›（博客里标题 / 标签提到它的那篇，relatedPost；没有就 cd ../next）。
 * 能编辑（canManage：games-manage）：命令链「touch games/ +」新建、「sort games/」调整顺序；条目页里「vim games/<名字>」编辑；编辑弹层里删除（要确认）。
 *   不能编辑时命令链空着（同 /music/，不放 su 提示）。编辑弹层去掉了「在哪台设备上」（关联设备，设计稿 v1.0 PR 2）：保存时不发 device_id，库里原值不动（PR 3 清零）。
 * 封面：选图 → 全屏「移动和缩放」（3:4 取景框，同奇趣；样式 .cu-crop 在奇趣 main.css）→ 长边 ≤1200、webp（不支持就 jpeg），保存后再传。
 * 调整顺序：居中悬浮卡片 <dialog class="sgx-qp gm-dlg">（共享 modalSheet，同音乐上传窗），拖把手或上移 / 下移，保存 = game.order {ids}（全部游戏）；
 *   409 mismatch（中途有人加 / 删了游戏）→ 提示刷新后再试。
 * 确认框、提示条、弹层开关、条目页路由借 games-ui.js（window.SgxGamesUI）。界面文案 #sgx-i18n-gamesPage（data/games/i18n 的 js.gamesPage）。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/* ================= 纯函数 ================= */
var STATUS = ['want', 'playing', 'done', 'shelved'];

/** 游戏筛选：all 或某个状态 */
function filterGames(list, f){
  return (list || []).filter(function(g){ return !f || f === 'all' || g.status === f; });
}
/** 平台联想：已有游戏里出现过的平台，按次数多到少，去重 */
function platformsOf(games){
  var n = {};
  (games || []).forEach(function(g){ var p = String(g.platform || '').trim(); if (p) n[p] = (n[p] || 0) + 1; });
  return Object.keys(n).sort(function(a, b){ return n[b] - n[a] || a.localeCompare(b); });
}
/** 文字里有没有这个词：中文按子串；拉丁词要整词（pro 不算 project） */
function hasWord(text, w){
  if (/[\u3400-\u9fff]/.test(w)) return text.indexOf(w) >= 0;
  var i = text.indexOf(w);
  while (i >= 0) {
    var b = text.charAt(i - 1), e = text.charAt(i + w.length);
    if (!/[a-z0-9]/.test(b) && !/[a-z0-9]/.test(e)) return true;
    i = text.indexOf(w, i + 1);
  }
  return false;
}
/**
 * 「相关文章」：按名字在博客文章（标题 + 标签）里找（同 curio-items.js）。整个名字出现在标题里最好；
 * 否则按名字里的词（拉丁词 ≥ 3 个字母、中文词 ≥ 2 个字）在标题 / 标签里出现的个数打分，0 分不算；同分取新的（posts 已经新→旧）。
 * @param {string} name @param {{t:string, u:string, g?:string[]}[]} posts @returns {{t:string, u:string}|null}
 */
function relatedPost(name, posts){
  var n = String(name || '').trim().toLowerCase();
  if (!n || !posts || !posts.length) return null;
  var words = n.split(/[\s·・,，、:：()（）]+/).filter(function(w){ return /[\u3400-\u9fff]/.test(w) ? w.length >= 2 : w.length >= 3 && !/^\d+$/.test(w); });
  var best = null, bestScore = 0;
  posts.forEach(function(p){
    var t = String(p.t || '').toLowerCase(), g = (p.g || []).join(' ').toLowerCase();
    var sc = t.indexOf(n) >= 0 ? 100 : 0;
    if (!sc) words.forEach(function(w){ if (hasWord(t, w)) sc += 2; else if (hasWord(g, w)) sc += 1; });
    if (sc > bestScore) { best = p; bestScore = sc; }
  });
  return best;
}
/** 列表里前一个 / 后一个（按当前顺序；越界 null） */
function neighbors(list, id){
  var i = -1;
  (list || []).forEach(function(x, j){ if (x.id === id) i = j; });
  return { prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
}
/** 把 ids 里下标 from 的那个挪到下标 to（拖动 / 上移下移都走这个）；越界或没动返回 null @param {number[]} ids @param {number} from @param {number} to */
function moveIndex(ids, from, to){
  var n = (ids || []).length;
  if (!(from >= 0 && from < n && to >= 0 && to < n) || from === to) return null;
  var out = ids.slice();
  var x = out.splice(from, 1)[0];
  out.splice(to, 0, x);
  return out;
}
/** 两个顺序是不是一样（没动过就不发请求） */
function sameOrder(a, b){
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** 接口错误码 → 文案键 @param {string} code */
function errKey(code){
  var c = String(code || '');
  if (c === 'bad-title' || c === 'bad-name') return 'needName';
  if (c === 'not-image') return 'notImage';
  if (c === 'too-large') return 'tooLarge';
  if (c === 'forbidden') return 'noPermission';
  if (c === 'mismatch') return 'orderStale';
  if (c === 'not-found') return 'notFound';
  return 'failed';
}
/** 封面地址（换过封面的带 ?v= 破缓存） @param {number} id @param {number} [v] */
function coverUrl(id, v){ return '/games/api/cover?id=' + id + (v ? '&v=' + v : ''); }

/* ---- 裁剪的几何（同 curio-items.js：照片在舞台上左上角 (tx,ty)、缩放 k；取景框 f = {l,t,w,h}，舞台坐标） ---- */
/** 游戏封面卡的比例（宽 / 高），和奇趣 CSS 的 .it-media--cover（3/4）一致 */
var COVER_RATIO = 3 / 4;
function cropFrame(stageW, stageH, ratio){
  var w = Math.max(1, Math.min(stageW - 48, 520)), h = w / ratio, mh = Math.max(1, stageH - 220);
  if (h > mh) { h = mh; w = h * ratio; }
  return { w: Math.round(w), h: Math.round(h) };
}
function coverScale(nw, nh, fw, fh){ return Math.max(fw / nw, fh / nh); }
function clampView(v, nw, nh, f, zmax){
  var kMin = coverScale(nw, nh, f.w, f.h);
  var k = Math.min(Math.max(v.k, kMin), kMin * (zmax || 8));
  var tx = Math.max(Math.min(v.tx, f.l), f.l + f.w - nw * k);
  var ty = Math.max(Math.min(v.ty, f.t), f.t + f.h - nh * k);
  return { tx: tx, ty: ty, k: k };
}
function centerView(nw, nh, f){
  var k = coverScale(nw, nh, f.w, f.h);
  return { tx: f.l + (f.w - nw * k) / 2, ty: f.t + (f.h - nh * k) / 2, k: k };
}
function cropSource(v, nw, nh, f){
  var sw = Math.min(nw, f.w / v.k), sh = Math.min(nh, f.h / v.k);
  var sx = Math.min(Math.max(0, (f.l - v.tx) / v.k), nw - sw);
  var sy = Math.min(Math.max(0, (f.t - v.ty) / v.k), nh - sh);
  return { sx: sx, sy: sy, sw: sw, sh: sh };
}
function cropOut(sw, sh, ratio, max){
  var L = Math.max(1, Math.round(Math.min(max, Math.max(sw, sh))));
  return ratio >= 1 ? { w: L, h: Math.max(1, Math.round(L / ratio)) } : { w: Math.max(1, Math.round(L * ratio)), h: L };
}
function viewFromSource(s, f){
  var k = f.w / s.sw;
  return { tx: f.l - s.sx * k, ty: f.t - s.sy * k, k: k };
}

/* ---------- 文案表（同 curio / music 各脚本同一份小工具） ---------- */
function readDict(doc, table){
  try {
    var el = doc && doc.getElementById('sgx-i18n-' + table);
    var o = el && el.textContent ? JSON.parse(el.textContent) : null;
    return o && typeof o === 'object' ? o : {};
  } catch (e) { return {}; }
}
function makeTr(dict, lang){
  var src = {};
  for (var k0 in dict) if (Object.prototype.hasOwnProperty.call(dict, k0)) src[k0] = dict[k0];
  var pr = null;
  try { pr = new Intl.PluralRules(lang || 'en'); } catch (e) { pr = null; }
  return function tr(key, vars){
    var s = null;
    if (vars && typeof vars.n === 'number' && pr) s = src[key + '_' + pr.select(vars.n)];
    if (s == null) s = src[key];
    s = s == null ? '' : String(s);
    if (vars) for (var k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  };
}

var pure = { STATUS: STATUS, filterGames: filterGames, platformsOf: platformsOf, relatedPost: relatedPost, neighbors: neighbors, moveIndex: moveIndex, sameOrder: sameOrder,
  errKey: errKey, coverUrl: coverUrl, COVER_RATIO: COVER_RATIO, cropFrame: cropFrame, coverScale: coverScale, clampView: clampView, centerView: centerView,
  cropSource: cropSource, cropOut: cropOut, viewFromSource: viewFromSource, readDict: readDict, makeTr: makeTr };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }
G.SgxGames = pure;

/* ================= 页面 ================= */
var doc = G.document;
if (!doc.getElementById('cu-pane-games')) return;
var UI = G.SgxGamesUI;
var $ = function(s){ return doc.querySelector(s) || doc.createElement('div'); };

var lang = doc.documentElement.lang || 'en';
var T = readDict(doc, 'gamesPage');
var tr = makeTr(T, lang);
T.status = {};
STATUS.forEach(function(s){ T.status[s] = T['status_' + s] || s; });
function starsLabel(n){ return tr('stars', { n: n }); }

var GAME_IC = '<path d="M7 8h10a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L15 14H9l-.6.8A3 3 0 0 1 3 13v-1a4 4 0 0 1 4-4z"/><path d="M8 11v2M7 12h2M15.5 11.5h.01M17.5 12.5h.01"/>';
function icon(size){ return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + GAME_IC + '</svg>'; }
var LOCK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
function starSvg(n){ return '<svg viewBox="0 0 24 24" width="' + n + '" height="' + n + '" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor"/></svg>'; }
var UP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
var DOWN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
var GRIP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

var games = [], canManage = false, showPrivate = false, loaded = false;
var gmFilter = 'all';
var ver = {}; /* 封面缓存破坏：换过封面的游戏带 ?v= */

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function toast(m){ if (UI) UI.toast(m); }
function open(id){ if (UI) UI.openOverlay(id); }
function close(id){ if (UI) UI.closeOverlay(id); }
function getJSON(url){
  return fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
}
function send(method, url, body, type){
  return fetch(url, {
    method: method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': type || 'application/json' },
    body: body === undefined ? undefined : type ? body : JSON.stringify(body),
  }).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(j){
      /* 401（没进门）→ 请人进站（同 curio-items.js） */
      if (r.status === 401) { if (UI && UI.sudo) UI.sudo(); throw Object.assign(new Error('locked'), { sgxLocked: true }); }
      if (!r.ok || !j.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { code: j.error });
      return j;
    });
  });
}
function op(body){ return send('POST', '/games/api/games', body).then(function(j){ games = j.games || []; render(); return j; }); }
function errText(e){ var k = errKey(e && e.code); return T[k] || T.failed; }
function findGame(id){ return games.filter(function(g){ return g.id === id; })[0] || null; }

/* ---------- 画 ---------- */
var POSTS = (function(){ try { var e = doc.getElementById('cu-posts'); return e ? JSON.parse(e.textContent) || [] : []; } catch (x) { return []; } })();
function chips(el, opts, cur){
  el.innerHTML = opts.map(function(o){ return '<button type="button" role="tab" class="sgx-chip" aria-selected="' + (o[0] === cur) + '" data-f="' + o[0] + '">' + esc(o[1]) + ' <i>' + o[2] + '</i></button>'; }).join('');
}
function starsText(n){ var s = ''; for (var i = 1; i <= 5; i++) s += i <= n ? '★' : '☆'; return s; }
function stars(n){
  if (!n) return '';
  return '<span class="it-stars-ro" role="img" aria-label="' + esc(starsLabel(n)) + '">' + starsText(n) + '</span>';
}
/** 一张封面卡；data-s-* 给 games-list.js 排序（recent = id，order = 接口给的顺序，rating，name） */
function gameCard(g, i){
  return '<a class="sgx-cc it-cc it-cc--game" href="?game=' + g.id + '" data-item="' + g.id + '" data-game="' + g.id + '"'
    + ' data-ord="' + i + '" data-s-recent="' + g.id + '" data-s-order="' + i + '" data-s-rating="' + (g.rating || 0) + '" data-s-name="' + esc(g.title) + '">'
    + '<span class="sgx-cc-im">' + (g.cover ? '<img src="' + coverUrl(g.id, ver[g.id]) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' : '<span class="it-media-ic">' + icon(32) + '</span>') + '</span>'
    + '<span class="sgx-cc-ci"><span class="sgx-cc-m"><span translate="no">games</span>' + (g.platform ? ' · ' + esc(g.platform) : '') + '</span>'
    + '<span class="sgx-cc-t"><span class="it-name">' + esc(g.title) + '</span>' + (showPrivate && g.private ? '<span class="cu-lock-inline" title="' + esc(T.priv) + '">' + LOCK + '</span>' : '') + '</span>'
    + '<span class="sgx-cc-k"><span class="it-status it-status--' + esc(g.status) + '">' + esc(T.status[g.status] || '') + '</span>' + (g.rating ? ' · ' + stars(g.rating) : '') + '</span>'
    + '</span></a>';
}
function render(){
  chips($('#gm-chips'), [['all', T.all, games.length]].concat(STATUS.map(function(s){ return [s, T.status[s], filterGames(games, s).length]; })), gmFilter);
  var gs = filterGames(games, gmFilter);
  $('#gm-list').innerHTML = gs.map(gameCard).join('');
  var ge = $('#gm-empty');
  ge.textContent = games.length ? T.noMatch : canManage ? T.emptyAdmin : T.empty;
  ge.classList.toggle('hidden', !loaded || gs.length > 0);
  if (loaded && UI && UI.itemId()) route(UI.itemId());
}
$('#gm-chips').addEventListener('click', function(e){ var b = e.target.closest('[data-f]'); if (b) { gmFilter = b.dataset.f; render(); } });

/* ---------- 条目页（?game=） ---------- */
function txt(v){ return esc(v).replace(/\n/g, '<br>'); }
/** 底部两卡：‹ 上一个（第一个时 cd .. 回列表）│ 相关文章 ›（没有就 cd ../next 下一个） */
function nxCards(list, g){
  var nb = neighbors(list, g.id), rel = relatedPost(g.title, POSTS);
  return {
    prev: nb.prev ? { href: '?game=' + nb.prev.id, id: nb.prev.id, k: 'cd ../prev', title: nb.prev.title } : { href: '?', id: 0, k: 'cd ..', title: T.back },
    next: rel ? { href: rel.u, k: T.related, title: rel.t } : nb.next ? { href: '?game=' + nb.next.id, id: nb.next.id, k: 'cd ../next', title: nb.next.title } : null,
  };
}
function viewGame(g){
  var spec = [[T.state, '<span class="it-status it-status--' + esc(g.status) + '">' + esc(T.status[g.status] || '') + '</span>']];
  if (g.rating) spec.push([T.rating, '<span class="cy">' + stars(g.rating) + '</span>']);
  if (g.platform) spec.push([T.platform, txt(g.platform)]);
  if (g.edition) spec.push([T.edition, txt(g.edition)]);
  var list = filterGames(games, gmFilter).some(function(x){ return x.id === g.id; }) ? filterGames(games, gmFilter) : games;
  var nx = nxCards(list, g);
  UI.showItem({ name: g.title, meta: ['games', T.status[g.status], g.platform].filter(Boolean).join(' · '), spec: spec, prose: g.review,
    img: g.cover ? '<img src="' + coverUrl(g.id, ver[g.id]) + '" alt="">' : '<span class="it-media-ic">' + icon(56) + '</span>',
    edit: canManage ? { k: 'vim games/' + UI.slug(g.title), d: T.editCmd, fn: function(){ openGameEdit(findGame(g.id)); } } : null,
    prev: nx.prev, next: nx.next });
}
/** 路由：0 = 列表；数据还没回来先不画（回来后 render 再调）；找不到（删了 / 私密）→ 一句提示 + cd .. */
function route(id){
  if (!UI) return;
  if (!id) { UI.showList(); return; }
  if (!loaded) return;
  var g = findGame(id);
  if (!g) { UI.showItem({ name: '#' + id, meta: 'games', prose: T.notFound, prev: { href: '?', id: 0, k: 'cd ..', title: T.back }, next: null }); return; }
  viewGame(g);
}
if (UI && UI.onItemRoute) UI.onItemRoute(route);

/* ---------- 封面：选图 → 移动和缩放 → 裁成长边 ≤1200 → webp（不支持就 jpeg）；同 curio-items.js 的 crop / photoBox，只留游戏 ---------- */
var CROP_OUT = 1200, ZOOM_MAX = 8;
function encode(c){
  return new Promise(function(resolve, reject){
    c.toBlob(function(b){
      if (b && b.type === 'image/webp') return resolve(b);
      c.toBlob(function(j){ j ? resolve(j) : reject(Object.assign(new Error('encode'), { code: 'not-image' })); }, 'image/jpeg', 0.85);
    }, 'image/webp', 0.85);
  });
}
/* 全屏裁剪弹层（样式 .cu-crop 在奇趣 main.css）：<dialog> 在最上层，盖过编辑弹层；取消 / Esc / 系统返回 = 什么都不改 */
var crop = (function(){
  var dlg = null, stage, pic, frame, doneBtn;
  var nw = 0, nh = 0, ratio = COVER_RATIO, f = { l: 0, t: 0, w: 0, h: 0 }, v = { tx: 0, ty: 0, k: 1 };
  var pts = {}, nPts = 0, url = '', cb = null, busy = false;
  function layout(){
    var w = stage.clientWidth, h = stage.clientHeight, fr = cropFrame(w, h, ratio);
    f = { l: Math.round((w - fr.w) / 2), t: Math.round((h - fr.h) / 2 - 20), w: fr.w, h: fr.h };
    frame.style.left = f.l + 'px'; frame.style.top = f.t + 'px'; frame.style.width = f.w + 'px'; frame.style.height = f.h + 'px';
  }
  function paint(){ v = clampView(v, nw, nh, f, ZOOM_MAX); pic.style.transform = 'translate(' + v.tx + 'px,' + v.ty + 'px) scale(' + v.k + ')'; }
  function zoomAt(k2, px, py){
    var kMin = coverScale(nw, nh, f.w, f.h), kk = Math.min(Math.max(k2, kMin), kMin * ZOOM_MAX);
    v = { tx: px - (px - v.tx) * kk / v.k, ty: py - (py - v.ty) * kk / v.k, k: kk };
    paint();
  }
  function pinch(){
    var a = Object.keys(pts).map(function(id){ return pts[id]; });
    return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
  }
  function shut(){
    if (dlg.open) dlg.close();
    pts = {}; nPts = 0; cb = null; busy = false;
    pic.removeAttribute('src');
    if (url) { URL.revokeObjectURL(url); url = ''; }
  }
  function local(e){ var r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function build(){
    dlg = doc.createElement('dialog');
    dlg.className = 'cu-crop';
    dlg.setAttribute('aria-labelledby', 'cu-crop-title');
    dlg.innerHTML = '<div class="cu-crop-stage"><img class="cu-crop-img" alt="" draggable="false"><div class="cu-crop-frame"></div></div>'
      + '<div id="cu-crop-title" class="cu-crop-title">' + esc(T.crop) + '</div>'
      + '<div class="cu-crop-bar"><button type="button" class="cu-crop-btn" data-crop-cancel>' + esc(T.cancel) + '</button>'
      + '<button type="button" class="cu-crop-btn primary" data-crop-done>' + esc(T.done) + '</button></div>';
    doc.body.appendChild(dlg);
    stage = dlg.querySelector('.cu-crop-stage'); pic = dlg.querySelector('.cu-crop-img'); frame = dlg.querySelector('.cu-crop-frame');
    doneBtn = dlg.querySelector('[data-crop-done]');
    dlg.querySelector('[data-crop-cancel]').addEventListener('click', shut);
    doneBtn.addEventListener('click', done);
    /* Esc / 系统返回 = 取消；Esc 不再冒泡到 games-ui.js，免得把下面的编辑弹层也关了 */
    dlg.addEventListener('cancel', function(e){ e.preventDefault(); shut(); });
    dlg.addEventListener('keydown', function(e){ if (e.key === 'Escape') e.stopPropagation(); });
    stage.addEventListener('pointerdown', function(e){
      try { stage.setPointerCapture(e.pointerId); } catch (x) {}
      if (!pts[e.pointerId]) nPts++;
      pts[e.pointerId] = local(e);
    });
    stage.addEventListener('pointermove', function(e){
      var p = pts[e.pointerId];
      if (!p) return;
      var q = local(e);
      if (nPts === 1) { v = { tx: v.tx + q.x - p.x, ty: v.ty + q.y - p.y, k: v.k }; p.x = q.x; p.y = q.y; paint(); return; }
      if (nPts === 2) {
        var a = pinch(); p.x = q.x; p.y = q.y; var b = pinch();
        v = { tx: v.tx + b.x - a.x, ty: v.ty + b.y - a.y, k: v.k };
        if (a.d > 0) zoomAt(v.k * b.d / a.d, b.x, b.y); else paint();
      }
    });
    function up(e){ if (pts[e.pointerId]) { delete pts[e.pointerId]; nPts--; } }
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', function(e){ e.preventDefault(); var q = local(e); zoomAt(v.k * Math.exp(-e.deltaY * 0.0015), q.x, q.y); }, { passive: false });
    G.addEventListener('resize', function(){
      if (!dlg.open || !nw) return;
      var s = cropSource(v, nw, nh, f);
      layout(); v = viewFromSource(s, f); paint();
    });
  }
  function done(){
    if (busy || !nw) return;
    busy = true; doneBtn.disabled = true;
    var s = cropSource(v, nw, nh, f), o = cropOut(s.sw, s.sh, ratio, CROP_OUT);
    var c = doc.createElement('canvas'); c.width = o.w; c.height = o.h;
    var g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(pic, s.sx, s.sy, s.sw, s.sh, 0, 0, o.w, o.h);
    var fn = cb;
    encode(c).then(function(b){ shut(); if (fn) fn(b, s); }, function(e){ shut(); toast(errText(e)); });
  }
  /** 选的文件只当图片解码：按 image/* 重新包一层 Blob（不是位图类型、或是 SVG，就给 octet-stream），这个 object URL 不会被当成网页打开 */
  function asImage(file){ return new Blob([file], { type: /^image\/(?!svg)/i.test(file.type) ? file.type : 'application/octet-stream' }); }
  /** 打开：file = 原图；src = 上次框住的原图区域（重新调整时带上）；onDone(blob, src) */
  function openCrop(file, src, onDone){
    if (!dlg) build();
    if (url) URL.revokeObjectURL(url);
    cb = onDone; busy = false; nw = nh = 0; pts = {}; nPts = 0;
    doneBtn.disabled = true;
    url = URL.createObjectURL(asImage(file));
    pic.onload = function(){
      nw = pic.naturalWidth; nh = pic.naturalHeight;
      if (!nw || !nh) { shut(); toast(T.notImage); return; }
      pic.style.width = nw + 'px'; pic.style.height = nh + 'px';
      if (!dlg.open) dlg.showModal();
      layout();
      v = src ? viewFromSource(src, f) : centerView(nw, nh, f);
      paint();
      doneBtn.disabled = false;
    };
    pic.onerror = function(){ shut(); toast(T.notImage); };
    pic.src = url;
  }
  return { open: openCrop };
})();
var ADJ = '<span class="it-photo-adj" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg></span>';
/** 编辑弹层的封面状态：pending = 裁好的 Blob，drop = 要去掉；file / src = 原图和框住的区域（保存前可重新调整） */
var cover = (function(){
  var st = { pending: null, drop: false, had: false, prevUrl: '', file: null, src: null };
  var prev = $('#gm-photo-prev'), input = $('#gm-photo'), del = $('#gm-photo-del');
  function show(src){
    if (st.prevUrl) { URL.revokeObjectURL(st.prevUrl); st.prevUrl = ''; }
    var adj = !!(src && st.pending && st.file);
    prev.textContent = '';
    if (src) {
      var im = document.createElement('img');
      im.src = src; im.alt = '';
      prev.appendChild(im);
      if (adj) prev.insertAdjacentHTML('beforeend', ADJ);
    } else prev.innerHTML = icon(32);
    prev.disabled = !adj;
    if (adj) { prev.setAttribute('aria-label', T.adjust); prev.removeAttribute('aria-hidden'); }
    else { prev.removeAttribute('aria-label'); prev.setAttribute('aria-hidden', 'true'); }
    del.classList.toggle('hidden', !src);
  }
  function cropped(file){
    return function(b, src){
      st.pending = b; st.drop = false; st.file = file; st.src = src;
      var u = URL.createObjectURL(b);
      show(u); st.prevUrl = u;
    };
  }
  input.addEventListener('change', function(){
    var f = input.files && input.files[0];
    input.value = '';
    if (f) crop.open(f, null, cropped(f));
  });
  /* 刚选的图还没保存：点缩略图回到裁剪，接着上次框住的位置调 */
  prev.addEventListener('click', function(){ if (st.pending && st.file) crop.open(st.file, st.src, cropped(st.file)); });
  del.addEventListener('click', function(){ st.pending = null; st.file = null; st.src = null; st.drop = st.had; show(''); });
  return {
    reset: function(g){ st.pending = null; st.file = null; st.src = null; st.drop = false; st.had = !!(g && g.cover); show(st.had ? coverUrl(g.id, ver[g.id]) : ''); },
    /** 保存后跑：有新图就传，有「去掉」就删；返回 Promise<是否出错> */
    commit: function(id){
      var p = st.pending ? send('POST', coverUrl(id), st.pending, st.pending.type)
        : st.drop ? send('DELETE', coverUrl(id)) : null;
      if (!p) return Promise.resolve(false);
      var has = !!st.pending;
      return p.then(function(){
        ver[id] = Date.now();
        /* 本地列表跟上：第一次传图 / 去掉封面后卡片立刻换（列表是保存时 op 回的，那时封面还没传） */
        var g = findGame(id);
        if (g) g.cover = has;
        return false;
      }, function(e){ if (e.sgxLocked) throw e; return true; });
    }
  };
})();

/* ---------- 编辑（新增 / 修改；没有「在哪台设备上」） ---------- */
var gmEditing = null, gmStatus = 'want', gmRating = 0;
function renderStatus(){
  $('#gm-status').innerHTML = STATUS.map(function(s){ return '<button type="button" role="radio" class="cu-chip cu-chip-sm" aria-checked="' + (gmStatus === s) + '" data-s="' + s + '">' + esc(T.status[s]) + '</button>'; }).join('');
}
function renderRating(){
  var h = '';
  for (var i = 1; i <= 5; i++) h += '<button type="button" role="radio" class="it-star-btn' + (i <= gmRating ? ' on' : '') + '" aria-checked="' + (i === gmRating) + '" aria-label="' + esc(starsLabel(i)) + '" data-r="' + i + '">' + starSvg(28) + '</button>';
  $('#gm-rating').innerHTML = h;
}
$('#gm-status').addEventListener('click', function(e){ var b = e.target.closest('[data-s]'); if (b) { gmStatus = b.dataset.s; renderStatus(); } });
/* 点同一颗星再点一次 = 清空评分 */
$('#gm-rating').addEventListener('click', function(e){ var b = e.target.closest('[data-r]'); if (!b) return; var n = Number(b.dataset.r); gmRating = n === gmRating ? 0 : n; renderRating(); });
function gmErr(m){ var el = $('#gm-err'); el.textContent = m || ''; el.classList.toggle('hidden', !m); }
function openGameEdit(g){
  gmEditing = g || null;
  $('#gm-edit-title').textContent = g ? T.editGame : T.addGame;
  gmStatus = g ? g.status : 'want'; renderStatus();
  gmRating = g ? g.rating : 0; renderRating();
  $('#gm-title').value = g ? g.title : '';
  $('#gm-platform').value = g ? g.platform : '';
  $('#gm-platforms').innerHTML = platformsOf(games).map(function(p){ return '<option value="' + esc(p) + '">'; }).join('');
  $('#gm-edition').value = g ? g.edition : '';
  $('#gm-review').value = g ? g.review : '';
  $('#gm-private').checked = !!(g && g.private);
  $('#gm-del').classList.toggle('hidden', !g);
  cover.reset(g);
  gmErr('');
  open('gm-edit-wrap');
  if (!g) setTimeout(function(){ $('#gm-title').focus(); }, 50);
}
$('#gm-fab').addEventListener('click', function(){ if (canManage) openGameEdit(null); });
$('#gm-save').addEventListener('click', function(){
  var title = $('#gm-title').value.trim();
  if (!title) { gmErr(T.needName); return; }
  /* 不发 device_id：add 时取缺省 0，edit 时库里原值不动（关联设备 PR 2 去掉界面、PR 3 清零） */
  var body = {
    title: title, status: gmStatus, rating: gmRating, platform: $('#gm-platform').value,
    edition: $('#gm-edition').value, review: $('#gm-review').value, private: $('#gm-private').checked,
  };
  if (gmEditing) { body.op = 'game.edit'; body.id = gmEditing.id; } else body.op = 'game.add';
  var btn = $('#gm-save'); btn.disabled = true;
  op(body).then(function(j){
    var id = gmEditing ? gmEditing.id : j.id;
    return cover.commit(id).then(function(bad){ if (!bad) return; toast(T.photoFail); throw { quiet: true }; }).then(function(){ render(); close('gm-edit-wrap'); toast(T.saved); });
  }).catch(function(e){ if (e && e.quiet) { render(); close('gm-edit-wrap'); return; } if (!e.sgxLocked) gmErr(errText(e)); }).then(function(){ btn.disabled = false; });
});
$('#gm-del').addEventListener('click', function(){
  if (!gmEditing || !UI) return;
  var id = gmEditing.id;
  UI.ask(T.delGame, T.del, function(){ op({ op: 'game.del', id: id }).then(function(){ close('gm-edit-wrap'); toast(T.deleted); if (UI.itemId()) UI.goItem(0, true); }).catch(function(e){ if (!e.sgxLocked) toast(errText(e)); }); });
});

/* ---------- 调整顺序（sort games/）：居中悬浮卡片 <dialog class="sgx-qp gm-dlg">（共享 modalSheet，同音乐上传窗） ---------- */
var ordDlg = doc.getElementById('gm-order-wrap');
var ordList = $('#gm-order-list');
var ordIds = [], ordBase = [];
function bodyLock(on){ doc.body.style.overflow = on || doc.querySelector('.bk-overlay.open') ? 'hidden' : ''; }
var ordSheet = !ordDlg ? null : G.SgxModalSheet
  ? G.SgxModalSheet(ordDlg, $('#gm-order-open'), { ms: 240, reducedMs: 120, stateKey: 'sgxGmOrder', modal: false, onOpen: function(){ bodyLock(true); }, onClosed: function(){ bodyLock(false); } })
  : { open: function(){ if (!ordDlg.open) { ordDlg.show(); ordDlg.classList.add('is-open'); bodyLock(true); } }, close: function(cb){ if (ordDlg.open) { ordDlg.classList.remove('is-open'); ordDlg.close(); } bodyLock(false); if (typeof cb === 'function') cb(); } };
function ordErr(m){ var el = $('#gm-order-err'); el.textContent = m || ''; el.classList.toggle('hidden', !m); }
function renderOrder(focusId, focusAct){
  var lu = ordList.getAttribute('data-l-up') || '', ld = ordList.getAttribute('data-l-down') || '';
  ordList.innerHTML = ordIds.map(function(id, i){
    var g = findGame(id) || { id: id, title: '#' + id };
    return '<li class="gm-ord-row" data-id="' + id + '">'
      + '<span class="gm-ord-grip" aria-hidden="true">' + GRIP + '</span>'
      + '<span class="gm-ord-n" translate="no">' + (i < 9 ? '0' : '') + (i + 1) + '</span>'
      + '<span class="gm-ord-t">' + esc(g.title) + (g.private ? '<span class="cu-lock-inline" title="' + esc(T.priv) + '">' + LOCK + '</span>' : '') + '</span>'
      + '<button type="button" class="gm-ord-btn" data-act="up" aria-label="' + esc(lu + ' · ' + g.title) + '"' + (i === 0 ? ' disabled' : '') + '>' + UP + '</button>'
      + '<button type="button" class="gm-ord-btn" data-act="down" aria-label="' + esc(ld + ' · ' + g.title) + '"' + (i === ordIds.length - 1 ? ' disabled' : '') + '>' + DOWN + '</button>'
      + '</li>';
  }).join('');
  $('#gm-order-save').disabled = sameOrder(ordIds, ordBase);
  if (focusId) {
    var b = ordList.querySelector('[data-id="' + focusId + '"] [data-act="' + focusAct + '"]');
    if (b && b.disabled) b = ordList.querySelector('[data-id="' + focusId + '"] [data-act="' + (focusAct === 'up' ? 'down' : 'up') + '"]');
    if (b) try { b.focus(); } catch (e) {}
  }
}
function openOrder(){
  if (!canManage || !ordSheet) return;
  /* 接口给的就是「我的顺序」（pos, id），canManage 时私密的也在里面 = 全部游戏 */
  ordBase = games.map(function(g){ return g.id; });
  ordIds = ordBase.slice();
  ordErr('');
  renderOrder();
  ordSheet.open();
}
$('#gm-order-open').addEventListener('click', openOrder);
if (ordDlg) {
  ordDlg.addEventListener('click', function(e){ if (e.target === ordDlg) ordSheet.close(); });
  $('#gm-order-x').addEventListener('click', function(){ ordSheet.close(); });
  $('#gm-order-cancel').addEventListener('click', function(){ ordSheet.close(); });
  /* 顶栏窗口互斥（同 music-page.js）：排序窗开着时点顶栏任一按钮，先关它、等历史哨兵出栈，下一个任务再把这次点击补给原按钮 */
  var nav = doc.getElementById('site-nav');
  if (nav) nav.addEventListener('click', function(e){
    if (!ordDlg.open) return;
    var t = e.target.closest && e.target.closest('button, a');
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    ordSheet.close(function(){ G.setTimeout(function(){ t.click(); }, 0); });
  }, true);
}
ordList.addEventListener('click', function(e){
  var b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  var id = Number(b.closest('[data-id]').getAttribute('data-id'));
  var i = ordIds.indexOf(id), next = moveIndex(ordIds, i, i + (b.dataset.act === 'up' ? -1 : 1));
  if (!next) return;
  ordIds = next;
  renderOrder(id, b.dataset.act);
});
/* 拖动：按住把手（.gm-ord-grip，鼠标 / 手指 / 笔都行）上下拖，经过别的行就换到那里；松手定下（同一份 ordIds，保存才发） */
(function(){
  var drag = null;
  function rowAt(y){
    var rows = ordList.querySelectorAll('.gm-ord-row');
    for (var k = 0; k < rows.length; k++) { var r = rows[k].getBoundingClientRect(); if (y >= r.top && y < r.bottom) return k; }
    if (rows.length && y >= rows[rows.length - 1].getBoundingClientRect().bottom) return rows.length - 1;
    return rows.length && y < rows[0].getBoundingClientRect().top ? 0 : -1;
  }
  ordList.addEventListener('pointerdown', function(e){
    var grip = e.target.closest && e.target.closest('.gm-ord-grip');
    if (!grip || (e.pointerType === 'mouse' && e.button !== 0)) return;
    var row = grip.closest('.gm-ord-row');
    e.preventDefault();
    drag = { id: Number(row.getAttribute('data-id')), pid: e.pointerId };
    try { grip.setPointerCapture(e.pointerId); } catch (x) {}
    row.classList.add('is-drag');
    ordList.classList.add('is-dragging');
  });
  ordList.addEventListener('pointermove', function(e){
    if (!drag || e.pointerId !== drag.pid) return;
    e.preventDefault();
    var to = rowAt(e.clientY), from = ordIds.indexOf(drag.id);
    var next = to >= 0 ? moveIndex(ordIds, from, to) : null;
    if (next) {
      ordIds = next;
      renderOrder();
      var row = ordList.querySelector('[data-id="' + drag.id + '"]');
      if (row) { row.classList.add('is-drag'); var gp = row.querySelector('.gm-ord-grip'); try { gp.setPointerCapture(drag.pid); } catch (x) {} }
    }
    /* 拖到可滚区域的上下边缘时跟着滚 */
    var box = ordList.closest('.gm-dlg-body');
    if (box) {
      var r = box.getBoundingClientRect();
      if (e.clientY < r.top + 32) box.scrollTop -= 12; else if (e.clientY > r.bottom - 32) box.scrollTop += 12;
    }
  });
  function end(e){
    if (!drag || (e && e.pointerId !== drag.pid)) return;
    drag = null;
    ordList.classList.remove('is-dragging');
    ordList.querySelectorAll('.is-drag').forEach(function(r){ r.classList.remove('is-drag'); });
  }
  ordList.addEventListener('pointerup', end);
  ordList.addEventListener('pointercancel', end);
  ordList.addEventListener('lostpointercapture', function(e){ if (drag && e.pointerId === drag.pid && !e.target.isConnected) return; end(e); });
})();
$('#gm-order-save').addEventListener('click', function(){
  var btn = this;
  if (sameOrder(ordIds, ordBase)) { ordSheet.close(); return; }
  btn.disabled = true; ordErr('');
  op({ op: 'game.order', ids: ordIds }).then(function(){
    ordSheet.close();
    if (G.SgxGamesList) G.SgxGamesList.sortBy('order');
    toast(T.orderSaved);
  }).catch(function(e){
    if (e.sgxLocked) { btn.disabled = false; return; }
    ordErr(errText(e));
    btn.disabled = false;
  });
});

/* ---------- 启动 ---------- */
getJSON('/games/api/games').then(function(j){
  canManage = !!j.canManage; showPrivate = !!j.showPrivate; games = j.games || []; loaded = true;
  /* 命令链：只有 canManage 时显示「touch games/ +」「sort games/」；不能编辑时空着（同 /music/） */
  $('#gm-fab').classList.toggle('hidden', !canManage);
  $('#gm-order-open').classList.toggle('hidden', !canManage);
  $('#gm-loading').classList.add('hidden');
  render();
}).catch(function(e){
  if (e && e.sgxLocked) return;
  $('#gm-loading').textContent = (T.loadFail || T.failed);
});
})();
