/* assets/common/js/music/music-player.js —— 弹出播放器页（/music/player/，中文 /music/zh/player/；音乐分层方案 v1.13 第二步 2b；浏览器 IIFE；node 测试时导出纯函数）。
 *
 * music 搬家第 3 步（搬家设计稿 v1.1 3.2 / 3.3，2026-11-21）：地址从 /curio/music/player/ 搬到 /music/player/，接口走 /music/api/*；
 * 音乐页不再出声，本页是唯一发声的页。这一步只加两样：认 ?t=<i>（开窗就从第 i 首放）、认 remote-cmd play（音乐页点播放交过来），其余不动。
 *
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
 *   （歌单里没有这张就重取一次歌单再找：音乐页刚传的新专辑）；切到前面靠音乐页那边同一次点击里的 window.open('', 窗口名)，这边能 focus 也 focus 一下。
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
 * 小遥控层要的「现在在播什么」（方案 v1.13 §三 / §九：顶栏图标下的遥控，BroadcastChannel「sgx-music」）。
 * on = 有一首在播或暂停着（没开播 / 放完停了是 false，遥控只显示入口）；title / artist 给遥控层画字。
 * @param {{ album: number, list: any[], i: number }} st 共用核的 state @param {boolean} playing @param {any[]} albums
 */
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
function remoteState(st, playing, albums){
  var t = st && st.i >= 0 ? st.list[st.i] : null;
  var a = null;
  for (var k = 0; albums && k < albums.length; k++) if (albums[k].id === st.album) { a = albums[k]; break; }
  return { type: 'player-state', on: !!t, playing: !!t && !!playing, title: t ? String(t.title || '') : '', artist: t ? String((a && a.artist) || '') : '' };
}

var pure = { albumOf: albumOf, trackOf: trackOf, startOf: startOf, failKind: failKind, artworkOf: artworkOf, remoteState: remoteState, groupsOf: groupsOf, musicPathOf: musicPathOf };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }
G.SgxMusicPlayer = pure;

var doc = G.document;
if (!doc.getElementById('mp-app')) return;
/* 叫顶栏终端进站（同 curio.js askSudo：只发 sgx:sudo）；第 7 步进 Platform 后不再借产品的 SgxCurioUI */
function sudo(){ try { doc.dispatchEvent(new CustomEvent('sgx:sudo')); } catch (e) {} }
var $ = function(s){ return doc.querySelector(s); };
var lang = doc.documentElement.lang || 'en';
var T = readDict(doc, 'curioPlayer'), tr = makeTr(T, lang);
var baseTitle = doc.title;
/* 2c 单窗口：本页的窗口名 = 顶栏入口找的那个（topbar/panel.js MUSIC_WIN）；被拦退路是本标签页直接跳过来的，离开时清掉名字，
   免得这个标签页走到别的页后还被当成播放器 */
var WIN = 'sgx-music-player';
try { G.name = WIN; } catch (e) {}
G.addEventListener('pageshow', function(){ try { G.name = WIN; } catch (e) {} });
G.addEventListener('pagehide', function(){ try { if (!G.opener) G.name = ''; } catch (e) {} });
var store = null;
try { store = G.localStorage; } catch (e) { store = null; }

/* all = 接口回的全部记录（专辑 + 单曲）；albums = 列表里的项（专辑 + 末尾的单曲组，groupsOf），cur 是它的下标 */
var all = [], albums = [], cur = 0, speed = 1, lyr = { lines: [], line: -2 };
/** 歌手表（M4，GET 回答的 artists） */
var arts = [];
var audio = $('#mp-audio');
var viewOnly = doc.documentElement.getAttribute('data-sgx-lock-session') === 'locked';
var P = CORE.createPlayer({
  audio: audio,
  sign: function(albumId){ return req('POST', '/music/api/music-play', { album: albumId }); },
  onTrack: paintTrack,
  onChange: syncState,
  onStop: function(){ $('#mp-now-k').classList.add('hidden'); renderTracks(); syncState(); },
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
function album(){ return albums[cur] || null; }
function albumById(id){ return all.filter(function(a){ return a.id === id; })[0] || null; }
/** 单曲组在列表里的下标（没有 -1） */
function singlesIdx(){ for (var k = 0; k < albums.length; k++) if (albums[k].singles) return k; return -1; }
/** 曲目表第 i 行是不是正在放的 */
function isOn(a, i){
  var st = P.state;
  if (st.i < 0) return false;
  return a.singles ? !!st.queue && st.album === a.items[i].id : !st.queue && st.album === a.id && st.i === i;
}
function coverUrl(a){ return '/music/api/music-cover?album=' + a.id; }
/** 歌手名（M4）：对得上歌手表就是歌手页链接，点了交给主窗口（openArtist） */
function paintArtist(a){
  var el = $('#mp-artist'), name = a && a.artist || '', id = a && a.artist_id;
  var ok = name && id > 0 && arts.some(function(r){ return r.id === id; });
  if (!ok) { el.textContent = name; return; }
  el.innerHTML = '<a class="mu-artist-a" href="' + esc(CORE.artistHref(musicPathOf(G.location.pathname), id)) + '" data-artist="' + id + '">' + esc(name) + '</a>';
}

/* ---------- 提示（登录过期 / 没权限 / 出错） ---------- */
/** kind：'expired' / 'locked'（带「登录」按钮）· 'noPermission' · 'failed' · ''（收起） */
function note(kind){
  var box = $('#mp-note'), sign = kind === 'expired' || kind === 'locked';
  box.classList.toggle('hidden', !kind);
  $('#mp-note-tx').textContent = kind ? tr(kind) : '';
  $('#mp-signin').classList.toggle('hidden', !sign);
  if (sign) { doc.documentElement.classList.add('mu-view-only'); P.reset(); }
}
$('#mp-signin').addEventListener('click', function(){ sudo(); });

/* ---------- 画 ---------- */
function renderAlbums(){
  $('#mp-albums').innerHTML = albums.map(function(a, i){
    return '<li><button type="button" class="mp-alb' + (i === cur ? ' on' : '') + '" data-a="' + i + '"' + (i === cur ? ' aria-current="true"' : '') + '>'
      + '<span class="mp-alb-im">' + (a.cover ? '<img src="' + coverUrl(a) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' : '') + '</span>'
      + '<span class="mp-alb-tx"><b>' + esc(a.title) + '</b><i>' + esc(a.singles ? tr('tracks', { n: a.tracks.length }) : a.artist || '') + '</i></span></button></li>';
  }).join('');
}
function renderTracks(){
  var a = album();
  $('#mp-tracks-sub').textContent = a ? ' · ' + a.title + ' · ' + tr('tracks', { n: a.tracks.length }) : '';
  $('#mp-tracks').innerHTML = a ? a.tracks.map(function(t, i){
    var on = isOn(a, i);
    return '<li><button type="button" class="mu-track' + (on ? ' on' : '') + '" data-t="' + i + '"' + (on ? ' aria-current="true"' : '') + '>'
      + '<span class="mu-track-no">' + (t.no || i + 1) + '</span><span class="mu-track-title">' + esc(t.title) + (a.singles && a.items[i].artist ? ' <span class="mp-h-sub">· ' + esc(a.items[i].artist) + '</span>' : '') + '</span>'
      + '<span class="mu-track-dur">' + (t.duration ? CORE.fmtTime(t.duration) : '') + '</span></button></li>';
  }).join('') : '';
  doc.querySelectorAll('.mp-alb').forEach(function(b, i){ b.classList.toggle('on', i === cur); if (i === cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
}
function paintCover(a){
  var box = $('#mp-cover'), old = box.querySelector('img');
  if (old) old.remove();
  var u = CORE.coverOf(a, arts);  /* 单曲没封面 → 歌手头像（M4） */
  if (u) { var img = doc.createElement('img'); img.alt = ''; img.decoding = 'async'; img.src = u; img.onerror = function(){ img.remove(); }; box.appendChild(img); }
}
/** 共用核开始放某一首：正在播、歌词、曲目高亮、Media Session、标签页标题 */
function paintTrack(t, st){
  var a = albumById(st.album);
  note('');
  $('#mp-now-k').classList.remove('hidden');
  $('#mp-title').textContent = t.title;
  paintArtist(a);
  /* 单曲：副标题只显示歌手，不显示专辑名（Gray 2026-11-14 17:33） */
  $('#mp-album').textContent = a && !CORE.isSingle(a) ? a.title : '';
  paintCover(a);
  setLyrics(t.lrc);
  $('#mp-time').textContent = CORE.fmtTime(0); $('#mp-seek').value = '0';
  $('#mp-dur').textContent = CORE.durText(NaN, t.duration);  /* 元数据到之前先用已知时长 */
  doc.title = t.title + ' | ' + baseTitle;
  if (a) { var k = CORE.isSingle(a) ? singlesIdx() : albums.indexOf(a); if (k >= 0 && k !== cur) { cur = k; } }
  renderTracks();
  mediaMeta(t, a);
}
function syncState(){
  var b = $('#mp-toggle'), on = P.playing();
  b.classList.toggle('is-playing', on);
  b.setAttribute('aria-label', on ? b.dataset.lPause : b.dataset.lPlay);
  var ms = G.navigator && G.navigator.mediaSession;
  if (ms) { try { ms.playbackState = P.state.i < 0 ? 'none' : on ? 'playing' : 'paused'; } catch (e) {} }
  var sh = $('#mp-shuffle'); sh.setAttribute('aria-pressed', String(P.state.shuffle)); sh.title = tr(P.state.shuffle ? 'shuffleOn' : 'shuffleOff');
  tell();
}

/* ---------- 小遥控层（顶栏图标下，方案 v1.13 §九）：同源各页的遥控走 BroadcastChannel「sgx-music」 ----------
   遥控每页加载先问 player-hello，这边答 player-state；播放状态 / 曲目一变也广播；遥控发 remote-cmd（prev / toggle / next；音乐页发 play，第 3 步）；关窗广播 player-bye。
   单开一个频道对象：共用核那个的 onmessage 管防同时响，两边互不干扰（同一页的两个频道对象也互相收得到，核只认 type=playing） */
var rc = null;
try { if (typeof G.BroadcastChannel === 'function') rc = new G.BroadcastChannel(CORE.CHANNEL); } catch (e) { rc = null; }
function tell(){ if (rc) { try { rc.postMessage(remoteState(P.state, P.playing(), all)); } catch (e) {} } }
if (rc) rc.onmessage = function(ev){
  var m = ev && ev.data;
  if (!m) return;
  if (m.type === 'player-hello') tell();
  else if (m.type === CORE.ARTIST_MSG.here && artistWait && m.req === artistWait.req && typeof m.from === 'string') artistWait.replies.push({ from: m.from, at: Number(m.at) || 0 });
  else if (m.type === 'remote-cmd') {
    if (m.cmd === 'toggle') { if (viewOnly) { note('locked'); return; } if (!P.toggle()) playFrom(0); }
    else if (m.cmd === 'prev') P.prev();
    else if (m.cmd === 'next') P.next();
    else if (m.cmd === 'play') playCmd(m);
  }
};
G.addEventListener('pagehide', function(){ if (rc) { try { rc.postMessage({ type: 'player-bye' }); } catch (e) {} } });

/* ---------- 歌手名 → 主窗口打开歌手页（M4，十二 M4 第 3 条）：播放器不跳走 ---------- */
var artistWait = null;
function openArtist(id, href){
  var reqId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  artistWait = { req: reqId, replies: [] };
  if (rc) { try { rc.postMessage({ type: CORE.ARTIST_MSG.ask, req: reqId, id: id }); } catch (e) {} }
  G.setTimeout(function(){
    var w = artistWait; artistWait = null;
    var pick = w && CORE.pickMain(w.replies);
    if (pick && rc) { try { rc.postMessage({ type: CORE.ARTIST_MSG.go, req: reqId, to: pick.from, id: id, url: href }); return; } catch (e) {} }
    /* 没有主窗口答：开播放器的那一页还在就让它去；再不行开新标签页（还在这次点击的激活期里）；都不行报一句 */
    try { if (G.opener && !G.opener.closed) { G.opener.location.href = href; G.opener.focus(); return; } } catch (e) {}
    var nw = null;
    try { nw = G.open(href, '_blank'); } catch (e) { nw = null; }
    if (!nw) note('failed');
  }, CORE.ARTIST_WAIT_MS);
}
$('#mp-artist').addEventListener('click', function(e){
  var a = e.target.closest && e.target.closest('a[data-artist]');
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  openArtist(Number(a.getAttribute('data-artist')), a.getAttribute('href'));
});
G.addEventListener('pageshow', function(e){ if (e && e.persisted) tell(); });

/* ---------- 歌词：当前一句；点一下展开全部，再点收起 ---------- */
function setLyrics(src){
  lyr.lines = CORE.parseLrc(src); lyr.line = -2;
  $('#mp-lyrics-in').innerHTML = lyr.lines.map(function(l, i){ return '<span data-l="' + i + '">' + esc(l.text || '♪') + '</span>'; }).join('');
  $('#mp-lyrics').classList.toggle('hidden', !lyr.lines.length);
  syncLyrics();
}
function syncLyrics(){
  if (!lyr.lines.length) return;
  var i = CORE.lrcIndex(lyr.lines, audio.currentTime);
  if (i === lyr.line) return;
  lyr.line = i;
  var box = $('#mp-lyrics');
  box.querySelectorAll('[data-l].on').forEach(function(p){ p.classList.remove('on'); });
  var p = box.querySelector('[data-l="' + Math.max(0, i) + '"]');
  if (p) { if (i >= 0) p.classList.add('on'); if (box.getAttribute('aria-expanded') === 'true') p.scrollIntoView({ block: 'nearest' }); }
}
$('#mp-lyrics').addEventListener('click', function(){
  var open = this.getAttribute('aria-expanded') !== 'true';
  this.setAttribute('aria-expanded', String(open));
  this.title = tr(open ? 'hideLyrics' : 'showLyrics');
  lyr.line = -2; syncLyrics();
});

/* ---------- 操作 ---------- */
function playFrom(i){
  var a = album();
  if (!a || !a.tracks.length) return;
  if (viewOnly) { note('locked'); return; }
  if (a.singles) { P.playQueue(a.items.map(function(x){ return x.id; }), i); return; }
  P.playFrom(a.id, i);
}
/**
 * 音乐页交过来的 remote-cmd play（第 3 步 3.3）：专辑 {album, i} 换到那张从第 i 首放；单曲 {queue:[记录 id…], i} 单曲组当前、按这一列放。
 * 歌单里没有这张（音乐页刚传的）就重取一次歌单再找，还没有就不动。能 focus 就把自己切到前面（多半要靠音乐页那边的 window.open 才切得过来）。
 * @param {{album?: number, queue?: number[], i?: number}} m @param {boolean} [again] 已经重取过一次
 */
function playCmd(m, again){
  if (viewOnly) { note('locked'); return; }
  var i = Number(m.i), k = -1;
  if (Array.isArray(m.queue)) {
    var q = m.queue.map(Number).filter(function(x){ return x > 0; });
    if (!(i >= 0 && i < q.length)) return;
    if (!q.every(function(id){ return !!albumById(id); })) { if (!again) reload().then(function(){ playCmd(m, true); }); return; }
    k = singlesIdx();
    if (k >= 0 && k !== cur) { cur = k; renderTracks(); }
    P.playQueue(q, i);
  } else {
    var id = Number(m.album);
    for (var n = 0; n < albums.length; n++) if (!albums[n].singles && albums[n].id === id) { k = n; break; }
    if (k < 0) { if (!again) reload().then(function(){ playCmd(m, true); }); return; }
    if (!(i >= 0 && i < albums[k].tracks.length)) return;
    if (k !== cur) { cur = k; renderTracks(); }
    P.playFrom(id, i);
  }
  try { G.focus(); } catch (e) {}
}
$('#mp-tracks').addEventListener('click', function(e){ var b = e.target.closest('[data-t]'); if (b) playFrom(Number(b.dataset.t)); });
$('#mp-toggle').addEventListener('click', function(){
  if (viewOnly) { note('locked'); sudo(); return; }
  if (!P.toggle()) playFrom(0);
});
$('#mp-prev').addEventListener('click', function(){ P.prev(); });
$('#mp-next').addEventListener('click', function(){ P.next(); });
$('#mp-shuffle').addEventListener('click', function(){
  var on = !P.state.shuffle;
  P.setShuffle(on);
  CORE.saveMode(store, on ? 'shuffle' : 'seq');
});
$('#mp-speed').addEventListener('click', function(){
  speed = CORE.nextSpeed(speed, CORE.PLAYER_SPEEDS);
  P.setSpeed(speed);
  this.textContent = speed + '×'; this.setAttribute('aria-label', tr('speed', { s: speed }));
});
/* 音量 + 静音（本窗口） */
function syncVol(){
  var m = audio.muted || audio.volume === 0, b = $('#mp-mute');
  b.setAttribute('aria-pressed', String(m)); b.classList.toggle('is-muted', m); b.title = tr(m ? 'unmute' : 'mute');
  $('#mp-volume').value = String(Math.round((audio.muted ? 0 : audio.volume) * 100));
}
$('#mp-volume').addEventListener('input', function(){ audio.volume = Number(this.value) / 100; audio.muted = audio.volume === 0; syncVol(); });
$('#mp-mute').addEventListener('click', function(){ if (audio.muted || audio.volume === 0) { audio.muted = false; if (audio.volume === 0) audio.volume = 1; } else audio.muted = true; syncVol(); });
audio.addEventListener('volumechange', syncVol);
/* 进度 */
var seeking = false;
$('#mp-seek').addEventListener('input', function(){ seeking = true; if (audio.duration) $('#mp-time').textContent = CORE.fmtTime(audio.duration * this.value / 1000); });
$('#mp-seek').addEventListener('change', function(){ seeking = false; if (audio.duration) audio.currentTime = audio.duration * this.value / 1000; });
audio.addEventListener('timeupdate', function(){
  if (!seeking && audio.duration) { $('#mp-seek').value = String(Math.round(audio.currentTime / audio.duration * 1000)); $('#mp-time').textContent = CORE.fmtTime(audio.currentTime); }
  syncLyrics();
  mediaPos();
});
/** 总时长：元数据到了用真实 duration，没到 / 不可用用曲目已知时长（CORE.durText） */
function paintDur(){ var t = P.state.list[P.state.i]; $('#mp-dur').textContent = CORE.durText(audio.duration, t && t.duration); }
audio.addEventListener('loadedmetadata', function(){ paintDur(); mediaPos(); });
audio.addEventListener('durationchange', paintDur);
/* 专辑列表：可收起；点一张换专辑（换列表，不自动开播） */
$('#mp-albums-btn').addEventListener('click', function(){
  var open = this.getAttribute('aria-expanded') !== 'true';
  this.setAttribute('aria-expanded', String(open));
  $('#mp-albums').classList.toggle('hidden', !open);
});
$('#mp-albums').addEventListener('click', function(e){
  var b = e.target.closest('[data-a]'); if (!b) return;
  cur = Number(b.dataset.a); renderTracks();
  if (P.state.i < 0) { var a = album(); $('#mp-title').textContent = a.title; paintArtist(a); $('#mp-album').textContent = ''; paintCover(a); }
});

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
  on('play', function(){ if (P.state.i < 0) playFrom(0); else if (audio.paused) P.toggle(); });
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
/** 换一份歌单（启动、remote-cmd play 找不到那张时重取）：当前那张尽量留着 */
function setList(j){
  var keep = album();
  all = j.albums || [];
  arts = j.artists || [];
  albums = groupsOf(all, tr('singles'));
  if (keep) { for (var n = 0; n < albums.length; n++) if (albums[n].id === keep.id) { cur = n; break; } }
  if (cur >= albums.length) cur = 0;
}
function reload(){
  return req('GET', '/music/api/music').then(function(j){ setList(j); renderAlbums(); renderTracks(); }, function(){});
}
req('GET', '/music/api/music').then(function(j){
  setList(j);
  done();
  if (!albums.length) { var em = $('#mp-empty'); em.textContent = tr('empty'); em.classList.remove('hidden'); return; }
  /* ?album=<id>&t=<i>（第 3 步）：停在那张；有 t 就从那首放 */
  var go = startOf(albums, all, albumOf(G.location.search), trackOf(G.location.search));
  cur = go.cur;
  $('#mp-app').classList.remove('hidden');
  renderAlbums(); renderTracks();
  var a = album(); $('#mp-title').textContent = a.title; paintArtist(a); paintCover(a);
  if (viewOnly) note('locked');
  syncState();
  if (go.i >= 0 && !viewOnly) playFrom(go.i);
}).catch(function(){
  done();
  var p = doc.querySelector('.it-loading'); if (p) { p.textContent = tr('loadFail') || tr('failed'); p.classList.remove('hidden'); }
});
})();
