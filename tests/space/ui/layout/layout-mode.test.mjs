/**
 * 布局模式（P4-3 PR-4b，Gray 2026-11-07 定稿）：只有手机 phone / 桌面 desktop。
 * - 手动 手机 / 桌面：照办，什么都不看（应用内浏览器没有桌面版开关，靠手动选桌面）。
 * - 自动：浏览器是手机版网站模式（userAgentData.mobile，没有就看 UA）→ 手机；否则桌面，但视口 < 720 → 手机（窄窗口 / 分屏的保险，只在自动里）。
 * - 旧值 mobile → phone，dex / pc → desktop，未知值 → auto；?layout=auto 逃生口。
 * 同时核对 prefs.js resolveLayout()、共享外壳源头 lib/layout-mode.js __sgxLayout() 和 baseof.html __layoutMode()（含偏好迁移）给出同一结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLayout, normLayout, uaMobile, layoutNarrow } from '../../../../space/web/assets/js/lib/prefs.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const baseof = readFileSync(path.join(REPO, 'space/web/layouts/_default/baseof.html'), 'utf8');
const lib = readFileSync(path.join(REPO, 'space/web/assets/js/lib/layout-mode.js'), 'utf8');
const src = baseof.match(/function __layoutMode\(\)\{[\s\S]*?\n\}/)[0];

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const TABLET_UA = 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 跑 baseof 的内联函数（先内联 layout-mode.js）：stub window / localStorage / location / navigator；回 [结果, 存的偏好] */
function inline(pref, { w = 1280, ua = DESK_UA, uad, search = '' } = {}) {
  const store = new Map(pref == null ? [] : [['sgx-layout', pref]]);
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const window = { innerWidth: w };
  const location = { search };
  const navigator = uad === undefined ? { userAgent: ua } : { userAgent: ua, userAgentData: uad };
  const fn = new Function('window', 'localStorage', 'location', 'navigator', 'URLSearchParams', lib + '\n' + src + '\nreturn [__layoutMode(), localStorage.getItem("sgx-layout")];');
  return fn(window, localStorage, location, navigator, URLSearchParams);
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

test('layout-mode.js：没有像素断点以外的规则（不再有 840 / 980 / 横屏判断），只有自动里 720 那一条', () => {
  const code = lib.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /840|980|innerHeight|orientation:\s*landscape/);
  assert.match(code, /w<720\?'phone':'desktop'/);
  assert.match(code, /matchMedia/);
});
