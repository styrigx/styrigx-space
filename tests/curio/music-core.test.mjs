/* 音乐播放共用核（space/web/assets/common/js/music/music-core.js；音乐分层方案 v1.13 第二步 2a）：
   签令牌 / 续签、切曲、放完停、令牌过期续签一次接着放、倍速保持、防同时响（BroadcastChannel「sgx-music」）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const CORE = require('../../space/web/assets/common/js/music/music-core.js');
const MU = require('../../space/web/assets/music/js/music-page.js');

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

test('纯函数从共用核转出；音乐页（music-page.js，music 搬家第 3 步起不出声）只留时间格式，倍速 / 歌词解析不再导出', () => {
  assert.equal(MU.fmtTime, CORE.fmtTime);
  for (const k of ['SPEEDS', 'nextSpeed', 'parseLrc', 'lrcIndex']) assert.equal(MU[k], undefined, k);
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

test('音乐页不出声（搬家设计稿 v1.1 3.3）：不建播放器、不签令牌、不碰 <audio>；点播放 = handOff（remote-cmd play + sgx-music-open）；共用核不碰界面', () => {
  const src = readFileSync(new URL('../../space/web/assets/music/js/music-page.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /CORE\.createPlayer\(/, '本页不建播放器');
  assert.doesNotMatch(code, /music-stream/, '本页不拉音频');
  /* music-play 只剩一处：编辑歌词时读这张的歌词正文（歌词只在签令牌时给，管理用，不是播放） */
  assert.equal((src.match(/'\/music\/api\/music-play'/g) || []).length, 1, 'music-play 只用来读歌词');
  assert.match(code, /return fetch\('\/music\/api\/music-play'/);
  assert.doesNotMatch(code, /mu-audio|mu-player|mu-lyrics|#mu-seek|#mu-toggle|#mu-speed|#mu-shuffle/, '播放条 / audio / 歌词条的选择器都删了');
  assert.doesNotMatch(code, /\.play\(\)|playbackRate/, '本页不出声');
  assert.match(code, /function handOff\(o, openAlbum, openI\)\{\n  if \(mc\) \{ try \{ mc\.postMessage\(playCmd\(o\)\); \} catch \(e\) \{\} \}/, '先发 remote-cmd play（不等 player-hello）');
  assert.match(code, /new CustomEvent\('sgx-music-open', \{ detail: \{ url: url \}, cancelable: true \}\)/, '再发可取消的 sgx-music-open，顶栏 mountMusic 开窗');
  assert.match(code, /if \(viewOnly\) return askSudo\(\);/, '只看模式点播放发 sgx:sudo，不开播放器');
  const tpl = readFileSync(new URL('../../space/web/layouts/music/section.html', import.meta.url), 'utf8').replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, '');
  for (const id of ['mu-player', 'mu-audio', 'mu-lyrics', 'mu-seek', 'mu-toggle', 'mu-speed', 'mu-shuffle', 'mu-prev', 'mu-next', '<audio']) assert.ok(!tpl.includes(id), '模板没有 ' + id);
  const core = readFileSync(new URL('../../space/web/assets/common/js/music/music-core.js', import.meta.url), 'utf8');
  assert.doesNotMatch(core, /document|querySelector/, '共用核不碰界面');
});

test('音乐页交接的纯函数：playerPathOf / playerUrl（?album=&t=，中英）、playCmd（专辑 album + i；单曲 queue + i）、窗口名同顶栏', async () => {
  const { MUSIC_WIN, PLAYER_URL } = await import('../../space/web/assets/common/js/frame/topbar/panel.js');
  assert.equal(MU.PLAYER_WIN, MUSIC_WIN);
  assert.equal(MU.playerPathOf('/music/'), '/music/player/');
  assert.equal(MU.playerPathOf('/music/zh/'), '/music/zh/player/');
  assert.equal(MU.playerPathOf(''), '/music/player/');
  assert.equal(MU.playerUrl('/music/', 3, 2), '/music/player/?album=3&t=2');
  assert.equal(MU.playerUrl('/music/zh/', '12', '0'), '/music/zh/player/?album=12&t=0');
  for (const u of [MU.playerUrl('/music/', 3, 2), MU.playerUrl('/music/zh/', 9, 0)]) assert.ok(PLAYER_URL.test(u), u + ' 过顶栏白名单');
  assert.deepEqual(MU.playCmd({ album: '7', i: 3 }), { type: 'remote-cmd', cmd: 'play', i: 3, album: 7 });
  const q = [11, 12, 13];
  const m = MU.playCmd({ queue: q, i: 1 });
  assert.deepEqual(m, { type: 'remote-cmd', cmd: 'play', i: 1, queue: [11, 12, 13] });
  assert.notEqual(m.queue, q, '复制一份，不和页面的数组共用');
  assert.equal('album' in m, false);
});

test('播放器 ?t= 与 startOf（第 3 步）：专辑停在那张、t 在范围内才放；单曲记录 → 单曲组里它那一首（只认 t=0）；没有这张 → 第一张不放', () => {
  const MP = require('../../space/web/assets/common/js/music/music-player.js');
  assert.equal(MP.trackOf('?album=3&t=2'), 2);
  assert.equal(MP.trackOf('?t=0&album=3'), 0);
  assert.equal(MP.trackOf('?album=3'), -1);
  assert.equal(MP.trackOf('?album=3&t=x'), -1);
  assert.equal(MP.trackOf('?album=3&t=12345'), -1, '最多 4 位');
  assert.equal(MP.trackOf(''), -1);
  const all = [
    { id: 1, kind: 'album', title: 'A', tracks: [{ id: 10, title: 'a1' }, { id: 11, title: 'a2' }, { id: 12, title: 'a3' }] },
    { id: 2, kind: 'single', title: 'S1', tracks: [{ id: 20, title: 'S1' }] },
    { id: 4, kind: 'album', title: 'B', tracks: [{ id: 40, title: 'b1' }] },
    { id: 3, kind: 'single', title: 'S2', tracks: [{ id: 30, title: 'S2' }] },
  ];
  const g = MP.groupsOf(all, 'Singles');
  assert.deepEqual(g.map((x) => x.id), [1, 4, -1]);
  assert.deepEqual(MP.startOf(g, all, 1, 2), { cur: 0, i: 2 });
  assert.deepEqual(MP.startOf(g, all, 4, 0), { cur: 1, i: 0 });
  assert.deepEqual(MP.startOf(g, all, 1, 3), { cur: 0, i: -1 }, 't 越界只显示不放');
  assert.deepEqual(MP.startOf(g, all, 1, -1), { cur: 0, i: -1 }, '没 t（顶栏图标开的）只显示不放');
  assert.deepEqual(MP.startOf(g, all, 3, 0), { cur: 2, i: 1 }, '单曲记录：单曲组里它那一首');
  assert.deepEqual(MP.startOf(g, all, 2, 0), { cur: 2, i: 0 });
  assert.deepEqual(MP.startOf(g, all, 3, 1), { cur: 2, i: -1 }, '单曲只认 t=0');
  assert.deepEqual(MP.startOf(g, all, 99, 0), { cur: 0, i: -1 }, '没有这张（刚删）：第一张不放');
  assert.deepEqual(MP.startOf(g, all, 0, -1), { cur: 0, i: -1 });
  assert.deepEqual(MP.startOf([], [], 1, 0), { cur: 0, i: -1 });
});

test('播放器收 remote-cmd play（第 3 步）：专辑 / 单曲两种消息都认；只看模式只提示；歌单里没有先重取一次', () => {
  const src = readFileSync(new URL('../../space/web/assets/common/js/music/music-player.js', import.meta.url), 'utf8');
  assert.match(src, /else if \(m\.cmd === 'play'\) playCmd\(m\);/);
  const fn = src.slice(src.indexOf('function playCmd(m, again){'), src.indexOf("$('#mp-tracks').addEventListener"));
  assert.match(fn, /if \(viewOnly\) \{ note\('locked'\); return; \}/);
  assert.match(fn, /Array\.isArray\(m\.queue\)/);
  assert.match(fn, /P\.playQueue\(q, i\)/);
  assert.match(fn, /P\.playFrom\(id, i\)/);
  assert.equal((fn.match(/if \(!again\) reload\(\)\.then\(function\(\)\{ playCmd\(m, true\); \}\)/g) || []).length, 2, '专辑 / 单曲都只重取一次');
  assert.match(src, /if \(go\.i >= 0 && !viewOnly\) playFrom\(go\.i\);/, '?t= 开窗就从那首放（只看模式不放）');
});

/* ---------- 2b：播放模式（顺序 / 随机）、播放器倍速档 ---------- */
/** 可复现的伪随机 */
function seeded(seed = 7) { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }

test('播放器倍速档 1 → 1.25 → 1.5 → 2 → 1；共用核 SPEEDS 不变（0.75–2；音乐页不再用，核的逻辑不改）', () => {
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
  const MP = require('../../space/web/assets/common/js/music/music-player.js');
  assert.equal(MP.albumOf('?album=12'), 12);
  assert.equal(MP.albumOf('?x=1&album=3'), 3);
  assert.equal(MP.albumOf('?album=abc'), 0);
  assert.equal(MP.albumOf(''), 0);
  assert.equal(MP.failKind({ sgxLocked: true }), 'expired');
  assert.equal(MP.failKind({ status: 401 }), 'expired');
  assert.equal(MP.failKind({ code: 'forbidden', status: 403 }), 'noPermission');
  assert.equal(MP.failKind(new Error('x')), 'failed');
  assert.deepEqual(MP.artworkOf({ id: 4, cover: true }), [{ src: '/music/api/music-cover?album=4', sizes: '512x512' }]);
  assert.deepEqual(MP.artworkOf({ id: 4, cover: false }), []);
  assert.deepEqual(MP.artworkOf(null), []);
});

test('播放器给小遥控层的状态：有一首 = on，歌名 + 本专辑歌手；没开播 = 空', () => {
  const MP = require('../../space/web/assets/common/js/music/music-player.js');
  const albums = [{ id: 3, artist: 'Singer' }];
  assert.deepEqual(MP.remoteState({ album: 3, list: [{ title: 'A' }, { title: 'B' }], i: 1 }, true, albums),
    { type: 'player-state', on: true, playing: true, title: 'B', artist: 'Singer' });
  assert.deepEqual(MP.remoteState({ album: 3, list: [{ title: 'A' }], i: 0 }, false, []),
    { type: 'player-state', on: true, playing: false, title: 'A', artist: '' });
  assert.deepEqual(MP.remoteState({ album: 0, list: [], i: -1 }, true, albums),
    { type: 'player-state', on: false, playing: false, title: '', artist: '' });
});

/* ---------- 单曲列表（音乐 v1.13 ②，Gray 2026-11-14 17:33：单曲区当播放列表，按当前模式走、到尾停，切歌按需签） ---------- */

test('单曲列表 playQueue：每首按需签自己那条记录；放完接下一首、到尾停；state.album = 正在放的单曲记录', async () => {
  const { p, audio, signs, log } = make({ n: 1 });
  await p.playQueue([11, 12, 13], 0);
  assert.deepEqual(signs, [11], '只签第一首');
  assert.equal(p.state.album, 11);
  assert.match(audio.src, /a11s1/);
  audio.emit('ended'); await tick(); await tick();
  assert.deepEqual(signs, [11, 12], '切到第二首才签它');
  assert.equal(p.state.album, 12);
  assert.equal(p.state.i, 1);
  audio.emit('ended'); await tick(); await tick();
  assert.equal(p.state.album, 13);
  audio.emit('ended'); await tick();
  assert.equal(p.state.i, -1, '到尾停');
  assert.equal(log.at(-1), 'stop');
  /* 回到第一首：令牌还有效，不重签 */
  await p.playQueue([11, 12, 13], 0);
  assert.deepEqual(signs, [11, 12, 13]);
  await p.prev();
  assert.equal(p.state.i, 0, '第一首再往前不动');
});

test('单曲列表：上一首 / 下一首按列表；快过期的那首先续签；放到一半出错续签这一首接着放', async () => {
  const { p, audio, signs, setClock } = make({ n: 1 });
  await p.playQueue([5, 6], 1);
  assert.deepEqual(signs, [6]);
  await p.prev();
  assert.equal(p.state.album, 5);
  assert.deepEqual(signs, [6, 5]);
  setClock(1000 + 600000 - 10000);
  await p.next();
  assert.deepEqual(signs, [6, 5, 6], '第二首快过期了，先续签');
  audio.currentTime = 42;
  audio.emit('error'); await tick(); await tick();
  assert.deepEqual(signs, [6, 5, 6, 6]);
  assert.equal(audio.currentTime, 42);
  assert.equal(p.state.album, 6);
});

test('单曲列表 ↔ 专辑：换了列表丢掉旧令牌；从单曲回到专辑重新按专辑签；随机模式在单曲列表里同样打乱', async () => {
  const seq = [0.1, 0.9, 0.5, 0.3, 0.7];
  let k = 0;
  const { p, signs } = make({ n: 1, random: () => seq[k++ % seq.length] });
  await p.playQueue([1, 2, 3], 0);
  await p.playFrom(9, 0);
  assert.equal(p.state.queue, null);
  assert.equal(p.state.album, 9);
  await p.playQueue([1, 2], 0);
  assert.deepEqual(signs, [1, 9, 1], '列表变了重签');
  p.setShuffle(true);
  assert.equal(p.state.order.length, 2);
  assert.equal(p.state.order[0], 0, '随机：正在放的排第一');
  await p.next();
  assert.equal(p.state.album, 2);
});

test('单曲 / 专辑分类的纯函数：nowSub（单曲只显示歌手）、splitKinds / pickSection（哪边为空显示另一边）、播放器 groupsOf（末尾单曲组）', () => {
  const PL = require('../../space/web/assets/common/js/music/music-player.js');
  const alb = { id: 1, kind: 'album', title: 'Blue', artist: 'Joni Mitchell', tracks: [{ id: 10, title: 'All I Want', duration: 214 }] };
  const s1 = { id: 2, kind: 'single', title: 'River', artist: 'Joni Mitchell', tracks: [{ id: 20, title: 'River', duration: 240 }] };
  const s2 = { id: 3, kind: 'single', title: '空的', artist: '', tracks: [] };
  assert.equal(CORE.nowSub(alb), 'Blue · Joni Mitchell');
  assert.equal(CORE.nowSub(s1), 'Joni Mitchell');
  assert.equal(CORE.nowSub({ ...alb, kind: undefined }), 'Blue · Joni Mitchell', '旧数据没 kind 当专辑');
  assert.equal(CORE.nowSub(null), '');
  const k = MU.splitKinds([s1, alb, s2]);
  assert.deepEqual(k.albums.map((a) => a.id), [1]);
  assert.deepEqual(k.singles.map((a) => a.id), [2, 3]);
  assert.equal(MU.pickSection('album', 1, 2), 'album');
  assert.equal(MU.pickSection('single', 1, 2), 'single');
  assert.equal(MU.pickSection('album', 0, 2), 'single', '没专辑只显示单曲');
  assert.equal(MU.pickSection('single', 3, 0), 'album', '没单曲只显示专辑');
  assert.equal(MU.pickSection('single', 0, 0), 'album');
  const g = PL.groupsOf([s1, alb, s2], '单曲');
  assert.deepEqual(g.map((x) => x.id), [1, -1]);
  assert.equal(g[1].singles, true);
  assert.equal(g[1].title, '单曲');
  assert.deepEqual(g[1].items.map((x) => x.id), [2], '没有音频的单曲不进列表');
  assert.deepEqual(g[1].tracks, [{ id: 20, no: 0, title: 'River', duration: 240 }]);
  assert.deepEqual(PL.groupsOf([alb], 'x').map((x) => x.id), [1], '没单曲不加组');
  /* 遥控层：单曲在播时只给歌手 */
  const r = PL.remoteState({ album: 2, list: [{ title: 'River' }], i: 0 }, true, [alb, s1]);
  assert.deepEqual(r, { type: 'player-state', on: true, playing: true, title: 'River', artist: 'Joni Mitchell' });
});

test('durText：元数据到了用真实 duration；没到 / NaN / Infinity / 0 用曲目已知时长；都没有 --:--', () => {
  assert.equal(CORE.durText(1.2, 240), '0:01');
  assert.equal(CORE.durText(NaN, 240), '4:00');
  assert.equal(CORE.durText(Infinity, 269), '4:29');
  assert.equal(CORE.durText(0, 271), '4:31');
  assert.equal(CORE.durText(undefined, 3725), '1:02:05');
  assert.equal(CORE.durText(NaN, 0), '--:--');
  assert.equal(CORE.durText(NaN, undefined), '--:--');
  assert.equal(CORE.durText(245.6, 0), '4:05');
});

/* ---------- M4（音乐 v1.19 7.5 / 十二 M4）：单曲封面回退、主窗口挑选 ---------- */
test('M4 coverOf：有封面用自己的；单曲没封面 → 歌手头像；歌手没头像 / 专辑没封面 → 空（默认图）', () => {
  const arts = [{ id: 2, avatar: true }, { id: 5, avatar: false }];
  assert.equal(CORE.coverOf({ id: 7, kind: 'album', cover: true, artist_id: 2 }, arts), '/music/api/music-cover?album=7');
  assert.equal(CORE.coverOf({ id: 7, kind: 'single', cover: true, artist_id: 2 }, arts, 9), '/music/api/music-cover?album=7&v=9');
  assert.equal(CORE.coverOf({ id: 8, kind: 'single', cover: false, artist_id: 2 }, arts), '/music/api/music-cover?artist=2');
  assert.equal(CORE.coverOf({ id: 8, kind: 'single', cover: false, artist_id: 5 }, arts), '');
  assert.equal(CORE.coverOf({ id: 8, kind: 'single', cover: false, artist_id: 0 }, arts), '');
  assert.equal(CORE.coverOf({ id: 8, kind: 'single', cover: false, artist_id: 99 }, arts), '', '对不上歌手表');
  assert.equal(CORE.coverOf({ id: 9, kind: 'album', cover: false, artist_id: 2 }, arts), '', '专辑不回退到歌手头像（7.5 只说单曲）');
  assert.equal(CORE.coverOf(null, arts), '');
});

test('M4 pickMain：挑最近用过的主窗口（at 最大，一样取先答的）；没人答 null；artistHref', () => {
  assert.equal(CORE.pickMain([]), null);
  assert.equal(CORE.pickMain([{ from: 'a', at: 5 }, { from: 'b', at: 9 }, { from: 'c', at: 9 }]).from, 'b');
  assert.equal(CORE.pickMain([{ from: '', at: 99 }, { from: 'x', at: 1 }]).from, 'x');
  assert.equal(CORE.artistHref('/music/zh/', 3), '/music/zh/?artist=3');
  assert.deepEqual(Object.values(CORE.ARTIST_MSG), ['artist-ask', 'artist-here', 'artist-go']);
});

test('M4 music-page 纯函数：artistOf 读 ?artist=；artistWorks 按 artist_id 分专辑 / 单曲；similarArtist 只差大小写 / 空格才提示；squareCrop 取中间正方形 ≤ 1000', () => {
  assert.equal(MU.artistOf('?artist=12'), 12);
  assert.equal(MU.artistOf('?x=1&artist=3'), 3);
  for (const q of ['', '?artist=', '?artist=0', '?artist=-1', '?artist=1x', '?artist=99999999999']) assert.equal(MU.artistOf(q), 0, q);
  const list = [
    { id: 1, kind: 'album', artist_id: 2 }, { id: 2, kind: 'single', artist_id: 2 }, { id: 3, kind: 'album', artist_id: 5 }, { id: 4, kind: 'single', artist_id: 2 },
  ];
  const w = MU.artistWorks(list, 2);
  assert.deepEqual([w.albums.map((a) => a.id), w.singles.map((a) => a.id)], [[1], [2, 4]]);
  assert.deepEqual(MU.artistWorks(list, 0), { albums: [], singles: [] });
  const arts = [{ id: 1, name: 'Jay Chou' }, { id: 2, name: '周杰伦' }];
  assert.equal(MU.similarArtist('jay chou', arts), 'Jay Chou');
  assert.equal(MU.similarArtist(' JayChou ', arts), 'Jay Chou');
  assert.equal(MU.similarArtist('Jay Chou', arts), '', '完全一样 = 同一个人，不提示');
  assert.equal(MU.similarArtist('周杰倫', arts), '', '繁简不合并（十一 第 4 条）');
  assert.equal(MU.similarArtist('', arts), '');
  assert.deepEqual(MU.squareCrop(3000, 2000, 1000), { sx: 500, sy: 0, side: 2000, out: 1000 });
  assert.deepEqual(MU.squareCrop(400, 600, 1000), { sx: 0, sy: 100, side: 400, out: 400 });
});

test('M4 music-page relatedAlbums（歌手页诚实空状态，Gray 2026-11-20）：别的歌手的专辑里有 TA 的曲目 → 那些专辑（不算单曲记录、不算 TA 自己的），保持顺序', () => {
  const tr = (id, artist_id) => ({ id, artist_id });
  const list = [
    { id: 1, kind: 'album', artist_id: 2, tracks: [tr(11, 2), tr(12, 7)] },
    { id: 2, kind: 'single', artist_id: 5, tracks: [tr(21, 7)] },
    { id: 3, kind: 'album', artist_id: 7, tracks: [tr(31, 7)] },
    { id: 4, kind: 'album', artist_id: 0, tracks: [tr(41, 7), tr(42, 7)] },
    { id: 5, kind: 'album', artist_id: 2, tracks: [] },
    { id: 6, kind: 'album', artist_id: 2 },
  ];
  assert.deepEqual(MU.relatedAlbums(list, 7).map((a) => a.id), [1, 4]);
  assert.deepEqual(MU.relatedAlbums(list, 9), []);
  assert.deepEqual(MU.relatedAlbums(list, 0), []);
  assert.deepEqual(MU.relatedAlbums(null, 7), []);
});
