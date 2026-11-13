/* P4-3 PR-4a（顶栏视觉小修）：§6.2 标签常驻衬底变量、22 套预设对比度；PR-4b 起顶栏没有标签 / 分段，§6.3 页名胶囊居中 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const shell = rd('space/web/assets/common/css/shell.css');

test('§6.2 衬底变量在共享外壳里：导航选中色 45%', () => {
  assert.match(shell, /--sgx-tb-label-bg: color-mix\(in oklab, var\(--sgx-nav-selected\) 45%, transparent\);/);
});

test('PR-4b 定稿：页名胶囊只显示页名——主站没有顶栏标签，三个子站顶栏没有分段滑块（分区切换在首页正文：对齐 PR-C2 起奇趣是下划线 tab、日刻是窗标题链接）', () => {
  const css = rd('space/web/assets/common/css/input.css');
  assert.doesNotMatch(css, /\.sgx-tb-tabs? \{/);
  for (const f of ['space/web/assets/blog/css/blog/components.css', 'space/web/assets/curio/css/input.css', 'space/web/assets/daymark/css/input.css', 'space/web/assets/common/css/shell.css']) {
    assert.doesNotMatch(rd(f).replace(/\/\*[\s\S]*?\*\//g, ''), /\.sgx-seg(?:-btn|-ind)?\b/, f);
  }
  for (const [f, attr] of [['space/web/layouts/partials/blog/topnav.html', 'data-sgx-seg'], ['space/web/layouts/curio/baseof.html', 'data-cu-seg'], ['space/web/layouts/daymark/baseof.html', 'data-dm-seg']]) {
    const src = rd(f);
    assert.doesNotMatch(src, new RegExp(attr), f);
    /* P4-3 奇趣拆页：奇趣的分区是独立子页，胶囊 = 页名（首页站名、子页子页名），不再由脚本换；博客 / 日刻仍是页内分区 */
    /* 对齐 PR-C：博客首页是单一文章列表，胶囊同样只显示页名（原首页 tabs 模式删除） */
    if (f.includes('/blog/')) assert.doesNotMatch(src, /data-sgx-titles/, f + '：没有分区名切换');
    else if (f.includes('/curio/')) assert.match(src, /\{\{ \$center = printf "<span class=\\"sgx-tb-title\\">%s<\/span>" \(htmlEscape \$pageName\) \}\}/, f + '：胶囊 = 页名');
    else assert.match(src, /class=\\"sgx-tb-title\\" data-sgx-titles=/, f + '：首页胶囊 = 站名，分区名由脚本换');
  }
  assert.match(rd('space/web/layouts/partials/curio/page-head.html'), /<div class="sgx-ctab" id="cu-tabs">/, '奇趣：页头下划线 tab');
  const dm = rd('space/web/layouts/daymark/section.html');
  for (const w of ['trove', 'flavors']) assert.match(dm, /<a href="#\{\{ \$w \}\}">/, '日刻：窗标题进拾录 / 百味');
});

test('§6.3（顶栏 v3 起）：宽屏不再三段网格定宽中段、页名不在顶栏显示（#site-nav 里藏）；页名样式留着（锁屏顶栏用），按字定宽、长页名省略号', () => {
  assert.doesNotMatch(shell, /--sgx-tb-mid|grid-template-columns: 1fr min\(/);
  assert.match(shell, /#site-nav \.sgx-tb-pill \{ display: none; \}/);
  assert.match(shell, /\.sgx-tb-title \{ display: block; min-width: 0; max-width: 100%;[^}]*white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
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

test('§6.2 对比度：22 套预设（v4 起每套一个模式），非当前项 / 当前项文字都 ≥ 4.5:1', () => {
  const { presets } = JSON.parse(rd('space/web/data/common/palettes.json'));
  assert.equal(presets.length, 25);
  for (const p of presets) {
    const t = p.tokens, mode = p.mode;
    const base = over(rgba(t['topbar-glass']), rgba(t.background));
    const ns = rgba(t['nav-selected']);
    const bg = over([ns[0], ns[1], ns[2], 0.45], base);
    assert.ok(cr(rgba(t['text-primary']), bg) >= 4.5, `${p.id} ${mode} 非当前项`);
    assert.ok(cr(rgba(t['on-nav-selected']), ns) >= 4.5, `${p.id} ${mode} 当前项`);
  }
});
