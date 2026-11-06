/* P4-3 PR-4a（顶栏视觉小修）：§6.2 标签常驻衬底（主站标签 + 三个子站分段，同一个变量），§6.3 宽屏中段定宽，22 套预设对比度 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const shell = rd('space/web/shared/shell/shell.css');

test('§6.2 衬底变量在共享外壳里：导航选中色 45%', () => {
  assert.match(shell, /--sgx-tb-label-bg: color-mix\(in oklab, var\(--sgx-nav-selected\) 45%, transparent\);/);
});

test('§6.2 主站标签：常驻衬底 + 主文字色；当前项实色 + 粗体；悬停叠状态层不换底色', () => {
  const css = rd('space/web/assets/css/input.css');
  const base = css.match(/\n\.sgx-tb-tab \{[^}]*\}/)[0];
  assert.match(base, /background-color: var\(--sgx-tb-label-bg\);/);
  assert.match(base, /color: var\(--sgx-text-primary\);/);
  assert.match(css, /\.sgx-tb-tab\[aria-current="page"\] \{ background-color: var\(--sgx-nav-selected\); color: var\(--sgx-on-nav-selected\); font-weight: 700; \}/);
  assert.match(css, /\.sgx-tb-tab:not\(\[aria-current="page"\]\):hover \{ background-image: linear-gradient/);
});

for (const [site, file] of [['blog', 'atlas/web/blog/assets/css/blog/components.css'], ['curio', 'atlas/web/curio/assets/css/input.css'], ['daymark', 'atlas/web/daymark/assets/css/input.css']]) {
  test(`§6.2 子站分段（${site}）：非当前项常驻衬底 + 主文字色；当前项不叠衬底（实色在滑动指示器上）`, () => {
    const css = rd(file);
    const base = css.match(/\n\.sgx-seg-btn \{[^}]*\}/)[0];
    assert.match(base, /background: var\(--sgx-tb-label-bg\);/);
    assert.match(base, /color: var\(--sgx-text-primary\);/);
    assert.match(css, /\.sgx-seg-btn\[aria-current=['"]page['"]\] \{\s*background: transparent;\s*color: var\(--sgx-on-nav-selected\);/);
    assert.match(css, /\.sgx-seg-ind \{[^}]*background(-color)?: var\(--sgx-nav-selected\);/);
  });
}

test('§6.3 宽屏中段定宽 --sgx-tb-mid（400px），不按内容伸缩；长页名省略号', () => {
  assert.match(shell, /--sgx-tb-mid: 400px;/);
  assert.match(shell, /@media \(min-width: 600px\) \{\s*\.sgx-topbar \{ display: grid; grid-template-columns: 1fr min\(var\(--sgx-tb-mid\), calc\(100% - 2 \* \(3 \* var\(--sgx-tb-ic\) \+ 16px\)\)\) 1fr; \}/);
  assert.match(shell, /\.sgx-tb-pill \{ width: 100%; \}/);
  assert.doesNotMatch(shell, /\.sgx-tb-pill \{ min-width: 160px; max-width: 480px; \}/);
  assert.match(shell, /\.sgx-tb-title \{[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
});

/* 对比度：非当前项文字 text-primary 对衬底（导航选中色 45% 叠在顶栏玻璃 + 页面底色上）≥ 4.5:1；当前项 on-nav-selected 对 nav-selected ≥ 4.5:1 */
const rgba = (h) => {
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  const a = /rgba?\(([^)]+)\)/.exec(h)[1].split(',').map(Number);
  return [a[0], a[1], a[2], a[3] ?? 1];
};
const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat(1);
const lum = (c) => { const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const cr = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('§6.2 对比度：22 套预设 × 深浅色，非当前项 / 当前项文字都 ≥ 4.5:1', () => {
  const { presets } = JSON.parse(rd('space/web/shared/shell/palettes.json'));
  assert.equal(presets.length, 22);
  for (const p of presets) for (const mode of ['light', 'dark']) {
    const t = p.tokens[mode];
    const base = over(rgba(t['topbar-glass']), rgba(t.background));
    const ns = rgba(t['nav-selected']);
    const bg = over([ns[0], ns[1], ns[2], 0.45], base);
    assert.ok(cr(rgba(t['text-primary']), bg) >= 4.5, `${p.id} ${mode} 非当前项`);
    assert.ok(cr(rgba(t['on-nav-selected']), ns) >= 4.5, `${p.id} ${mode} 当前项`);
  }
});
