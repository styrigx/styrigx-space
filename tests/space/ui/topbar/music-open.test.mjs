/**
 * 音乐分层方案 v1.13 第二步 2c：顶栏音乐图标点开播放器（topbar/panel.js mountMusic）。
 * 没开就弹、已开切过去、被拦直接跳转，单窗口。浏览器里的真弹窗在 tests/space/e2e/topbar/music-open.spec.js。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountMusic, MUSIC_WIN, MUSIC_FEATURES, MUSIC_PATH, PLAYER_URL, ARTIST_URL, ALBUM_URL, LIBRARY_URL, MUSIC_PAGE, HANDOFF_WAIT_MS, playCmdOk, stateOf, linkOf } from '../../../../space/web/assets/common/js/frame/topbar/panel.js';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const URL_EN = 'https://styrigx.com/music/player/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 打磨 6.3：有频道时开 / 切播放器要先握手，测试里把等待缩到 W（有一条用真的 HANDOFF_WAIT_MS） */
const W = 20;

function fakeDoc() {
  const btn = { href: URL_EN, h: null, addEventListener(t, f) { if (t === 'click') this.h = f; } };
  return { btn, doc: { querySelector: (s) => (s === '.sgx-tb-music' ? btn : null) } };
}
function win(href, pathname) {
  return { focused: 0, location: { href, pathname }, focus() { this.focused++; } };
}
function setup(w) {
  const { btn, doc } = fakeDoc();
  const calls = [], nav = [];
  const go = mountMusic(doc, { open: (u, n, f) => { calls.push([u, n, f]); return typeof w === 'function' ? w() : w; }, navigate: (u) => nav.push(u) });
  return { btn, go, calls, nav };
}

test('没开：空 URL + 固定窗口名开小窗，再让新窗去播放器页并 focus', () => {
  const w = win('about:blank', 'blank');
  const { go, calls, nav } = setup(w);
  assert.equal(go(URL_EN), 'opened');
  assert.deepEqual(calls, [['', MUSIC_WIN, MUSIC_FEATURES]]);
  assert.equal(w.location.href, URL_EN);
  assert.equal(w.focused, 1);
  assert.deepEqual(nav, []);
});

test('已开：找到同名播放器窗只 focus，不改地址（歌不断）', () => {
  const w = win(URL_EN + '?album=3', '/music/player/');
  const { go } = setup(w);
  assert.equal(go(URL_EN), 'focused');
  assert.equal(w.location.href, URL_EN + '?album=3');
  assert.equal(w.focused, 1);
});

test('同名窗口已走到别的页：让它回播放器页', () => {
  const w = win('https://styrigx.com/blog/', '/blog/');
  const { go } = setup(w);
  assert.equal(go(URL_EN), 'opened');
  assert.equal(w.location.href, URL_EN);
});

test('被拦（window.open 回 null / 抛错）：本页直接跳到播放器页', () => {
  const a = setup(null);
  assert.equal(a.go(URL_EN), 'navigated');
  assert.deepEqual(a.nav, [URL_EN]);
  const b = setup(() => { throw new Error('blocked'); });
  assert.equal(b.go(URL_EN), 'navigated');
  assert.deepEqual(b.nav, [URL_EN]);
});

test('读不了窗口地址（不同源）：当它是播放器，只 focus', () => {
  const w = { focused: 0, get location() { throw new Error('SecurityError'); }, focus() { this.focused++; } };
  const { go, nav } = setup(w);
  assert.equal(go(URL_EN), 'focused');
  assert.equal(w.focused, 1);
  assert.deepEqual(nav, []);
});

test('点击：普通左键拦下走 go；中键 / 修饰键照旧按链接走', () => {
  const w = win('about:blank', 'blank');
  const { btn, calls } = setup(w);
  const ev = (o) => Object.assign({ button: 0, defaultPrevented: false, prevented: 0, preventDefault() { this.prevented++; }, stopImmediatePropagation() {} }, o);
  for (const o of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { defaultPrevented: true }]) {
    const e = ev(o); btn.h(e); assert.equal(e.prevented, 0, JSON.stringify(o));
  }
  assert.equal(calls.length, 0);
  const e = ev({}); btn.h(e);
  assert.equal(e.prevented, 1);
  assert.equal(calls.length, 1);
});

test('没有音乐图标的页不接线', () => {
  assert.equal(mountMusic({ querySelector: () => null }), null);
});

test('播放器路径（英文 / 中文；music 搬家第 3 步起 /music/player/、/music/zh/player/，旧地址同一条正则也认）', () => {
  assert.ok(MUSIC_PATH.test('/music/player/'));
  assert.ok(MUSIC_PATH.test('/music/zh/player/'));
  assert.ok(MUSIC_PATH.test('/curio/music/player/'));
  assert.ok(MUSIC_PATH.test('/curio/zh/music/player/'));
  assert.ok(!MUSIC_PATH.test('/music/'));
  assert.ok(!MUSIC_PATH.test('/music/zh/'));
});

test('音乐页交接的播放器地址白名单（PLAYER_URL）：只认 /music/(zh/)player/?album=<数字>&t=<数字>', () => {
  for (const u of ['/music/player/?album=3&t=0', '/music/zh/player/?album=12&t=7', '/music/player/?album=1234567890&t=9999']) assert.ok(PLAYER_URL.test(u), u);
  for (const u of ['/music/player/?album=3', '/music/player/?t=0&album=3', '/curio/music/player/?album=3&t=0', 'https://evil.com/music/player/?album=3&t=0',
    '//evil.com/music/player/?album=3&t=0', '/music/player/?album=3&t=0&x=1', '/music/player/?album=x&t=0', '/music/en/player/?album=3&t=0', 'javascript:alert(1)']) assert.ok(!PLAYER_URL.test(u), u);
  /* 歌手页地址：只认新音乐页 */
  assert.ok(ARTIST_URL.test('/music/?artist=3') && ARTIST_URL.test('/music/zh/?artist=3'));
  assert.ok(!ARTIST_URL.test('/curio/music/?artist=3') && !ARTIST_URL.test('/music/player/?artist=3'));
});

test('四站顶栏的音乐链接都指向播放器页（当前语言）；播放器页把窗口名设成同一个', () => {
  for (const p of ['space/web/layouts/_default/baseof.html', 'space/web/layouts/curio/baseof.html', 'space/web/layouts/daymark/baseof.html', 'space/web/layouts/music/baseof.html', 'space/web/layouts/partials/blog/topnav.html']) {
    assert.match(rd(p), /"music" \(partial "common\/lang-path\.html" \(dict "path" "(https:\/\/styrigx\.com)?\/music\/player\/"/, p);
  }
  const mp = rd('space/web/assets/common/js/music/music-player.js');
  assert.ok(mp.includes("var WIN = '" + MUSIC_WIN + "'"));
  assert.match(rd('space/web/assets/common/js/frame/topbar/panel.js'), /\n  mountMusic\(doc\);\n/);
});

/* ---------- 小遥控层（方案 v1.13 §九）：BroadcastChannel 问「在播什么」，播放器答了且有一首在播 / 暂停着才弹遥控层 ---------- */
function cls() { const s = new Set(); return { s, toggle(c, on) { if (on) s.add(c); else s.delete(c); }, contains: (c) => s.has(c) }; }
function el(attrs) {
  const a = Object.assign({}, attrs || {});
  return { textContent: '', hidden: false, title: '', classList: cls(), getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); }, a };
}
function remoteSetup(path, wait) {
  const btn = { href: URL_EN, hs: [], classList: cls(), addEventListener(t, f) { if (t === 'click') this.hs.push(f); } };
  const parts = { '[data-mu-title]': el(), '[data-mu-artist]': el(), '[data-mu="toggle"]': el({ 'data-l-play': 'Play', 'data-l-pause': 'Pause' }) };
  const dlg = Object.assign(el(), { h: null, querySelector: (s) => parts[s] || null, addEventListener(t, f) { if (t === 'click') this.h = f; } });
  const events = [];
  const doc = { querySelector: (s) => (s === '.sgx-tb-music' ? btn : null), getElementById: (id) => (id === 'sgx-mu' ? dlg : null), dispatchEvent: (e) => { events.push(e.type); } };
  const sent = [];
  const ch = { onmessage: null, postMessage: (m) => sent.push(m) };
  const opened = [];
  const go = mountMusic(doc, { channel: ch, path: path || '/zh/status/', wait: wait == null ? W : wait, open: (u, n) => { opened.push(n); return win(URL_EN, '/music/player/'); }, navigate: () => {} });
  const say = (m) => ch.onmessage({ data: m });
  const click = () => { const e = { button: 0, defaultPrevented: false, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopImmediatePropagation() { this.stopped++; } }; btn.hs.forEach((f) => f(e)); return e; };
  return { btn, dlg, parts, doc, ch, sent, opened, go, say, click, events };
}

test('遥控：加载先握手 player-hello {req, from}；刚加载就点（还没到点）→ 等满 HANDOFF_WAIT_MS 没人答才开播放器、拦住遥控层', async () => {
  assert.equal(HANDOFF_WAIT_MS, 300);
  const r = remoteSetup(undefined, HANDOFF_WAIT_MS);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0], { type: 'player-hello', req: r.sent[0].req, from: r.go.pageId });
  assert.equal(typeof r.sent[0].req, 'string');
  const t0 = Date.now();
  const e = r.click();
  assert.equal(e.prevented, 1); assert.equal(e.stopped, 1);
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].type, 'player-hello');
  assert.equal(typeof r.sent[1].req, 'string');
  assert.equal(r.sent[1].from, r.go.pageId);
  assert.deepEqual(r.opened, [], '还在等回答');
  await sleep(HANDOFF_WAIT_MS - 100);
  assert.deepEqual(r.opened, []);
  await sleep(200);
  assert.deepEqual(r.opened, [MUSIC_WIN]);
  assert.ok(Date.now() - t0 >= HANDOFF_WAIT_MS - 5);
});

test('遥控：播放器答了在播 → 放行给遥控层，画歌名 / 歌手 / 暂停钮，图标亮小点', () => {
  const r = remoteSetup();
  r.say({ type: 'player-state', on: true, playing: true, title: 'Song A', artist: 'Singer' });
  assert.equal(r.parts['[data-mu-title]'].textContent, 'Song A');
  assert.equal(r.parts['[data-mu-artist]'].textContent, 'Singer');
  assert.equal(r.parts['[data-mu-artist]'].hidden, false);
  assert.equal(r.parts['[data-mu="toggle"]'].a['aria-label'], 'Pause');
  assert.ok(r.btn.classList.contains('is-playing'));
  const e = r.click();
  assert.equal(e.prevented, 0); assert.equal(e.stopped, 0);
  assert.deepEqual(r.opened, []);
});

test('遥控：暂停着也弹遥控层（小点灭）；没开播 / 放完（on=false）只开播放器', () => {
  const r = remoteSetup();
  r.say({ type: 'player-state', on: true, playing: false, title: 'Song A', artist: '' });
  assert.ok(!r.btn.classList.contains('is-playing'));
  assert.equal(r.parts['[data-mu-artist]'].hidden, true);
  assert.equal(r.parts['[data-mu="toggle"]'].a['aria-label'], 'Play');
  assert.equal(r.click().prevented, 0);
  r.say({ type: 'player-state', on: false, playing: false, title: '', artist: '' });
  assert.equal(r.click().prevented, 1);
  assert.ok(r.events.includes('sgx-music-off'));
});

test('遥控：播放器关窗（player-bye）→ 回到只开播放器，并通知收起遥控层', () => {
  const r = remoteSetup();
  r.say({ type: 'player-state', on: true, playing: true, title: 'A', artist: 'B' });
  r.events.length = 0;
  r.say({ type: 'player-bye' });
  assert.ok(!r.btn.classList.contains('is-playing'));
  assert.deepEqual(r.events, ['sgx-music-off', 'sgx-music-state']);
  assert.equal(r.click().prevented, 1);
});

test('遥控层按钮：上一曲、播放/暂停、下一曲发 remote-cmd；「播放器」切到播放器窗', async () => {
  const r = remoteSetup();
  r.say({ type: 'player-state', on: true, playing: true, title: 'A', artist: 'B' });
  const hit = (k) => r.dlg.h({ target: { closest: (s) => (s === '[data-mu]' ? { getAttribute: () => k } : null) } });
  hit('toggle');
  assert.deepEqual(r.sent.at(-1), { type: 'remote-cmd', cmd: 'toggle' });
  assert.equal(r.parts['[data-mu="toggle"]'].a['aria-label'], 'Play');
  hit('prev');
  assert.deepEqual(r.sent.at(-1), { type: 'remote-cmd', cmd: 'prev' });
  hit('next');
  assert.deepEqual(r.sent.at(-1), { type: 'remote-cmd', cmd: 'next' });
  hit('open');
  assert.deepEqual(r.opened, [], '先握手');
  await sleep(W + 30);
  assert.deepEqual(r.opened, [MUSIC_WIN]);
});

test('遥控：播放器页自己的顶栏不弹遥控层，点了只切过去；不认的消息不动', () => {
  const r = remoteSetup('/music/zh/player/');
  r.say({ type: 'player-state', on: true, playing: true, title: 'A', artist: 'B' });
  assert.equal(r.click().prevented, 1);
  assert.equal(r.go.remoteOn(), false);
  const r2 = remoteSetup();
  r2.say({ type: 'playing', from: 'x' });
  assert.equal(r2.go.state(), null);
});

test('四站顶栏都有遥控层标记；播放器页答 player-hello / 收 remote-cmd / 关窗发 player-bye', () => {
  const tb = rd('space/web/layouts/partials/common/frame/topbar.html');
  assert.match(tb, /<dialog id="sgx-mu" class="sgx-qp sgx-mu"/);
  for (const k of ['data-mu-title', 'data-mu-artist', 'data-mu="prev"', 'data-mu="toggle"', 'data-mu="next"', 'data-mu="open"']) assert.ok(tb.includes(k), k);
  const mp = rd('space/web/assets/common/js/music/music-player.js');
  for (const k of ["'player-hello'", "'remote-cmd'", "'player-bye'", "m.cmd === 'prev'"]) assert.ok(mp.includes(k), k);
  for (const l of ['en', 'zh']) assert.match(rd(`space/web/data/common/frame/i18n/${l}.yaml`), /musicNow: .+\n  musicPlay: .+\n  musicPause: .+\n  musicPrev: .+\n  musicNext: .+\n  musicOpen: .+/);
});

/* ---------- 歌手页（M4，音乐 v1.19 十二 M4 第 3 条）：播放器点歌手名 → 主窗口打开歌手页，播放器不跳走 ---------- */
function artistSetup(path, extra) {
  const r = remoteSetup(path);
  const nav = [];
  /* 重新接一次，拿得到 navigate；doc 带 dispatchEvent（可取消） */
  const ch = { onmessage: null, postMessage: (m) => sent.push(m) };
  const sent = [];
  const fired = [];
  const doc = Object.assign({}, r.doc, { dispatchEvent: (e) => { fired.push(e); if (extra && extra.cancel && e.type === 'sgx-music-artist') e.preventDefault(); return !e.defaultPrevented; } });
  mountMusic(doc, { channel: ch, path: path || '/blog/', open: () => null, navigate: (u) => nav.push(u) });
  return { ch, sent, nav, fired, say: (m) => ch.onmessage({ data: m }) };
}

test('歌手页：主窗口答 artist-ask（带本页 id 和最近用过的时间）；播放器页自己不答', () => {
  const a = artistSetup('/blog/');
  a.sent.length = 0;
  a.say({ type: 'artist-ask', req: 'r1', id: 3 });
  assert.equal(a.sent.length, 1);
  assert.equal(a.sent[0].type, 'artist-here');
  assert.equal(a.sent[0].req, 'r1');
  assert.equal(typeof a.sent[0].from, 'string');
  assert.equal(typeof a.sent[0].at, 'number');
  const p = artistSetup('/music/player/');
  p.sent.length = 0;
  p.say({ type: 'artist-ask', req: 'r1', id: 3 });
  assert.deepEqual(p.sent, []);
});

test('歌手页：artist-go 只给挑中的那页；音乐页接住 sgx-music-artist 就不整页跳，没人接才跳；地址只认音乐页 ?artist=<数字>', () => {
  const a = artistSetup('/blog/');
  a.say({ type: 'artist-ask', req: 'r1', id: 3 });
  const me = a.sent.at(-1).from;
  a.say({ type: 'artist-go', req: 'r1', to: 'someone-else', id: 3, url: '/music/?artist=3' });
  assert.deepEqual(a.nav, [], '不是给我的');
  a.say({ type: 'artist-go', req: 'r1', to: me, id: 3, url: '/music/zh/?artist=3' });
  assert.deepEqual(a.nav, ['/music/zh/?artist=3']);
  assert.equal(a.fired.at(-1).type, 'sgx-music-artist');
  assert.deepEqual(a.fired.at(-1).detail, { id: 3, url: '/music/zh/?artist=3' });
  for (const url of ['https://evil.com/', '//evil.com/music/?artist=3', '/music/?artist=3&x=1', '/curio/music/?artist=3', 'javascript:alert(1)']) {
    a.say({ type: 'artist-go', req: 'r2', to: me, id: 3, url });
  }
  assert.deepEqual(a.nav, ['/music/zh/?artist=3'], '别的地址一律不跳');
  const c = artistSetup('/music/', { cancel: true });
  c.say({ type: 'artist-ask', req: 'r1', id: 3 });
  c.say({ type: 'artist-go', req: 'r1', to: c.sent.at(-1).from, id: 3, url: '/music/?artist=3' });
  assert.deepEqual(c.nav, [], '本页在页内换视图');
});

test('歌手页：播放器 / 共用核 / 音乐页三边接上（消息名同一套）', () => {
  const core = rd('space/web/assets/common/js/music/music-core.js');
  assert.match(core, /ask: 'artist-ask', here: 'artist-here', go: 'artist-go'/);
  const mp = rd('space/web/assets/common/js/music/music-player.js');
  assert.ok(mp.includes('CORE.ARTIST_MSG.ask') && mp.includes('CORE.ARTIST_MSG.go') && mp.includes('CORE.pickMain'));
  assert.ok(rd('space/web/assets/music/js/music-page.js').includes("doc.addEventListener('sgx-music-artist'"));
});

/* ---------- 音乐页「播放」交接（music 搬家第 3 步 3.3）：音乐页发可取消的 sgx-music-open {url}，mountMusic 用同一个 go() 开 / 切播放器 ---------- */
/** answer：频道上收到 player-hello {req} 时播放器怎么答（不给 = 没开播放器，不答；数组 = 几个播放器先后答） */
function openSetup(path, w, answer) {
  const btn = { href: URL_EN, addEventListener() {} };
  const hs = {};
  const doc = { baseURI: 'https://styrigx.com/music/', querySelector: (s) => (s === '.sgx-tb-music' ? btn : null), addEventListener: (t, f) => { hs[t] = f; } };
  const calls = [], nav = [], sent = [];
  const ch = { onmessage: null, postMessage(m) {
    sent.push(m);
    if (m.type === 'player-hello' && m.req && answer) {
      for (const a of [].concat(answer)) {
        const { after, ...rest } = a;
        setTimeout(() => ch.onmessage({ data: Object.assign({ type: 'player-state', on: true, playing: true, title: 'A', artist: 'B', req: m.req }, rest) }), after || 1);
      }
    }
  } };
  const api = mountMusic(doc, { channel: ch, path, wait: W, open: (u, n, f) => { calls.push([u, n, f]); return typeof w === 'function' ? w() : w; }, navigate: (u) => nav.push(u) });
  const fire = (url, cmd) => { const e = { detail: cmd === undefined ? { url } : { url, cmd }, prevented: 0, preventDefault() { this.prevented++; } }; hs['sgx-music-open'](e); return e; };
  const cmds = () => sent.filter((m) => m.type !== 'player-hello');
  return { fire, calls, nav, hs, sent, cmds, api, ch };
}

test('交接：没开播放器（握手没人答）→ 同名窗口开 /music/player/?album=&t=（绝对地址），接住事件，不发 remote-cmd', async () => {
  const w = win('about:blank', 'blank');
  const o = openSetup('/music/', w);
  const e = o.fire('/music/player/?album=3&t=2', { cmd: 'play', album: 3, i: 2 });
  assert.equal(e.prevented, 1);
  assert.deepEqual(o.calls, [], '先握手');
  await sleep(W + 30);
  assert.deepEqual(o.calls, [['', MUSIC_WIN, MUSIC_FEATURES]]);
  assert.deepEqual(o.cmds(), [], '没人答就不发 remote-cmd（新窗口靠地址里的 ?album=&t= 放）');
  assert.equal(w.location.href, 'https://styrigx.com/music/player/?album=3&t=2');
  assert.equal(w.focused, 1);
});

test('交接：本页开的播放器答了（mine）→ remote-cmd play 带 to 发给它，go() 切过去、不改地址', async () => {
  const w = win(URL_EN + '?album=1', '/music/player/');
  const o = openSetup('/music/zh/', w, { id: 'p1', mine: true });
  assert.equal(o.fire('/music/zh/player/?album=3&t=0', { cmd: 'play', album: 3, i: 0 }).prevented, 1);
  await sleep(10);
  assert.deepEqual(o.cmds(), [{ cmd: 'play', i: 0, album: 3, type: 'remote-cmd', to: 'p1' }]);
  assert.deepEqual(o.calls, [['', MUSIC_WIN, MUSIC_FEATURES]]);
  assert.equal(w.location.href, URL_EN + '?album=1');
  assert.equal(w.focused, 1);
  await sleep(W + 20);
  assert.equal(o.calls.length, 1, '到点也不再开');
});

test('交接：手动开的播放器答了（不是本页开的）→ cmd 带 to 发给它，再发 player-focus，不开窗（不会多出第二个播放器）', async () => {
  const o = openSetup('/music/', win('about:blank', 'blank'), { id: 'manual', mine: false });
  o.fire('/music/player/?album=1&t=2', { cmd: 'play', album: 1, i: 2 });
  await sleep(W + 30);
  assert.deepEqual(o.cmds(), [{ cmd: 'play', i: 2, album: 1, type: 'remote-cmd', to: 'manual' }, { type: 'player-focus', to: 'manual' }]);
  assert.deepEqual(o.calls, [], '不 window.open');
  assert.deepEqual(o.nav, []);
});

test('交接：单曲队列照发；只认第一个回答；别人的 req 不算', async () => {
  const o = openSetup('/music/', win('about:blank', 'blank'), [{ id: 'x', mine: false, req: 'someone-else' }, { id: 'p1', mine: false, after: 3 }, { id: 'p2', mine: false, after: 6 }]);
  o.fire('/music/player/?album=31&t=0', { cmd: 'play', queue: [31, 32], i: 1 });
  await sleep(W + 30);
  assert.deepEqual(o.cmds(), [{ cmd: 'play', i: 1, queue: [31, 32], type: 'remote-cmd', to: 'p1' }, { type: 'player-focus', to: 'p1' }]);
  assert.deepEqual(o.calls, []);
});

test('交接：cmd 白名单（只认 play + 整数 i + album 或 queue）；不合格的 cmd 不发，只切 / 开', async () => {
  assert.ok(playCmdOk({ cmd: 'play', album: 3, i: 0 }));
  assert.ok(playCmdOk({ cmd: 'play', queue: [1, 2], i: 1 }));
  for (const c of [null, 'play', { cmd: 'next', album: 3, i: 0 }, { cmd: 'play', album: '3', i: 0 }, { cmd: 'play', album: 3, i: -1 }, { cmd: 'play', album: 3 }, { cmd: 'play', queue: [], i: 0 }, { cmd: 'play', queue: [1, 'x'], i: 0 }, { cmd: 'play', album: 0, i: 0 }]) assert.ok(!playCmdOk(c), JSON.stringify(c));
  const o = openSetup('/music/', win('about:blank', 'blank'), { id: 'p1', mine: false });
  o.fire('/music/player/?album=3&t=0', { cmd: 'play', album: 3, i: 0, evil: 1, to: 'zz' });
  await sleep(W + 30);
  o.fire('/music/player/?album=3&t=0', { cmd: 'toggle' });
  await sleep(W + 30);
  assert.deepEqual(o.cmds(), [{ cmd: 'play', i: 0, album: 3, type: 'remote-cmd', to: 'p1' }, { type: 'player-focus', to: 'p1' }, { type: 'player-focus', to: 'p1' }], '多余字段丢掉；不合格的只切过去');
});

test('交接：被拦 → 本页整页跳到播放器地址', async () => {
  const o = openSetup('/music/', null);
  o.fire('/music/player/?album=3&t=0', { cmd: 'play', album: 3, i: 0 });
  await sleep(W + 30);
  assert.deepEqual(o.nav, ['https://styrigx.com/music/player/?album=3&t=0']);
});

test('交接：没有频道（老浏览器）→ 不等，同步 go()（还在点击的激活期里）', () => {
  const btn = { href: URL_EN, addEventListener() {} };
  const hs = {};
  const doc = { baseURI: 'https://styrigx.com/music/', querySelector: (s) => (s === '.sgx-tb-music' ? btn : null), addEventListener: (t, f) => { hs[t] = f; } };
  const calls = [];
  mountMusic(doc, { path: '/music/', open: (u, n) => { calls.push(n); return win('about:blank', 'blank'); }, navigate() {} });
  hs['sgx-music-open']({ detail: { url: '/music/player/?album=3&t=0', cmd: { cmd: 'play', album: 3, i: 0 } }, preventDefault() {} });
  assert.deepEqual(calls, [MUSIC_WIN]);
});

test('顶栏图标：播放器答了（手动开的）→ 只发 player-focus，不开窗、不发 remote-cmd', async () => {
  const r = remoteSetup();
  const e = r.click();
  assert.equal(e.prevented, 1);
  const hello = r.sent.at(-1);
  r.say({ type: 'player-state', on: false, playing: false, title: '', artist: '', id: 'manual', req: hello.req, mine: false });
  await sleep(W + 20);
  assert.deepEqual(r.opened, []);
  assert.deepEqual(r.sent.at(-1), { type: 'player-focus', to: 'manual' });
  assert.ok(!r.sent.some((m) => m.type === 'remote-cmd'), '图标不带 cmd');
});

test('加载时握的手已到点没人答 → 点了不再等，同步 go()（新窗口还在点击里开，能自动播放）', async () => {
  const o = openSetup('/music/', win('about:blank', 'blank'));
  await sleep(W + 10);
  o.fire('/music/player/?album=3&t=1', { cmd: 'play', album: 3, i: 1 });
  assert.deepEqual(o.calls, [['', MUSIC_WIN, MUSIC_FEATURES]], '同步开');
  assert.equal(o.sent.filter((m) => m.type === 'player-hello').length, 1, '不再握手');
  assert.deepEqual(o.cmds(), []);
});

test('平时广播里已经知道有播放器（by = 本页 → mine）：同步发 cmd（to）+ go() 切过去，不再等', async () => {
  const w = win(URL_EN, '/music/player/');
  const o = openSetup('/music/', w);
  await sleep(W + 10);
  o.sent.length = 0;
  /* 播放器开着、状态一变广播（不带 req），by = 开它的那页 */
  const pid = o.api.pageId;
  {
    o.ch.onmessage({ data: { type: 'player-state', on: true, playing: true, title: 'A', artist: 'B', id: 'p9', by: pid } });
    o.fire('/music/player/?album=3&t=0', { cmd: 'play', album: 3, i: 0 });
    assert.deepEqual(o.cmds(), [{ cmd: 'play', i: 0, album: 3, type: 'remote-cmd', to: 'p9' }]);
    assert.deepEqual(o.calls, [['', MUSIC_WIN, MUSIC_FEATURES]]);
    assert.equal(w.focused, 1);
    assert.equal(w.location.href, URL_EN, '不改地址');
  }
});

test('已知的播放器不是本页开的：同步发 cmd + player-focus；再握手确认，到点没人答（崩了没发 bye）才开窗', async () => {
  const o = openSetup('/music/', win('about:blank', 'blank'));
  await sleep(W + 10);
  o.ch.onmessage({ data: { type: 'player-state', on: false, playing: false, title: '', artist: '', id: 'gone', by: 'other-page' } });
  o.fire('/music/player/?album=3&t=0', { cmd: 'play', album: 3, i: 0 });
  assert.deepEqual(o.cmds(), [{ cmd: 'play', i: 0, album: 3, type: 'remote-cmd', to: 'gone' }, { type: 'player-focus', to: 'gone' }]);
  assert.deepEqual(o.calls, []);
  await sleep(W + 20);
  assert.deepEqual(o.calls, [['', MUSIC_WIN, MUSIC_FEATURES]], '确认不在了才开');
  /* 它已经从已知里删掉：下一次直接同步开 */
  o.fire('/music/player/?album=3&t=0', { cmd: 'play', album: 3, i: 0 });
  assert.equal(o.calls.length, 2);
});

test('player-bye 带 id：只删那一个；别的页握手回答里的 mine 不算本页的', async () => {
  const o = openSetup('/music/', win('about:blank', 'blank'));
  await sleep(W + 10);
  o.ch.onmessage({ data: { type: 'player-state', on: true, playing: true, title: 'A', artist: 'B', id: 'p1', req: 'not-mine', mine: true, by: 'x' } });
  o.ch.onmessage({ data: { type: 'player-bye', id: 'p1' } });
  o.fire('/music/player/?album=3&t=0', { cmd: 'play', album: 3, i: 0 });
  assert.deepEqual(o.calls, [['', MUSIC_WIN, MUSIC_FEATURES]], 'bye 之后当没开');
  const o2 = openSetup('/music/', win(URL_EN, '/music/player/'));
  await sleep(W + 10);
  o2.ch.onmessage({ data: { type: 'player-state', on: true, playing: true, title: 'A', artist: 'B', id: 'p1', req: 'not-mine', mine: true, by: 'x' } });
  o2.fire('/music/player/?album=3&t=0', { cmd: 'play', album: 3, i: 0 });
  assert.deepEqual(o2.cmds(), [{ cmd: 'play', i: 0, album: 3, type: 'remote-cmd', to: 'p1' }, { type: 'player-focus', to: 'p1' }], '别人的 mine 不算：发 player-focus，不 go()');
  assert.deepEqual(o2.calls, []);
});

test('本页 id 挂在 window.sgxMusicPageId 上（播放器读 opener 的判断 mine）', () => {
  assert.match(rd('space/web/assets/common/js/frame/topbar/panel.js'), /\(window\)\.sgxMusicPageId = pageId/);
});

test('交接：不在白名单的地址不接（不 preventDefault、不开窗）；播放器页自己不接', async () => {
  const o = openSetup('/music/', win('about:blank', 'blank'));
  for (const u of ['https://evil.com/', '/music/player/?album=3&t=0&x=1', '/curio/music/player/?album=3&t=0', 42]) assert.equal(o.fire(/** @type {any} */ (u)).prevented, 0, String(u));
  assert.deepEqual(o.calls, []);
  const p = openSetup('/music/player/', win('about:blank', 'blank'));
  assert.equal(p.fire('/music/player/?album=3&t=0').prevented, 0);
  await sleep(W + 20);
  assert.deepEqual(o.calls, []);
  assert.deepEqual(p.calls, []);
});

/* ---------- 打磨 6.4：音乐页迷你播放条 / 曲目高亮（sgx-music-state）、播放条遥控（sgx-music-dock）、⋯ 的专辑 / 曲库（artist-go kind） ---------- */
test('6.4 stateOf：多记 album / i / queue / cover / 进度，类型不对的丢掉；封面只认 /music/api/music-cover', () => {
  assert.deepEqual(stateOf({ on: true, playing: true, title: 'A', artist: 'B', album: 3, i: 1, queue: false, cover: '/music/api/music-cover?album=3', t: 12.5, d: 200, rate: 1.5, at: 99 }),
    { on: true, playing: true, title: 'A', artist: 'B', album: 3, i: 1, queue: false, cover: '/music/api/music-cover?album=3', t: 12.5, d: 200, rate: 1.5, at: 99 });
  const bad = stateOf({ on: 1, album: '3', i: 1.5, cover: 'https://evil.com/x.png', t: -4, d: 'x', rate: 0 });
  assert.equal(bad.album, 0); assert.equal(bad.i, -1); assert.equal(bad.cover, ''); assert.equal(bad.t, 0); assert.equal(bad.d, 0); assert.equal(bad.rate, 1);
  assert.equal(stateOf({ cover: '/music/api/music-cover?artist=7&v=12' }).cover, '/music/api/music-cover?artist=7&v=12');
});

test('6.4 每次画都发 sgx-music-state（detail = 状态拷贝；关窗 null），音乐页靠它画迷你播放条', () => {
  const a = artistSetup('/music/zh/');
  a.say({ type: 'player-state', on: true, playing: false, title: 'A', artist: 'B', album: 2, i: 0, queue: true, cover: '', t: 1, d: 30, rate: 1, at: 5 });
  const st = a.fired.filter((e) => e.type === 'sgx-music-state');
  assert.equal(st.at(-1).detail.album, 2);
  assert.equal(st.at(-1).detail.queue, true);
  assert.equal(st.at(-1).detail.d, 30);
  a.say({ type: 'player-bye' });
  assert.equal(a.fired.filter((e) => e.type === 'sgx-music-state').at(-1).detail, null);
});

test('6.4 音乐页答 artist-here 带 music: true（播放器 ⋯ 优先回到它）；别的页 false', () => {
  for (const [path, want] of [['/music/', true], ['/music/zh/', true], ['/blog/', false], ['/music/zh/player/', null]]) {
    const a = artistSetup(path);
    a.sent.length = 0;
    a.say({ type: 'artist-ask', req: 'r', id: 0, kind: 'library' });
    if (want === null) { assert.deepEqual(a.sent, [], '播放器页自己不答'); continue; }
    assert.equal(a.sent[0].music, want, path);
  }
  assert.ok(MUSIC_PAGE.test('/music/') && MUSIC_PAGE.test('/music/zh/') && !MUSIC_PAGE.test('/music/player/'));
});

test('6.4 linkOf：artist（没 kind 的旧消息也当歌手）/ album / library；地址只认音乐页的，别的 kind 不认', () => {
  assert.deepEqual(linkOf({ id: 3, url: '/music/?artist=3' }), { kind: 'artist', id: 3, url: '/music/?artist=3' });
  assert.deepEqual(linkOf({ kind: 'album', id: 5, url: '/music/zh/?album=5' }), { kind: 'album', id: 5, url: '/music/zh/?album=5' });
  assert.deepEqual(linkOf({ kind: 'album', id: 5, url: 'https://evil.com/' }), { kind: 'album', id: 5, url: '' });
  assert.deepEqual(linkOf({ kind: 'library', id: 0, url: '/music/zh/' }), { kind: 'library', id: 0, url: '/music/zh/' });
  assert.deepEqual(linkOf({ kind: 'library', url: '/music/?x=1' }), { kind: 'library', id: 0, url: '' });
  assert.equal(linkOf({ kind: 'album', id: 0, url: '/music/?album=0' }), null);
  assert.equal(linkOf({ kind: 'vip', id: 1, url: '/music/' }), null);
  assert.ok(ALBUM_URL.test('/music/?album=12') && !ALBUM_URL.test('/music/?album=1&t=2'));
  assert.ok(LIBRARY_URL.test('/music/zh/') && !LIBRARY_URL.test('/music/player/'));
});

test('6.4 artist-go kind=album / library：发可取消的 sgx-music-link（音乐页页内换视图）；没人接才整页跳；kind=artist 照旧 sgx-music-artist', () => {
  const a = artistSetup('/blog/');
  a.say({ type: 'artist-ask', req: 'r1', id: 5, kind: 'album' });
  const me = a.sent.at(-1).from;
  a.say({ type: 'artist-go', req: 'r1', to: me, id: 5, kind: 'album', url: '/music/zh/?album=5' });
  assert.equal(a.fired.at(-1).type, 'sgx-music-link');
  assert.deepEqual(a.fired.at(-1).detail, { kind: 'album', id: 5, url: '/music/zh/?album=5' });
  assert.deepEqual(a.nav, ['/music/zh/?album=5']);
  a.say({ type: 'artist-go', req: 'r2', to: me, id: 0, kind: 'library', url: '/music/zh/' });
  assert.deepEqual(a.nav, ['/music/zh/?album=5', '/music/zh/']);
  a.say({ type: 'artist-go', req: 'r3', to: me, id: 0, kind: 'library', url: 'https://evil.com/' });
  assert.equal(a.nav.length, 2, '别的地址不跳');
  /* 音乐页接住（preventDefault）就不跳 */
  const fired = [], nav = [];
  const ch = { onmessage: null, postMessage() {} };
  const doc = { querySelector: (q) => (q === '.sgx-tb-music' ? { href: URL_EN, addEventListener() {} } : null), getElementById: () => null,
    dispatchEvent: (e) => { fired.push(e); if (e.type === 'sgx-music-link') e.preventDefault(); return !e.defaultPrevented; } };
  const g = mountMusic(doc, { channel: ch, path: '/music/', open: () => null, navigate: (u) => nav.push(u) });
  ch.onmessage({ data: { type: 'artist-go', to: g.pageId, id: 1, kind: 'album', url: '/music/?album=1' } });
  assert.deepEqual(nav, []);
});

test('6.4 sgx-music-dock：open = reach（同顶栏图标）；queue = reach 并带 {cmd:show, what:queue}；toggle 发 remote-cmd（不带 to）', async () => {
  const w = win(URL_EN, '/music/player/');
  const o = openSetup('/music/', w, { id: 'p1', mine: true });
  await sleep(W + 20);
  const fire = (act) => { const e = { detail: { act }, prevented: 0, preventDefault() { this.prevented++; } }; o.hs['sgx-music-dock'](e); return e; };
  assert.equal(fire('open').prevented, 1);
  await sleep(5);
  assert.equal(o.calls.length, 1, '切到播放器（mine → go()）');
  assert.equal(fire('queue').prevented, 1);
  await sleep(5);
  assert.deepEqual(o.cmds().at(-1), { cmd: 'show', what: 'queue', type: 'remote-cmd', to: 'p1' });
  assert.equal(fire('toggle').prevented, 1);
  assert.deepEqual(o.cmds().at(-1), { type: 'remote-cmd', cmd: 'toggle' });
  assert.equal(fire('nope').prevented, 0);
});
