/* P4-3 §6.6 / 设计 §5.2、§6.2、§6.3（段式标签 PR）：原顶栏分段滑块搬进内容页（页内二级切换），内容页顶栏下方标题带。
   - 共享外壳：sgx-segtabs.html / sgx-page-hero.html（gen-shell 原样复制成 segtabs.html / page-hero.html，三站同步），CSS 在 input.css 的 @inpage 段
   - 段式标签：非当前项 = 导航选中色 45% 衬底 + text-primary，当前项 = nav-selected 实色 + 粗体 + on-nav-selected（同顶栏）
   - 对比度审计：22 套预设 × 深浅色 + 自定义色（色相扫一圈 × 5 档明度 + 极端值），段式标签放在页面底色 / 表面色上，非当前项文字 ≥ 4.5:1、当前项 ≥ 4.5:1 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { rolesFor } from '../../../../space/web/assets/js/lib/palette-scheme.js';
import { SHELL_REGIONS } from '../../../../space/scripts/gen-shell.mjs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const has = (p) => existsSync(new URL('../../../../' + p, import.meta.url));
const shell = rd('space/web/shared/shell/shell.css');

test('共享外壳：inpage 段进 shell.css，段式标签用导航选中色 45% 衬底、当前项实色加粗', () => {
  assert.ok(SHELL_REGIONS.includes('inpage'));
  assert.match(shell, /\.sgx-segs-tab \{[^}]*background-color: color-mix\(in oklab, var\(--sgx-nav-selected\) 45%, transparent\); color: var\(--sgx-text-primary\);/);
  assert.match(shell, /\.sgx-segs-tab\[aria-current="page"\] \{ background-color: var\(--sgx-nav-selected\); color: var\(--sgx-on-nav-selected\); font-weight: 700; \}/);
  assert.match(shell, /\.sgx-segs\[hidden\] \{ display: none; \}/);
  assert.match(shell, /\.sgx-hero-title \{/);
});

test('标题带只在手机布局显示：桌面布局视觉隐藏（顶栏胶囊已有页名），h1 留在 DOM；段式标签两种布局都显示', () => {
  const desk = shell.match(/:root\[data-sgx-layout="desktop"\] \.sgx-hero \{([^}]*)\}/);
  assert.ok(desk, '桌面布局有 .sgx-hero 规则');
  assert.match(desk[1], /position: absolute; width: 1px; height: 1px;/);
  assert.match(desk[1], /clip-path: inset\(50%\)/);
  assert.doesNotMatch(desk[1], /display: none/, '不用 display:none，读屏仍能读到 h1');
  assert.doesNotMatch(shell, /:root\[data-sgx-layout="desktop"\] \.sgx-hero-(title|desc) \{/, '桌面不再给标题 / 说明单独定字号');
  assert.doesNotMatch(shell, /\[data-sgx-layout="[a-z]+"\][^{]*\.sgx-segs[^{]*\{[^}]*display: none/, '段式标签不按布局隐藏');
  for (const site of ['blog', 'curio', 'daymark']) {
    const css = rd(site === 'blog' ? 'atlas/web/blog/assets/css/sgx-shell.css' : `atlas/web/${site}/assets/css/input.css`);
    assert.ok(css.includes(desk[0]), site + ' 同步了桌面隐藏规则');
  }
});

test('inpage 段只用 --sgx-* 角色，不写死颜色', () => {
  /* 只用 --sgx-* 角色，不写死颜色 */
  const region = shell.slice(shell.indexOf('/* ---- inpage ---- */'), shell.indexOf('/* ---- wide ---- */'));
  assert.ok(region.length > 200);
  assert.doesNotMatch(region, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});

test('共享外壳：segtabs.html / page-hero.html 原样复制，三个子站同步成 sgx-shell-*.html', () => {
  assert.equal(rd('space/web/shared/shell/segtabs.html'), rd('space/web/layouts/partials/sgx-segtabs.html'));
  assert.equal(rd('space/web/shared/shell/page-hero.html'), rd('space/web/layouts/partials/sgx-page-hero.html'));
  for (const site of ['blog', 'curio', 'daymark']) {
    assert.equal(rd(`atlas/web/${site}/layouts/partials/sgx-shell-segtabs.html`), rd('space/web/shared/shell/segtabs.html'), site);
    assert.equal(rd(`atlas/web/${site}/layouts/partials/sgx-shell-page-hero.html`), rd('space/web/shared/shell/page-hero.html'), site);
  }
  /* 标题带缺 description：只显示标题 + 构建警告 */
  assert.match(rd('space/web/layouts/partials/sgx-page-hero.html'), /if not \.desc \}\}\{\{ warnf "page-hero:/);
});

test('子站接入：奇趣子页页头（标题带 + 段式标签），日刻 / 博客页内分区（首页是入口页；另两个分区面板各一个标题带 + 段式标签）', () => {
  for (const id of ['finds', 'devices', 'games', 'movies', 'music']) {
    assert.match(rd(`atlas/web/curio/layouts/_default/${id}.html`), new RegExp(`partial "curio/page-head\\.html" \\(dict "page" \\. "id" "${id}"`), id);
    for (const f of [`${id}.md`, `${id}.zh.md`]) assert.match(rd(`atlas/web/curio/content/${f}`), /^description: '.+'$/m, f);
  }
  const head = rd('atlas/web/curio/layouts/partials/curio/page-head.html');
  assert.match(head, /partial "sgx-shell-page-hero\.html"/);
  assert.match(head, /partial "sgx-shell-segtabs\.html" \(dict "items" \$segs "current" \.id/);
  assert.match(rd('atlas/web/curio/assets/css/input.css'), /html:not\(\.cu-music-ok\) #cu-segs \.sgx-segs-tab\[data-seg="music"\]:not\(\[aria-current\]\) \{ display: none; \}/);
  for (const [site, panes] of [['daymark', ['trove', 'flavors']], ['blog', ['posts', 'topics']]]) {
    const idx = rd(`atlas/web/${site}/layouts/index.html`);
    /* 首页分区是入口页（平铺入口），不放段式标签；另外两个分区面板各一个标题带 + 一条段式标签（服务端写好当前项，不用脚本） */
    assert.equal((idx.match(/partial "sgx-shell-page-hero\.html"/g) || []).length, 2, site);
    for (const id of panes) assert.match(idx, new RegExp(`partial "sgx-shell-page-hero\\.html" .*"tag" "h2"\\) \\}\\}\\n\\s*\\{\\{ partial "sgx-shell-segtabs\\.html" \\(dict "items" \\$segItems "current" "${id}"`), site + ' ' + id);
  }
});

test('主站内容页：标题带接入，front matter 都有 description（中英）', () => {
  const pages = ['theme', 'wellbeing', 'about', 'status', 'security', 'security-tempkeys', 'account-apps', 'account-devices', 'account-profile', 'account-security', 'account-sync'];
  for (const p of pages) for (const f of [`space/web/content/${p}.md`, `space/web/content/zh/${p}.md`]) assert.match(rd(f), /^description: '.+'$/m, f);
  for (const l of ['sub', 'status', 'security', 'security-tempkeys', 'account-apps', 'account-devices', 'account-profile', 'account-security', 'account-sync']) {
    assert.ok(has(`space/web/layouts/_default/${l}.html`), l);
    assert.match(rd(`space/web/layouts/_default/${l}.html`), /partial "sgx-page-hero\.html" \(dict "title" [^ ]+ "desc" \.Description "path" \.File\.Path\)/, l);
  }
});

/* 对比度（同 topbar-pr4a.test.mjs 的算法；段式标签在页面里：底 = 页面底色或表面色） */
const rgba = (h) => {
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  const a = /rgba?\(([^)]+)\)/.exec(h)[1].split(',').map(Number);
  return [a[0], a[1], a[2], a[3] ?? 1];
};
const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat(1);
const lum = (c) => { const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const cr = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const check = (t, label) => {
  for (const base of ['background', 'surface']) {
    const ns = rgba(t['nav-selected']);
    const bg = over([ns[0], ns[1], ns[2], 0.45], rgba(t[base]));
    assert.ok(cr(rgba(t['text-primary']), bg) >= 4.5, `${label} ${base} 非当前项`);
  }
  assert.ok(cr(rgba(t['on-nav-selected']), rgba(t['nav-selected'])) >= 4.5, `${label} 当前项`);
};

test('对比度：22 套预设 × 深浅色，段式标签非当前项 / 当前项文字 ≥ 4.5:1', () => {
  const { presets } = JSON.parse(rd('space/web/shared/shell/palettes.json'));
  assert.equal(presets.length, 22);
  for (const p of presets) for (const mode of ['light', 'dark']) check(p.tokens[mode], `${p.id} ${mode}`);
});

test('对比度：自定义色（色相每 10° × 5 档饱和 / 明度 + 极端值）× 深浅色 ≥ 4.5:1', () => {
  const hsl = (h, s, l) => {
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
  };
  const seeds = ['#000000', '#ffffff', '#808080', '#ffd400', '#00ff00'];
  for (let h = 0; h < 360; h += 10) for (const [s, l] of [[90, 50], [60, 40], [100, 70], [30, 30], [80, 85]]) seeds.push(hsl(h, s, l));
  for (const seed of seeds) {
    const r = rolesFor(seed);
    for (const mode of ['light', 'dark']) check(r[mode], `${seed} ${mode}`);
  }
});
