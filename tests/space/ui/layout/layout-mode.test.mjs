/**
 * 布局模式（P4-3 PR-4b，Gray 2026-11-07 定稿）：只有手机 phone / 桌面 desktop。
 * - 手动 手机 / 桌面：照办，什么都不看（应用内浏览器没有桌面版开关，靠手动选桌面）。
 * - 自动：视口 < 720 → 手机（窄窗口 / 分屏 / 手机竖屏）；否则浏览器不是手机版网站模式（userAgentData.mobile，没有就看 UA）→ 桌面；
 *   UA 报手机但浏览器在用桌面版网站的虚拟视口（布局视口 > 屏幕宽 × 1.25）→ 桌面（2026-11-07 录屏：奇趣 980 视口下还是手机）；其余手机。
 * - 设备档 resolveDevice / __sgxDevice：UA 报手机，或粗指针 + 屏幕短边 < 600 → phone，其余 desktop（只给桌面顶栏宽分档）。
 * - 旧值 mobile → phone，dex / pc → desktop，未知值 → auto；?layout=auto 逃生口。
 * 同时核对 prefs.js resolveLayout()、共享外壳源头 lib/layout-mode.js __sgxLayout() 和 baseof.html __layoutMode()（含偏好迁移）给出同一结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLayout, resolveDevice, normLayout, uaMobile, layoutNarrow } from '../../../../space/web/assets/js/lib/prefs.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const baseof = readFileSync(path.join(REPO, 'space/web/layouts/_default/baseof.html'), 'utf8');
const lib = readFileSync(path.join(REPO, 'space/web/assets/js/lib/layout-mode.js'), 'utf8');
const src = baseof.match(/function __layoutMode\(\)\{[\s\S]*?\n\}/)[0];

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const TABLET_UA = 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 跑 baseof 的内联函数（先内联 layout-mode.js）：stub window / localStorage / location / navigator；回 [结果, 存的偏好] */
function inline(pref, { w = 1280, ua = DESK_UA, uad, search = '', screen } = {}) {
  const store = new Map(pref == null ? [] : [['sgx-layout', pref]]);
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const window = { innerWidth: w };
  const location = { search };
  const navigator = uad === undefined ? { userAgent: ua } : { userAgent: ua, userAgentData: uad };
  const fn = new Function('window', 'localStorage', 'location', 'navigator', 'URLSearchParams', 'screen', lib + '\n' + src + '\nreturn [__layoutMode(), localStorage.getItem("sgx-layout")];');
  return fn(window, localStorage, location, navigator, URLSearchParams, screen);
}

const AUTO = [
  /* [视口宽, UA, userAgentData, 期望] */
  [412, PHONE_UA, undefined, 'phone'], // 手机竖屏
  [915, PHONE_UA, undefined, 'phone'], // 手机横屏（没开桌面版网站）
  [1280, PHONE_UA, undefined, 'phone'], // 手机 UA 不管多宽都是手机
  [412, PHONE_UA, { mobile: true }, 'phone'],
  [980, DESK_UA, { mobile: false }, 'desktop'], // 三星浏览器「桌面版网站」：报桌面 → 桌面（录屏那台约 982 宽竖屏）
  [412, DESK_UA, { mobile: false }, 'phone'], // 但视口 < 720 → 手机（保险）
  [980, PHONE_UA, { mobile: false }, 'desktop'], // userAgentData 优先于 UA
  [412, DESK_UA, { mobile: true }, 'phone'],
  [390, IPHONE_UA, undefined, 'phone'],
  [1024, TABLET_UA, undefined, 'desktop'], // Android 平板（UA 不带 Mobile）
  [1280, DESK_UA, undefined, 'desktop'],
  [1920, DESK_UA, undefined, 'desktop'],
  [720, DESK_UA, undefined, 'desktop'], // 正好 720 = 桌面
  [719, DESK_UA, undefined, 'phone'],
  [700, DESK_UA, undefined, 'phone'], // 电脑上的窄窗口 / 分屏
];

for (const [w, ua, uad, want] of AUTO) {
  test(`自动 ${w} 宽 ${ua === PHONE_UA ? '手机 UA' : ua === IPHONE_UA ? 'iPhone UA' : ua === TABLET_UA ? '平板 UA' : '桌面 UA'}${uad ? ' userAgentData.mobile=' + uad.mobile : ''} → ${want}`, () => {
    const nav = uad === undefined ? { userAgent: ua } : { userAgent: ua, userAgentData: uad };
    assert.equal(resolveLayout('auto', uaMobile(nav), w), want);
    assert.equal(inline('auto', { w, ua, uad })[0], want);
    assert.equal(inline(null, { w, ua, uad })[0], want);
  });
}

test('手动 手机 / 桌面：照办，UA 和视口都不看', () => {
  for (const [w, ua] of [[1920, DESK_UA], [412, PHONE_UA], [412, DESK_UA], [980, PHONE_UA]]) {
    assert.equal(resolveLayout('phone', uaMobile({ userAgent: ua }), w), 'phone');
    assert.equal(inline('phone', { w, ua })[0], 'phone');
    assert.equal(resolveLayout('desktop', uaMobile({ userAgent: ua }), w), 'desktop');
    assert.equal(inline('desktop', { w, ua })[0], 'desktop');
  }
  /* 应用内浏览器（手机 UA、没有桌面版开关）手动选桌面 → 桌面 */
  assert.equal(inline('desktop', { w: 412, ua: PHONE_UA, uad: { mobile: true } })[0], 'desktop');
});

test('旧值兼容：mobile → phone、dex / pc → desktop（主站写回新值）；未知值 → auto', () => {
  assert.equal(normLayout('mobile'), 'phone');
  assert.equal(normLayout('dex'), 'desktop');
  assert.equal(normLayout('pc'), 'desktop');
  assert.equal(normLayout('tablet'), 'auto');
  assert.equal(normLayout(null), 'auto');
  assert.deepEqual(inline('mobile', { w: 1920 }), ['phone', 'phone']);
  assert.deepEqual(inline('dex', { w: 412, ua: PHONE_UA }), ['desktop', 'desktop']);
  assert.deepEqual(inline('pc', { w: 1920 }), ['desktop', 'desktop']);
  assert.deepEqual(inline('tablet', { w: 1920 }), ['desktop', 'auto']);
});

test('?layout=auto 逃生口重置偏好', () => {
  assert.deepEqual(inline('phone', { w: 1920, search: '?layout=auto' }), ['desktop', 'auto']);
});

test('layoutNarrow（旧接口）恒 false：桌面任何时候都能选', () => {
  assert.equal(layoutNarrow(), false);
});

test('layout-mode.js：没有像素断点以外的规则（不再有 840 / 980 / 横屏判断），只有自动里 720 那一条（另有设备档屏幕短边 600、虚拟视口 1.25 倍两个比例）', () => {
  /* 980 只许出现在「手动桌面 + 手机屏」的固定视口宽 __SGX_DESKTOP_VW 那一行（不是断点） */
  const code = lib.replace(/\/\*[\s\S]*?\*\//g, '').replace(/var __SGX_DESKTOP_VW=980;/, '');
  assert.doesNotMatch(code, /840|980|innerHeight|orientation:\s*landscape/);
  assert.match(code, /w<720\)return 'phone'/);
  assert.match(code, /w>s\[0\]\*1\.25/);
  assert.match(code, /<600\?'phone':'desktop'/);
  assert.match(code, /matchMedia/);
});

/* 手机开「桌面版网站」：屏幕 384（S23 Ultra），布局视口 980 */
const S23 = { width: 384, height: 824 };
for (const [w, ua, uad, scr, want] of [
  [980, PHONE_UA, { mobile: true }, S23, 'desktop'], // UA 还报手机，但虚拟视口 980 > 384 × 1.25 → 桌面版网站
  [980, DESK_UA, { mobile: false }, S23, 'desktop'],
  [412, PHONE_UA, { mobile: true }, { width: 412, height: 915 }, 'phone'], // 手机版网站：布局视口 = 屏幕宽
  [915, PHONE_UA, { mobile: true }, { width: 915, height: 412 }, 'phone'], // 手机横屏
  [1280, PHONE_UA, undefined, { width: 1280, height: 800 }, 'phone'], // 手机 UA、视口 = 屏幕：还是手机
  [700, PHONE_UA, { mobile: true }, S23, 'phone'], // < 720 一律手机
]) {
  test(`自动 ${w} 宽 屏幕 ${scr.width} ${ua === PHONE_UA ? '手机 UA' : '桌面 UA'}${uad ? ' mobile=' + uad.mobile : ''} → ${want}`, () => {
    const nav = uad === undefined ? { userAgent: ua } : { userAgent: ua, userAgentData: uad };
    assert.equal(resolveLayout('auto', uaMobile(nav), w, w >= 720 && w > scr.width * 1.25), want);
    assert.equal(inline('auto', { w, ua, uad, screen: scr })[0], want);
  });
}

test('设备档 resolveDevice：手机 UA / 粗指针 + 短边 < 600 → phone；电脑、平板、触屏电脑 → desktop', () => {
  assert.equal(resolveDevice(true, false, 1920), 'phone');
  assert.equal(resolveDevice(false, true, 384), 'phone'); // 手机开桌面版网站（UA 报桌面）
  assert.equal(resolveDevice(false, false, 384), 'desktop'); // 细指针（电脑窄窗口不算）
  assert.equal(resolveDevice(false, true, 800), 'desktop'); // 平板 / 触屏电脑
  assert.equal(resolveDevice(false, true, 600), 'desktop');
});

/* ---------- 手动桌面 + 手机屏 → viewport 980（2026-11-07 Gray 真机：X 应用内浏览器选桌面只有顶栏变了） ---------- */
/** 跑 layout-mode.js（带一个只有 viewport / color-scheme / theme-color meta 的假 document）：回 { meta, synced, auto, api } */
function withDoc({ pref = null, screen = { width: 384, height: 824 }, ua = PHONE_UA, w = 384, dark = false, coarse = true, content = 'width=device-width, initial-scale=1' } = {}) {
  const store = new Map(pref == null ? [] : [['sgx-layout', pref]]);
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const mk = (attrs) => ({ a: { ...attrs }, getAttribute(k) { return k in this.a ? this.a[k] : null; }, setAttribute(k, v) { this.a[k] = String(v); } });
  const vp = mk({ name: 'viewport', content });
  const cs = mk({ name: 'color-scheme', content: 'light dark' });
  const tc = [mk({ name: 'theme-color', content: '#f5f8fa' }), mk({ name: 'theme-color', content: '#10151a', media: '(prefers-color-scheme: dark)' })];
  const styles = [];
  const html = { getAttribute: (k) => (k === 'data-dark' ? (dark ? '1' : '0') : null), classList: { contains: (c) => c === 'dark' && dark }, clientWidth: w };
  const head = { firstChild: null, insertBefore(el) { styles.unshift(el); } };
  const document = {
    documentElement: html, head,
    querySelector: (sel) => (sel === 'meta[name="viewport"]' ? vp : null),
    querySelectorAll: (sel) => (sel === 'meta[name="color-scheme"]' ? [cs] : sel === 'meta[name="theme-color"]' ? tc : []),
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
  };
  const window = { innerWidth: w, matchMedia: (q) => ({ matches: q === '(pointer: coarse)' ? coarse : false }) };
  const fn = new Function('window', 'localStorage', 'location', 'navigator', 'URLSearchParams', 'screen', 'document',
    lib + '\nreturn { sync: __sgxViewportSync, auto: __sgxLayoutAuto, forced: __sgxViewportForced, layout: __sgxLayout };');
  const api = fn(window, localStorage, { search: '' }, { userAgent: ua }, URLSearchParams, screen, document);
  return { vp, cs, tc, styles, api, store };
}

test('手动桌面 + 手机屏（S23 Ultra 384 宽）：加载时 viewport 改成 width=980，原值记在 data-sgx-vp', () => {
  const r = withDoc({ pref: 'desktop' });
  assert.equal(r.vp.getAttribute('content'), 'width=980');
  assert.equal(r.vp.getAttribute('data-sgx-vp'), 'width=device-width, initial-scale=1');
  assert.equal(r.api.forced(), true);
  assert.equal(r.api.layout(), 'desktop');
  /* 再同步一次不再变（不会反复重载） */
  assert.equal(r.api.sync(), false);
});

test('手动桌面时「自动」按 UA 算（视口宽是我们改的，不能拿来判断）：手机 UA → 手机，桌面 UA（三星桌面版网站）→ 桌面', () => {
  assert.equal(withDoc({ pref: 'desktop', w: 980 }).api.auto(), 'phone');
  assert.equal(withDoc({ pref: 'desktop', w: 980, ua: DESK_UA }).api.auto(), 'desktop');
});

test('换回自动 / 手机：viewport 还原，sync() 回 true（快捷面板据此整页重载）', () => {
  const r = withDoc({ pref: 'desktop' });
  r.store.set('sgx-layout', 'auto');
  assert.equal(r.api.sync(), true);
  assert.equal(r.vp.getAttribute('content'), 'width=device-width, initial-scale=1');
  assert.equal(r.api.forced(), false);
  r.store.set('sgx-layout', 'phone');
  assert.equal(r.api.sync(), false);
});

for (const [label, o] of [
  ['自动（手机）', { pref: null }],
  ['手机偏好', { pref: 'phone' }],
  ['平板（短边 800）手动桌面', { pref: 'desktop', screen: { width: 1280, height: 800 }, ua: TABLET_UA, w: 1280 }],
  ['电脑 / DeX（1920×1080）手动桌面', { pref: 'desktop', screen: { width: 1920, height: 1080 }, ua: DESK_UA, w: 1920 }],
  ['三星桌面版网站（UA 报桌面、自动）', { pref: null, ua: DESK_UA, w: 980 }],
  ['电脑上屏幕很小的窗口（桌面 UA、细指针，屏幕 412）手动桌面', { pref: 'desktop', ua: DESK_UA, coarse: false, screen: { width: 412, height: 915 }, w: 412 }],
]) {
  test(`viewport 不动：${label}`, () => {
    const r = withDoc(o);
    assert.equal(r.vp.getAttribute('content'), 'width=device-width, initial-scale=1');
    assert.equal(r.api.forced(), false);
  });
}

test('首帧底色：本站深色（系统浅色）→ color-scheme / theme-color 改成深色，<head> 最前面插最低层的 html 底色', () => {
  const r = withDoc({ dark: true });
  assert.equal(r.cs.getAttribute('content'), 'dark');
  assert.deepEqual(r.tc.map((m) => m.getAttribute('content')), ['#10151a', '#10151a']);
  assert.equal(r.styles.length, 1);
  assert.equal(r.styles[0].id, 'sgx-first-paint');
  assert.equal(r.styles[0].textContent, '@layer sgx-first-paint{html{background-color:#0a0e10;color-scheme:dark}}');
  const l = withDoc({ dark: false });
  assert.equal(l.cs.getAttribute('content'), 'light');
  assert.equal(l.styles[0].textContent, '@layer sgx-first-paint{html{background-color:#f2f6f7;color-scheme:light}}');
});

test('默认调色板的首帧底色 = palettes.json 雾霾蓝 bg-1（换了默认调色板要跟着改）', () => {
  const pal = JSON.parse(readFileSync(path.join(REPO, 'space/web/shared/shell/palettes.json'), 'utf8'));
  const def = pal.presets.find((p) => p.id === pal.default);
  assert.match(lib, new RegExp("bg=dk\\?'" + def.tokens.dark['bg-1'] + "':'" + def.tokens.light['bg-1'] + "'"));
});
