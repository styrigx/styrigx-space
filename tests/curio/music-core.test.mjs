/* 音乐播放共用核（space/web/assets/curio/js/music-core.js；音乐分层方案 v1.13 第二步 2a）：
   签令牌 / 续签、切曲、放完停、令牌过期续签一次接着放、倍速保持、防同时响（BroadcastChannel「sgx-music」）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const CORE = require('../../space/web/assets/curio/js/music-core.js');
const MU = require('../../space/web/assets/curio/js/curio-music.js');

class FakeAudio {
  constructor() { this.paused = true; this.ended = false; this.currentTime = 0; this.src = ''; this.playbackRate = 1; this.defaultPlaybackRate = 1; this.ls = {}; this.plays = 0; }
  addEventListener(n, f) { (this.ls[n] = this.ls[n] || []).push(f); }
  emit(n) { (this.ls[n] || []).forEach((f) => f()); }
  play() { this.paused = false; this.ended = false; this.plays++; this.emit('play'); return Promise.resolve(); }
  pause() { if (this.paused) return; this.paused = true; this.emit('pause'); }
  removeAttribute(k) { if (k === 'src') this.src = ''; }
}
/** 同一条频道上的几个端（模拟同源两页） */
function bus() {
  const ends = [];
  return () => { const e = { onmessage: null, postMessage(m) { ends.forEach((o) => { if (o !== e && o.onmessage) o.onmessage({ data: m }); }); } }; ends.push(e); return e; };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const tracks = (n, tag = 't') => Array.from({ length: n }, (_, i) => ({ title: 'T' + (i + 1), src: '/s?' + tag + '=' + i, lrc: '' }));

function make(opts = {}) {
  const audio = new FakeAudio();
  let clock = 1000;
  const signs = [];
  const log = [];
  const p = CORE.createPlayer({
    audio,
    now: () => clock,
    random: opts.random,
    channel: opts.channel || { onmessage: null, postMessage() {} }, /* 不开真的 BroadcastChannel（node 22 有，开了进程不退） */
    sign: (album) => { signs.push(album); if (opts.fail) return Promise.reject(opts.fail); return Promise.resolve({ tracks: tracks(opts.n || 3, 'a' + album + 's' + signs.length), ttl: 600000 }); },
    onTrack: (t) => log.push('track:' + t.title),
    onStop: () => log.push('stop'),
    onError: (e, where) => log.push('err:' + where),
  });
  return { p, audio, signs, log, setClock: (v) => { clock = v; } };
}

test('纯函数从共用核转出，curio-music.js 原有导出不变', () => {
  for (const k of ['SPEEDS', 'nextSpeed', 'fmtTime', 'parseLrc', 'lrcIndex']) assert.equal(MU[k], CORE[k], k);
  assert.equal(CORE.CHANNEL, 'sgx-music');
  assert.equal(CORE.nextSpeed(2), 0.75);
  assert.equal(CORE.fmtTime(3725), '1:02:05');
});

test('签令牌：同一张专辑、离过期 30 秒以上不重签；快过期再切曲先续签', async () => {
  const { p, signs, setClock } = make();
  await p.playFrom(7, 0);
  await p.next();
  assert.deepEqual(signs, [7]);
  assert.equal(p.state.i, 1);
  setClock(1000 + 600000 - 29000);
  await p.next();
  assert.deepEqual(signs, [7, 7], '剩不到 30 秒续签');
  assert.equal(p.state.i, 2);
  await p.playFrom(8, 0);
  assert.deepEqual(signs, [7, 7, 8], '换专辑重签');
});

test('切曲：上一首放了 3 秒以上回开头；越界不动；放完一首接下一首，最后一首放完停', async () => {
  const { p, audio, log } = make({ n: 2 });
  await p.playFrom(1, 0);
  audio.currentTime = 10;
  await p.prev();
  assert.equal(audio.currentTime, 0);
  assert.equal(p.state.i, 0);
  await p.prev();
  assert.equal(p.state.i, 0, '第一首再往前不动');
  audio.ended = true; audio.emit('ended'); await tick();
  assert.equal(p.state.i, 1);
  audio.paused = true; audio.ended = true; audio.emit('ended'); await tick();
  assert.equal(p.state.i, -1);
  assert.equal(log.at(-1), 'stop');
});

test('令牌过期（<audio> 报错）：续签一次接着原来的位置放；同一首再错不再续', async () => {
  const { p, audio, signs } = make();
  await p.playFrom(3, 1);
  audio.currentTime = 42;
  audio.emit('error'); await tick();
  assert.deepEqual(signs, [3, 3]);
  assert.equal(p.state.i, 1);
  assert.equal(audio.currentTime, 42);
  assert.match(audio.src, /s2/, '用新令牌的地址');
  audio.emit('error'); await tick();
  assert.deepEqual(signs, [3, 3], '只续一次');
});

test('签令牌失败：交给 onError，标明是点播还是续签', async () => {
  const { p, log } = make({ fail: Object.assign(new Error('locked'), { sgxLocked: true }) });
  await p.playFrom(1, 0);
  assert.deepEqual(log, ['err:play']);
});

test('倍速换曲目也保持；toggle 没在放时返回 false；reset 清掉令牌', async () => {
  const { p, audio } = make();
  assert.equal(p.toggle(), false);
  p.setSpeed(1.5);
  await p.playFrom(1, 0);
  await p.next();
  assert.equal(audio.playbackRate, 1.5);
  assert.equal(audio.defaultPlaybackRate, 1.5);
  assert.equal(p.toggle(), true);
  assert.equal(audio.paused, true);
  p.reset();
  assert.deepEqual([p.state.album, p.state.list.length, p.state.i, p.state.expires, audio.src], [0, 0, -1, 0, '']);
});

test('防同时响：一边开播，另一边（同一频道）自动暂停；自己的广播不停自己', async () => {
  const end = bus();
  const A = make({ channel: end() }), B = make({ channel: end() });
  await A.p.playFrom(1, 0);
  assert.equal(A.audio.paused, false);
  await B.p.playFrom(2, 0);
  assert.equal(B.audio.paused, false, '自己不停');
  assert.equal(A.audio.paused, true, '奇趣页 / 播放器另一边停');
  A.p.toggle();
  assert.equal(A.audio.paused, false);
  assert.equal(B.audio.paused, true);
});

test('curio-music.js 不再自己签令牌 / 续签（只走共用核）', () => {
  const src = readFileSync(new URL('../../space/web/assets/curio/js/curio-music.js', import.meta.url), 'utf8');
  assert.match(src, /sign: function\(albumId\)\{ return req\('POST', '\/curio\/api\/music-play'/, '签令牌只经 sign 回调');
  assert.doesNotMatch(src, /function (session|startTrack|step)\(/, '旧的签令牌 / 切曲函数已搬走');
  assert.match(src, /CORE\.createPlayer\(/);
  assert.doesNotMatch(src, /addEventListener\('(error|ended)'/, '续签 / 接下一首在共用核');
  const core = readFileSync(new URL('../../space/web/assets/curio/js/music-core.js', import.meta.url), 'utf8');
  assert.doesNotMatch(core, /document|querySelector/, '共用核不碰界面');
});

/* ---------- 2b：播放模式（顺序 / 随机）、播放器倍速档 ---------- */
/** 可复现的伪随机 */
function seeded(seed = 7) { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }

test('播放器倍速档 1 → 1.25 → 1.5 → 2 → 1；奇趣页 SPEEDS 不变（0.75–2）', () => {
  const L = CORE.PLAYER_SPEEDS;
  assert.deepEqual(L, [1, 1.25, 1.5, 2]);
  assert.deepEqual([1, 1.25, 1.5, 2].map((s) => CORE.nextSpeed(s, L)), [1.25, 1.5, 2, 1]);
  assert.deepEqual(CORE.SPEEDS, [0.75, 1, 1.25, 1.5, 2]);
  assert.equal(CORE.nextSpeed(2), 0.75);
});

test('shuffleOrder：不重复、first 排第一；avoid 不排第一', () => {
  const r = seeded(3);
  for (let k = 0; k < 50; k++) {
    const a = CORE.shuffleOrder(6, 4, -1, r);
    assert.equal(a[0], 4); assert.deepEqual([...a].sort(), [0, 1, 2, 3, 4, 5]);
    const b = CORE.shuffleOrder(6, -1, 2, r);
    assert.notEqual(b[0], 2); assert.deepEqual([...b].sort(), [0, 1, 2, 3, 4, 5]);
  }
  assert.deepEqual(CORE.shuffleOrder(1, -1, 0, r), [0], '只有一首时没法避开');
});

test('模式存本地：readMode / saveMode（键 sgx-music-mode；坏值、读不到 = 顺序）', () => {
  const m = new Map();
  const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  assert.equal(CORE.readMode(store), 'seq');
  CORE.saveMode(store, 'shuffle'); assert.equal(m.get('sgx-music-mode'), 'shuffle'); assert.equal(CORE.readMode(store), 'shuffle');
  m.set('sgx-music-mode', 'x'); assert.equal(CORE.readMode(store), 'seq');
  assert.equal(CORE.readMode({ getItem() { throw new Error('denied'); } }), 'seq');
  assert.equal(CORE.readMode(null), 'seq');
});

test('默认顺序（奇趣页不调 setShuffle）：放完停，同 2a', async () => {
  const { p, audio, log } = make({ n: 2 });
  await p.playFrom(1, 0);
  audio.emit('ended'); await tick();
  audio.emit('ended'); await tick();
  assert.deepEqual(log, ['track:T1', 'track:T2', 'stop']);
});

test('随机：从点的那首开始、一轮不重复；上一首回到刚才那首；放完一轮重新打乱接着放、不连着同一首', async () => {
  const { p, audio, log } = make({ n: 5, random: seeded(11) });
  p.setShuffle(true);
  await p.playFrom(1, 2);
  assert.equal(p.state.i, 2);
  const seen = [p.state.i];
  for (let k = 0; k < 4; k++) { audio.emit('ended'); await tick(); seen.push(p.state.i); }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4], '一轮五首不重复');
  audio.currentTime = 0;
  await p.prev();
  assert.equal(p.state.i, seen[3], '上一首 = 刚才那首');
  await p.next();
  const last = p.state.i;
  assert.equal(last, seen[4]);
  audio.emit('ended'); await tick();
  assert.notEqual(p.state.i, last, '新一轮第一首避开刚放完的');
  assert.ok(!log.includes('stop'), '随机放完一轮不停');
});

test('切回顺序：从正在播的这首按曲序往下，不跳回第一首；切到随机：当前这首排第一', async () => {
  const { p, audio } = make({ n: 5, random: seeded(5) });
  p.setShuffle(true);
  await p.playFrom(1, 3);
  audio.emit('ended'); await tick();
  const now = p.state.i;
  p.setShuffle(false);
  await p.next();
  assert.equal(p.state.i, now + 1 < 5 ? now + 1 : now, '按曲序往下');
  await p.playFrom(1, 1);
  p.setShuffle(true);
  assert.equal(p.state.order[0], 1, '正在播的排第一');
  assert.equal(p.state.order.length, 5);
});

test('播放器页纯函数：?album= 取专辑；签令牌失败分 登录过期（401）/ 没权限（403）/ 出错；Media Session 封面只在有封面时给', () => {
  const MP = require('../../space/web/assets/curio/js/music-player.js');
  assert.equal(MP.albumOf('?album=12'), 12);
  assert.equal(MP.albumOf('?x=1&album=3'), 3);
  assert.equal(MP.albumOf('?album=abc'), 0);
  assert.equal(MP.albumOf(''), 0);
  assert.equal(MP.failKind({ sgxLocked: true }), 'expired');
  assert.equal(MP.failKind({ status: 401 }), 'expired');
  assert.equal(MP.failKind({ code: 'forbidden', status: 403 }), 'noPermission');
  assert.equal(MP.failKind(new Error('x')), 'failed');
  assert.deepEqual(MP.artworkOf({ id: 4, cover: true }), [{ src: '/curio/api/music-cover?album=4', sizes: '512x512' }]);
  assert.deepEqual(MP.artworkOf({ id: 4, cover: false }), []);
  assert.deepEqual(MP.artworkOf(null), []);
});
