/* assets/curio/js/music-core.js —— 音乐播放共用核（音乐分层方案 v1.13 第二步 2a；浏览器 IIFE → window.SgxMusicCore；node 测试时 module.exports）。
 *
 * 奇趣音乐页（curio-music.js）和弹出播放器（2b）各自引用这一份，免得两份签令牌 / 续签逻辑：
 *   - 签令牌：POST /curio/api/music-play {album} 由调用方传 sign(albumId) 发（各页自己的 req 管 401 / 只看模式），
 *     这里只记 album / list / expires；同一张专辑、离过期还有 30 秒以上不重签。
 *   - 切曲：start / playFrom / step（上一首 / 下一首）/ ended 接下一首、放完停。
 *   - 续签：放到一半令牌过期（<audio> 报错）续签一次，接着原来的位置放。
 *   - 倍速：换曲目也保持。
 *   - 防同时响：同源各页共用 BroadcastChannel「sgx-music」，一边开播就广播 playing，别的页（奇趣页 / 播放器）收到就暂停。
 *   - 播放模式（2b，方案 v1.13 §7.1 / §7.2）：顺序 / 随机。随机 = 专辑内把曲序打乱成一个队列（不重复、当前这首排第一），
 *     放完一轮重新打乱、新一轮第一首避开刚放完的那首；切回顺序从正在播的这首按曲序往下。默认顺序；只有调用方 setShuffle(true) 才随机
 *     （奇趣页没有随机按钮，不调，行为同 2a）。模式记在 localStorage「sgx-music-mode」（readMode / saveMode，调用方自己读写）。
 * 只管声音和状态，不画界面：画什么由调用方的 onTrack / onChange / onStop 决定。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

var SPEEDS = [0.75, 1, 1.25, 1.5, 2];
/** 弹出播放器的倍速档（方案 v1.13 §7.1：1×、1.25×、1.5×、2× 循环；奇趣页仍用 SPEEDS，两边各自记，不共用） */
var PLAYER_SPEEDS = [1, 1.25, 1.5, 2];
/** 播放模式存在本地的键（'seq' 顺序 / 'shuffle' 随机） */
var MODE_KEY = 'sgx-music-mode';
/** 同源各页之间的广播频道名（防同时响；以后遥控也走这个） */
var CHANNEL = 'sgx-music';
/** 令牌离过期不到这么久就先续签再换曲目 */
var RENEW_MS = 30000;

/** 下一档倍速（list 不给 = 奇趣页的 SPEEDS） */
function nextSpeed(cur, list){
  var L = Array.isArray(list) ? list : SPEEDS, i = L.indexOf(cur);
  return L[(i < 0 ? 0 : i + 1) % L.length];
}
/** 本地记的播放模式：'shuffle' 或 'seq'（读不到 / 不认识 = 顺序） */
function readMode(store){ try { return store && store.getItem(MODE_KEY) === 'shuffle' ? 'shuffle' : 'seq'; } catch (e) { return 'seq'; } }
function saveMode(store, m){ try { if (store) store.setItem(MODE_KEY, m === 'shuffle' ? 'shuffle' : 'seq'); } catch (e) { /* 隐私模式写不进 */ } }
/**
 * 随机队列：0..n-1 打乱（Fisher–Yates），first ≥ 0 时把它排第一；avoid ≥ 0 且 n > 1 时第一首不能是它（新一轮避开刚放完的）。
 * @param {number} n @param {number} first @param {number} avoid @param {function(): number} [rand]
 */
function shuffleOrder(n, first, avoid, rand){
  var r = rand || Math.random, a = [], i;
  for (i = 0; i < n; i++) a.push(i);
  for (i = n - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
  if (first >= 0 && first < n) { a.splice(a.indexOf(first), 1); a.unshift(first); }
  else if (avoid >= 0 && n > 1 && a[0] === avoid) { var k = 1 + Math.floor(r() * (n - 1)); a[0] = a[k]; a[k] = avoid; }
  return a;
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

/**
 * 播放核。
 * @param {{
 *   audio: HTMLAudioElement,
 *   sign: function(number): Promise<{tracks: Array<any>, ttl?: number}>,
 *   onTrack?: function(any, any): void,   // 开始放某一首（曲目对象，状态）
 *   onChange?: function(any): void,       // 播 / 停 / 换曲后（画高亮、播放键）
 *   onStop?: function(any): void,         // 放完 / 停下 / 重置
 *   onError?: function(any, string): void,// 签令牌失败：'play'（点播）/ 'step'（切曲）/ 'retry'（续签）
 *   channel?: any,                        // 测试用：替代 BroadcastChannel
 *   now?: function(): number
 * }} o
 */
function createPlayer(o){
  var audio = o.audio;
  var now = o.now || function(){ return Date.now(); };
  var id = Math.random().toString(36).slice(2) + now().toString(36);
  var st = { album: 0, list: [], i: -1, expires: 0, retried: false, speed: 1, shuffle: false, order: [] };
  var rand = o.random || Math.random;
  /** 放的顺序（曲目下标）：顺序 = 0..n-1；随机 = 打乱、first 排第一 */
  function makeOrder(first, avoid){
    var n = st.list.length, a = [];
    if (st.shuffle) return shuffleOrder(n, first, avoid, rand);
    for (var k = 0; k < n; k++) a.push(k);
    return a;
  }
  function pos(){ return st.order.indexOf(st.i); }
  var ch = o.channel || null;
  if (!ch && typeof G.BroadcastChannel === 'function') { try { ch = new G.BroadcastChannel(CHANNEL); } catch (e) { ch = null; } }
  function fire(name, a, b){ var f = o[name]; if (typeof f === 'function') f(a, b); }
  function playing(){ return !audio.paused && !audio.ended; }

  function session(albumId){
    if (st.album === albumId && st.list.length && now() < st.expires - RENEW_MS) return Promise.resolve();
    return o.sign(albumId).then(function(j){
      st.album = albumId; st.list = (j && j.tracks) || []; st.expires = now() + ((j && j.ttl) || 600000);
    });
  }
  function start(i, at){
    var t = st.list[i];
    if (!t) { stop(); return; }
    st.i = i; st.retried = false;
    audio.src = t.src;
    audio.defaultPlaybackRate = st.speed; audio.playbackRate = st.speed;
    if (at) audio.currentTime = at;
    fire('onTrack', t, st);
    var p = audio.play();
    if (p && p.catch) p.catch(function(){});
    fire('onChange', st);
  }
  function playFrom(albumId, i){
    return session(albumId).then(function(){ st.order = makeOrder(i, -1); start(i, 0); }).catch(function(e){ fire('onError', e, 'play'); });
  }
  /** 按放的顺序走 d 步（上一首 -1 / 下一首 +1）；到头：顺序不动，随机的「下一首」重新打乱接着放（ended 也走这里） */
  function step(d){
    if (st.i < 0) return Promise.resolve();
    if (st.order.length !== st.list.length) st.order = makeOrder(st.shuffle ? st.i : -1, -1);
    var p = pos() + d, j;
    if (p >= 0 && p < st.order.length) j = st.order[p];
    else if (d > 0 && st.shuffle && st.list.length) { st.order = makeOrder(-1, st.i); j = st.order[0]; }
    else return Promise.resolve();
    return session(st.album).then(function(){ start(j, 0); }).catch(function(e){ fire('onError', e, 'step'); });
  }
  /** 切播放模式：随机 = 以正在播的这首为第一首重新打乱；顺序 = 从正在播的这首按曲序往下 */
  function setShuffle(on){
    st.shuffle = !!on;
    st.order = makeOrder(st.shuffle && st.i >= 0 ? st.i : -1, -1);
    fire('onChange', st);
  }
  /** 上一首：放了 3 秒以上先回到这首开头 */
  function prev(){ if (audio.currentTime > 3) { audio.currentTime = 0; return Promise.resolve(); } return step(-1); }
  function next(){ return step(1); }
  function toggle(){
    if (st.i < 0) return false;
    if (audio.paused) { var p = audio.play(); if (p && p.catch) p.catch(function(){}); } else audio.pause();
    return true;
  }
  function stop(){ audio.pause(); st.i = -1; fire('onChange', st); fire('onStop', st); }
  /** 清空（专辑被删 / 切到只看模式）：停声、去掉地址、忘掉令牌 */
  function reset(){
    audio.pause(); audio.removeAttribute('src');
    st.album = 0; st.list = []; st.i = -1; st.expires = 0; st.retried = false; st.order = [];
    fire('onStop', st);
  }
  function setSpeed(s){ st.speed = s; audio.defaultPlaybackRate = s; audio.playbackRate = s; }

  audio.addEventListener('play', function(){
    if (ch) { try { ch.postMessage({ type: 'playing', from: id }); } catch (e) { /* 频道关了 */ } }
    fire('onChange', st);
  });
  audio.addEventListener('pause', function(){ fire('onChange', st); });
  /* 放完：还有下一首就接着放；顺序到尾停，随机放完一轮重新打乱接着放 */
  audio.addEventListener('ended', function(){ if (pos() + 1 < st.order.length || st.shuffle) step(1); else stop(); });
  /* 令牌过期（放到一半 / 暂停很久以后拖进度）：续签一次，接着原来的位置放 */
  audio.addEventListener('error', function(){
    if (st.i < 0 || st.retried) return;
    var at = audio.currentTime || 0, i = st.i;
    st.expires = 0;
    session(st.album).then(function(){ start(i, at); st.retried = true; }).catch(function(e){ fire('onError', e, 'retry'); });
  });
  /* 防同时响：别的页开播了，这边暂停 */
  if (ch) ch.onmessage = function(ev){
    var m = ev && ev.data;
    if (m && m.type === 'playing' && m.from !== id && playing()) audio.pause();
  };

  return {
    state: st, id: id,
    session: session, start: start, playFrom: playFrom, step: step, prev: prev, next: next,
    toggle: toggle, stop: stop, reset: reset, setSpeed: setSpeed, setShuffle: setShuffle, playing: playing,
  };
}

var api = { SPEEDS: SPEEDS, PLAYER_SPEEDS: PLAYER_SPEEDS, MODE_KEY: MODE_KEY, readMode: readMode, saveMode: saveMode, shuffleOrder: shuffleOrder, CHANNEL: CHANNEL, RENEW_MS: RENEW_MS, nextSpeed: nextSpeed, fmtTime: fmtTime, parseLrc: parseLrc, lrcIndex: lrcIndex, createPlayer: createPlayer };
if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
G.SgxMusicCore = api;
})();
