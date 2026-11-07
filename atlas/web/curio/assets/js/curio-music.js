/* assets/js/curio-music.js —— 奇趣「音乐」私人子页（P4-3 奇趣拆页：/curio/music/；浏览器 IIFE；node 测试时导出纯函数）。
 *
 * 仅本人可见：GET /curio/api/music 回 401 account / 403 scope 时只显示 #mu-denied（链到账号页）；401 unauthorized = 锁了 → 刷新去锁屏。
 * 播放器（交互借 jojo.best/music 的思路，只借交互）：
 *   - 封面横滑切专辑（scroll-snap，停下来的那张是当前专辑；点封面也能切），下面是这张的曲目（按曲序）。
 *   - 「播放整张」从第 1 首按曲序放到最后一首；点某一首从那首开始，放完接下一首。
 *   - 歌词：有 LRC 就在播放条里滚动，当前行高亮（parseLrc / lrcIndex）。
 *   - 倍速：0.75 → 1 → 1.25 → 1.5 → 2 → 0.75 循环（SPEEDS），换曲目也保持。
 * 播放短链：POST /curio/api/music-play {album} 签随机令牌（10 分钟），<audio src> = /curio/api/music-stream?t=…&id=…（Range 拖进度）。
 *   快过期（剩不到 30 秒）再换曲目时先续签；放到一半令牌过期（<audio> 报错）就续签一次、接着原来的位置放。
 * 上传：「上传专辑」→ album.add → 封面缩到长边 1600、webp → 音频按文件名排序逐个直传（曲序取文件名开头的数字，单个 ≤ 95 MB）→ .lrc 按文件名对上曲目写进去。
 * 确认框、提示条、弹层开关借 curio.js 的（window.SgxCurioUI）。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

var SPEEDS = [0.75, 1, 1.25, 1.5, 2];
/** 单个音频上限（同 workers/curio-core/src/api/_music.js MUSIC_LIMITS.trackBytes） */
var TRACK_MAX = 95 * 1024 * 1024;
var EXT_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav', webm: 'audio/webm' };

/** 下一档倍速 */
function nextSpeed(cur){
  var i = SPEEDS.indexOf(cur);
  return SPEEDS[(i < 0 ? 0 : i + 1) % SPEEDS.length];
}
/** 秒 → m:ss（≥ 1 小时 h:mm:ss） */
function fmtTime(s){
  s = Math.max(0, Math.floor(Number(s) || 0));
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  var p = function(n){ return (n < 10 ? '0' : '') + n; };
  return h ? h + ':' + p(m) + ':' + p(x) : m + ':' + p(x);
}
/** LRC → [{t 秒, text}]，按时间排；一行多个时间戳各算一条；[ar:] 这类标签、空行丢掉 */
function parseLrc(src){
  var out = [];
  String(src || '').split(/\r?\n/).forEach(function(line){
    var re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g, m, ts = [], last = 0;
    while ((m = re.exec(line))) { ts.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0)); last = re.lastIndex; }
    if (!ts.length) return;
    var text = line.slice(last).trim();
    ts.forEach(function(t){ out.push({ t: t, text: text }); });
  });
  return out.sort(function(a, b){ return a.t - b.t; });
}
/** 当前时间该亮哪一行（还没到第一行 → -1） */
function lrcIndex(lines, time){
  var lo = 0, hi = (lines || []).length - 1, ans = -1;
  while (lo <= hi) { var mid = (lo + hi) >> 1; if (lines[mid].t <= time + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
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

var pure = { readDict: readDict, makeTr: makeTr, SPEEDS: SPEEDS, TRACK_MAX: TRACK_MAX, nextSpeed: nextSpeed, fmtTime: fmtTime, parseLrc: parseLrc, lrcIndex: lrcIndex, trackFromName: trackFromName, sortByName: sortByName, audioType: audioType, lrcKey: lrcKey };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }
G.SgxCurioMusic = pure;

var doc = G.document;
if (!doc.getElementById('cu-pane-music')) return;
var UI = G.SgxCurioUI;
var $ = function(s){ return doc.querySelector(s); };
/* 界面文案（语言包化第二部分 2026-11-07）：页面里的 #sgx-i18n-curioMusic，模板从字符串表 data/i18n/<语言>.yaml 的 js.curioMusic 输出，
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
var NOTE = '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>';

var albums = [], cur = 0, coverVer = 0;
var audio = $('#mu-audio');
var play = { album: 0, list: [], i: -1, expires: 0, lines: [], line: -2, retried: false };
var speed = 1;

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function toast(m){ if (UI) UI.toast(m); }
/** 本页接口：401 unauthorized = 锁了（刷新去锁屏）；其它错误带 code 抛出 */
function req(method, url, body, type){
  return fetch(url, {
    method: method, credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': type || 'application/json' },
    body: body === undefined ? undefined : type ? body : JSON.stringify(body),
  }).then(function(r){
    if (r.type === 'opaqueredirect') { G.location.reload(); throw Object.assign(new Error('locked'), { sgxLocked: true }); }
    return r.json().catch(function(){ return {}; }).then(function(j){
      if (r.status === 401 && j.error !== 'account' && j.error !== 'reauth') { G.location.reload(); throw Object.assign(new Error('locked'), { sgxLocked: true }); }
      if (!r.ok || !j.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { code: j.error, status: r.status });
      return j;
    });
  });
}
function album(){ return albums[cur] || null; }
function coverUrl(a){ return '/curio/api/music-cover?album=' + a.id + (coverVer ? '&v=' + coverVer : ''); }

/* ---------- 画 ---------- */
function renderCovers(){
  $('#mu-covers').innerHTML = albums.map(function(a, i){
    return '<button type="button" role="listitem" class="mu-cover' + (i === cur ? ' on' : '') + '" data-i="' + i + '" aria-label="' + esc(a.title) + '">'
      + (a.cover ? '<img src="' + coverUrl(a) + '" alt="" decoding="async" onerror="this.remove()">' : '') + '<span class="mu-cover-ph">' + NOTE + '</span></button>';
  }).join('');
  $('#mu-dots').innerHTML = albums.length > 1 ? albums.map(function(_, i){ return '<i' + (i === cur ? ' class="on"' : '') + '></i>'; }).join('') : '';
}
function renderAlbum(){
  var a = album();
  $('#mu-empty').classList.toggle('hidden', albums.length > 0);
  ['#mu-covers', '#mu-dots'].forEach(function(s){ $(s).classList.toggle('hidden', !albums.length); });
  doc.querySelector('.mu-head').classList.toggle('hidden', !a);
  doc.querySelector('.mu-album-acts').classList.toggle('hidden', !a);
  $('#mu-tracks').innerHTML = '';
  if (!a) return;
  $('#mu-album-title').textContent = a.title;
  $('#mu-album-sub').textContent = [a.artist, a.year ? String(a.year) : '', T.tracks(a.tracks.length)].filter(Boolean).join(' · ');
  $('#mu-play-all').disabled = !a.tracks.length;
  $('#mu-tracks').innerHTML = a.tracks.map(function(t, i){
    var on = play.album === a.id && play.i === i;
    return '<li><button type="button" class="mu-track' + (on ? ' on' : '') + '" data-t="' + i + '"' + (on ? ' aria-current="true"' : '') + '>'
      + '<span class="mu-track-no">' + (t.no || i + 1) + '</span><span class="mu-track-title">' + esc(t.title) + '</span>'
      + '<span class="mu-track-dur">' + (t.duration ? fmtTime(t.duration) : '') + '</span></button></li>';
  }).join('');
  doc.querySelectorAll('#mu-dots i').forEach(function(d, i){ d.classList.toggle('on', i === cur); });
  doc.querySelectorAll('.mu-cover').forEach(function(c, i){ c.classList.toggle('on', i === cur); });
}
function select(i, scroll){
  if (i < 0 || i >= albums.length) return;
  cur = i;
  renderAlbum();
  if (scroll) { var c = doc.querySelector('.mu-cover[data-i="' + i + '"]'); if (c) c.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); }
}
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

/* ---------- 播放 ---------- */
function session(a){
  if (play.album === a.id && play.list.length && Date.now() < play.expires - 30000) return Promise.resolve();
  return req('POST', '/curio/api/music-play', { album: a.id }).then(function(j){
    play.album = a.id; play.list = j.tracks || []; play.expires = Date.now() + (j.ttl || 600000);
  });
}
function setLyrics(src){
  play.lines = parseLrc(src); play.line = -2;
  $('#mu-lyrics-in').innerHTML = play.lines.map(function(l, i){ return '<p data-l="' + i + '">' + esc(l.text || '♪') + '</p>'; }).join('');
  $('#mu-lyrics').classList.toggle('hidden', !play.lines.length);
}
function syncLyrics(){
  if (!play.lines.length) return;
  var i = lrcIndex(play.lines, audio.currentTime);
  if (i === play.line) return;
  play.line = i;
  var box = $('#mu-lyrics'), inner = $('#mu-lyrics-in');
  inner.querySelectorAll('p.on').forEach(function(p){ p.classList.remove('on'); });
  var p = i >= 0 ? inner.querySelector('[data-l="' + i + '"]') : null;
  if (p) { p.classList.add('on'); inner.style.transform = 'translateY(' + Math.round(box.clientHeight / 2 - p.offsetTop - p.offsetHeight / 2) + 'px)'; }
  else inner.style.transform = 'translateY(' + Math.round(box.clientHeight / 2 - 12) + 'px)';
}
function startTrack(i, at){
  var t = play.list[i];
  if (!t) { stop(); return; }
  play.i = i; play.retried = false;
  audio.src = t.src;
  audio.defaultPlaybackRate = speed; audio.playbackRate = speed;
  if (at) audio.currentTime = at;
  var a = albums.filter(function(x){ return x.id === play.album; })[0];
  $('#mu-now-title').textContent = t.title;
  $('#mu-now-sub').textContent = a ? [a.title, a.artist].filter(Boolean).join(' · ') : '';
  setLyrics(t.lrc);
  $('#mu-player').classList.remove('hidden');
  doc.documentElement.classList.add('mu-playing');
  var p = audio.play();
  if (p && p.catch) p.catch(function(){});
  renderAlbum();
}
function playFrom(a, i){
  return session(a).then(function(){ startTrack(i, 0); }).catch(function(e){ if (!e.sgxLocked) toast(T.failed); });
}
function stop(){ audio.pause(); play.i = -1; renderAlbum(); syncToggle(); }
function syncToggle(){
  var b = $('#mu-toggle'), on = !audio.paused && !audio.ended;
  b.classList.toggle('is-playing', on);
  b.setAttribute('aria-label', on ? b.dataset.lPause : b.dataset.lPlay);
}
$('#mu-play-all').addEventListener('click', function(){ var a = album(); if (a && a.tracks.length) playFrom(a, 0); });
$('#mu-tracks').addEventListener('click', function(e){ var b = e.target.closest('[data-t]'); var a = album(); if (b && a) playFrom(a, Number(b.dataset.t)); });
$('#mu-toggle').addEventListener('click', function(){
  if (play.i < 0) { var a = album(); if (a && a.tracks.length) playFrom(a, 0); return; }
  if (audio.paused) { var p = audio.play(); if (p && p.catch) p.catch(function(){}); } else audio.pause();
});
function step(d){
  if (play.i < 0) return;
  var a = albums.filter(function(x){ return x.id === play.album; })[0];
  var j = play.i + d;
  if (j < 0 || j >= play.list.length) return;
  if (a) session(a).then(function(){ startTrack(j, 0); }).catch(function(){});
}
$('#mu-prev').addEventListener('click', function(){ if (audio.currentTime > 3) { audio.currentTime = 0; return; } step(-1); });
$('#mu-next').addEventListener('click', function(){ step(1); });
$('#mu-speed').addEventListener('click', function(){
  speed = nextSpeed(speed);
  audio.defaultPlaybackRate = speed; audio.playbackRate = speed;
  var b = $('#mu-speed'); b.textContent = speed + '×'; b.setAttribute('aria-label', T.speed(speed));
});
var seeking = false;
$('#mu-seek').addEventListener('input', function(){ seeking = true; if (audio.duration) $('#mu-time').textContent = fmtTime(audio.duration * this.value / 1000); });
$('#mu-seek').addEventListener('change', function(){ seeking = false; if (audio.duration) audio.currentTime = audio.duration * this.value / 1000; });
audio.addEventListener('timeupdate', function(){
  if (!seeking && audio.duration) { $('#mu-seek').value = String(Math.round(audio.currentTime / audio.duration * 1000)); $('#mu-time').textContent = fmtTime(audio.currentTime); }
  syncLyrics();
});
audio.addEventListener('loadedmetadata', function(){ $('#mu-dur').textContent = fmtTime(audio.duration); });
audio.addEventListener('play', syncToggle);
audio.addEventListener('pause', syncToggle);
audio.addEventListener('ended', function(){ if (play.i + 1 < play.list.length) step(1); else stop(); });
/* 令牌过期（放到一半 / 暂停很久以后拖进度）：续签一次，接着原来的位置放 */
audio.addEventListener('error', function(){
  if (play.i < 0 || play.retried) return;
  var at = audio.currentTime || 0, i = play.i;
  var a = albums.filter(function(x){ return x.id === play.album; })[0];
  if (!a) return;
  play.expires = 0;
  session(a).then(function(){ startTrack(i, at); play.retried = true; }).catch(function(){});
});

/* ---------- 删除专辑 ---------- */
$('#mu-album-del').addEventListener('click', function(){
  var a = album();
  if (!a || !UI) return;
  UI.ask(T.delAlbum, T.del, function(){
    req('POST', '/curio/api/music', { op: 'album.del', id: a.id }).then(function(j){
      if (play.album === a.id) { audio.pause(); audio.removeAttribute('src'); play = { album: 0, list: [], i: -1, expires: 0, lines: [], line: -2, retried: false }; $('#mu-player').classList.add('hidden'); doc.documentElement.classList.remove('mu-playing'); }
      albums = j.albums || []; cur = Math.min(cur, Math.max(0, albums.length - 1)); renderCovers(); renderAlbum(); toast(T.deleted);
    }).catch(function(e){ if (!e.sgxLocked) toast(T.failed); });
  });
});

/* ---------- 上传 ---------- */
var upFiles = { audio: [], cover: null, lrc: [] };
function upMsg(m, bad){ var el = $('#mu-up-msg'); el.textContent = m || ''; el.classList.toggle('hidden', !m); el.classList.toggle('text-m-error', !!bad); }
$('#mu-upload').addEventListener('click', function(){
  $('#mu-up-form').reset(); upFiles = { audio: [], cover: null, lrc: [] };
  $('#mu-up-audio-name').textContent = T.choose; $('#mu-up-cover-name').textContent = T.coverNone; $('#mu-up-lrc-name').textContent = T.lrcNone;
  upMsg(''); $('#mu-up-go').disabled = false;
  if (UI) UI.openOverlay('mu-up-wrap');
});
$('#mu-up-audio').addEventListener('change', function(){ upFiles.audio = sortByName(this.files); $('#mu-up-audio-name').textContent = upFiles.audio.length ? T.chosen(upFiles.audio.length) : T.choose; });
$('#mu-up-cover').addEventListener('change', function(){ upFiles.cover = this.files && this.files[0] || null; $('#mu-up-cover-name').textContent = upFiles.cover ? upFiles.cover.name : T.coverNone; });
$('#mu-up-lrc').addEventListener('change', function(){ upFiles.lrc = Array.prototype.slice.call(this.files || []); $('#mu-up-lrc-name').textContent = upFiles.lrc.length ? T.chosen(upFiles.lrc.length) : T.lrcNone; });
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
  var name = $('#mu-up-name').value.trim();
  if (!name) return upMsg(T.needName, true);
  if (!upFiles.audio.length) return upMsg(T.needAudio, true);
  for (var k = 0; k < upFiles.audio.length; k++) {
    var f = upFiles.audio[k];
    if (f.size > TRACK_MAX) return upMsg(T.tooBig(f.name), true);
    if (!audioType(f)) return upMsg(T.badType(f.name), true);
  }
  var btn = $('#mu-up-go'); btn.disabled = true;
  var yr = Number($('#mu-up-year').value) || 0, albumId = 0, failed = 0, made = [];
  req('POST', '/curio/api/music', { op: 'album.add', title: name, artist: $('#mu-up-artist').value, year: yr >= 1900 && yr <= 2100 ? yr : 0 }).then(function(j){
    albumId = j.id;
    if (!upFiles.cover) return null;
    upMsg(T.cover);
    return shrink(upFiles.cover).then(function(b){ return req('POST', '/curio/api/music-upload?album=' + albumId + '&kind=cover', b, b.type); }).catch(function(e){ if (e.sgxLocked) throw e; failed++; });
  }).then(function(){
    var chain = Promise.resolve();
    upFiles.audio.forEach(function(f, i){
      chain = chain.then(function(){
        upMsg(T.up(i + 1, upFiles.audio.length, f.name));
        var meta = trackFromName(f.name, i + 1);
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
      var hit = made.filter(function(m){ return m.key === lrcKey(f.name); })[0];
      if (!hit) return null;
      return readText(f).then(function(text){ return req('POST', '/curio/api/music', { op: 'track.edit', id: hit.id, lrc: text }); }).catch(function(e){ if (e.sgxLocked) throw e; failed++; });
    }));
  }).then(function(){
    return req('GET', '/curio/api/music');
  }).then(function(j){
    albums = j.albums || []; coverVer = Date.now();
    var i = albums.map(function(a){ return a.id; }).indexOf(albumId);
    renderCovers(); select(i < 0 ? 0 : i, true);
    if (UI) UI.closeOverlay('mu-up-wrap');
    toast(failed ? T.partial(failed) : T.saved);
  }).catch(function(e){ if (!e.sgxLocked) upMsg(T.failed, true); }).then(function(){ btn.disabled = false; });
});

/* ---------- 启动 ---------- */
function done(){ doc.querySelectorAll('.it-loading').forEach(function(el){ el.classList.add('hidden'); }); }
req('GET', '/curio/api/music').then(function(j){
  albums = j.albums || [];
  done();
  $('#mu-app').classList.remove('hidden');
  renderCovers(); renderAlbum();
}).catch(function(e){
  if (e && e.sgxLocked) return;
  done();
  if (e && (e.code === 'account' || e.code === 'scope')) {
    var l = $('#mu-denied-link');
    if (l && e.code === 'scope') l.setAttribute('href', l.getAttribute('href') + 'apps/');
    $('#mu-denied').classList.remove('hidden');
    return;
  }
  var p = doc.querySelector('.it-loading'); if (p) { p.textContent = T.failed; p.classList.remove('hidden'); }
});
})();
