/**
 * 顶栏长度统一（P4-3 再修，Gray 2026-11-06 立规⑥：顶栏一会长一会短是设计问题；P4-3 PR-4b Gray 2026-11-07 定稿布局只有手机 / 桌面）。
 * 规则只有一份：共享外壳 layout-mode.js __sgxLayout()（源头 space/web/assets/shell/js/lib/layout-mode.js），四站 <head> 原样内联，写 <html data-sgx-layout="phone|desktop">；
 * 顶栏宽只在共享外壳 shell.css 按它定：手机布局 min(100% − 32, 640)；桌面布局按 <html data-sgx-device>（__sgxDevice()）分档——
 * 手机设备 min(720, 100% − 48)，电脑 / 平板 min(clamp(720, 60vw, 960), 100% − 48)（Gray 2026-11-07），居中；上限按 100%（不含滚动条），vw 只在 clamp 中间项。
 * 本文件：① 四站 <head> 内联的是同一份 layout-mode.js、都调 __sgxLayout() 写属性、都按 matchMedia 重算；
 * ② 四站内联脚本在一整张 视口 × UA × 偏好 × 查询串 表上给出和主站一样的 data-sgx-layout；
 * ③ 外壳 CSS 的宽度公式、横向不滚、窄屏收页名胶囊；④ 各站不再按 layout-* 类改 --sgx-content-max / 顶栏宽。
 * 浏览器里逐页量：tests/curio/e2e/topbar-length.spec.js（四站整树）、tests/space/e2e/topbar/topbar-length.spec.js（主站各页、切布局偏好）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const LIB = read('space/web/assets/shell/js/lib/layout-mode.js');

const TPL = {
  main: read('space/web/layouts/_default/baseof.html'),
  curio: read('space/web/layouts/curio/baseof.html'),
  daymark: read('space/web/layouts/daymark/baseof.html'),
  blog: read('space/web/layouts/partials/blog/head.html'),
};
/** 各站内联的布局脚本（__layoutMode 起到 __sgxLayoutWatch(__applyLayout); 止） */
const SCRIPTS = Object.fromEntries(Object.entries(TPL).map(([k, t]) => [k, t.match(/function __layoutMode\(\)\{[\s\S]*?\n__sgxLayoutWatch\(__applyLayout\);/)[0]]));
/** 各站同步来的 layout-mode.js（子站带 @sgx-shell 头注释） */
const COPIES = {
  main: LIB,
  curio: read('space/web/assets/shell/js/lib/layout-mode.js'),
  daymark: read('space/web/assets/shell/js/lib/layout-mode.js'),
  blog: read('space/web/assets/shell/js/lib/layout-mode.js'),
};
const body = (s) => s.slice(s.indexOf('function __sgxUaMobile')).replace(/\/\* @sgx-shell:end \*\/\n?$/, '');

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 跑一站的布局脚本（先跑它自己那份 layout-mode.js）：stub window / localStorage / location / navigator / document，回 data-sgx-layout 和 layout-* 类 */
function run(site, { w, ua = DESK_UA, uad, pref = null, search = '', screen, coarse = false }) {
  const store = new Map(pref == null ? [] : [['sgx-layout', pref]]);
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const attrs = new Map();
  const classes = new Set();
  const document = {
    documentElement: {
      classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)) },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    },
  };
  const listeners = [];
  const window = { innerWidth: w, matchMedia: (q) => ({ matches: q === '(pointer: coarse)' ? coarse : false, addEventListener: (_t, f) => listeners.push(f) }), dispatchEvent() {}, addEventListener() {} };
  const location = { search };
  const navigator = uad === undefined ? { userAgent: ua } : { userAgent: ua, userAgentData: uad };
  new Function('window', 'localStorage', 'location', 'navigator', 'document', 'URLSearchParams', 'Event', 'screen', COPIES[site] + '\n' + SCRIPTS[site])(
    window, localStorage, location, navigator, document, URLSearchParams, class {}, screen);
  return { attr: attrs.get('data-sgx-layout') ?? null, device: attrs.get('data-sgx-device') ?? null, cls: [...classes].filter((c) => c.startsWith('layout-')), listeners: listeners.length };
}

test('四站 <head> 原样内联同一份 layout-mode.js（共享外壳，sync-shell 同步）、用 __sgxLayout() 写 data-sgx-layout、按 matchMedia 重算', () => {
  for (const site of ['curio', 'daymark', 'blog']) {
    assert.equal(body(COPIES[site]), body(LIB), `${site} 的 layout-mode.js 和主站源头不同`);
    assert.match(TPL[site], /<script>\{\{ \(resources\.Get "shell\/js\/lib\/layout-mode\.js" \| minify\)\.Content \| safeJS \}\}<\/script>/, site);
  }
  assert.match(TPL.main, /<script>\{\{ \(resources\.Get "shell\/js\/lib\/layout-mode\.js" \| minify\)\.Content \| safeJS \}\}<\/script>/);
  for (const [site, s] of Object.entries(SCRIPTS)) {
    assert.match(s, /__sgxLayout\(\)/, site);
    assert.match(s, /setAttribute\('data-sgx-layout',/, site);
    assert.match(s, /setAttribute\('data-sgx-device',__sgxDevice\(\)\)/, site);
    /* 各站不许再自己写像素断点 / 横屏判断 */
    assert.doesNotMatch(s.replace(/\/\*[\s\S]*?\*\//g, ''), /innerWidth|innerHeight|840|980/, site);
    /* 同步内联脚本，在 <head> 里（body 首帧前就定好，不闪；不是 defer / module） */
    const t = TPL[site];
    const at = t.indexOf('function __layoutMode(){');
    const head = t.indexOf('</head>');
    if (head >= 0) assert.ok(at < head, `${site}：布局脚本要在 <head> 里`);
    assert.doesNotMatch(t.slice(t.lastIndexOf('<script', at), at), /defer|async|type="module"/, site);
  }
});

const WIDTHS = [320, 360, 384, 390, 412, 600, 700, 719, 720, 760, 900, 915, 980, 982, 1024, 1280, 1920, 2560];
const UAS = [[PHONE_UA, undefined], [DESK_UA, undefined], [DESK_UA, { mobile: false }], [PHONE_UA, { mobile: true }], [PHONE_UA, { mobile: false }]];
const PREFS = [null, 'auto', 'phone', 'desktop', 'mobile', 'dex', 'pc', 'tablet', ''];
const SEARCH = ['', '?layout=auto'];

test('四站内联脚本在每个视口 × UA × 偏好 × 查询串下写出和主站一样的 data-sgx-layout（phone / desktop），各站 layout-* 类跟着同一个模式', () => {
  let n = 0;
  const CLS = { main: { phone: 'layout-mobile', desktop: 'layout-dex' }, curio: { phone: 'layout-phone', desktop: 'layout-dex' },
    daymark: { phone: 'layout-mobile', desktop: 'layout-dex' }, blog: { phone: 'layout-mobile', desktop: 'layout-dex' } };
  for (const w of WIDTHS) for (const [ua, uad] of UAS) for (const pref of PREFS) for (const search of SEARCH) {
    const want = run('main', { w, ua, uad, pref, search });
    assert.ok(want.attr === 'phone' || want.attr === 'desktop', `主站 ${w} ${pref} → ${want.attr}`);
    for (const site of ['main', 'curio', 'daymark', 'blog']) {
      const got = run(site, { w, ua, uad, pref, search });
      assert.equal(got.attr, want.attr, `${site} ${w} pref=${pref} ${search} → ${got.attr}，主站 ${want.attr}`);
      assert.deepEqual(got.cls, [CLS[site][got.attr]], `${site} ${w} ${pref}`);
      assert.ok(got.listeners >= 1, `${site} 没有按 matchMedia 重算`);
      n++;
    }
  }
  assert.ok(n > 6000);
});

test('Gray 定稿的几台：手机竖 / 横、桌面、窄窗口、手机手动桌面', () => {
  for (const site of ['main', 'curio', 'daymark', 'blog']) {
    assert.equal(run(site, { w: 412, ua: PHONE_UA }).attr, 'phone', site);
    assert.equal(run(site, { w: 915, ua: PHONE_UA }).attr, 'phone', site); // 手机横屏（没开桌面版网站）
    assert.equal(run(site, { w: 982, ua: DESK_UA, uad: { mobile: false } }).attr, 'desktop', site); // 三星浏览器「桌面版网站」
    assert.equal(run(site, { w: 1280 }).attr, 'desktop', site);
    assert.equal(run(site, { w: 700 }).attr, 'phone', site); // 自动：桌面 UA 但 < 720
    assert.equal(run(site, { w: 700, pref: 'desktop' }).attr, 'desktop', site); // 手动桌面不看宽度
    assert.equal(run(site, { w: 980, ua: PHONE_UA, uad: { mobile: true }, pref: 'desktop' }).attr, 'desktop', site); // 应用内浏览器手动桌面
    assert.equal(run(site, { w: 1920, pref: 'phone' }).attr, 'phone', site);
  }
});

test('手机开「桌面版网站」（2026-11-07 录屏：S23 Ultra 视口 980、屏幕 384）：四站同一结果——桌面布局 + 设备 phone；UA 还报手机也认虚拟视口', () => {
  const S = { width: 384, height: 824 };
  for (const site of ['main', 'curio', 'daymark', 'blog']) {
    /* UA 报桌面（三星切桌面版后重载）→ 桌面；粗指针 + 屏幕短边 384 → 设备 phone */
    assert.deepEqual([run(site, { w: 980, ua: DESK_UA, uad: { mobile: false }, screen: S, coarse: true }).attr, run(site, { w: 980, ua: DESK_UA, uad: { mobile: false }, screen: S, coarse: true }).device], ['desktop', 'phone'], site);
    /* UA 还报手机（切换后没重载 / 某次跳转没带上桌面 UA）：布局视口 980 > 384 × 1.25 → 桌面版网站 → 桌面（录屏里奇趣的情况） */
    assert.deepEqual([run(site, { w: 980, ua: PHONE_UA, uad: { mobile: true }, screen: S, coarse: true }).attr, run(site, { w: 980, ua: PHONE_UA, uad: { mobile: true }, screen: S, coarse: true }).device], ['desktop', 'phone'], site);
    /* 手机版网站：布局视口 = 屏幕宽，横屏 915 也还是手机 */
    assert.equal(run(site, { w: 412, ua: PHONE_UA, uad: { mobile: true }, screen: { width: 412, height: 915 }, coarse: true }).attr, 'phone', site);
    assert.equal(run(site, { w: 915, ua: PHONE_UA, uad: { mobile: true }, screen: { width: 915, height: 412 }, coarse: true }).attr, 'phone', site);
    /* 电脑：细指针 → 设备 desktop；平板（粗指针、短边 ≥ 600）→ desktop；电脑触屏（粗指针、屏幕大）→ desktop */
    assert.equal(run(site, { w: 1280, screen: { width: 1920, height: 1080 } }).device, 'desktop', site);
    assert.equal(run(site, { w: 1024, ua: DESK_UA, uad: { mobile: false }, screen: { width: 1024, height: 1366 }, coarse: true }).device, 'desktop', site);
    assert.equal(run(site, { w: 1280, screen: { width: 1280, height: 800 }, coarse: true }).device, 'desktop', site);
    /* 手机 UA 手动选桌面：设备 phone（窄档） */
    assert.equal(run(site, { w: 412, ua: PHONE_UA, uad: { mobile: true }, pref: 'desktop' }).device, 'phone', site);
  }
});

test('外壳 CSS（顶栏 v3，2026-11 UI 重设计 PR-1）：顶栏贴顶通栏，内容宽一个 token --sgx-content-w（1080），左右内边距 --sgx-tb-pad（页边距 / 安全区 / 居中余量取大），上限按 100% 不用 100vw；横向不滚；页名不在顶栏显示', () => {
  const shell = read('space/web/assets/css/shell/shell.css');
  const code = shell.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /--sgx-content-w: 1080px;/);
  assert.match(code, /--sgx-tb-pad: max\(var\(--sgx-page-m\), env\(safe-area-inset-left, 0px\), env\(safe-area-inset-right, 0px\), \(100% - var\(--sgx-content-w\)\) \/ 2\);/);
  assert.match(code, /--sgx-tb-w: calc\(100% - 2 \* var\(--sgx-tb-pad\)\);/);
  assert.match(code, /:root\[data-sgx-layout="phone"\] \{ --sgx-content-max: 640px; \}/);
  assert.match(code, /:root \{ overflow-x: clip; \}/);
  assert.match(code, /#site-nav \.sgx-tb-pill \{ display: none; \}/);
  assert.doesNotMatch(code, /100vw/, '外壳里不许再用 100vw（经典滚动条下会横向溢出）');
  assert.doesNotMatch(code, /data-sgx-layout="(?:mobile|dex)"/);
  assert.match(code, /\.sgx-topbar \{ position: fixed; top: 0; left: 0; right: 0;[^}]*padding: env\(safe-area-inset-top, 0px\) var\(--sgx-tb-pad\) 0;/);
  assert.match(code, /\.sgx-foot \{[^}]*padding: 0 var\(--sgx-tb-pad\)/, '页脚和顶栏同一内容宽');
  assert.match(code, /\.sgx-qp \{ position: fixed;[^}]*left: 0; right: 0;/);
  assert.match(code, /\.sgx-tb-acts \{ grid-column: 3; justify-self: end;/, '图标组固定在第三列、靠右（页名格藏起来时也不会被挤进第二列）');
  /* 面板 / AI 窗口桌面样式按模式，不按 980 断点 */
  assert.match(code, /:root\[data-sgx-layout="desktop"\] \.sgx-qp-sheet \{/);
  assert.doesNotMatch(code, /min-width: 980px/);
  const bar = code.match(/\.sgx-topbar \{ position: fixed;[^}]*\}/)[0];
  assert.doesNotMatch(bar, /fit-content|max-content|min-content|width: auto|margin: 0 auto/);
});

test('各站自己的样式不再按 layout-* 类改 --sgx-content-max / 顶栏宽（只有外壳一处）', () => {
  const files = [
    'space/web/assets/css/input.css',
    'space/web/assets/curio/css/input.css',
    'space/web/assets/daymark/css/input.css',
    'space/web/assets/blog/css/blog/one-ui.css',
    'space/web/assets/blog/css/blog/components.css',
    'space/web/assets/blog/css/blog/base.css',
  ];
  for (const f of files) {
    const raw = read(f);
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(strip(raw), /layout-(?:mobile|phone|dex)[^{}]*\{[^}]*--sgx-content-max/, f);
    /* 外壳以外不许再给 .sgx-topbar 定宽 / 定左右（外壳段：主站 @shell:begin/end，子站 @sgx-shell:begin/end） */
    const outside = strip(raw.replace(/\/\* @(?:sgx-)?shell:begin[\s\S]*?@(?:sgx-)?shell:end[^*]*\*\//g, ''));
    for (const m of outside.matchAll(/([^{}]*\.sgx-topbar[^{}]*)\{([^}]*)\}/g)) {
      assert.doesNotMatch(m[2], /(?:^|[;\s])(?:width|left|right|max-width|min-width|margin)\s*:/, `${f}: ${m[1].trim()}`);
    }
  }
});
