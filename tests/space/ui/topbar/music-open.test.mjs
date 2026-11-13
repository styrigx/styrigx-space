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
  const ev = (o) => Object.assign({ button: 0, defaultPrevented: false, prevented: 0, preventDefault() { this.prevented++; } }, o);
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
