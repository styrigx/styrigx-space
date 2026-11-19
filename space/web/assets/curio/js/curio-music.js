/* assets/js/curio-music.js —— 奇趣「音乐」私人子页（P4-3 奇趣拆页：/curio/music/；浏览器 IIFE；node 测试时导出纯函数）。
 *
 * 三层（v5 S3；接口档在 workers/atlas-core/src/curio/routes.js ROUTE_ACCESS）：
 *   - 看：GET /curio/api/music 谁都能调（只有专辑 / 曲目元数据，没有音频地址）；回 canWrite（账号 + curio.write）才显示上传 / 删除专辑。
 *   - 听：要进站。没进站（网关标记 <html data-sgx-lock-session="locked">，或签令牌回 401）= 只看模式（html.mu-view-only）：
 *     播放整张 / 播放键是锁，播放条显示当前专辑和「未进站，仅可浏览」，上一首 / 下一首 / 倍速 / 进度不可用；
 *     点播放、点曲目都发 sgx:sudo（经 curio.js SgxCurioUI.sudo；= common/js/auth/sudo.js SUDO_EVENT），顶栏终端预填 su 。
 *   - 写的接口 401 同样按没进站处理。
 * 播放器（交互借 jojo.best/music 的思路，只借交互）：
 *   - 封面横滑切专辑（scroll-snap，停下来的那张是当前专辑；点封面也能切），下面是这张的曲目（按曲序）。
 *   - 「播放整张」从第 1 首按曲序放到最后一首；点某一首从那首开始，放完接下一首。
 *   - 歌词：有 LRC 就在播放条里滚动，当前行高亮（parseLrc / lrcIndex）。
 *   - 倍速：0.75 → 1 → 1.25 → 1.5 → 2 → 0.75 循环（SPEEDS），换曲目也保持。
 *   - 随机播放（第二步 2b）：顺序 / 随机，模式记在 localStorage「sgx-music-mode」，和弹出播放器共用一个设置（方案 v1.13 §7.1）；
 *     另一个窗口改了（storage 事件）这边跟着变。随机的队列规则在共用核。
 * 播放短链：POST /curio/api/music-play {album} 签随机令牌（10 分钟），<audio src> = /curio/api/music-stream?t=…&id=…（Range 拖进度）。
 *   签令牌、续签、切曲、倍速、防同时响都在共用核 music-core.js（SgxMusicCore.createPlayer；弹出播放器同一份），本文件只画界面。
 * 上传：「上传专辑」→ album.add → 封面缩到长边 1600、webp → 音频按文件名排序逐个直传（曲序取文件名开头的数字，单个 ≤ 95 MB）→ .lrc 按文件名对上曲目写进去。
 * 单曲 / 专辑分类（音乐 v1.13 ②，Gray 2026-11-14 17:33 定）：
 *   - 列表每条带 kind；页面分段「专辑 · 单曲」（两边都有才显示分段，哪边为空只显示有的那边）。专辑 = 封面横滑照旧；
 *     单曲 = 列表（小封面 · 歌名 · 歌手 · 时长），点一行就播，单曲区当播放列表（共用核 playQueue：按需为下一首签令牌，顺序 / 随机、到尾停同专辑）。
 *   - 播放条副标题：单曲只显示歌手（共用核 nowSub）。
 *   - 上传窗顶部分段「专辑 | 单曲」：单曲 album.add kind=single，「专辑名」改「歌名」，音频 / 歌词单选，不显示曲序说明，曲名 = 歌名。
 * 确认框、提示条、弹层开关借 curio.js 的（window.SgxCurioUI）。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/* 播放用的纯函数（倍速、时间、歌词）在共用核 music-core.js，这里转出去（测试照旧从本文件取） */
var CORE = typeof module !== 'undefined' && module.exports ? require('../../common/js/music/music-core.js') : G.SgxMusicCore;
var SPEEDS = CORE.SPEEDS, nextSpeed = CORE.nextSpeed, fmtTime = CORE.fmtTime, parseLrc = CORE.parseLrc, lrcIndex = CORE.lrcIndex;
/** 单个音频上限（同 workers/atlas-core/src/curio/api/_music.js MUSIC_LIMITS.trackBytes） */
var TRACK_MAX = 95 * 1024 * 1024;
var EXT_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav', webm: 'audio/webm' };

/** 文件名 → 曲序和曲名：开头的数字是曲序（没有就用 fallback），去掉扩展名和「01 - 」这类前缀 */
function trackFromName(name, fallback){
  var base = String(name || '').replace(/\.[^./\\]+$/, '');
  var m = /^\s*(\d{1,3})(?:\s*[-._)\]]\s*|\s+)(\S.*)$/.exec(base);
  var no = m ? Number(m[1]) : fallback;
  var title = (m ? m[2] : base).trim();
  return { no: no, title: title };
}
/** 文件按名字自然排序（01 < 2 < 10） */
function sortByName(files){
  return Array.prototype.slice.call(files || []).sort(function(a, b){ return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }); });
}
/** 上传用的音频类型：文件自带的，没有就按扩展名猜；不认识返回 '' */
function audioType(file){
  var t = String(file && file.type || '').toLowerCase();
  if (/^audio\//.test(t)) return t === 'audio/x-m4a' ? 'audio/mp4' : t;
  var ext = (/\.([a-z0-9]+)$/i.exec(String(file && file.name || '')) || [])[1];
  return EXT_TYPES[String(ext || '').toLowerCase()] || '';
}
/** 歌词文件对上曲目：同名（去扩展名、去曲序前缀后比，忽略大小写） */
function lrcKey(name){ return trackFromName(name, 0).title.toLowerCase(); }
/** 歌单分两边：kind=single 的是单曲，其余（含旧数据没 kind 的）是专辑；各自保持原顺序 */
function splitKinds(list){
  var out = { albums: [], singles: [] };
  (list || []).forEach(function(a){ (CORE.isSingle(a) ? out.singles : out.albums).push(a); });
  return out;
}
/** 该显示哪一边：想要的那边有内容就是它，否则有内容的那边；两边都空 = 'album'（显示空提示） */
function pickSection(want, nAlbums, nSingles){
  if (want === 'single' ? nSingles : nAlbums) return want === 'single' ? 'single' : 'album';
  return nAlbums ? 'album' : nSingles ? 'single' : 'album';
}

/* ---------- 导入后编辑（M3，音乐 v1.18 十二 M3 / 7.4 / 7.6）的纯函数 ---------- */
/** 「所属专辑」下拉：只列 kind=album（单曲不列，后端也拒绝移到单曲，十二 M3 第 2 条），按名排序（自然序、不分大小写；同名按 id） */
function albumChoices(list, lang){
  return (list || []).filter(function(a){ return !CORE.isSingle(a); })
    .map(function(a){ return { id: a.id, title: String(a.title || '') }; })
    .sort(function(x, y){ return x.title.localeCompare(y.title, lang || undefined, { numeric: true, sensitivity: 'base' }) || x.id - y.id; });
}
/** 歌词有没有改：orig = 读出来的原文（null = 有歌词但没读出来 → 只有填了东西才算改）；没改返回 null */
function lrcChange(orig, val){
  val = String(val == null ? '' : val);
  if (orig == null) return val.trim() ? val : null;
  return val === orig ? null : val;
}
/**
 * 编辑表单 → 一个 track.edit 请求（所有改动一次发，后端一个 batch 提交）；什么都没改返回 null。
 * t = 表单打开时显示的值 {id, title, artist, year（单曲记录的年份）}；cur = {albumId, single}；
 * f = {title, artist, album: 下拉的值（'0' = 移出变单曲 / 专辑 id）, lrc: lrcChange 的结果, year: yearOf 的结果（单曲才有）}。
 * 下拉停在原处（单曲停在顶项、曲目停在本专辑）= 不移，不带 album_id（后端对「移到本来那张」回 400，十一 第 5 条）。
 * 单曲：改名后端连单曲记录名一起改；year 只在单曲没移走时带（后端写单曲记录，专辑曲目 / 移专辑时 400）。都在同一个请求、同一个 batch（Gray 审 1、3）。
 */
function trackEditBody(t, cur, f){
  var b = { op: 'track.edit', id: t.id };
  var title = String(f.title == null ? '' : f.title).trim(), artist = String(f.artist == null ? '' : f.artist).trim();
  if (title && title !== String(t.title || '')) b.title = title;
  if (artist !== String(t.artist || '').trim()) b.artist = artist;
  if (f.lrc != null) b.lrc = f.lrc;
  if (f.album !== '' && f.album != null) {
    var to = Number(f.album);
    if (!(cur.single ? to === 0 : to === cur.albumId)) b.album_id = to;
  }
  if (cur.single && b.album_id === undefined && f.year != null && f.year !== (Number(t.year) || 0)) b.year = f.year;
  return Object.keys(b).length > 2 ? b : null;
}
/** 年份栏：空 = 0（不填）；1900–2100 的整数；不合格 null */
function yearOf(v){
  v = String(v == null ? '' : v).trim();
  if (!v) return 0;
  var n = Number(v);
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
}
/**
 * 批量改（十二 M3 第 3 条）→ 每条一组请求（前端逐条发，没有后端批量接口）。
 * items = [{trackId, albumId（所在专辑 / 单曲记录 id）, name}]；f = {artist: ''（= 不改）, album: ''（不改）/ '0'（移出变单曲）/ 专辑 id, year: ''（不改）/ 数字}；
 * singles = 单曲区（年份只对单曲：album.edit 改单曲记录；单曲划进专辑时年份不发，记录会删）。没有要改的条目不出现。
 */
function batchRequests(items, f, singles){
  var artist = String(f.artist == null ? '' : f.artist).trim();
  var to = f.album === '' || f.album == null ? null : Number(f.album);
  var yr = singles && f.year !== '' && f.year != null ? Number(f.year) : null;
  var out = [];
  (items || []).forEach(function(it){
    var reqs = [], b = { op: 'track.edit', id: it.trackId };
    if (artist) b.artist = artist;
    if (to !== null && to !== it.albumId && !(singles && to === 0)) b.album_id = to;
    if (Object.keys(b).length > 2) reqs.push(b);
    if (yr !== null && b.album_id === undefined) reqs.push({ op: 'album.edit', id: it.albumId, year: yr });
    if (reqs.length) out.push({ name: it.name, reqs: reqs });
  });
  return out;
}

/* ---------- 文案表（语言包化第二部分 2026-11-07；curio / daymark 各脚本同一份小工具） ---------- */
/** 页面里 #sgx-i18n-<表> 的扁平字典；没有 / 坏了返回 {} */
function readDict(doc, table){
  try {
    var el = doc && doc.getElementById('sgx-i18n-' + table);
    var o = el && el.textContent ? JSON.parse(el.textContent) : null;
    return o && typeof o === 'object' ? o : {};
  } catch (e) { return {}; }
}
/**
 * 字典 → tr(键, 变量)：{名} 占位替换；变量里有数字 n 时先按 Intl.PluralRules(lang) 找「键_one」这类复数形式，没有就用键本身；缺键返回 ''。
 * 语言自己的规则（英文 1 link / 2 links，中文不分）都在字符串表里，脚本不分语言。
 */
function makeTr(dict, lang){
  /* 先拷一份原始文案：调用方会把带数字的键改挂成函数（例如数量键被改成按 n 取文案的函数），
     tr 若直接读同一个字典，拿到的就是那个函数而不是「{n} 条」 */
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

var pure = { readDict: readDict, makeTr: makeTr, SPEEDS: SPEEDS, TRACK_MAX: TRACK_MAX, nextSpeed: nextSpeed, fmtTime: fmtTime, parseLrc: parseLrc, lrcIndex: lrcIndex, trackFromName: trackFromName, sortByName: sortByName, audioType: audioType, lrcKey: lrcKey, splitKinds: splitKinds, pickSection: pickSection, albumChoices: albumChoices, lrcChange: lrcChange, trackEditBody: trackEditBody, yearOf: yearOf, batchRequests: batchRequests };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }
G.SgxCurioMusic = pure;

var doc = G.document;
if (!doc.getElementById('cu-pane-music')) return;
var UI = G.SgxCurioUI;
var $ = function(s){ return doc.querySelector(s); };
/* 界面文案（语言包化第二部分 2026-11-07）：页面里的 #sgx-i18n-curioMusic，模板从字符串表 data/curio/i18n/<语言>.yaml 的 js.curioMusic 输出，
   已经是「英文表 ← 页面语言表」的合并（缺键回退英文）；本文件不再认识任何语言。带数字的文案走 tr（复数按 Intl.PluralRules）。 */
var lang = doc.documentElement.lang || 'en';
var T = readDict(doc, 'curioMusic');
var tr = makeTr(T, lang);
T.tracks = function(n){ return tr('tracks', { n: n }); };
T.tooBig = function(name){ return tr('tooBig', { name: name }); };
T.badType = function(name){ return tr('badType', { name: name }); };
T.up = function(i, n, name){ return tr('up', { i: i, n: n, name: name }); };
T.partial = function(n){ return tr('partial', { n: n }); };
T.chosen = function(n){ return tr('chosen', { n: n }); };
T.speed = function(s){ return tr('speed', { s: s }); };
T.selN = function(n){ return tr('selN', { n: n }); };
T.batchFail = function(n){ return tr('batchFail', { n: n }); };
T.batchDone = function(n){ return tr('batchDone', { n: n }); };
/** 删除键图标（同 curio/icon.html trash） */
var TRASH = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>';
/** 「⋯」编辑键、多选勾（M3） */
var MORE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg>';
var CHECK = '<span class="mu-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>';
var NOTE = '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>';

/* all = 接口回的全部记录；albums = 其中的专辑（封面横滑，cur 是下标）；singles = 单曲（列表）；sec = 当前分段 'album' / 'single' */
var all = [], albums = [], singles = [], sec = 'album', cur = 0, coverVer = 0;
/* 多选（M3 批量改）：on = 在多选里；ids = 选中的曲目 id（专辑页）/ 单曲记录 id（单曲区） */
var sel = { on: false, ids: {} };
function selCount(){ return Object.keys(sel.ids).length; }
function selExit(){ sel.on = false; sel.ids = {}; }
/** 换一份歌单：分两边，分段落在有内容的那边（want 不给 = 留在当前分段） */
function setData(list, want){
  all = list || [];
  var k = splitKinds(all);
  albums = k.albums; singles = k.singles;
  cur = Math.min(cur, Math.max(0, albums.length - 1));
  sec = pickSection(want || sec, albums.length, singles.length);
}
var audio = $('#mu-audio');
/** 歌词（画在播放条里）；声音和令牌在共用核 P 里 */
var lyr = { lines: [], line: -2 };
var speed = 1;
/* 共用核：签令牌走本页 req（401 = 只看模式），换曲 / 播停时这边只管画 */
var P = CORE.createPlayer({
  audio: audio,
  sign: function(albumId){ return req('POST', '/curio/api/music-play', { album: albumId }); },
  onTrack: paintTrack,
  onChange: syncToggle,
  onStop: function(){ renderAlbum(); syncToggle(); },
  /* 点播失败报一句（没进站已切只看模式，不再报）；切曲 / 续签失败照旧不吭声 */
  onError: function(e, where){ if (where === 'play' && !(e && e.sgxLocked)) toast(failMsg(e)); },
});

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function toast(m){ if (UI) UI.toast(m); }
/** 只看模式：没进站（网关标记；签令牌 401 时改成 true） */
var viewOnly = doc.documentElement.getAttribute('data-sgx-lock-session') === 'locked';
/** 写的权限（GET /api/music 回的 canWrite：账号 + curio.write） */
var canWrite = false;
/** 请人进站：顶栏终端预填 su （curio.js SgxCurioUI.sudo → sgx:sudo，topbar/panel.js 接） */
function askSudo(){ if (UI && UI.sudo) UI.sudo(); }
/** 本页接口：401 = 没进站（切到只看模式 + 请人进站，抛 sgxLocked，调用方不再报错）；其它错误带 code 抛出 */
function req(method, url, body, type, ticket){
  var h = body === undefined ? {} : { 'Content-Type': type || 'application/json' };
  if (ticket) h['X-Sgx-Sudo'] = ticket; /* D-3 a′：album.del 的一次性票（curio.js SgxCurioUI.sudoTicket） */
  return fetch(url, {
    method: method, credentials: 'same-origin', cache: 'no-store',
    headers: h,
    body: body === undefined ? undefined : type ? body : JSON.stringify(body),
  }).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(j){
      if (r.status === 401) { setViewOnly(true); askSudo(); throw Object.assign(new Error('locked'), { sgxLocked: true }); }
      if (!r.ok || !j.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { code: j.error, status: r.status });
      return j;
    });
  });
}
/** 失败提示：403 forbidden（2b：v6 身份不在 listen / curio-write，或 album.del 不是 root）说没权限，其余「出了点问题」 */
function failMsg(e){ return e && e.code === 'forbidden' && T.noPermission ? T.noPermission : T.failed; }
function album(){ return albums[cur] || null; }
/** 删专辑 / 单曲（album.del = root 档，D-3 a′）：先拿票再发；sudo 行带专辑 id */
function delAlbum(id){
  var get = UI && UI.sudoTicket ? UI.sudoTicket('sudo curio music rm ' + id, { method: 'POST', path: '/curio/api/music', action: 'album.del' }) : Promise.resolve('');
  return get.then(function(t){ return req('POST', '/curio/api/music', { op: 'album.del', id: id }, undefined, t); });
}
function coverUrl(a){ return '/curio/api/music-cover?album=' + a.id + (coverVer ? '&v=' + coverVer : ''); }

/* ---------- 画 ---------- */
/** 分段：两边都有才显示 */
function renderSeg(){
  $('#mu-seg').classList.toggle('hidden', !(albums.length && singles.length));
  doc.querySelectorAll('#mu-seg [data-sec]').forEach(function(b){ b.setAttribute('aria-selected', String(b.dataset.sec === sec)); });
}
/** 单曲列表：小封面 · 歌名 · 歌手 · 时长；正在放的高亮 */
function renderSingles(){
  var box = $('#mu-singles');
  box.classList.toggle('hidden', sec !== 'single' || !singles.length);
  if (sec !== 'single') { box.innerHTML = ''; return; }
  box.innerHTML = singles.map(function(a, i){
    var t = a.tracks[0], on = !!P.state.queue && P.state.i >= 0 && P.state.album === a.id;
    var picked = sel.on && !!sel.ids[a.id];
    return '<li' + (canWrite ? ' class="mu-single-row"' : '') + '><button type="button" class="mu-single' + (on ? ' on' : '') + '" data-s="' + i + '"' + (on ? ' aria-current="true"' : '') + (sel.on ? ' aria-pressed="' + picked + '"' : '') + (t ? '' : ' disabled') + '>'
      + (sel.on ? CHECK : '')
      + '<span class="mu-single-im" aria-hidden="true">' + (a.cover ? '<img src="' + coverUrl(a) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' : '') + '<span class="mu-cover-ph">' + NOTE + '</span></span>'
      + '<span class="mu-single-tx"><b>' + esc(a.title) + '</b><i>' + esc(a.artist || '') + '</i></span>'
      + '<span class="mu-track-dur">' + (t && t.duration ? fmtTime(t.duration) : '') + '</span></button>'
      /* 「⋯」编辑（M3：歌名、歌手、歌词、所属专辑、封面）；多选时不画 */
      + (canWrite && t && !sel.on ? '<button type="button" class="mu-more" data-ed="' + i + '" aria-label="' + esc(tr('editBtn', { name: a.title })) + '" title="' + esc(tr('editBtn', { name: a.title })) + '">' + MORE + '</button>' : '')
      /* 删除单曲（同「删除专辑」权限：接口回 canWrite 才画；点了先弹确认） */
      + (canWrite && !sel.on ? '<button type="button" class="mu-single-del" data-del="' + a.id + '" aria-label="' + esc(tr('delSingleBtn', { name: a.title })) + '" title="' + esc(tr('delSingleBtn', { name: a.title })) + '">' + TRASH + '</button>' : '')
      + '</li>';
  }).join('');
}
function renderCovers(){
  $('#mu-covers').innerHTML = albums.map(function(a, i){
    return '<button type="button" role="listitem" class="mu-cover' + (i === cur ? ' on' : '') + '" data-i="' + i + '" aria-label="' + esc(a.title) + '">'
      + (a.cover ? '<img src="' + coverUrl(a) + '" alt="" decoding="async" onerror="this.remove()">' : '') + '<span class="mu-cover-ph">' + NOTE + '</span></button>';
  }).join('');
  $('#mu-dots').innerHTML = albums.length > 1 ? albums.map(function(_, i){ return '<i' + (i === cur ? ' class="on"' : '') + '></i>'; }).join('') : '';
}
function renderAlbum(){
  var a = album(), inAlb = sec === 'album';
  $('#mu-empty').classList.toggle('hidden', all.length > 0);
  ['#mu-covers', '#mu-dots'].forEach(function(s){ $(s).classList.toggle('hidden', !albums.length || !inAlb); });
  doc.querySelector('.mu-head').classList.toggle('hidden', !a || !inAlb);
  doc.querySelector('.mu-album-acts').classList.toggle('hidden', !a || !canWrite || !inAlb);
  $('#mu-album-edit').classList.toggle('hidden', !a || !canWrite || !inAlb);
  renderSelBar(a, inAlb);
  $('#mu-tracks').innerHTML = '';
  renderSeg(); renderSingles();
  if (viewOnly) paintViewOnly(inAlb ? a : singles[0] || null);
  if (!a || !inAlb) return;
  $('#mu-album-title').textContent = a.title;
  $('#mu-album-sub').textContent = [a.artist, a.year ? String(a.year) : '', T.tracks(a.tracks.length)].filter(Boolean).join(' · ');
  $('#mu-play-all').disabled = !a.tracks.length;
  $('#mu-tracks').innerHTML = a.tracks.map(function(t, i){
    var on = P.state.album === a.id && P.state.i === i, picked = sel.on && !!sel.ids[t.id];
    return '<li' + (canWrite ? ' class="mu-track-row"' : '') + '><button type="button" class="mu-track' + (on ? ' on' : '') + '" data-t="' + i + '"' + (on ? ' aria-current="true"' : '') + (sel.on ? ' aria-pressed="' + picked + '"' : '') + '>'
      + (sel.on ? CHECK : '<span class="mu-track-no">' + (t.no || i + 1) + '</span>') + '<span class="mu-track-title">' + esc(t.title) + '</span>'
      + '<span class="mu-track-dur">' + (t.duration ? fmtTime(t.duration) : '') + '</span></button>'
      /* 「⋯」编辑（M3：歌名、歌手、歌词、所属专辑；专辑里的曲目不设封面，7.6）；多选时不画 */
      + (canWrite && !sel.on ? '<button type="button" class="mu-more" data-ed="' + i + '" aria-label="' + esc(tr('editBtn', { name: t.title })) + '" title="' + esc(tr('editBtn', { name: t.title })) + '">' + MORE + '</button>' : '')
      + '</li>';
  }).join('');
  doc.querySelectorAll('#mu-dots i').forEach(function(d, i){ d.classList.toggle('on', i === cur); });
  doc.querySelectorAll('.mu-cover').forEach(function(c, i){ c.classList.toggle('on', i === cur); });
}
function select(i, scroll){
  if (i < 0 || i >= albums.length) return;
  if (i !== cur) selExit();
  cur = i;
  renderAlbum();
  if (scroll) { var c = doc.querySelector('.mu-cover[data-i="' + i + '"]'); if (c) c.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); }
}
/* 分段切换：专辑 ↔ 单曲（只换显示，不打断正在放的） */
$('#mu-seg').addEventListener('click', function(e){
  var b = e.target.closest('[data-sec]');
  if (!b || b.dataset.sec === sec) return;
  sec = pickSection(b.dataset.sec, albums.length, singles.length);
  selExit();
  renderAlbum();
  if (sec === 'album') { var c = doc.querySelector('.mu-cover[data-i="' + cur + '"]'); if (c) c.scrollIntoView({ inline: 'center', block: 'nearest' }); }
});
/* 单曲：点一行从这首开始，单曲区当播放列表 */
$('#mu-singles').addEventListener('click', function(e){
  var d = e.target.closest('[data-del]');
  if (d) return askDelSingle(Number(d.dataset.del));
  var m = e.target.closest('[data-ed]');
  if (m) { var sa = singles[Number(m.dataset.ed)]; return sa && sa.tracks[0] && openTrackEdit(sa, sa.tracks[0]); }
  var b = e.target.closest('[data-s]');
  if (!b) return;
  if (sel.on) { var s1 = singles[Number(b.dataset.s)]; return s1 && selToggle(s1.id); }
  if (viewOnly) return askSudo();
  playSingles(Number(b.dataset.s));
});
/* 封面横滑：停下来以后离中线最近的那张是当前专辑 */
(function(){
  var box = $('#mu-covers'), t = 0;
  box.addEventListener('scroll', function(){
    clearTimeout(t);
    t = setTimeout(function(){
      var mid = box.scrollLeft + box.clientWidth / 2, best = cur, d = Infinity;
      box.querySelectorAll('.mu-cover').forEach(function(c, i){ var x = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (x < d) { d = x; best = i; } });
      if (best !== cur) select(best, false);
    }, 90);
  }, { passive: true });
  box.addEventListener('click', function(e){ var b = e.target.closest('.mu-cover'); if (b) select(Number(b.dataset.i), true); });
})();

/* ---------- 只看模式（没进站） ---------- */
/** 播放条停在当前专辑：标题 / 「艺术家 · 未进站，仅可浏览」，时间 --:-- @param {any} a */
function paintViewOnly(a){
  var pl = $('#mu-player');
  pl.classList.toggle('hidden', !a);
  if (!a) return;
  $('#mu-now-title').textContent = a.title;
  $('#mu-now-sub').textContent = [a.artist, T.viewOnly].filter(Boolean).join(' · ');  /* 专辑 / 单曲一样：歌手 · 未进站 */
  $('#mu-time').textContent = '--:--'; $('#mu-dur').textContent = '--:--';
  $('#mu-seek').value = '0';
}
/** 切到 / 离开只看模式（离开只在本页不会发生：进站后页面重新取） @param {boolean} v */
function setViewOnly(v){
  viewOnly = v;
  doc.documentElement.classList.toggle('mu-view-only', v);
  ['#mu-prev', '#mu-next', '#mu-speed', '#mu-seek', '#mu-shuffle'].forEach(function(s){ $(s).disabled = v; });
  ['#mu-play-all', '#mu-toggle'].forEach(function(s){
    var b = $(s);
    if (v) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-label', T.locked); }
    else b.removeAttribute('aria-disabled');
  });
  if (v) { P.reset(); doc.documentElement.classList.remove('mu-playing'); }
  renderAlbum();
}

/* ---------- 播放（声音、令牌、切曲在共用核 music-core.js；这里只画） ---------- */
function setLyrics(src){
  lyr.lines = parseLrc(src); lyr.line = -2;
  $('#mu-lyrics-in').innerHTML = lyr.lines.map(function(l, i){ return '<p data-l="' + i + '">' + esc(l.text || '♪') + '</p>'; }).join('');
  $('#mu-lyrics').classList.toggle('hidden', !lyr.lines.length);
}
function syncLyrics(){
  if (!lyr.lines.length) return;
  var i = lrcIndex(lyr.lines, audio.currentTime);
  if (i === lyr.line) return;
  lyr.line = i;
  var box = $('#mu-lyrics'), inner = $('#mu-lyrics-in');
  inner.querySelectorAll('p.on').forEach(function(p){ p.classList.remove('on'); });
  var p = i >= 0 ? inner.querySelector('[data-l="' + i + '"]') : null;
  if (p) { p.classList.add('on'); inner.style.transform = 'translateY(' + Math.round(box.clientHeight / 2 - p.offsetTop - p.offsetHeight / 2) + 'px)'; }
  else inner.style.transform = 'translateY(' + Math.round(box.clientHeight / 2 - 12) + 'px)';
}
/** 共用核开始放某一首：播放条标题、歌词、曲目高亮 */
function paintTrack(t, st){
  var a = all.filter(function(x){ return x.id === st.album; })[0];
  $('#mu-now-title').textContent = t.title;
  $('#mu-now-sub').textContent = CORE.nowSub(a);  /* 单曲只显示歌手 */
  $('#mu-time').textContent = fmtTime(0); $('#mu-seek').value = '0';
  $('#mu-dur').textContent = CORE.durText(NaN, t.duration);  /* 元数据到之前先用已知时长 */
  setLyrics(t.lrc);
  $('#mu-player').classList.remove('hidden');
  doc.documentElement.classList.add('mu-playing');
  renderAlbum();
}
function playFrom(a, i){ return P.playFrom(a.id, i); }
/** 单曲区当播放列表：从第 i 首开始（没有音频的单曲不进列表） */
function playSingles(i){
  var list = singles.filter(function(a){ return a.tracks.length; }), pick = singles[i];
  var k = list.indexOf(pick);
  if (k < 0) return;
  return P.playQueue(list.map(function(a){ return a.id; }), k);
}
function syncToggle(){
  var b = $('#mu-toggle'), on = P.playing();
  b.classList.toggle('is-playing', on);
  b.setAttribute('aria-label', on ? b.dataset.lPause : b.dataset.lPlay);
}
$('#mu-play-all').addEventListener('click', function(){ if (viewOnly) return askSudo(); var a = album(); if (a && a.tracks.length) playFrom(a, 0); });
$('#mu-tracks').addEventListener('click', function(e){
  var a = album(); if (!a) return;
  var m = e.target.closest('[data-ed]');
  if (m) { var t = a.tracks[Number(m.dataset.ed)]; return t && openTrackEdit(a, t); }
  var b = e.target.closest('[data-t]'); if (!b) return;
  if (sel.on) { var t1 = a.tracks[Number(b.dataset.t)]; return t1 && selToggle(t1.id); }
  if (viewOnly) return askSudo();
  playFrom(a, Number(b.dataset.t));
});
$('#mu-toggle').addEventListener('click', function(){
  if (viewOnly) return askSudo();
  if (!P.toggle()) {
    if (sec === 'single') return playSingles(0);
    var a = album(); if (a && a.tracks.length) playFrom(a, 0);
  }
});
/* 随机播放：和弹出播放器共用本地设置（sgx-music-mode） */
var modeStore = null;
try { modeStore = G.localStorage; } catch (e) { modeStore = null; }
function syncShuffle(){
  var b = $('#mu-shuffle'), on = P.state.shuffle;
  b.setAttribute('aria-pressed', String(on)); b.title = on ? T.shuffleOn : T.shuffleOff;
}
function applyMode(){ var on = CORE.readMode(modeStore) === 'shuffle'; if (on !== P.state.shuffle) P.setShuffle(on); syncShuffle(); }
$('#mu-shuffle').addEventListener('click', function(){
  if (viewOnly) return askSudo();
  P.setShuffle(!P.state.shuffle); CORE.saveMode(modeStore, P.state.shuffle ? 'shuffle' : 'seq'); syncShuffle();
});
G.addEventListener('storage', function(e){ if (!e || e.key === CORE.MODE_KEY) applyMode(); });
applyMode();
$('#mu-prev').addEventListener('click', function(){ P.prev(); });
$('#mu-next').addEventListener('click', function(){ P.next(); });
$('#mu-speed').addEventListener('click', function(){
  speed = nextSpeed(speed);
  P.setSpeed(speed);
  var b = $('#mu-speed'); b.textContent = speed + '×'; b.setAttribute('aria-label', T.speed(speed));
});
var seeking = false;
$('#mu-seek').addEventListener('input', function(){ seeking = true; if (audio.duration) $('#mu-time').textContent = fmtTime(audio.duration * this.value / 1000); });
$('#mu-seek').addEventListener('change', function(){ seeking = false; if (audio.duration) audio.currentTime = audio.duration * this.value / 1000; });
audio.addEventListener('timeupdate', function(){
  if (!seeking && audio.duration) { $('#mu-seek').value = String(Math.round(audio.currentTime / audio.duration * 1000)); $('#mu-time').textContent = fmtTime(audio.currentTime); }
  syncLyrics();
});
/** 总时长：元数据到了用真实 duration，没到 / 不可用用曲目已知时长（CORE.durText） */
function paintDur(){ var t = P.state.list[P.state.i]; $('#mu-dur').textContent = CORE.durText(audio.duration, t && t.duration); }
audio.addEventListener('loadedmetadata', paintDur);
audio.addEventListener('durationchange', paintDur);

/* ---------- 删除专辑 ---------- */
$('#mu-album-del').addEventListener('click', function(){
  var a = album();
  if (!a || !UI) return;
  UI.ask(T.delAlbum, T.del, function(){
    delAlbum(a.id).then(function(j){
      if (P.state.album === a.id) { P.reset(); lyr = { lines: [], line: -2 }; $('#mu-player').classList.add('hidden'); doc.documentElement.classList.remove('mu-playing'); }
      setData(j.albums); renderCovers(); renderAlbum(); toast(T.deleted);
    }).catch(function(e){ if (!e.sgxLocked) toast(failMsg(e)); });
  });
});

/* ---------- 删除单曲（v1.13 ②，Gray 2026-11-14 18:40）：每行一个删除键，先弹确认（悬浮卡片 <dialog class="sgx-qp sgx-up mu-del">，同上传窗，不从底部升起），
   确认后复用 album.del（单曲 = kind=single 的专辑记录，连音频 / 封面一起删）；回来的歌单重画，单曲区空了按 pickSection 回到专辑、分段随之隐藏 ---------- */
var delDlg = $('#mu-del-wrap'), delId = 0;
/* M3：同一张确认卡片也给「删曲目」用（十二 M3 第 4 条）：delOp = {title, msg, run() → Promise<歌单>, stops() → 删的是不是正在放的}；删单曲（album.del）照旧 */
var delOp = null;
var delSheet = G.SgxModalSheet ? G.SgxModalSheet(delDlg, doc.createElement('span') /* 共享状态机要一个同步 aria-expanded 的按钮；删除键是每行画的，给个占位 */, { ms: 240, reducedMs: 120, stateKey: 'sgxMuDel', modal: false, onOpen: function(){ upLock(true); }, onClosed: function(){ upLock(false); delId = 0; delOp = null; } })
  : { open: function(){ if (!delDlg.open) { delDlg.show(); delDlg.classList.add('is-open'); upLock(true); } }, close: function(){ if (delDlg.open) { delDlg.classList.remove('is-open'); delDlg.close(); } upLock(false); delId = 0; delOp = null; } };
/** 弹确认：id = 单曲记录 id。删的是它那一首（track.del，curio-write 档，十二 M3 第 4 条；Gray 审 2）：后端连空单曲记录和封面一起删。
 *  没有曲目的单曲记录（旧数据）没有 track.del 可发，才退回 album.del（root + 票） */
function askDelSingle(id){
  var a = singles.filter(function(x){ return x.id === id; })[0];
  if (!a || !canWrite) return;
  delId = id;
  var t = a.tracks[0];
  askDel({ title: T.delSingleTitle, msg: tr('delSingle', { name: a.title }),
    run: function(){ return t ? req('POST', '/curio/api/music', { op: 'track.del', id: t.id }) : delAlbum(id); },
    stops: function(){ return P.state.album === id; } });
}
/** 弹确认卡片（删单曲 / 删曲目共用） */
function askDel(o){
  delOp = o;
  $('#mu-del-title').textContent = o.title;
  $('#mu-del-msg').textContent = o.msg;
  $('#mu-del-ok').disabled = false;
  delSheet.open();
  try { $('#mu-del-cancel').focus(); } catch (e) {}
}
delDlg.addEventListener('click', function(e){ if (e.target === delDlg) delSheet.close(); });
$('#mu-del-x').addEventListener('click', function(){ delSheet.close(); });
$('#mu-del-cancel').addEventListener('click', function(){ delSheet.close(); });
$('#mu-del-ok').addEventListener('click', function(){
  var o = delOp, ok = this;
  if (!o) return delSheet.close();
  ok.disabled = true;
  o.run().then(function(j){
    if (o.stops()) {  /* 正在放这首：停下、收起播放条（同删专辑） */
      P.reset(); lyr = { lines: [], line: -2 }; $('#mu-player').classList.add('hidden'); doc.documentElement.classList.remove('mu-playing'); }
    delSheet.close();
    setData(j.albums); renderCovers(); renderAlbum(); toast(T.deleted);
  }).catch(function(e){ ok.disabled = false; delSheet.close(); if (!e.sgxLocked) toast(failMsg(e)); });
});

/* ---------- 上传 ---------- */
var upFiles = { audio: [], cover: null, lrc: [] };
/** 上传窗分段：'album' 专辑（默认）/ 'single' 单曲 */
var upKind = 'album';
function setUpKind(k){
  upKind = k === 'single' ? 'single' : 'album';
  var one = upKind === 'single';
  doc.querySelectorAll('#mu-up-kind [data-kind]').forEach(function(b){ b.setAttribute('aria-selected', String(b.dataset.kind === upKind)); });
  $('#mu-up-title').textContent = one ? T.uploadSingle : T.uploadAlbum;
  $('#mu-up-name-l').textContent = one ? T.songName : T.albumName;
  $('#mu-up-note').classList.toggle('hidden', one);
  $('#mu-up-audio').multiple = !one; $('#mu-up-lrc').multiple = !one;
  /* 切模式清掉已选的音频 / 歌词（多选的不能带进单选） */
  $('#mu-up-audio').value = ''; $('#mu-up-lrc').value = ''; upFiles.audio = []; upFiles.lrc = [];
  $('#mu-up-audio-name').textContent = one ? T.chooseOne : T.choose; $('#mu-up-lrc-name').textContent = one ? T.lrcOne : T.lrcNone;
  upMsg('');
}
$('#mu-up-kind').addEventListener('click', function(e){ var b = e.target.closest('[data-kind]'); if (b && b.dataset.kind !== upKind) setUpKind(b.dataset.kind); });
function upMsg(m, bad){ var el = $('#mu-up-msg'); el.textContent = m || ''; el.classList.toggle('hidden', !m); el.classList.toggle('text-m-error', !!bad); }
/* 上传窗 = 非模态 <dialog class="sgx-qp sgx-up">（同 AI 窗口的悬浮卡片）+ 共享 modalSheet（topbar-host.js 挂的 window.SgxModalSheet）：
 * 系统返回 / Esc 只关窗不离页；点遮罩（dialog 本身）关；点顶栏任一按钮先关它（同顶栏窗口互斥）。时长同 CSS .24s。
 * 拿不到状态机（不该发生）就退回裸 show / close。 */
var upDlg = $('#mu-up-wrap');
function upLock(on){ doc.body.style.overflow = on || doc.querySelector('.bk-overlay.open') ? 'hidden' : ''; }
var upSheet = G.SgxModalSheet ? G.SgxModalSheet(upDlg, $('#mu-upload'), { ms: 240, reducedMs: 120, stateKey: 'sgxMuUp', modal: false, onOpen: function(){ upLock(true); }, onClosed: function(){ upLock(false); } })
  : { open: function(){ if (!upDlg.open) { upDlg.show(); upDlg.classList.add('is-open'); upLock(true); } }, close: function(){ if (upDlg.open) { upDlg.classList.remove('is-open'); upDlg.close(); } upLock(false); } };
upDlg.addEventListener('click', function(e){ if (e.target === upDlg) upSheet.close(); });
var nav = doc.getElementById('site-nav');
/* 先关上传窗、等它的历史哨兵出栈，再在下一个任务里把这次点击补给原按钮（同 topbar/panel.js 顶栏窗口互斥）：
 * 同一个 popstate 还要派给顶栏窗口的 modalSheet 监听，同一下里就开顶栏窗口会被它当成「系统返回」立刻关掉 */
/* M3：三个编辑窗同样处理（openSheets 在下面编辑那节登记） */
var openSheets = [function(){ return upDlg.open ? upSheet : null; }];
if (nav) nav.addEventListener('click', function(e){
  var sh = null;
  for (var k = 0; k < openSheets.length && !sh; k++) sh = openSheets[k]();
  var t = sh && e.target.closest && e.target.closest('button, a');
  if (!t) return;
  e.preventDefault(); e.stopPropagation();
  sh.close(function(){ G.setTimeout(function(){ t.click(); }, 0); });
}, true);
$('#mu-up-x').addEventListener('click', function(){ upSheet.close(); });
$('#mu-upload').addEventListener('click', function(){
  $('#mu-up-form').reset(); upFiles = { audio: [], cover: null, lrc: [] };
  $('#mu-up-audio-name').textContent = T.choose; $('#mu-up-cover-name').textContent = T.coverNone; $('#mu-up-lrc-name').textContent = T.lrcNone;
  upMsg(''); $('#mu-up-go').disabled = false;
  setUpKind('album');
  upSheet.open();
});
$('#mu-up-audio').addEventListener('change', function(){
  var one = upKind === 'single';
  upFiles.audio = sortByName(this.files).slice(0, one ? 1 : undefined);
  $('#mu-up-audio-name').textContent = upFiles.audio.length ? (one ? upFiles.audio[0].name : T.chosen(upFiles.audio.length)) : (one ? T.chooseOne : T.choose);
});
$('#mu-up-cover').addEventListener('change', function(){ upFiles.cover = this.files && this.files[0] || null; $('#mu-up-cover-name').textContent = upFiles.cover ? upFiles.cover.name : T.coverNone; });
$('#mu-up-lrc').addEventListener('change', function(){
  var one = upKind === 'single';
  upFiles.lrc = Array.prototype.slice.call(this.files || []).slice(0, one ? 1 : undefined);
  $('#mu-up-lrc-name').textContent = upFiles.lrc.length ? (one ? upFiles.lrc[0].name : T.chosen(upFiles.lrc.length)) : (one ? T.lrcOne : T.lrcNone);
});
/** 封面：长边缩到 1600、webp（不支持就 jpeg） */
function shrink(file){
  return new Promise(function(resolve, reject){
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function(){
      var k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)), c = doc.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(function(b){ if (b && b.type === 'image/webp') return resolve(b); c.toBlob(function(j){ j ? resolve(j) : reject(new Error('encode')); }, 'image/jpeg', 0.86); }, 'image/webp', 0.86);
    };
    img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}
/** 音频时长（秒，取不到 0；最多等 8 秒） */
function durationOf(file){
  return new Promise(function(resolve){
    var a = doc.createElement('audio'), url = URL.createObjectURL(file), done = false;
    function fin(v){ if (done) return; done = true; URL.revokeObjectURL(url); resolve(v); }
    a.preload = 'metadata';
    a.onloadedmetadata = function(){ fin(isFinite(a.duration) ? Math.round(a.duration) : 0); };
    a.onerror = function(){ fin(0); };
    setTimeout(function(){ fin(0); }, 8000);
    a.src = url;
  });
}
function readText(f){ return new Promise(function(ok){ var r = new FileReader(); r.onload = function(){ ok(String(r.result || '')); }; r.onerror = function(){ ok(''); }; r.readAsText(f); }); }
$('#mu-up-go').addEventListener('click', function(){
  var name = $('#mu-up-name').value.trim(), one = upKind === 'single';
  if (!name) return upMsg(one ? T.needSong : T.needName, true);
  if (!upFiles.audio.length) return upMsg(T.needAudio, true);
  for (var k = 0; k < upFiles.audio.length; k++) {
    var f = upFiles.audio[k];
    if (f.size > TRACK_MAX) return upMsg(T.tooBig(f.name), true);
    if (!audioType(f)) return upMsg(T.badType(f.name), true);
  }
  var btn = $('#mu-up-go'); btn.disabled = true;
  var yr = Number($('#mu-up-year').value) || 0, albumId = 0, failed = 0, made = [];
  req('POST', '/curio/api/music', { op: 'album.add', kind: upKind, title: name, artist: $('#mu-up-artist').value, year: yr >= 1900 && yr <= 2100 ? yr : 0 }).then(function(j){
    albumId = j.id;
    if (!upFiles.cover) return null;
    upMsg(T.cover);
    return shrink(upFiles.cover).then(function(b){ return req('POST', '/curio/api/music-upload?album=' + albumId + '&kind=cover', b, b.type); }).catch(function(e){ if (e.sgxLocked) throw e; failed++; });
  }).then(function(){
    var chain = Promise.resolve();
    upFiles.audio.forEach(function(f, i){
      chain = chain.then(function(){
        upMsg(T.up(i + 1, upFiles.audio.length, f.name));
        /* 单曲：曲序 1、曲名 = 歌名；专辑：取自文件名 */
        var meta = one ? { no: 1, title: name } : trackFromName(f.name, i + 1);
        return durationOf(f).then(function(d){
          var q = '?album=' + albumId + '&kind=track&no=' + meta.no + '&title=' + encodeURIComponent(meta.title) + '&duration=' + d;
          return req('POST', '/curio/api/music-upload' + q, f, audioType(f)).then(function(r){ made.push({ id: r.id, key: lrcKey(f.name) }); });
        }).catch(function(e){ if (e.sgxLocked) throw e; failed++; });
      });
    });
    return chain;
  }).then(function(){
    if (!upFiles.lrc.length) return null;
    upMsg(T.lyrics);
    return Promise.all(upFiles.lrc.map(function(f){
      var hit = one ? made[0] : made.filter(function(m){ return m.key === lrcKey(f.name); })[0];
      if (!hit) return null;
      return readText(f).then(function(text){ return req('POST', '/curio/api/music', { op: 'track.edit', id: hit.id, lrc: text }); }).catch(function(e){ if (e.sgxLocked) throw e; failed++; });
    }));
  }).then(function(){
    return req('GET', '/curio/api/music');
  }).then(function(j){
    coverVer = Date.now();
    setData(j.albums, one ? 'single' : 'album');
    var i = albums.map(function(a){ return a.id; }).indexOf(albumId);
    renderCovers();
    if (one) renderAlbum(); else select(i < 0 ? 0 : i, true);
    upSheet.close();
    toast(failed ? T.partial(failed) : T.saved);
  }).catch(function(e){ if (!e.sgxLocked) upMsg(failMsg(e), true); }).then(function(){ btn.disabled = false; });
});

/* ---------- 导入后编辑（M3，音乐 v1.18 十二 M3 / 7.4 / 7.6） ----------
 * 曲目行 / 单曲行「⋯」→ #mu-ed-wrap：歌名、歌手（M4 之前只填文本，不联想）、所属专辑（只列 kind=album 按名排序，顶上「移出变单曲」）、歌词；
 *   单曲多一个封面、一个年份（专辑里的曲目不设封面，7.6；单曲选了划进专辑 → 封面不传、年份不发，跟专辑走）。所有改动一个 track.edit（后端一个 batch）：
 *   单曲改名 / 改年份由后端在同一个 batch 写进单曲记录（Gray 审 1、3）；换封面走 music-upload kind=cover。
 *   左下「删除」→ 确认卡片（同删除单曲）→ track.del（curio-write 档；单曲唯一一首 → 后端连空单曲记录和封面一起删）。
 * 专辑标题旁「编辑」→ #mu-ae-wrap：名、歌手、年份（album.edit）+ 封面（music-upload kind=cover），一个入口统一改整张专辑。
 * 多选 → 「批量改」→ #mu-be-wrap：歌手、移专辑；年份只对单曲（album.edit 单曲记录）。逐条发请求（batchRequests），失败的列出来。 */
function mkSheet(dlg, key){
  return G.SgxModalSheet ? G.SgxModalSheet(dlg, doc.createElement('span'), { ms: 240, reducedMs: 120, stateKey: key, modal: false, onOpen: function(){ upLock(true); }, onClosed: function(){ upLock(false); } })
    : { open: function(){ if (!dlg.open) { dlg.show(); dlg.classList.add('is-open'); upLock(true); } }, close: function(after){ if (dlg.open) { dlg.classList.remove('is-open'); dlg.close(); } upLock(false); if (after) after(); } };
}
function wire(dlg, sh, x){
  dlg.addEventListener('click', function(e){ if (e.target === dlg) sh.close(); });
  $(x).addEventListener('click', function(){ sh.close(); });
  openSheets.push(function(){ return dlg.open ? sh : null; });
}
function msgOf(id){ return function(m, bad){ var el = $(id); el.textContent = m || ''; el.classList.toggle('hidden', !m); el.classList.toggle('text-m-error', !!bad); }; }
/** 写失败的一句话：上限 / 封面复制失败 / 没权限，其余「出了点问题」 */
function errText(e){
  var c = e && e.code;
  if (c === 'limit') return T.errLimit || T.failed;
  if (c === 'storage') return T.errStorage || T.failed;
  return failMsg(e);
}
function fillAlbums(selEl, top, pick){
  selEl.innerHTML = top.map(function(o){ return '<option value="' + esc(o.v) + '">' + esc(o.t) + '</option>'; }).join('')
    + albumChoices(all, lang).map(function(a){ return '<option value="' + a.id + '">' + esc(a.title) + '</option>'; }).join('');
  selEl.value = String(pick);
}
/** 歌单换了（编辑之后）：重画，当前专辑按 id 留住 */
function refresh(list){
  var keep = album() ? album().id : 0;
  setData(list);
  var i = albums.map(function(a){ return a.id; }).indexOf(keep);
  if (i >= 0) cur = i;
  renderCovers(); renderAlbum();
}
function upCover(albumId, file){
  return shrink(file).then(function(b){ return req('POST', '/curio/api/music-upload?album=' + albumId + '&kind=cover', b, b.type); }).then(function(){ coverVer = Date.now(); });
}
function coverPreview(img, a){
  img.classList.toggle('hidden', !(a && a.cover));
  if (a && a.cover) img.src = coverUrl(a); else img.removeAttribute('src');
}

/* --- 曲目 / 单曲 --- */
var edDlg = $('#mu-ed-wrap'), edSheet = mkSheet(edDlg, 'sgxMuEd');
wire(edDlg, edSheet, '#mu-ed-x');
var edMsg = msgOf('#mu-ed-msg');
/** ed = {a: 所在专辑 / 单曲记录, t: 曲目, single, lrc: 读出来的歌词（null = 有但没读出来；'' = 没有）, cover: 新选的封面, gen} */
var ed = null, edGen = 0;
function edCoverName(){
  var into = ed.single && $('#mu-ed-album').value !== '0';
  $('#mu-ed-cover').disabled = into;
  $('#mu-ed-year').disabled = into;  /* 划进专辑：年份跟专辑走，不发 */
  $('#mu-ed-cover-name').textContent = into ? T.coverAlbum : ed.cover ? ed.cover.name : ed.a.cover ? T.coverHas : T.coverPick;
}
/** 歌词正文只在签播放令牌时给（GET 只说有没有）：直接调 music-play 读这张的歌词，不走 req（401 不切只看模式、不请人进站） */
function loadLrc(albumId, trackId){
  return fetch('/curio/api/music-play', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ album: albumId }) })
    .then(function(r){ return r.json(); })
    .then(function(j){
      var hit = j && j.ok && (j.tracks || []).filter(function(x){ return x.id === trackId; })[0];
      if (!hit || typeof hit.lrc !== 'string') throw new Error('lrc');
      return hit.lrc;
    });
}
function openTrackEdit(a, t){
  if (!canWrite || !a || !t) return;
  var single = CORE.isSingle(a), gen = ++edGen;
  ed = { a: a, t: t, single: single, lrc: t.lrc ? null : '', cover: null };
  $('#mu-ed-form').reset();
  $('#mu-ed-title').textContent = single ? T.editSingle : T.editTrack;
  $('#mu-ed-name').value = single ? a.title : t.title;
  $('#mu-ed-artist').value = single ? (a.artist || '') : (t.artist || '');
  fillAlbums($('#mu-ed-album'), [{ v: '0', t: single ? T.stayNoAlbum : T.moveOut }], single ? '0' : a.id);
  $('#mu-ed-cover-row').classList.toggle('hidden', !single);
  $('#mu-ed-year-row').classList.toggle('hidden', !single);
  $('#mu-ed-year').value = single && a.year ? String(a.year) : '';
  if (single) { coverPreview($('#mu-ed-cover-img'), a); edCoverName(); }
  var ta = $('#mu-ed-lrc'), note = $('#mu-ed-lrc-note');
  ta.value = ''; ta.disabled = !!t.lrc; note.classList.toggle('hidden', !t.lrc); note.textContent = t.lrc ? T.lrcLoading : '';
  if (t.lrc) loadLrc(a.id, t.id).then(function(text){
    if (gen !== edGen) return;
    ed.lrc = text; ta.value = text; ta.disabled = false; note.classList.add('hidden');
  }).catch(function(){ if (gen !== edGen) return; ta.disabled = false; note.textContent = T.lrcUnread; });
  edMsg(''); $('#mu-ed-save').disabled = false; $('#mu-ed-del').disabled = false;
  edSheet.open();
}
$('#mu-ed-album').addEventListener('change', function(){ if (ed && ed.single) edCoverName(); });
$('#mu-ed-cover').addEventListener('change', function(){ if (!ed) return; ed.cover = this.files && this.files[0] || null; edCoverName(); });
$('#mu-ed-save').addEventListener('click', function(){
  if (!ed) return;
  var e0 = ed, a = e0.a, t = e0.t, single = e0.single, btn = this;
  var name = $('#mu-ed-name').value.trim();
  if (!name) return edMsg(T.needSong, true);
  var yr = null;
  if (single && !$('#mu-ed-year').disabled) { yr = yearOf($('#mu-ed-year').value); if (yr === null) return edMsg(T.badYear, true); }
  var body = trackEditBody({ id: t.id, title: single ? a.title : t.title, artist: single ? a.artist : t.artist, year: single ? a.year : 0 }, { albumId: a.id, single: single },
    { title: name, artist: $('#mu-ed-artist').value, album: $('#mu-ed-album').value, lrc: $('#mu-ed-lrc').disabled ? null : lrcChange(e0.lrc, $('#mu-ed-lrc').value), year: yr });
  var stay = !(body && body.album_id !== undefined);  /* 没移走 */
  var cover = single && stay && e0.cover;
  if (!body && !cover) return edSheet.close();
  btn.disabled = true; edMsg('');
  var list = null;
  /* 歌名、歌手、歌词、所属专辑、单曲的名 / 年份：一个 track.edit（后端一个 batch）；换封面另走 music-upload */
  (body ? req('POST', '/curio/api/music', body) : Promise.resolve(null)).then(function(j){
    if (j) list = j.albums;
  }).then(function(){
    if (!cover) return null;
    edMsg(T.cover);
    return upCover(a.id, cover).then(function(){ return req('GET', '/curio/api/music'); }).then(function(j3){ list = j3.albums; });
  }).then(function(){
    if (list) refresh(list);
    edSheet.close(); toast(T.savedEdit);
  }).catch(function(e){
    if (list) refresh(list);
    if (!e.sgxLocked) edMsg(errText(e), true);
  }).then(function(){ btn.disabled = false; });
});
/* 删曲目：先关编辑窗、等它的历史哨兵出栈，再弹确认卡片（同上传窗关了再开顶栏窗口） */
$('#mu-ed-del').addEventListener('click', function(){
  if (!ed) return;
  var a = ed.a, t = ed.t, single = ed.single;
  edSheet.close(function(){ G.setTimeout(function(){
    askDel({
      title: single ? T.delSingleTitle : T.delTrackTitle,
      msg: tr(single ? 'delSingle' : 'delTrack', { name: single ? a.title : t.title }),
      run: function(){ return req('POST', '/curio/api/music', { op: 'track.del', id: t.id }); },
      stops: function(){ var c = P.state.list && P.state.list[P.state.i]; return P.state.album === a.id && (single || !!(c && c.id === t.id)); },
    });
  }, 0); });
});

/* --- 专辑 --- */
var aeDlg = $('#mu-ae-wrap'), aeSheet = mkSheet(aeDlg, 'sgxMuAe');
wire(aeDlg, aeSheet, '#mu-ae-x');
var aeMsg = msgOf('#mu-ae-msg');
var ae = null;
function aeCoverName(){ $('#mu-ae-cover-name').textContent = ae.cover ? ae.cover.name : ae.a.cover ? T.coverHas : T.coverPick; }
$('#mu-album-edit').addEventListener('click', function(){
  var a = album();
  if (!a || !canWrite) return;
  ae = { a: a, cover: null };
  $('#mu-ae-form').reset();
  $('#mu-ae-name').value = a.title; $('#mu-ae-artist').value = a.artist || ''; $('#mu-ae-year').value = a.year ? String(a.year) : '';
  coverPreview($('#mu-ae-cover-img'), a); aeCoverName();
  aeMsg(''); $('#mu-ae-save').disabled = false;
  aeSheet.open();
});
$('#mu-ae-cover').addEventListener('change', function(){ if (!ae) return; ae.cover = this.files && this.files[0] || null; aeCoverName(); });
$('#mu-ae-save').addEventListener('click', function(){
  if (!ae) return;
  var a = ae.a, file = ae.cover, btn = this;
  var name = $('#mu-ae-name').value.trim(), artist = $('#mu-ae-artist').value.trim(), yr = yearOf($('#mu-ae-year').value);
  if (!name) return aeMsg(T.needName, true);
  if (yr === null) return aeMsg(T.badYear, true);
  var b = { op: 'album.edit', id: a.id };
  if (name !== a.title) b.title = name;
  if (artist !== String(a.artist || '')) b.artist = artist;
  if (yr !== (a.year || 0)) b.year = yr;
  var edit = Object.keys(b).length > 2;
  if (!edit && !file) return aeSheet.close();
  btn.disabled = true; aeMsg('');
  var list = null;
  (edit ? req('POST', '/curio/api/music', b) : Promise.resolve(null)).then(function(j){
    if (j) list = j.albums;
    if (!file) return null;
    aeMsg(T.cover);
    return upCover(a.id, file).then(function(){ return req('GET', '/curio/api/music'); }).then(function(j2){ list = j2.albums; });
  }).then(function(){
    if (list) refresh(list);
    aeSheet.close(); toast(T.savedEdit);
  }).catch(function(e){
    if (list) refresh(list);
    if (!e.sgxLocked) aeMsg(errText(e), true);
  }).then(function(){ btn.disabled = false; });
});

/* --- 多选 / 批量改 --- */
/** 多选条：能写、这一边有东西才显示；没在多选 =「多选」，在多选 =「已选 n 首 · 批量改 · 取消」 */
function renderSelBar(a, inAlb){
  var has = inAlb ? !!(a && a.tracks.length) : singles.length > 0;
  var bar = $('#mu-sel-bar');
  bar.classList.toggle('hidden', !canWrite || !has);
  if (!has && sel.on) selExit();
  var n = selCount();
  $('#mu-sel-n').textContent = sel.on ? (n ? T.selN(n) : T.selNone) : '';
  $('#mu-sel').classList.toggle('hidden', sel.on);
  $('#mu-sel-edit').classList.toggle('hidden', !sel.on);
  $('#mu-sel-x').classList.toggle('hidden', !sel.on);
  $('#mu-sel-edit').disabled = !n;
}
function selToggle(id){ if (sel.ids[id]) delete sel.ids[id]; else sel.ids[id] = 1; renderAlbum(); }
$('#mu-sel').addEventListener('click', function(){ sel.on = true; sel.ids = {}; renderAlbum(); });
$('#mu-sel-x').addEventListener('click', function(){ selExit(); renderAlbum(); });
var beDlg = $('#mu-be-wrap'), beSheet = mkSheet(beDlg, 'sgxMuBe');
wire(beDlg, beSheet, '#mu-be-x');
var beMsg = msgOf('#mu-be-msg');
/** 选中的条目 → batchRequests 的 items（专辑页：本专辑的曲目；单曲区：单曲记录和它那一首） */
function selItems(){
  if (sec === 'single') return singles.filter(function(s){ return sel.ids[s.id] && s.tracks[0]; }).map(function(s){ return { trackId: s.tracks[0].id, albumId: s.id, name: s.title }; });
  var a = album();
  return a ? a.tracks.filter(function(t){ return sel.ids[t.id]; }).map(function(t){ return { trackId: t.id, albumId: a.id, name: t.title }; }) : [];
}
$('#mu-sel-edit').addEventListener('click', function(){
  if (!selCount()) return;
  var one = sec === 'single';
  $('#mu-be-form').reset();
  fillAlbums($('#mu-be-album'), [{ v: '', t: T.keep }].concat(one ? [] : [{ v: '0', t: T.moveOut }]), '');
  $('#mu-be-year-row').classList.toggle('hidden', !one);
  beMsg(''); $('#mu-be-save').disabled = false;
  beSheet.open();
});
$('#mu-be-save').addEventListener('click', function(){
  var one = sec === 'single', btn = this;
  var yv = $('#mu-be-year').value.trim();
  if (one && yv && !yearOf(yv)) return beMsg(T.badYear, true);
  var plan = batchRequests(selItems(), { artist: $('#mu-be-artist').value, album: $('#mu-be-album').value, year: one && yv ? yearOf(yv) : '' }, one);
  if (!plan.length) return beSheet.close();
  btn.disabled = true; beMsg('');
  var fails = [], list = null, locked = false;
  var chain = Promise.resolve();
  plan.forEach(function(item){
    chain = chain.then(function(){
      if (locked) return null;
      var c = Promise.resolve();
      item.reqs.forEach(function(b){ c = c.then(function(){ return req('POST', '/curio/api/music', b).then(function(j){ list = j.albums; }); }); });
      return c.catch(function(e){ if (e.sgxLocked) { locked = true; return; } fails.push(item.name + '：' + errText(e)); });
    });
  });
  chain.then(function(){
    if (list) refresh(list);
    if (locked) return;
    if (fails.length) { beMsg(T.batchFail(fails.length) + '\n' + fails.join('\n'), true); return; }
    selExit(); renderAlbum();
    beSheet.close(); toast(T.batchDone(plan.length));
  }).then(function(){ btn.disabled = false; });
});

/* ---------- 启动 ---------- */
function done(){ doc.querySelectorAll('.it-loading').forEach(function(el){ el.classList.add('hidden'); }); }
req('GET', '/curio/api/music').then(function(j){
  setData(j.albums);
  canWrite = !!j.canWrite;
  done();
  $('#mu-app').classList.remove('hidden');
  $('#mu-upload').classList.toggle('hidden', !canWrite);
  renderCovers();
  if (viewOnly) setViewOnly(true); else renderAlbum();
}).catch(function(){
  done();
  var p = doc.querySelector('.it-loading'); if (p) { p.textContent = (T.loadFail || T.failed); p.classList.remove('hidden'); }
});
})();
