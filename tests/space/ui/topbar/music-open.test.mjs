/**
 * 音乐分层方案 v1.13 第二步 2c：顶栏音乐图标点开播放器（topbar/panel.js mountMusic）。
 * 没开就弹、已开切过去、被拦直接跳转，单窗口。浏览器里的真弹窗在 tests/space/e2e/topbar/music-open.spec.js。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountMusic, MUSIC_WIN, MUSIC_FEATURES, MUSIC_PATH } from '../../../../space/web/assets/common/js/frame/topbar/panel.js';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const URL_EN = 'https://styrigx.com/curio/music/player/';

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
  const w = win(URL_EN + '?album=3', '/curio/music/player/');
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

test('播放器路径（英文 / 中文）', () => {
  assert.ok(MUSIC_PATH.test('/curio/music/player/'));
  assert.ok(MUSIC_PATH.test('/curio/zh/music/player/'));
  assert.ok(!MUSIC_PATH.test('/curio/music/'));
});

test('四站顶栏的音乐链接都指向播放器页（当前语言）；播放器页把窗口名设成同一个', () => {
  for (const p of ['space/web/layouts/_default/baseof.html', 'space/web/layouts/curio/baseof.html', 'space/web/layouts/daymark/baseof.html', 'space/web/layouts/partials/blog/topnav.html']) {
    assert.match(rd(p), /"music" \(partial "common\/lang-path\.html" \(dict "path" "(https:\/\/styrigx\.com)?\/curio\/music\/player\/"/, p);
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
function remoteSetup(path) {
  const btn = { href: URL_EN, hs: [], classList: cls(), addEventListener(t, f) { if (t === 'click') this.hs.push(f); } };
  const parts = { '[data-mu-title]': el(), '[data-mu-artist]': el(), '[data-mu="toggle"]': el({ 'data-l-play': 'Play', 'data-l-pause': 'Pause' }) };
  const dlg = Object.assign(el(), { h: null, querySelector: (s) => parts[s] || null, addEventListener(t, f) { if (t === 'click') this.h = f; } });
  const events = [];
  const doc = { querySelector: (s) => (s === '.sgx-tb-music' ? btn : null), getElementById: (id) => (id === 'sgx-mu' ? dlg : null), dispatchEvent: (e) => { events.push(e.type); } };
  const sent = [];
  const ch = { onmessage: null, postMessage: (m) => sent.push(m) };
  const opened = [];
  const go = mountMusic(doc, { channel: ch, path: path || '/zh/status/', open: (u, n) => { opened.push(n); return win(URL_EN, '/curio/music/player/'); }, navigate: () => {} });
  const say = (m) => ch.onmessage({ data: m });
  const click = () => { const e = { button: 0, defaultPrevented: false, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopImmediatePropagation() { this.stopped++; } }; btn.hs.forEach((f) => f(e)); return e; };
  return { btn, dlg, parts, doc, ch, sent, opened, go, say, click, events };
}

test('遥控：加载先问 player-hello；播放器没答 → 点图标照旧开播放器、拦住遥控层', () => {
  const r = remoteSetup();
  assert.deepEqual(r.sent, [{ type: 'player-hello' }]);
  const e = r.click();
  assert.equal(e.prevented, 1); assert.equal(e.stopped, 1);
  assert.deepEqual(r.opened, [MUSIC_WIN]);
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
  assert.deepEqual(r.events, ['sgx-music-off']);
  assert.equal(r.click().prevented, 1);
});

test('遥控层按钮：上一曲、播放/暂停、下一曲发 remote-cmd；「播放器」切到播放器窗', () => {
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
  assert.deepEqual(r.opened, [MUSIC_WIN]);
});

test('遥控：播放器页自己的顶栏不弹遥控层，点了只切过去；不认的消息不动', () => {
  const r = remoteSetup('/curio/zh/music/player/');
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
