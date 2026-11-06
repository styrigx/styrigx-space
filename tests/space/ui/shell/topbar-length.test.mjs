/**
 * 顶栏长度统一（P4-3 再修，Gray 2026-11-06 立规⑥：顶栏一会长一会短是设计问题）。
 * 根因：顶栏胶囊宽 = --sgx-shell-w = min(100% − 2 × 页边距, --sgx-content-max)，最宽按布局模式定（Mobile 640 / DeX 1440），
 * 而布局模式四个站各算各的——奇趣是「宽 < 980 = 手机」、不看横竖屏、不认主站偏好；主站 / 日刻 / 博客是「宽 ≥ 840、高 ≥ 500 且横屏 = DeX」。
 * 宽竖屏（录屏里三星浏览器视口约 982 宽、竖屏）主站 / 日刻 / 博客是 Mobile 640，奇趣是 DeX 1440 → 顶栏差将近 300px。
 * 修法：最宽只在共享外壳按 <html data-sgx-layout> 定一次；四站 <head> 内联脚本用同一条规则（主站 __layoutMode() 的只读版）写这个属性。
 * 本文件：① 四站内联脚本在一整张视口 × 偏好 × 查询串表上给出和主站一样的 data-sgx-layout；② 子站 __sgxShellLayout() 一字不差；
 * ③ 外壳 CSS 按属性定最宽、各站不再按 layout-* 类改 --sgx-content-max；④ 顶栏 / 快捷面板按 100vw 定位（经典滚动条下不随页面变）。
 * 浏览器里逐页量左右边距：tests/curio/e2e/topbar-length.spec.js（四站整树）、tests/space/e2e/topbar/topbar-length.spec.js（主站各页、切布局偏好）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');

/** baseof / head.html 里布局那段内联脚本（从 function __layoutMode / 博客的 IIFE 起，到 data-sgx-layout 写完） */
const SCRIPTS = {
  main: read('space/web/layouts/_default/baseof.html').match(/function __layoutMode\(\)\{[\s\S]*?\n__applyLayout\(\);/)[0],
  curio: read('atlas/web/curio/layouts/_default/baseof.html').match(/function __layoutMode\(\)\{[\s\S]*?\n__applyLayout\(\);/)[0],
  daymark: read('atlas/web/daymark/layouts/_default/baseof.html').match(/function __layoutMode\(\)\{[\s\S]*?\n__applyLayout\(\);/)[0],
  blog: read('atlas/web/blog/layouts/partials/head.html').match(/<script>(\(function\(\)\{var d=document\.documentElement[\s\S]*?)<\/script>/)[1],
};

/** 跑一站的内联脚本：stub window / localStorage / location / document，回 <html> 上的 data-sgx-layout 和 layout-* 类 */
function run(site, { w, h, pref = null, search = '' }) {
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
  const window = { innerWidth: w, innerHeight: h };
  const location = { search };
  new Function('window', 'localStorage', 'location', 'document', 'URLSearchParams', SCRIPTS[site])(window, localStorage, location, document, URLSearchParams);
  return { attr: attrs.get('data-sgx-layout') ?? null, cls: [...classes].filter((c) => c.startsWith('layout-')) };
}

const WIDTHS = [320, 360, 390, 412, 599, 600, 768, 839, 840, 900, 979, 980, 982, 1024, 1180, 1280, 1366, 1440, 1920, 2560];
const HEIGHTS = [400, 499, 500, 600, 700, 800, 915, 1080, 1366, 2104];
const PREFS = [null, 'auto', 'mobile', 'dex', 'pc', 'phone', 'tablet', ''];
const SEARCH = ['', '?layout=auto'];

test('四站 <head> 内联脚本在每个视口 × 偏好 × 查询串下写出和主站一样的 data-sgx-layout（mobile / dex）', () => {
  let n = 0;
  for (const w of WIDTHS) for (const h of HEIGHTS) for (const pref of PREFS) for (const search of SEARCH) {
    const want = run('main', { w, h, pref, search });
    assert.ok(want.attr === 'mobile' || want.attr === 'dex', `主站 ${w}×${h} ${pref} → ${want.attr}`);
    /* 主站自己：属性和 layout-* 类是同一个结果（主站页面的版面和顶栏长度一起切） */
    assert.deepEqual(want.cls, ['layout-' + want.attr], `主站 ${w}×${h} ${pref}`);
    for (const site of ['curio', 'daymark', 'blog']) {
      const got = run(site, { w, h, pref, search });
      assert.equal(got.attr, want.attr, `${site} ${w}×${h} pref=${pref} ${search} → ${got.attr}，主站 ${want.attr}`);
      n++;
    }
  }
  assert.ok(n > 9000);
});

test('录屏那台：三星浏览器宽竖屏约 982×2104 → 四站都是 mobile（原来奇趣按 ≥ 980 宽算成 DeX，顶栏 928 vs 640）', () => {
  for (const site of ['main', 'curio', 'daymark', 'blog']) assert.equal(run(site, { w: 982, h: 2104 }).attr, 'mobile', site);
  /* 奇趣自己的 layout-* 类不动（只管弹层样式）：仍按 980 规则 */
  assert.deepEqual(run('curio', { w: 982, h: 2104 }).cls, ['layout-dex']);
  assert.deepEqual(run('curio', { w: 900, h: 600 }).cls, ['layout-phone']);
  assert.equal(run('curio', { w: 900, h: 600 }).attr, 'dex');
});

test('主站偏好跨站生效（同源同一份 localStorage）：桌面选 Mobile → 四站都是 640 那档；手机选 DeX → 仍 mobile', () => {
  for (const site of ['main', 'curio', 'daymark', 'blog']) {
    assert.equal(run(site, { w: 1920, h: 1080, pref: 'mobile' }).attr, 'mobile', site);
    assert.equal(run(site, { w: 1024, h: 1366, pref: 'dex' }).attr, 'dex', site);
    assert.equal(run(site, { w: 412, h: 915, pref: 'dex' }).attr, 'mobile', site);
  }
});

test('子站的 __sgxShellLayout() 三站一字不差（改一处就要三处一起改）', () => {
  const fn = (s) => s.match(/function __sgxShellLayout\(\)\{[\s\S]*?\n\}/)[0];
  const curio = fn(SCRIPTS.curio);
  assert.equal(fn(SCRIPTS.daymark), curio);
  assert.equal(fn(SCRIPTS.blog), curio);
  /* 只读：不写 localStorage（迁移 / 逃生口只在主站做） */
  assert.doesNotMatch(curio, /setItem/);
});

test('外壳 CSS：最宽只按 data-sgx-layout 定（640 / 1440，默认 1068）；顶栏 / 快捷面板按 100vw 定位', () => {
  const shell = read('space/web/shared/shell/shell.css');
  assert.match(shell, /:root \{ --sgx-page-m: 16px; --sgx-content-max: 1068px; --sgx-shell-w: min\(100% - 2 \* var\(--sgx-page-m\), var\(--sgx-content-max\)\);\s*--sgx-tb-w: min\(100vw - 2 \* var\(--sgx-page-m\), var\(--sgx-content-max\)\); \}/);
  assert.match(shell, /:root\[data-sgx-layout="mobile"\] \{ --sgx-content-max: 640px; \}/);
  assert.match(shell, /:root\[data-sgx-layout="dex"\] \{ --sgx-content-max: 1440px; \}/);
  /* 按整个窗口宽（100vw，含经典滚动条）居中：right 撑出滚动条那一截，仍用 margin auto（无滚动条时和原来逐像素一样） */
  assert.match(shell, /\.sgx-topbar \{ position: fixed;[^}]*left: 0; right: calc\(100% - 100vw\); margin: 0 auto; width: var\(--sgx-tb-w\);/);
  assert.match(shell, /\.sgx-qp \{ position: fixed;[^}]*left: 0; right: calc\(100% - 100vw\);/);
  assert.match(shell, /\.sgx-qp-sheet \{ position: absolute;[^}]*left: calc\(\(100% - var\(--sgx-tb-w\)\) \/ 2\); right: calc\(\(100% - var\(--sgx-tb-w\)\) \/ 2\);/);
  /* 顶栏宽不许再按内容 / 页名伸缩：胶囊上没有 fit-content / max-content / auto 宽 */
  const bar = shell.match(/\.sgx-topbar \{ position: fixed;[^}]*\}/)[0];
  assert.doesNotMatch(bar, /fit-content|max-content|min-content|width: auto/);
});

test('各站自己的样式不再按 layout-* 类改 --sgx-content-max / 顶栏宽（只有外壳一处）', () => {
  const files = [
    'space/web/assets/css/input.css',
    'atlas/web/curio/assets/css/input.css',
    'atlas/web/daymark/assets/css/input.css',
    'atlas/web/blog/assets/css/blog/one-ui.css',
    'atlas/web/blog/assets/css/blog/components.css',
    'atlas/web/blog/assets/css/blog/base.css',
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
