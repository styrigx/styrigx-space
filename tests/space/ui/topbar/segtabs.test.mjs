/* P4-3 §6.6 / 设计 §5.2、§6.2、§6.3（段式标签 PR）：原顶栏分段滑块搬进内容页（页内二级切换），内容页顶栏下方标题带。
   - 共享外壳：sgx-segtabs.html / sgx-ph.html（页头，2026-11 对齐 PR-C 取代 sgx-page-hero.html；合站后四站直接用主站这一份），CSS 在 input.css 的 @inpage 段（gen-shell 抽成 assets/css/shell/shell.css）
   - 段式标签：2026-11 UI 重设计 PR-3 起终端风小方签（细线框、当前项主题色描边 + term-sel 衬底）；下面的对比度审计仍守着 nav-selected 这组角色（顶栏 / 锁屏还在用）
   - 对比度审计：22 套预设 × 深浅色 + 自定义色（色相扫一圈 × 5 档明度 + 极端值），段式标签放在页面底色 / 表面色上，非当前项文字 ≥ 4.5:1、当前项 ≥ 4.5:1 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { rolesFor } from '../../../../space/web/assets/js/lib/palette-scheme.js';
import { SHELL_REGIONS } from '../../../../space/scripts/gen-shell.mjs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const has = (p) => existsSync(new URL('../../../../' + p, import.meta.url));
const shell = rd('space/web/assets/css/shell/shell.css');

test('共享外壳：inpage 段进 shell.css；段式标签（2026-11 UI 重设计 PR-3 起终端风小方签，奇趣 / 日刻还在用）：细线框、次要文字色，当前项主题色描边 + 主题色字 + term-sel 衬底', () => {
  assert.ok(SHELL_REGIONS.includes('inpage'));
  assert.match(shell, /\.sgx-segs-tab \{[^}]*border: 1px solid var\(--sgx-term-line\); border-radius: 8px;[^}]*background-color: transparent; color: var\(--sgx-text-secondary\);[^}]*font-family: var\(--sgx-font-mono\);/);
  assert.match(shell, /\.sgx-segs-tab\[aria-current="page"\] \{ border-color: var\(--sgx-primary\); background-color: var\(--sgx-term-sel\); color: var\(--sgx-primary\); font-weight: 500; \}/);
  assert.match(shell, /\.sgx-segs\[hidden\] \{ display: none; \}/);
  assert.match(shell, /\.sgx-ph-title \{/);
});

test('页头 .sgx-ph（2026-11 对齐 PR-C，设计稿 .hero.ph）：$ 命令 · 标题_ · 一行说明，两种布局都显示（不再桌面视觉隐藏）；旧 .sgx-hero 标题带退役', () => {
  assert.doesNotMatch(shell, /\.sgx-hero(-title|-desc|--term)?\b/, '旧标题带样式删除');
  assert.doesNotMatch(shell, /\.sgx-ph[^{]*\{[^}]*(clip-path: inset\(50%\)|display: none)/, '页头不隐藏');
  assert.match(shell, /\.sgx-ph-title \{[^}]*font-family: var\(--sgx-font-mono\); font-size: 40px;/, '手机 40px');
  assert.match(shell, /:root\[data-sgx-layout="desktop"\] \.sgx-ph-title \{ font-size: 64px; \}/, '桌面 64px');
  assert.match(shell, /\.sgx-ph-title::after \{ content: "_" \/ ""; color: var\(--sgx-primary\); \}/, '「_」是 CSS ::after（读屏不念）');
  assert.doesNotMatch(shell, /\[data-sgx-layout="[a-z]+"\][^{]*\.sgx-segs[^{]*\{[^}]*display: none/, '段式标签不按布局隐藏');
  const ph = rd('space/web/layouts/partials/sgx-ph.html');
  assert.match(ph, /<header class="sgx-ph" data-sgx-ph>/);
  assert.match(ph, /<p class="sgx-ph-cmd" aria-hidden="true" translate="no"><span class="sgx-pr">styrigx@space:~\$<\/span> \{\{ \.cmd \}\}<\/p>/);
  assert.match(ph, /if not \.cmd \}\}\{\{ errorf "sgx-ph:/, '缺命令构建失败');
  assert.match(ph, /if not \.desc \}\}\{\{ warnf "sgx-ph:/, '缺说明只警告');
  assert.ok(!has('space/web/layouts/partials/sgx-page-hero.html'), 'sgx-page-hero.html 退役');
  /* 2026-11 合站：三个子站的样式表直接 @import 这份 shell.css（不再同步副本） */
  for (const site of ['blog', 'curio', 'daymark']) {
    assert.match(rd(`space/web/assets/${site}/css/input.css`), /@import ['"]\.\.\/\.\.\/css\/shell\/shell\.css['"];/, site + ' 引入共享外壳 shell.css');
  }
});

test('对齐 PR-C 共用件：chips（当前项 aria-current 主题色描边）、文章行（桌面 70px 1fr auto 60px，摘要两行）、less 分页条、两窗 1.25fr : 1fr', () => {
  assert.match(shell, /\.sgx-chip\[aria-current="true"\] \{ border-color: var\(--sgx-primary\); color: var\(--sgx-primary\);/);
  assert.match(shell, /\.sgx-chip--more \{ margin-left: auto; border-style: dashed; \}/);
  assert.match(shell, /\.sgx-pl \{ display: grid; grid-template-columns: 70px minmax\(0, 1fr\) auto 60px;/);
  assert.match(shell, /\.sgx-pl-ex \{[^}]*-webkit-line-clamp: 2;/);
  assert.match(shell, /\.sgx-pg-l b \{[^}]*background: var\(--sgx-text-primary\);/);
  assert.match(shell, /:root\[data-sgx-layout="desktop"\] \.sgx-tw \{ grid-template-columns: minmax\(0, 1\.25fr\) minmax\(0, 1fr\);/);
});

test('inpage 段只用 --sgx-* 角色，不写死颜色', () => {
  /* 只用 --sgx-* 角色，不写死颜色 */
  const region = shell.slice(shell.indexOf('/* ---- inpage ---- */'), shell.indexOf('/* ---- wide ---- */'));
  assert.ok(region.length > 200);
  assert.doesNotMatch(region, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});

test('共享外壳：sgx-segtabs.html / sgx-ph.html 只有主站一份（2026-11 合站后三个子站直接调用，没有副本）', () => {
  for (const site of ['blog', 'curio', 'daymark']) {
    assert.ok(!has(`space/web/layouts/partials/${site}/sgx-shell-segtabs.html`), site);
    assert.ok(!has(`space/web/layouts/partials/${site}/sgx-shell-page-hero.html`), site);
  }
});

test('子站接入：奇趣子页页头（页头 + 段式标签），日刻页内分区（另两个分区面板各一个页头 + 段式标签）；博客首页 / 目录页 / 标签页用 sgx-ph，没有段式标签', () => {
  for (const id of ['finds', 'devices', 'games', 'movies', 'music']) {
    assert.match(rd(`space/web/layouts/curio/${id}.html`), new RegExp(`partial "curio/page-head\\.html" \\(dict "page" \\. "id" "${id}"`), id);
    for (const f of [`${id}.md`, `${id}.zh.md`]) assert.match(rd(`space/web/content/curio/${f}`), /^description: '.+'$/m, f);
  }
  const head = rd('space/web/layouts/partials/curio/page-head.html');
  assert.match(head, /partial "sgx-ph\.html"/);
  assert.match(head, /partial "sgx-segtabs\.html" \(dict "items" \$segs "current" \.id/);
  assert.match(rd('space/web/assets/curio/css/input.css'), /html:not\(\.cu-music-ok\) #cu-segs \.sgx-segs-tab\[data-seg="music"\]:not\(\[aria-current\]\) \{ display: none; \}/);
  const dm = rd('space/web/layouts/daymark/section.html');
  assert.equal((dm.match(/partial "sgx-ph\.html"/g) || []).length, 2, 'daymark');
  for (const id of ['trove', 'flavors']) assert.match(dm, new RegExp(`partial "sgx-ph\\.html" \\(dict "cmd" "[^"]+" .*"tag" "h2"\\) \\}\\}\\n\\s*\\{\\{ partial "sgx-segtabs\\.html" \\(dict "items" \\$segItems "current" "${id}"`), 'daymark ' + id);
  for (const f of ['section.html', 'tree.html', 'term.html']) {
    const src = rd(`space/web/layouts/blog/${f}`);
    assert.match(src, /partial "sgx-ph\.html" \(dict "cmd" /, 'blog ' + f);
    assert.doesNotMatch(src, /sgx-segtabs|sgx-entries/, 'blog ' + f);
  }
});

test('主站内容页：页头接入（带命令），front matter 都有 description（中英）', () => {
  /* 对齐 PR-B：数字健康 / 关于本站 / 服务状态并进旷野页 wild（三份旧内容删除）；对齐 PR-C：风格页 theme 退役 */
  for (const p of ['wellbeing', 'about', 'status', 'theme']) for (const f of [`space/web/content/${p}.md`, `space/web/content/zh/${p}.md`]) assert.ok(!has(f), f + ' 应已删除');
  const pages = ['wild', 'security', 'security-tempkeys', 'account-apps', 'account-devices', 'account-profile', 'account-security', 'account-sync'];
  for (const p of pages) for (const f of [`space/web/content/${p}.md`, `space/web/content/zh/${p}.md`]) assert.match(rd(f), /^description: '.+'$/m, f);
  for (const l of pages) {
    assert.ok(has(`space/web/layouts/_default/${l}.html`), l);
    assert.match(rd(`space/web/layouts/_default/${l}.html`), /partial "sgx-ph\.html" \(dict "cmd" "[^"]+" "title" \.Title "desc" \.Description "path" \.File\.Path\)/, l);
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
  const { presets } = JSON.parse(rd('space/web/data/shell/palettes.json'));
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
