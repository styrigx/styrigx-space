/**
 * 共享外壳 web/atlas/shared/shell（scripts/gen-shell.mjs 生成，子站 sync-shell.mjs 同步）：
 * 生成物必须和源头一致；外壳 CSS 只用色彩角色，不写死颜色；导航项 / 图标齐全；顶栏标记 topbar.html 四站一份（2026-11-04 P5-1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderAll, OUT_DIR, SHELL_REGIONS, extractRegion } from '../../../../scripts/gen-shell.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const files = renderAll();
const ROLES = JSON.parse(readFileSync(path.join(REPO, 'web/atlas/data/palette-roles.json'), 'utf8'));

test('web/atlas/shared/shell 和源头一致（改了源头要重跑 node scripts/gen-shell.mjs）', () => {
  for (const [k, v] of Object.entries(files)) assert.equal(readFileSync(path.join(OUT_DIR, k), 'utf8'), v, k);
});

test('manifest 的 sha256 对得上每个文件', () => {
  const m = JSON.parse(files['manifest.json']);
  for (const [k, h] of Object.entries(m.files)) assert.equal(createHash('sha256').update(files[k]).digest('hex'), h, k);
});

test('外壳 CSS 段只用 --sgx-* 角色：没有十六进制颜色、没有旧 --m-* 令牌', () => {
  const css = readFileSync(path.join(REPO, 'web/atlas/assets/css/input.css'), 'utf8');
  for (const n of SHELL_REGIONS) {
    const r = extractRegion(css, n).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(r, /#[0-9a-fA-F]{3,8}\b/, n);
    assert.doesNotMatch(r, /var\(--m-/, n);
    assert.doesNotMatch(r, /rgba\((?!0,0,0,)/, n + '：除阴影外不许写死 rgba');
  }
});

test('快捷面板（P5-1，替代抽屉）：非模态窗口在顶栏下面、毛玻璃面板、两页 scroll-snap、导航页 tonal 当前项；抽屉样式全删', () => {
  const s = files['shell.css'];
  assert.match(s, /\.sgx-qp \{ position: fixed; top: var\(--sgx-qp-top\);[^}]*z-index: 45;/, '遮罩在顶栏（z 50+）下面');
  // 毛玻璃两行分开：基础规则只写 -webkit-，标准属性在 @supports 里单独一条（压缩器合并同值两行会丢掉其中一行）
  assert.match(s, /\.sgx-qp-sheet \{[^}]*background: var\(--sgx-mat\); -webkit-backdrop-filter: var\(--sgx-mat-filter\);/);
  assert.match(s, /@supports \(backdrop-filter: blur\(1px\)\) \{\s*\.sgx-qp-sheet \{ backdrop-filter: var\(--sgx-mat-filter\); \}/);
  assert.match(s, /@supports \(backdrop-filter: blur\(1px\)\) \{\s*\.sgx-topbar \{ backdrop-filter: var\(--sgx-mat-filter\); \}/);
  assert.match(s, /--sgx-qp-shadow: 0 4px 12px rgba\(0,0,0,\.10\), 0 16px 48px rgba\(0,0,0,\.24\)/);
  assert.match(s, /\.dark \{ --sgx-qp-shadow: 0 4px 12px rgba\(0,0,0,\.22\), 0 16px 48px rgba\(0,0,0,\.5\)/);
  // 宽屏 400px（AI 440px），右缘对齐外壳框
  assert.match(s, /@media \(min-width: 980px\) \{\s*\.sgx-qp-sheet \{ left: auto; right: calc\(\(100% - var\(--sgx-shell-w\)\) \/ 2\); width: 400px; margin: 0; \}\s*\.sgx-ai \.sgx-qp-sheet \{ width: 440px; \}/);
  // 两页：页签 + 横向 scroll-snap
  assert.match(s, /\.sgx-qp-tab\[aria-selected="true"\] \{ background: var\(--sgx-nav-selected\); color: var\(--sgx-on-nav-selected\);/);
  assert.match(s, /\.sgx-qp-pages \{ display: flex; overflow-x: auto;[^}]*scroll-snap-type: x mandatory;/);
  assert.match(s, /\.sgx-qp-page \{ flex: 0 0 100%;[^}]*scroll-snap-align: start;/);
  assert.match(s, /\.sgx-qp-nav-item\[aria-current="page"\][^{]*\{ background: var\(--sgx-nav-selected\); color: var\(--sgx-on-nav-selected\)/);
  assert.doesNotMatch(s, /\.sgx-drawer-(item|sheet|head|brand|body|foot|search|me|sep)\b|--sgx-drawer-/, '抽屉样式全删');
  assert.doesNotMatch(s, /is-fading|is-curtain|--sgx-curtain/);
});

test('nav.json：主站 / 奇趣 / 日刻 / 博客，没有设置；顶栏 / 磁贴 / AI 图标都在，九宫格图标删了', () => {
  const nav = JSON.parse(files['nav.json']);
  assert.deepEqual(nav.items.map((i) => i.id), ['home', 'curio', 'daymark', 'blog']);
  // 2026-10-21：书签项换成子站 奇趣 Curio（主站书签功能下线）
  const curio = nav.items.find((i) => i.id === 'curio');
  // 合并 PR3：三站和主站同在 styrigx.com（导航页里子站互相是相对地址 /curio/，见 partials/shell-topbar.html）
  assert.deepEqual([curio.icon, curio.origin, curio.path, curio.en], ['nav-curio', 'https://styrigx.com', '/curio/', 'Curio']);
  assert.ok(!JSON.stringify(nav).includes('atlas.styrigx.com'));
  assert.deepEqual(nav.footer, []);
  assert.ok(![...nav.items, ...nav.footer].some((i) => i.id === 'settings'));
  // P4-2b：搜索层删了，nav.json 没有 search 段，也没有它的 ai-search 图标
  assert.equal(nav.search, undefined);
  assert.equal(nav.icons['ai-search'], undefined);
  // 顶栏头像（子站链到主站账号页）
  assert.deepEqual(nav.me, { zh: '账号', en: 'Account', href: 'https://styrigx.com/account/', avatar: 'https://styrigx.com/avatar/192.webp' });
  assert.deepEqual(nav.items.map((i) => i.zh), ['主站', '奇趣', '日刻', '博客']);
  for (const i of [...nav.items, ...nav.footer]) assert.match(nav.icons[i.icon], /^<svg[\s\S]*<\/svg>$/, i.icon);
  for (const k of ['tb-sliders', 'tb-chat', 'tb-moon', 'sun', 'tb-globe', 'lock', 'tb-undo', 'share', 'tb-send']) assert.match(nav.icons[k], /^<svg[\s\S]*<\/svg>$/, k);
  assert.equal(nav.icons['apps-grid'], undefined, '九宫格删了');
});

test('palettes.json：22 套七色调色板（每项带 group / bg / 6 前景 + 亮暗 Shell + Semantic token），种子和 tokens.css 的 --sgx-seed 一致', () => {
  const p = JSON.parse(files['palettes.json']);
  assert.equal(p.presets.length, 22);
  assert.deepEqual(p.groups.map((g) => g.id), ['cool', 'nature', 'warm', 'floral', 'neutral']);
  for (const x of p.presets) {
    assert.ok(p.groups.some((g) => g.id === x.group), x.id);
    assert.match(x.bg, /^#[0-9a-f]{6}$/, x.id);
    assert.equal(x.fg.length, 6, x.id);
    assert.equal(x.seed, x.fg[0], x.id + ' 种子 = 前景 1');
    assert.ok(!/^x[a-z]/.test(x.id), x.id + ' 撞色 x* id 已删除');
    for (const m of ['light', 'dark']) {
      const t = x.tokens[m];
      for (const k of ['bg-1', 'bg-7', 'surface', 'topbar-glass', 'primary', 'on-primary', 'primary-container', 'secondary', 'nav-selected', 'link', 'outline-variant', 'text-primary', 'text-secondary', 'chart-1', 'chart-6', 'tag-bg', 'tag-fg'])
        assert.ok(typeof t[k] === 'string' && t[k], `${x.id} ${m} ${k}`);
      // chart-N = 引擎生成的角色（本色 → ink 回退，对比度 / 区分度单测在 palette-scheme.test.mjs）
      for (let i = 1; i <= 6; i++) assert.equal(t['chart-' + i], ROLES.presets[x.id][m]['chart-' + i], `${x.id} ${m} chart-${i}`);
      // 完整导出：填充档、固定状态色、焦点环、状态层、前景四档都在
      for (const k of ['primary-fill', 'on-primary-fill', 'focus-ring', 'danger', 'on-danger-container', 'success', 'success-container', 'warning', 'on-warning',
        'warning-container', 'info', 'on-info-container', 'state-color', 'state-hover', 'state-pressed', 'fg-1-on', 'fg-6-on', 'night-card', 'switch-track-on'])
        assert.ok(t[k] !== undefined && t[k] !== '', `${x.id} ${m} ${k}`);
      // tokens.css 里同名变量同值
      assert.ok(files['tokens.css'].includes(`--sgx-bg-1: ${t['bg-1']};`), `${x.id} ${m} bg-1 in tokens.css`);
    }
  }
  assert.equal(p.default, 'dustyblue');
  assert.equal(p.rulesVersion, 'palette-rules-1');
  assert.equal(JSON.parse(files['manifest.json']).rulesVersion, 'palette-rules-1');
  assert.equal(p.presets[0].id, 'dustyblue');
  for (const { id, seed } of p.presets) {
    const sel = id === 'dustyblue' ? ':root,\n:root[data-palette="dustyblue"] {' : `:root[data-palette="${id}"] {`;
    assert.ok(files['tokens.css'].includes(`${sel}\n  --sgx-seed: ${seed};`), id);
  }
  // 调色板派生 token（tag）在 tokens.css；chart-1..6 是每套生成的角色
  assert.match(files['tokens.css'], /--sgx-chart-1: #[0-9a-f]{6};/);
  assert.doesNotMatch(files['tokens.css'], /--sgx-chart-1: var\(--sgx-fg-1\);/);
  assert.match(files['tokens.css'], /--sgx-tag-bg: var\(--sgx-fg-4-tint\);/);
});

test('顶栏 P5-1（2026-11-04）：一整条胶囊 [logo][中间][快捷面板 · AI · 头像]，同一份标记 topbar.html 四站共用；九宫格 / 右圆 / 抽屉头删除', () => {
  assert.deepEqual(SHELL_REGIONS, ['topbar-frame', 'panel']);
  const s = files['shell.css'];
  assert.match(s, /\.sgx-topbar \{ position: fixed;[^}]*width: var\(--sgx-shell-w\);[^}]*border-radius: 999px;[^}]*background: var\(--sgx-mat\);/);
  assert.match(s, /\.sgx-tb-btn \{ width: var\(--sgx-tb-ic\); height: var\(--sgx-tb-ic\);[^}]*border-radius: 999px;/);
  assert.match(s, /\.sgx-tb-title \{[^}]*text-align: center;[^}]*text-overflow: ellipsis;/);
  assert.match(s, /@media \(min-width: 600px\) \{\s*\.sgx-topbar \{ display: grid; grid-template-columns: 1fr auto 1fr; \}/, '宽屏中间居中');
  assert.doesNotMatch(s, /\.sgx-tb-nav\b|\.sgx-tb-end\b|\.sgx-tb-gbtn\b|\.sgx-drawer/);
  // 标记：topbar.html = 主站 partials/shell-topbar.html 原样
  const src = readFileSync(path.join(REPO, 'web/atlas/layouts/partials/shell-topbar.html'), 'utf8');
  assert.equal(files['topbar.html'], src);
  assert.doesNotMatch(src.replace(/\{\{-? \/\*[\s\S]*?\*\/ -?\}\}/g, ''), /\bpartial |site\.Data|hugo\.Data|resources\.Get/, '只用参数，不调别的 partial / 数据');
  const order = ['class="sgx-tb-logo"', 'class="sgx-tb-pill', 'sgx-tb-quick', 'sgx-tb-ai', 'sgx-tb-me'].map((k) => src.indexOf(k));
  assert.ok(order.every((x, n) => x > 0 && (n === 0 || x > order[n - 1])), 'logo → 中间 → 快捷面板 → AI → 头像');
  assert.match(src, /<dialog id="sgx-qp" class="sgx-qp"/);
  assert.match(src, /<dialog id="sgx-ai" class="sgx-qp sgx-ai"/);
  const base = readFileSync(path.join(REPO, 'web/atlas/layouts/_default/baseof.html'), 'utf8');
  /* 主站中间：主页 / 设置两页是标签（partials/topbar-tabs.html，2026-11-04 去掉聊天），其他页只有页名 */
  assert.match(base, /\{\{ if \$tabCur \}\}\{\{ \$center = partial "topbar-tabs\.html" \(dict "isEn" \$isEn "cur" \$tabCur\) \}\}\{\{ else \}\}\{\{ \$center = printf "<span class=\\"sgx-tb-title\\">%s<\/span>" \(htmlEscape \$pageName\) \}\}\{\{ end \}\}/);
  assert.match(base, /\{\{ partial "shell-topbar\.html" \(dict/);
  assert.doesNotMatch(base, /sgx-drawer|sgx-tb-nav|topbar-end\.html/);
  /* 标签样式只在主站段，不进共享外壳 */
  assert.doesNotMatch(s, /sgx-tb-tab/);
  assert.ok(!existsSync(path.join(REPO, 'web/atlas/layouts/partials/topbar-end.html')), 'topbar-end.html 已删');
});

test('P4-2b：搜索层整套删除——没有 search.js、shell.css 没有 search 段、主站没有 search-layer / search-host', () => {
  assert.equal(files['search.js'], undefined);
  assert.doesNotMatch(files['shell.css'], /---- search ----|\.sgx-srch/);
  for (const f of ['web/atlas/assets/js/shell/search-layer.js', 'web/atlas/assets/js/shell/search-host.js', 'web/atlas/shared/shell/search.js', 'web/atlas/static/opensearch.xml'])
    assert.ok(!existsSync(path.join(REPO, f)), f);
});
