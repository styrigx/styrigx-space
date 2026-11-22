/* assets/common/js/music/music-player.js —— 弹出播放器页（/music/player/，中文 /music/zh/player/；音乐分层方案 v1.13 第二步 2b；浏览器 IIFE；node 测试时导出纯函数）。
 *
 * music 搬家第 3 步（搬家设计稿 v1.1 3.2 / 3.3，2026-11-21）：地址从 /curio/music/player/ 搬到 /music/player/，接口走 /music/api/*；
 * 音乐页不再出声，本页是唯一发声的页。这一步只加两样：认 ?t=<i>（开窗就从第 i 首放）、认 remote-cmd play（音乐页点播放交过来），其余不动。
 *
 * 打磨 6.4（v2 稿，Gray 2026-11-22 定）：界面重做，功能照旧——没有曲目列表、没有专辑列表（选歌只在 /music/）；手机两页左右滑（播放页 / 歌词页，
 *   拖过 22% 或甩一下翻页，顶上两个页点），桌面左播放右歌词；队列、⋯ 是居中的悬浮卡片（非模态 <dialog class="sgx-qp mp-dlg">，共享 modalSheet；
 *   桌面队列是右侧抽屉、⋯ 是小浮层）。⋯ 只有三行：专辑 → /music/?album=、歌手 → /music/?artist=、回到曲库 → /music/，
 *   和歌手名同一套（ARTIST_MSG 三步，artist-go 带 kind），开着的音乐页优先（pickMain）；顶行「选歌」也一样，播放器不跳走。
 *   广播的 player-state 多带 album / i / queue / cover / 进度（t、d、at），音乐页的迷你播放条和曲目高亮用。
 *   下面 2b 时的条目里「曲目列表」「专辑列表」「歌词点一下展开」已经没有了，其余照旧。
 * 只播放，不管理（上传 / 删除留在音乐页 music/js/music-page.js）。功能按方案 §7.1 播放层：
 *   - 正在播：封面小图 + 歌名 + 歌手 + 专辑名；标签页标题跟着歌名。
 *   - 播放控制：播放 / 暂停、上一首、下一首；进度条可拖（Range）+ 当前时间 / 总时长。
 *   - 播放模式：顺序 / 随机（共用核 setShuffle；模式记在 localStorage「sgx-music-mode」，下次打开还是上次的；
 *     多开的窗口之间 storage 事件同步）。
 *   - 倍速：1× → 1.25× → 1.5× → 2× 循环（PLAYER_SPEEDS；只记在本窗口内存里）。
 *   - 音量滑条 + 静音（本窗口）。
 *   - 歌词：有 LRC 显示当前一句（跟播放同步）；点一下展开全部，再点收起。
 *   - 曲目列表：当前专辑，点一首直接播，正在播的高亮。专辑列表可收起，点一张换专辑（换的是列表，点曲目 / 播放才开播）。
 *   - Media Session：锁屏 / 耳机键 播放、暂停、上一首、下一首、拖进度；显示歌名、歌手、专辑、封面。
 *   - 防同时响：共用核的 BroadcastChannel「sgx-music」，别的页开播这边自动停，反过来一样。
 *   - 登录过期提示：签令牌 401（没登录 / 会话过期，music-use 档拒）→ 一句提示 +「登录」（发 sgx:sudo，顶栏终端预填 su ；第 7 步进 Platform 前是借 curio.js 的 SgxCurioUI.sudo，同一个事件），
 *     403 → 没有权限；都不静默卡住。页面带网关标记 data-sgx-lock-session="locked" 时一打开就提示。
 *   - 单窗口（2c）：窗口名 sgx-music-player，顶栏音乐图标（topbar/panel.js mountMusic）按这个名字找，已开就切过来不重开。
 * 单曲（音乐 v1.13 ②，Gray 2026-11-14 17:33）：专辑列表最后多一项「单曲」（有单曲才有），选它曲目表 = 全部单曲，点一首从那首开始，
 *   单曲区当播放列表（共用核 playQueue，按需为下一首签令牌；顺序 / 随机、到尾停同专辑）。正在播是单曲时副标题只显示歌手，不显示专辑名（#mp-album 空），
 *   Media Session 的 album 也空；顶栏遥控（remoteState）本来就只给歌手。
 * 地址可带 ?album=<编号> 先显示那张专辑（入口 2c 用得上），没有就第一张。
 * 再带 &t=<第几首，从 0 起>（第 3 步，音乐页没开播放器时点播放开的就是 /music/player/?album=<id>&t=<i>）：一打开就从那首放（startOf）。
 *   单曲 album = 那条单曲记录（t = 0），从单曲组里它那一首开始、单曲组当播放列表。新开的窗口没有用户手势，浏览器拦了自动播放就停在那首、
 *   播放键亮着，点一下就放（共用核 start 吞掉 play() 的拒绝，不另想绕法）。只看模式照旧只提示「登录」，不放。
 * 音乐页点播放（第 3 步 3.3）：开着的播放器收 remote-cmd {cmd:'play', album, i}（单曲 {cmd:'play', queue, i}），换到那张、从第 i 首放
 *   （歌单里没有这张就重取一次歌单再找：音乐页刚传的新专辑；纯函数 playCmdWith）；切到前面靠音乐页那边同一次点击里的 window.open('', 窗口名)，这边能 focus 也 focus 一下。
 * 交接握手（打磨 6.3）：顶栏 reach() 发 player-hello {req, from}，本窗口答 player-state {…, id, req, mine}（mine = opener 就是问的那页）；
 *   之后的 remote-cmd 带 to = 本窗口 id，不是给自己的不认（不带 to 的照旧认）；收到给自己的 player-focus 就 focus()（尽力）。手动开的播放器也接得到。
 * 歌手页（M4，音乐 v1.19 7.5 / 十二 M4）：正在播的歌手名可点；点了不在播放器里跳走（播放会断），经 BroadcastChannel 让主窗口打开歌手页
 *   （共用核 ARTIST_MSG 三步：artist-ask → 主窗口 artist-here → 挑最近用过的那个 artist-go；没人答退回 window.opener，再不行开新标签页）。
 *   单曲没封面：封面空 → 歌手头像 → 默认图（共用核 coverOf，正在播的封面和 Media Session 一样）。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;
var CORE = typeof module !== 'undefined' && module.exports ? require('./music-core.js') : G.SgxMusicCore;

/** 地址里的 ?album=<编号>；没有 / 不对返回 0 */
function albumOf(search){ var m = /[?&]album=(\d+)(?:&|$)/.exec(String(search || '')); return m ? Number(m[1]) : 0; }
/** 签令牌失败怎么提示：401 = 'expired'（进站过期 / 没进站），403 forbidden = 'noPermission'，其他 = 'failed' */
function failKind(e){ if (e && (e.sgxLocked || e.status === 401)) return 'expired'; if (e && e.code === 'forbidden') return 'noPermission'; return 'failed'; }
/** Media Session 的封面（有封面才给；单曲没封面用歌手头像，M4） @param {any} a @param {any[]} [arts] */
function artworkOf(a, arts){ var u = CORE.coverOf(a, arts); return u ? [{ src: u, sizes: '512x512' }] : []; }
/** 地址里的 &t=<第几首>（从 0 起）；没有 / 不对返回 -1（只显示，不自动放） */
function trackOf(search){ var m = /[?&]t=(\d{1,4})(?:&|$)/.exec(String(search || '')); return m ? Number(m[1]) : -1; }
/**
 * 打开时停在哪张、要不要从某首放：groups = groupsOf 的列表；all = 全部记录；want = ?album；t = ?t。
 * 专辑：那张、第 t 首（t 越界 = 不放）；单曲记录：单曲组、它在组里那一首（t 只能是 0）；没有这张：第一张、不放。
 * @returns {{cur: number, i: number}} i = -1 不放
 */
function startOf(groups, all, want, t){
  var k = -1, i = -1, g;
  for (var n = 0; n < (groups || []).length; n++) if (!groups[n].singles && groups[n].id === want) { k = n; break; }
  if (k >= 0) { g = groups[k]; if (t >= 0 && t < g.tracks.length) i = t; return { cur: k, i: i }; }
  var a = null;
  for (var x = 0; want && all && x < all.length; x++) if (all[x].id === want) { a = all[x]; break; }
  if (a && CORE.isSingle(a)) {
    for (var s = 0; s < groups.length; s++) if (groups[s].singles) {
      g = groups[s];
      var j = g.items.map(function(r){ return r.id; }).indexOf(want);
      return { cur: s, i: j >= 0 && t === 0 ? j : -1 };
    }
  }
  return { cur: 0, i: -1 };
}
/** 播放器所在页 → 音乐页路径（/music/player/ → /music/；中文 /music/zh/player/ → /music/zh/） */
function musicPathOf(pathname){ return String(pathname || '/music/player/').replace(/player\/?$/, ''); }
/** 文案表（同 music-page.js readDict / makeTr 的做法） */
function readDict(doc, table){
  try { var el = doc && doc.getElementById('sgx-i18n-' + table); var o = el && el.textContent ? JSON.parse(el.textContent) : null; return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
}
function makeTr(dict, lang){
  var pr = null;
  try { pr = new Intl.PluralRules(lang || 'en'); } catch (e) { pr = null; }
  return function(key, vars){
    var s = null;
    if (vars && typeof vars.n === 'number' && pr) s = dict[key + '_' + pr.select(vars.n)];
    if (s == null) s = dict[key];
    s = s == null ? '' : String(s);
    if (vars) for (var k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  };
}

/**
 * 播放器的「专辑列表」：专辑照原顺序，有单曲时最后加一项单曲组 {singles:true, id:-1, title, items:[单曲记录], tracks:[每首单曲的那一首]}。
 * @param {any[]} list GET /music/api/music 的 albums（每条带 kind） @param {string} label 单曲组的名字
 */
function groupsOf(list, label){
  var al = [], sg = [];
  (list || []).forEach(function(a){ (CORE.isSingle(a) ? sg : al).push(a); });
  sg = sg.filter(function(a){ return a.tracks && a.tracks.length; });
  if (sg.length) al.push({ singles: true, id: -1, title: label || '', artist: '', cover: false, items: sg, tracks: sg.map(function(a){ var t = a.tracks[0]; return { id: t.id, no: 0, title: a.title, duration: t.duration }; }) });
  return al;
}
/**
 * 收到 remote-cmd play 怎么办（第 3 步 3.3；打磨 6.3 拆成纯函数好测）：专辑 {album, i} 换到那张从第 i 首放；单曲 {queue:[记录 id…], i} 单曲组当前、按这一列放。
 * 歌单里没有这张 / 这几条（音乐页刚传的）就重取一次歌单再找，还没有就不动、也不再重取（again = 已经重取过）。
 * env：viewOnly、groups()（当前专辑列表，groupsOf 的）、has(id)（全部记录里有没有）、reload()（重取歌单，回 Promise）、locked()、
 *   select(k)（换到第 k 项）、playQueue(q, i)、playFrom(id, i)、focus()。
 * @returns {'locked'|'reload'|'skip'|'queue'|'album'|'none'} 做了什么（测试用）
 */
function playCmdWith(m, env, again){
  if (env.viewOnly) { env.locked(); return 'locked'; }
  var i = Number(m.i), k = -1, gs = env.groups(), n;
  var retry = function(){ if (again) return 'none'; env.reload().then(function(){ playCmdWith(m, env, true); }); return 'reload'; };
  if (Array.isArray(m.queue)) {
    var q = m.queue.map(Number).filter(function(x){ return x > 0; });
    if (!(i >= 0 && i < q.length)) return 'skip';
    if (!q.every(function(id){ return env.has(id); })) return retry();
    for (n = 0; n < gs.length; n++) if (gs[n].singles) { k = n; break; }
    if (k >= 0) env.select(k);
    env.playQueue(q, i);
    env.focus();
    return 'queue';
  }
  var id = Number(m.album);
  for (n = 0; n < gs.length; n++) if (!gs[n].singles && gs[n].id === id) { k = n; break; }
  if (k < 0) return retry();
  if (!(i >= 0 && i < gs[k].tracks.length)) return 'skip';
  env.select(k);
  env.playFrom(id, i);
  env.focus();
  return 'album';
}
/** 这条 remote-cmd 给不给本窗口（打磨 6.3）：带 to 的只认自己的 id，不带 to 的（遥控层 prev / toggle / next）照旧都认 */
function cmdForMe(m, id){ return !m || m.to == null || m.to === id; }
/**
 * 小遥控层要的「现在在播什么」（方案 v1.13 §三 / §九：顶栏图标下的遥控，BroadcastChannel「sgx-music」）。
 * on = 有一首在播或暂停着（没开播 / 放完停了是 false，遥控只显示入口）；title / artist 给遥控层画字。
 * 打磨 6.4：多带 album（正在放的那条记录 id，单曲 = 单曲记录）、i（在这一列里第几首）、queue（单曲列表模式）、cover（封面地址，coverOf），
 *   音乐页迷你播放条和曲目高亮用；没在放时 album 0、i -1。
 * @param {{ album: number, list: any[], i: number, queue?: any }} st 共用核的 state @param {boolean} playing @param {any[]} albums @param {any[]} [arts]
 */
function remoteState(st, playing, albums, arts){
  var t = st && st.i >= 0 ? st.list[st.i] : null;
  var a = null;
  for (var k = 0; albums && k < albums.length; k++) if (albums[k].id === st.album) { a = albums[k]; break; }
  return { type: 'player-state', on: !!t, playing: !!t && !!playing, title: t ? String(t.title || '') : '', artist: t ? String((a && a.artist) || '') : '',
    album: t ? st.album : 0, i: t ? st.i : -1, queue: !!(t && st.queue), cover: t ? CORE.coverOf(a, arts || []) : '' };
}
/** 手机两页：拖动中的位置（0 = 播放页，1 = 歌词页；两头各多拖 8% 有阻力感） @param {number} p0 @param {number} dx @param {number} w */
function dragP(p0, dx, w){ return Math.max(-0.08, Math.min(1.08, p0 - dx / Math.max(1, w))); }
/** 翻页阈值（v2 稿）：拖过宽度的 22%，或甩一下（≥ 24px、速度 ≥ 0.45 px/ms） */
var PAGE_SWIPE = 0.22, PAGE_FLING = 0.45;
/** 松手后停在哪页 @param {number} p0 按下时的页 @param {number} dx 横向位移（px，向左为负） @param {number} w 宽 @param {number} ms 用时 */
function pageAfterDrag(p0, dx, w, ms){
  var v = dx / Math.max(1, ms), fl = Math.abs(dx) >= 24;
  if (dx < -w * PAGE_SWIPE || (fl && v < -PAGE_FLING)) return 1;
  if (dx > w * PAGE_SWIPE || (fl && v > PAGE_FLING)) return 0;
  return p0;
}
/** 歌词第 i 行离当前句多远（0–4，越远越淡）；还没到第一句时按离第一句算 @param {number} i @param {number} cur */
function lyricDist(i, cur){ return Math.min(4, Math.abs(i - (cur < 0 ? -1 : cur))); }
/**
 * ⋯ 的三行（Gray 2026-11-22）：专辑：<专辑名> → 音乐页 ?album=<id>；歌手：<歌手> → ?artist=<id>；回到曲库 → 音乐页。
 * 单曲没有专辑那行；歌手对不上歌手表（没 id）没有歌手那行。没有会员 / 购买 / 铃声 / 音质 / 投屏这类。
 * @param {any} a 正在播 / 显示着的那条记录 @param {any[]} arts 歌手表 @param {string} path 音乐页路径（/music/、/music/zh/）
 * @returns {Array<{kind: 'album'|'artist'|'library', id: number, name: string, href: string}>}
 */
function moreRows(a, arts, path){
  var out = [], p = String(path || '/music/');
  if (a && !CORE.isSingle(a) && a.id > 0) out.push({ kind: 'album', id: a.id, name: String(a.title || ''), href: p + '?album=' + a.id });
  var id = a && a.artist_id;
  if (a && a.artist && id > 0 && (arts || []).some(function(r){ return r.id === id; })) out.push({ kind: 'artist', id: id, name: String(a.artist), href: CORE.artistHref(p, id) });
  out.push({ kind: 'library', id: 0, name: '', href: p });
  return out;
}
/**
 * 队列弹层画什么（只是当前这一列，不是选歌）：
 * - 在放单曲列表：列表里的每条单曲（歌名 · 歌手 · 时长），正在放的那首 on；
 * - 在放专辑：这张专辑签下来的曲目（list），正在放的 on；
 * - 还没放：打开时停着的那一组（专辑的曲目 / 单曲组），都不 on。
 * @param {any} st 共用核 state @param {any[]} all 全部记录 @param {any} g 停着的那一组（groupsOf 的一项）
 * @returns {{ ref: any, items: Array<{title: string, artist: string, dur: number, on: boolean}> }} ref = 专辑记录（单曲列表时 null）
 */
function queueOf(st, all, g){
  var by = function(id){ for (var k = 0; all && k < all.length; k++) if (all[k].id === id) return all[k]; return null; };
  if (st && st.i >= 0 && st.queue) {
    return { ref: null, items: st.queue.map(function(id, k){ var r = by(id), t = r && r.tracks && r.tracks[0]; return { title: String(r ? r.title : ''), artist: String((r && r.artist) || ''), dur: Number(t && t.duration) || 0, on: k === st.i }; }) };
  }
  if (st && st.i >= 0) {
    var a = by(st.album);
    return { ref: a, items: (st.list || []).map(function(t, k){ return { title: String((t && t.title) || ''), artist: String((a && a.artist) || ''), dur: Number(t && t.duration) || 0, on: k === st.i }; }) };
  }
  if (!g) return { ref: null, items: [] };
  if (g.singles) return { ref: null, items: g.items.map(function(r){ var t = r.tracks[0]; return { title: String(r.title || ''), artist: String(r.artist || ''), dur: Number(t && t.duration) || 0, on: false }; }) };
  return { ref: g, items: g.tracks.map(function(t){ return { title: String(t.title || ''), artist: String(g.artist || ''), dur: Number(t.duration) || 0, on: false }; }) };
}

var pure = { playCmdWith: playCmdWith, cmdForMe: cmdForMe, albumOf: albumOf, trackOf: trackOf, startOf: startOf, failKind: failKind, artworkOf: artworkOf, remoteState: remoteState, groupsOf: groupsOf, musicPathOf: musicPathOf,
  dragP: dragP, pageAfterDrag: pageAfterDrag, PAGE_SWIPE: PAGE_SWIPE, PAGE_FLING: PAGE_FLING, lyricDist: lyricDist, moreRows: moreRows, queueOf: queueOf };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }
G.SgxMusicPlayer = pure;

var doc = G.document;
if (!doc.getElementById('mp-app')) return;
/* 叫顶栏终端进站（同 curio.js askSudo：只发 sgx:sudo）；第 7 步进 Platform 后不再借产品的 SgxCurioUI */
function sudo(){ try { doc.dispatchEvent(new CustomEvent('sgx:sudo')); } catch (e) {} }
var $ = function(s){ return doc.querySelector(s); };
var $$ = function(s){ return Array.prototype.slice.call(doc.querySelectorAll(s)); };
var de = doc.documentElement;
var lang = de.lang || 'en';
var T = readDict(doc, 'curioPlayer'), tr = makeTr(T, lang);
var baseTitle = doc.title;
var MUSIC = musicPathOf(G.location.pathname);
/* 2c 单窗口：本页的窗口名 = 顶栏入口找的那个（topbar/panel.js MUSIC_WIN）；被拦退路是本标签页直接跳过来的，离开时清掉名字，
   免得这个标签页走到别的页后还被当成播放器 */
var WIN = 'sgx-music-player';
try { G.name = WIN; } catch (e) {}
G.addEventListener('pageshow', function(){ try { G.name = WIN; } catch (e) {} });
G.addEventListener('pagehide', function(){ try { if (!G.opener) G.name = ''; } catch (e) {} });
var store = null;
try { store = G.localStorage; } catch (e) { store = null; }

/* all = 接口回的全部记录（专辑 + 单曲）；albums = 组（专辑 + 末尾的单曲组，groupsOf），cur 是停着的那一组、pend 是那组里没开播时点播放从哪首起 */
var all = [], albums = [], cur = 0, pend = 0, speed = 1, lyr = { lines: [], line: -2 };
/** 歌手表（M4，GET 回答的 artists） */
var arts = [];
var audio = $('#mp-audio');
var viewOnly = de.getAttribute('data-sgx-lock-session') === 'locked';
var P = CORE.createPlayer({
  audio: audio,
  sign: function(albumId){ return req('POST', '/music/api/music-play', { album: albumId }); },
  onTrack: paintTrack,
  onChange: syncState,
  onStop: function(){ paintNow(); syncState(); },
  onError: function(e){ note(failKind(e)); },
});

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function req(method, url, body){
  return fetch(url, {
    method: method, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(j){
      if (r.status === 401) throw Object.assign(new Error('locked'), { sgxLocked: true, status: 401 });
      if (!r.ok || !j.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { code: j.error, status: r.status });
      return j;
    });
  });
}
function isDesk(){ return de.getAttribute('data-sgx-layout') === 'desktop'; }
function group(){ return albums[cur] || null; }
function albumById(id){ return all.filter(function(a){ return a.id === id; })[0] || null; }
/** 单曲组在列表里的下标（没有 -1） */
function singlesIdx(){ for (var k = 0; k < albums.length; k++) if (albums[k].singles) return k; return -1; }
/** 正在放 / 停着等放的那条记录（专辑，或单曲的那条记录） */
function shownRec(){
  if (P.state.i >= 0) return albumById(P.state.album);
  var g = group();
  if (!g) return null;
  return g.singles ? g.items[Math.min(pend, g.items.length - 1)] || null : g;
}
/** 正在放 / 停着等放的那一首 */
function shownTrack(){
  if (P.state.i >= 0) return P.state.list[P.state.i] || null;
  var g = group();
  return g ? g.tracks[Math.min(pend, g.tracks.length - 1)] || null : null;
}

/* ---------- 提示（登录过期 / 没权限 / 出错） ---------- */
/** kind：'expired' / 'locked'（带「登录」按钮）· 'noPermission' · 'failed' · ''（收起） */
function note(kind){
  var box = $('#mp-note'), sign = kind === 'expired' || kind === 'locked';
  box.classList.toggle('hidden', !kind);
  $('#mp-note-tx').textContent = kind ? tr(kind) : '';
  $('#mp-signin').classList.toggle('hidden', !sign);
  if (sign) { de.classList.add('mu-view-only'); P.reset(); }
}
$('#mp-signin').addEventListener('click', function(){ sudo(); });

/* ---------- 画：正在播（或停着等放的那首） ---------- */
function paintCover(box, a){
  var old = box.querySelector('img');
  var u = CORE.coverOf(a, arts);  /* 单曲没封面 → 歌手头像（M4） */
  if (old && old.getAttribute('src') === u) return;
  if (old) old.remove();
  if (u) { var img = doc.createElement('img'); img.alt = ''; img.decoding = 'async'; img.draggable = false; img.src = u; img.onerror = function(){ img.remove(); }; box.appendChild(img); }
}
/** 歌手名（M4）：对得上歌手表就是歌手页链接，点了交给主窗口（openLink） */
function artistHtml(a){
  var name = a && a.artist || '', id = a && a.artist_id;
  var ok = name && id > 0 && arts.some(function(r){ return r.id === id; });
  return ok ? '<a class="mu-artist-a" href="' + esc(CORE.artistHref(MUSIC, id)) + '" data-artist="' + id + '">' + esc(name) + '</a>' : esc(name);
}
function paintNow(){
  var a = shownRec(), t = shownTrack();
  var title = t ? String(t.title || '') : (a ? String(a.title || '') : tr('empty'));
  $('#mp-title').textContent = title;
  /* 副标题：歌手 · 专辑 · 年份；单曲不显示专辑名（Gray 2026-11-14 17:33） */
  var alb = a && !CORE.isSingle(a) ? String(a.title || '') : '';
  var yr = a && a.year ? String(a.year) : '';
  $('#mp-artist').innerHTML = artistHtml(a);
  $('#mp-album').textContent = alb;
  $('#mp-year').textContent = yr;
  $('#mp-album').classList.toggle('mp-sep', !!alb && !!(a && a.artist));
  $('#mp-year').classList.toggle('mp-sep', !!yr && !!((a && a.artist) || alb));
  $('#mp-lh-title').textContent = title;
  $('#mp-lh-artist').textContent = a && a.artist || '';
  $('#mp-lrc-file').textContent = tr('lrcFile', { t: title });
  paintCover($('#mp-cover'), a); paintCover($('#mp-lh-cover'), a); paintCover($('#mp-m-cover'), a);
  if (P.state.i < 0) { setLyrics(''); $('#mp-nolrc').classList.add('hidden'); doc.title = baseTitle; }
  if (moreSheet && moreSheet.isOpen()) renderMore();
  if (qSheet && qSheet.isOpen()) renderQueue();
}
/** 共用核开始放某一首：正在播、歌词、Media Session、标签页标题 */
function paintTrack(t, st){
  var a = albumById(st.album);
  note('');
  if (a) { var k = CORE.isSingle(a) ? singlesIdx() : albums.indexOf(a); if (k >= 0) cur = k; }
  paintNow();
  setLyrics(t.lrc);
  $('#mp-nolrc').classList.toggle('hidden', lyr.lines.length > 0);
  paintTime(0);
  $('#mp-dur').textContent = $('#mp-d-dur').textContent = CORE.durText(NaN, t.duration);  /* 元数据到之前先用已知时长 */
  doc.title = t.title + ' | ' + baseTitle;
  mediaMeta(t, a);
}
function syncState(){
  var on = P.playing();
  $$('[data-toggle]').forEach(function(b){
    b.classList.toggle('is-playing', on);
    b.setAttribute('aria-label', on ? b.dataset.lPause : b.dataset.lPlay);
  });
  var ms = G.navigator && G.navigator.mediaSession;
  if (ms) { try { ms.playbackState = P.state.i < 0 ? 'none' : on ? 'playing' : 'paused'; } catch (e) {} }
  var sh = P.state.shuffle, lbl = tr(sh ? 'modeShuffle' : 'modeSeq');
  $$('#mp-shuffle, #mp-q-mode').forEach(function(b){ b.setAttribute('aria-pressed', String(sh)); b.classList.toggle('is-shuffle', sh); });
  $('#mp-shuffle').title = lbl; $('#mp-shuffle').setAttribute('aria-label', lbl);
  $('#mp-q-mode-tx').textContent = lbl;
  if (qSheet && qSheet.isOpen()) renderQueue();
  tell();
}

/* ---------- 小遥控层（顶栏图标下，方案 v1.13 §九）：同源各页的遥控走 BroadcastChannel「sgx-music」 ----------
   遥控每页加载先问 player-hello，这边答 player-state；播放状态 / 曲目一变也广播；遥控发 remote-cmd（prev / toggle / next；音乐页发 play，第 3 步；
   打磨 6.4 音乐页迷你播放条的「队列」发 show）；关窗广播 player-bye。
   单开一个频道对象：共用核那个的 onmessage 管防同时响，两边互不干扰（同一页的两个频道对象也互相收得到，核只认 type=playing） */
var rc = null;
try { if (typeof G.BroadcastChannel === 'function') rc = new G.BroadcastChannel(CORE.CHANNEL); } catch (e) { rc = null; }
/* 打磨 6.3 交接握手：本窗口的 id；问的页带 req + from（那页的 window.sgxMusicPageId）时答 {…状态, id, req, mine}，
   mine = 开本窗口的那一页（opener）就是问的那页（它能 window.open('', 窗口名) 切过来；不是的话它发 player-focus 让这边自己 focus） */
var PID = Math.random().toString(36).slice(2) + Date.now().toString(36);
function tell(extra){
  if (!rc) return;
  var m = remoteState(P.state, P.playing(), all, arts);
  /* 每次都带 id 和 by（opener 那页的 id）：各页平时就知道有没有播放器、是不是自己开的，点播放不用再等回答 */
  m.id = PID; m.by = openerId();
  /* 打磨 6.4：进度（迷你播放条自己按 at 往前推，不用每秒广播） */
  m.t = audio.currentTime || 0; m.d = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (shownTrack() && shownTrack().duration) || 0; m.rate = audio.playbackRate || 1; m.at = Date.now();
  if (extra) for (var k in extra) m[k] = extra[k];
  try { rc.postMessage(m); } catch (e) {}
}
function openerId(){ try { var v = G.opener && !G.opener.closed ? G.opener.sgxMusicPageId : ''; return typeof v === 'string' ? v : ''; } catch (e) { return ''; } }
function openerIs(from){ return typeof from === 'string' && !!from && openerId() === from; }
if (rc) rc.onmessage = function(ev){
  var m = ev && ev.data;
  if (!m) return;
  if (m.type === 'player-hello') tell(typeof m.req === 'string' ? { id: PID, req: m.req, mine: openerIs(m.from) } : null);
  else if (m.type === 'player-focus') { if (m.to === PID) { try { G.focus(); } catch (e) {} } }
  else if (m.type === CORE.ARTIST_MSG.here && linkWait && m.req === linkWait.req && typeof m.from === 'string') linkWait.replies.push({ from: m.from, at: Number(m.at) || 0, music: m.music === true });
  else if (m.type === 'remote-cmd') {
    if (!cmdForMe(m, PID)) return;
    if (m.cmd === 'toggle') { if (viewOnly) { note('locked'); return; } toggle(); }
    else if (m.cmd === 'prev') P.prev();
    else if (m.cmd === 'next') P.next();
    else if (m.cmd === 'play') playCmd(m);
    else if (m.cmd === 'show' && m.what === 'queue') { openQueue(); try { G.focus(); } catch (e) {} }
  }
};
G.addEventListener('pagehide', function(){ if (rc) { try { rc.postMessage({ type: 'player-bye', id: PID }); } catch (e) {} } });
G.addEventListener('pageshow', function(e){ if (e && e.persisted) tell(); });

/* ---------- 歌手名 / ⋯ 的专辑、歌手、曲库 / 顶行「选歌」→ 主窗口（M4 歌手名那套，打磨 6.4 加 kind）：播放器不跳走 ---------- */
var linkWait = null;
/** @param {'artist'|'album'|'library'} kind @param {number} id @param {string} href */
function openLink(kind, id, href){
  var reqId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  linkWait = { req: reqId, replies: [] };
  if (rc) { try { rc.postMessage({ type: CORE.ARTIST_MSG.ask, req: reqId, id: id, kind: kind }); } catch (e) {} }
  G.setTimeout(function(){
    var w = linkWait; linkWait = null;
    var pick = w && CORE.pickMain(w.replies);
    if (pick && rc) { try { rc.postMessage({ type: CORE.ARTIST_MSG.go, req: reqId, to: pick.from, id: id, kind: kind, url: href }); return; } catch (e) {} }
    /* 没有主窗口答：开播放器的那一页还在就让它去；再不行开新标签页（还在这次点击的激活期里）；都不行报一句 */
    try { if (G.opener && !G.opener.closed) { G.opener.location.href = href; G.opener.focus(); return; } } catch (e) {}
    var nw = null;
    try { nw = G.open(href, '_blank'); } catch (e) { nw = null; }
    if (!nw) note('failed');
  }, CORE.ARTIST_WAIT_MS);
}
function plainClick(e){ return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey; }
$('#mp-artist').addEventListener('click', function(e){
  var a = e.target.closest && e.target.closest('a[data-artist]');
  if (!a || !plainClick(e)) return;
  e.preventDefault();
  openLink('artist', Number(a.getAttribute('data-artist')), a.getAttribute('href'));
});
$('#mp-pick').addEventListener('click', function(e){
  if (!plainClick(e)) return;
  e.preventDefault();
  openLink('library', 0, MUSIC);
});

/* ---------- 歌词：歌词页 / 桌面右栏滚动，当前句主色、离得远的淡；播放页一句 ---------- */
var lrcUserAt = 0;
function setLyrics(src){
  lyr.lines = CORE.parseLrc(src); lyr.line = -2;
  $('#mp-lyrics-in').innerHTML = lyr.lines.map(function(l, i){ return '<p data-l="' + i + '" data-d="' + lyricDist(i, -1) + '">' + esc(l.text || '♪') + '</p>'; }).join('');
  $('#mp-lyrics').scrollTop = 0;
  syncLyrics();
}
function syncLyrics(force){
  var line = $('#mp-line');
  if (!lyr.lines.length) { line.textContent = ''; line.classList.add('is-empty'); return; }
  var i = CORE.lrcIndex(lyr.lines, audio.currentTime);
  if (i === lyr.line && !force) return;
  lyr.line = i;
  line.classList.remove('is-empty');
  line.textContent = lyr.lines[Math.max(0, i)].text || '♪';
  var box = $('#mp-lyrics');
  box.querySelectorAll('[data-l]').forEach(function(p, k){ p.classList.toggle('on', k === i); p.setAttribute('data-d', String(lyricDist(k, i))); });
  if (Date.now() - lrcUserAt > 3000) scrollLyrics(!force);
}
function scrollLyrics(smooth){
  var box = $('#mp-lyrics'), p = box.querySelector('[data-l="' + Math.max(0, lyr.line) + '"]');
  if (!p || !box.clientHeight) return;
  var top = Math.max(0, p.offsetTop - box.clientHeight * 0.34);
  try { box.scrollTo({ top: top, behavior: smooth && !reduced() ? 'smooth' : 'auto' }); } catch (e) { box.scrollTop = top; }
}
function reduced(){ return de.classList.contains('reduced-motion') || !!(G.matchMedia && G.matchMedia('(prefers-reduced-motion: reduce)').matches); }
['wheel', 'touchstart'].forEach(function(n){ $('#mp-lyrics').addEventListener(n, function(){ lrcUserAt = Date.now(); }, { passive: true }); });
/* 点一句 = 跳到那里 */
$('#mp-lyrics').addEventListener('click', function(e){
  var p = e.target.closest('[data-l]');
  if (!p || P.state.i < 0) return;
  var l = lyr.lines[Number(p.getAttribute('data-l'))];
  if (!l) return;
  audio.currentTime = l.t; lrcUserAt = 0; syncLyrics(true);
});
$('#mp-line').addEventListener('click', function(){ goPage(1); });

/* ---------- 手机两页：左右滑 / 点页点（桌面两栏并排，不翻页） ---------- */
var app = $('#mp-app'), pager = $('#mp-pager'), page = 0;
function setP(p){ app.style.setProperty('--p', String(p)); }
function goPage(n){
  page = n ? 1 : 0;
  app.classList.remove('is-drag');
  setP(page);
  app.setAttribute('data-page', String(page));
  $$('#mp-dots [data-go]').forEach(function(b){ b.setAttribute('aria-selected', String(Number(b.dataset.go) === page)); });
  var desk = isDesk();
  $('#mp-pg-player').inert = !desk && page !== 0;
  $('#mp-pg-lyrics').inert = !desk && page !== 1;
  if (page === 1 || desk) G.requestAnimationFrame(function(){ scrollLyrics(false); });
}
$('#mp-dots').addEventListener('click', function(e){ var b = e.target.closest('[data-go]'); if (b) goPage(Number(b.dataset.go)); });
(function(){
  var x0 = null, y0 = 0, t0 = 0, lock = null, id = -1;
  pager.addEventListener('pointerdown', function(e){
    if (isDesk() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    /* 进度条 / 音量自己要横拖 */
    if (e.target.closest && e.target.closest('input[type="range"]')) return;
    x0 = e.clientX; y0 = e.clientY; t0 = Date.now(); lock = null; id = e.pointerId;
  });
  pager.addEventListener('pointermove', function(e){
    if (x0 === null || e.pointerId !== id) return;
    var dx = e.clientX - x0, dy = e.clientY - y0;
    if (lock === null && Math.sqrt(dx * dx + dy * dy) > 8) lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (lock !== 'x') return;
    if (!app.classList.contains('is-drag')) { try { pager.setPointerCapture(id); } catch (x) {} }
    app.classList.add('is-drag');
    setP(dragP(page, dx, pager.clientWidth));
  });
  function end(e){
    if (x0 === null || e.pointerId !== id) return;
    var dx = e.clientX - x0, was = lock;
    x0 = null; lock = null;
    if (was !== 'x') { app.classList.remove('is-drag'); return; }
    /* 拖过就不算点（别让松手那一下点到歌词 / 按钮） */
    var swallow = function(ev){ ev.stopPropagation(); ev.preventDefault(); };
    G.addEventListener('click', swallow, true);
    G.setTimeout(function(){ G.removeEventListener('click', swallow, true); }, 0);
    goPage(e.type === 'pointercancel' ? page : pageAfterDrag(page, dx, pager.clientWidth, Date.now() - t0));
  }
  pager.addEventListener('pointerup', end);
  pager.addEventListener('pointercancel', end);
})();

/* ---------- 布局：桌面 / 手机切换时倍速键挪位置、两页都可点；页面高度跟顶栏 / 页脚 ---------- */
function placeSpeed(){
  var sp = $('#mp-speed');
  if (isDesk()) { if (sp.parentNode !== $('#mp-util')) $('#mp-util').appendChild(sp); }
  else if (sp.parentNode !== $('#mp-top-r')) $('#mp-top-r').insertBefore(sp, $('#mp-more-btn'));
}
function measure(){
  var r = $('.mp-wrap').getBoundingClientRect(), top = Math.max(0, Math.round(r.top + (G.scrollY || 0)));
  de.style.setProperty('--mp-top', top + 'px');
  /* 桌面：播放器下面到页底还有多少（main 的下内边距 + 页脚），整块正好一屏 */
  var rest = Math.round(Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0) - (r.bottom + (G.scrollY || 0)));
  de.style.setProperty('--mp-foot', Math.max(0, Math.min(400, rest)) + 'px');
}
function relayout(){ placeSpeed(); measure(); goPage(isDesk() ? 0 : page); }
try { new MutationObserver(relayout).observe(de, { attributes: true, attributeFilter: ['data-sgx-layout'] }); } catch (e) {}
G.addEventListener('resize', measure);
relayout();

/* ---------- 队列 / ⋯：非模态悬浮卡片（同音乐上传窗 .sgx-qp + 共享 modalSheet；主站 quick-panel.js 挂的 window.SgxModalSheet） ---------- */
var qDlg = $('#mp-queue'), mDlg = $('#mp-more'), qSheet = null, moreSheet = null;
function makeSheet(dlg, btn, key, onOpen){
  if (G.SgxModalSheet) return G.SgxModalSheet(dlg, btn, { ms: 240, reducedMs: 120, stateKey: key, modal: false, onOpen: onOpen });
  /* 拿不到状态机（不该发生）：退回裸 show / close，Esc 自己接 */
  var o = { open: function(){ if (!dlg.open) { dlg.show(); dlg.classList.add('is-open'); btn.setAttribute('aria-expanded', 'true'); if (onOpen) onOpen(); } },
    close: function(after){ if (dlg.open) { dlg.classList.remove('is-open'); dlg.close(); btn.setAttribute('aria-expanded', 'false'); } if (after) after(); },
    isOpen: function(){ return dlg.open; }, isShown: function(){ return dlg.open; } };
  doc.addEventListener('keydown', function(e){ if (e.key === 'Escape' && dlg.open) o.close(); });
  return o;
}
function sheetOf(dlg){ return dlg === qDlg ? (qSheet = qSheet || makeSheet(qDlg, $('#mp-queue-btn'), 'sgxMpQueue', onQueueOpen)) : (moreSheet = moreSheet || makeSheet(mDlg, $('#mp-more-btn'), 'sgxMpMore', onMoreOpen)); }
function openQueue(){ if (moreSheet && moreSheet.isOpen()) moreSheet.close(function(){ G.setTimeout(openQueue, 0); }); else sheetOf(qDlg).open(); }
function openMore(){ if (qSheet && qSheet.isOpen()) qSheet.close(function(){ G.setTimeout(openMore, 0); }); else sheetOf(mDlg).open(); }
[qDlg, mDlg].forEach(function(d){ d.addEventListener('click', function(e){ if (e.target === d) sheetOf(d).close(); }); });
$('#mp-queue-btn').addEventListener('click', function(){ if (qSheet && qSheet.isShown()) qSheet.close(); else openQueue(); });
$('#mp-more-btn').addEventListener('click', function(){ if (moreSheet && moreSheet.isShown()) moreSheet.close(); else openMore(); });
$('#mp-q-x').addEventListener('click', function(){ sheetOf(qDlg).close(); });
$('#mp-m-x').addEventListener('click', function(){ sheetOf(mDlg).close(); });
/* 顶栏按钮：先关开着的卡片、等它的历史哨兵出栈，再把这次点击补给原按钮（同音乐页上传窗 / 顶栏窗口互斥） */
var nav = doc.getElementById('site-nav');
if (nav) nav.addEventListener('click', function(e){
  var sh = qSheet && qSheet.isOpen() ? qSheet : moreSheet && moreSheet.isOpen() ? moreSheet : null;
  var t = sh && e.target.closest && e.target.closest('button, a');
  if (!t) return;
  e.preventDefault(); e.stopPropagation();
  sh.close(function(){ G.setTimeout(function(){ t.click(); }, 0); });
}, true);
function onQueueOpen(){ renderQueue(); var on = qDlg.querySelector('.mp-q.on'); if (on) on.scrollIntoView({ block: 'center' }); }
function onMoreOpen(){
  renderMore();
  /* 桌面：⋯ 按钮下的小浮层（右缘对齐按钮）；手机居中卡片，不定位 */
  var sh = mDlg.querySelector('.sgx-qp-sheet');
  if (!isDesk()) { sh.style.top = sh.style.left = ''; return; }
  var b = $('#mp-more-btn').getBoundingClientRect(), d = mDlg.getBoundingClientRect(), w = sh.offsetWidth || 340;
  sh.style.top = Math.round(b.bottom - d.top + 6) + 'px';
  sh.style.left = Math.round(Math.max(8, Math.min(b.right + 8 - w, d.width - w - 8))) + 'px';
}
function renderQueue(){
  var q = queueOf(P.state, all, group()), total = 0;
  q.items.forEach(function(x){ total += x.dur; });
  $('#mp-q-n').textContent = String(q.items.length);
  var ref = q.ref ? tr('queueOf', { t: q.ref.title }) : tr('singles');
  $('#mp-q-sub').innerHTML = '<span class="mp-ps">$</span> queue · ' + esc(ref) + (total ? ' · ' + CORE.fmtTime(total) : '');
  $('#mp-q-list').innerHTML = q.items.map(function(x, k){
    var no = k < 9 ? '0' + (k + 1) : String(k + 1);
    return '<li><button type="button" class="mp-q' + (x.on ? ' on' : '') + '" data-q="' + k + '"' + (x.on ? ' aria-current="true"' : '') + '>'
      + '<span class="mp-qno">' + (x.on ? '<span class="mp-eq" aria-hidden="true"><i></i><i></i><i></i></span>' : no) + '</span>'
      + '<span class="mp-qtx"><b>' + esc(x.title) + '</b>' + (x.artist ? '<i>' + esc(x.artist) + '</i>' : '') + '</span>'
      + '<span class="mp-qd">' + (x.dur ? CORE.fmtTime(x.dur) : '') + '</span></button></li>';
  }).join('');
}
/* 点队列里的一首 = 在这一列里跳到那首（不换专辑、不是选歌） */
$('#mp-q-list').addEventListener('click', function(e){
  var b = e.target.closest('[data-q]'); if (!b) return;
  var k = Number(b.dataset.q);
  if (viewOnly) { note('locked'); return; }
  if (P.state.i >= 0 && P.state.queue) P.playQueue(P.state.queue.slice(), k);
  else if (P.state.i >= 0) P.playFrom(P.state.album, k);
  else { pend = k; playFrom(k); }
});
$('#mp-q-mode').addEventListener('click', function(){ setMode(!P.state.shuffle); });
function renderMore(){
  var a = shownRec(), t = shownTrack();
  $('#mp-m-title').textContent = t ? t.title : (a ? a.title : '');
  $('#mp-m-sub').textContent = [a && a.artist, a && !CORE.isSingle(a) ? a.title : '', a && a.year ? String(a.year) : ''].filter(Boolean).join(' · ');
  var ICON = {
    album: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/></svg>',
    artist: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.9-3.9 3.9-6 7.5-6s6.6 2.1 7.5 6"/></svg>',
    library: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/></svg>',
  };
  var CHEV = '<svg class="mp-mr-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>';
  $('#mp-m-list').innerHTML = moreRows(a, arts, MUSIC).map(function(r){
    var label = r.kind === 'album' ? esc(tr('moreAlbum')) + '<em>' + esc(r.name) + '</em>' : r.kind === 'artist' ? esc(tr('moreArtist')) + '<em>' + esc(r.name) + '</em>' : esc(tr('moreLibrary'));
    return '<li><a class="mp-mr" data-more="' + r.kind + '" data-id="' + r.id + '" href="' + esc(r.href) + '"><span class="mp-mr-ic">' + ICON[r.kind] + '</span>'
      + '<span class="mp-mr-tx"><b>' + label + '</b><i translate="no">' + esc(r.href) + '</i></span>' + CHEV + '</a></li>';
  }).join('');
}
$('#mp-m-list').addEventListener('click', function(e){
  var a = e.target.closest('a[data-more]');
  if (!a || !plainClick(e)) return;
  e.preventDefault();
  var kind = a.getAttribute('data-more'), id = Number(a.getAttribute('data-id')) || 0, href = a.getAttribute('href');
  /* 先在这次点击里问主窗口（退路要开新标签页，得在点击的激活期里），再收起卡片 */
  openLink(/** @type {any} */ (kind), id, href);
  sheetOf(mDlg).close();
});

/* ---------- 操作 ---------- */
function playFrom(i){
  var g = group();
  if (!g || !g.tracks.length) return;
  if (viewOnly) { note('locked'); return; }
  if (g.singles) { P.playQueue(g.items.map(function(x){ return x.id; }), i); return; }
  P.playFrom(g.id, i);
}
function toggle(){ if (!P.toggle()) playFrom(pend); }
/** 音乐页交过来的 remote-cmd play：逻辑在纯函数 playCmdWith（歌单里没有先重取一次，重取后还没有就不动） @param {any} m */
function playCmd(m){
  return playCmdWith(m, {
    viewOnly: viewOnly,
    groups: function(){ return albums; },
    has: function(id){ return !!albumById(id); },
    reload: reload,
    locked: function(){ note('locked'); },
    select: function(k){ cur = k; },
    playQueue: function(q, i){ P.playQueue(q, i); },
    playFrom: function(id, i){ P.playFrom(id, i); },
    focus: function(){ try { G.focus(); } catch (e) {} },
  }, false);
}
$$('[data-toggle]').forEach(function(b){ b.addEventListener('click', function(){
  if (viewOnly) { note('locked'); sudo(); return; }
  toggle();
}); });
$$('#mp-prev, #mp-d-prev').forEach(function(b){ b.addEventListener('click', function(){ P.prev(); }); });
$$('#mp-next, #mp-d-next').forEach(function(b){ b.addEventListener('click', function(){ P.next(); }); });
function setMode(on){ P.setShuffle(on); CORE.saveMode(store, on ? 'shuffle' : 'seq'); }
$('#mp-shuffle').addEventListener('click', function(){ setMode(!P.state.shuffle); });
$('#mp-speed').addEventListener('click', function(){
  speed = CORE.nextSpeed(speed, CORE.PLAYER_SPEEDS);
  P.setSpeed(speed);
  this.textContent = speed + '×'; this.setAttribute('aria-label', tr('speed', { s: speed }));
});
/* 音量 + 静音（本窗口；只在桌面布局显示） */
function syncVol(){
  var m = audio.muted || audio.volume === 0, b = $('#mp-mute'), v = $('#mp-volume');
  b.setAttribute('aria-pressed', String(m)); b.classList.toggle('is-muted', m); b.title = tr(m ? 'unmute' : 'mute');
  v.value = String(Math.round((audio.muted ? 0 : audio.volume) * 100));
  v.style.setProperty('--v', v.value + '%');
}
$('#mp-volume').addEventListener('input', function(){ audio.volume = Number(this.value) / 100; audio.muted = audio.volume === 0; syncVol(); });
$('#mp-mute').addEventListener('click', function(){ if (audio.muted || audio.volume === 0) { audio.muted = false; if (audio.volume === 0) audio.volume = 1; } else audio.muted = true; syncVol(); });
audio.addEventListener('volumechange', syncVol);
/* 进度 */
var seeking = false;
function paintTime(cur){
  var d = audio.duration, pct = isFinite(d) && d > 0 ? Math.min(100, cur / d * 100) : 0;
  $('#mp-time').textContent = $('#mp-d-time').textContent = CORE.fmtTime(cur);
  if (!seeking) $('#mp-seek').value = String(Math.round(pct * 10));
  $('#mp-seek').style.setProperty('--v', (seeking ? Number($('#mp-seek').value) / 10 : pct) + '%');
  $('#mp-d-bar').style.width = pct + '%';
}
$('#mp-seek').addEventListener('input', function(){ seeking = true; this.style.setProperty('--v', Number(this.value) / 10 + '%'); if (audio.duration) $('#mp-time').textContent = CORE.fmtTime(audio.duration * this.value / 1000); });
$('#mp-seek').addEventListener('change', function(){ seeking = false; if (audio.duration) audio.currentTime = audio.duration * this.value / 1000; });
audio.addEventListener('timeupdate', function(){
  if (!seeking && audio.duration) paintTime(audio.currentTime);
  syncLyrics();
  mediaPos();
});
audio.addEventListener('seeked', function(){ tell(); });
audio.addEventListener('ratechange', function(){ tell(); });
/** 总时长：元数据到了用真实 duration，没到 / 不可用用曲目已知时长（CORE.durText） */
function paintDur(){ var t = P.state.list[P.state.i]; $('#mp-dur').textContent = $('#mp-d-dur').textContent = CORE.durText(audio.duration, t && t.duration); }
audio.addEventListener('loadedmetadata', function(){ paintDur(); mediaPos(); tell(); });
audio.addEventListener('durationchange', paintDur);

/* ---------- Media Session（锁屏 / 耳机键） ---------- */
function mediaMeta(t, a){
  var ms = G.navigator && G.navigator.mediaSession;
  if (!ms || typeof G.MediaMetadata !== 'function') return;
  try { ms.metadata = new G.MediaMetadata({ title: t.title, artist: a && a.artist || '', album: a && !CORE.isSingle(a) ? a.title : '', artwork: artworkOf(a, arts) }); } catch (e) {}
}
function mediaPos(){
  var ms = G.navigator && G.navigator.mediaSession;
  if (!ms || !ms.setPositionState || !isFinite(audio.duration) || !audio.duration) return;
  try { ms.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, audio.duration) }); } catch (e) {}
}
(function(){
  var ms = G.navigator && G.navigator.mediaSession;
  if (!ms || !ms.setActionHandler) return;
  var on = function(name, fn){ try { ms.setActionHandler(name, fn); } catch (e) { /* 浏览器不认这个动作 */ } };
  on('play', function(){ if (P.state.i < 0) playFrom(pend); else if (audio.paused) P.toggle(); });
  on('pause', function(){ audio.pause(); });
  on('previoustrack', function(){ P.prev(); });
  on('nexttrack', function(){ P.next(); });
  on('seekto', function(d){ if (d && typeof d.seekTime === 'number' && audio.duration) { audio.currentTime = Math.min(d.seekTime, audio.duration); mediaPos(); } });
})();

/* ---------- 启动 ---------- */
P.setShuffle(CORE.readMode(store) === 'shuffle');
/* 别的窗口改了随机（同一个本地设置）：这边跟着变 */
G.addEventListener('storage', function(e){
  if (e && e.key !== CORE.MODE_KEY) return;
  var on = CORE.readMode(store) === 'shuffle';
  if (on !== P.state.shuffle) P.setShuffle(on);
});
syncVol();
function done(){ doc.querySelectorAll('.it-loading').forEach(function(el){ el.classList.add('hidden'); }); }
/** 换一份歌单（启动、remote-cmd play 找不到那张时重取）：停着的那组尽量留着 */
function setList(j){
  var keep = group();
  all = j.albums || [];
  arts = j.artists || [];
  albums = groupsOf(all, tr('singles'));
  if (keep) { for (var n = 0; n < albums.length; n++) if (albums[n].id === keep.id) { cur = n; break; } }
  if (cur >= albums.length) cur = 0;
}
function reload(){
  return req('GET', '/music/api/music').then(function(j){ setList(j); paintNow(); }, function(){});
}
req('GET', '/music/api/music').then(function(j){
  setList(j);
  done();
  if (!albums.length) { var em = $('#mp-empty'); em.textContent = tr('empty'); em.classList.remove('hidden'); return; }
  /* ?album=<id>&t=<i>（第 3 步）：停在那张；有 t 就从那首放（单曲：停在单曲组里它那一首） */
  var want = albumOf(G.location.search), go = startOf(albums, all, want, trackOf(G.location.search));
  cur = go.cur;
  pend = go.i >= 0 ? go.i : 0;
  if (go.i < 0 && albums[cur] && albums[cur].singles) { var si = albums[cur].items.map(function(r){ return r.id; }).indexOf(want); if (si >= 0) pend = si; }
  app.classList.remove('hidden');
  measure(); goPage(0);
  paintNow();
  if (viewOnly) note('locked');
  syncState();
  if (go.i >= 0 && !viewOnly) playFrom(go.i);
}).catch(function(){
  done();
  var p = doc.querySelector('.it-loading'); if (p) { p.textContent = tr('loadFail') || tr('failed'); p.classList.remove('hidden'); }
});
})();
