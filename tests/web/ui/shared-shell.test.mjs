/**
 * 共享外壳 web/shared/shell（scripts/gen-shell.mjs 生成，子站 sync-shell.mjs 同步）：
 * 生成物必须和源头一致；外壳 CSS 只用色彩角色，不写死颜色；抽屉项 / 图标齐全。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderAll, OUT_DIR, SHELL_REGIONS, extractRegion } from '../../../scripts/gen-shell.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const files = renderAll();

test('web/shared/shell 和源头一致（改了源头要重跑 node scripts/gen-shell.mjs）', () => {
  for (const [k, v] of Object.entries(files)) assert.equal(readFileSync(path.join(OUT_DIR, k), 'utf8'), v, k);
});

test('manifest 的 sha256 对得上每个文件', () => {
  const m = JSON.parse(files['manifest.json']);
  for (const [k, h] of Object.entries(m.files)) assert.equal(createHash('sha256').update(files[k]).digest('hex'), h, k);
});

test('外壳 CSS 段只用 --sgx-* 角色：没有十六进制颜色、没有旧 --m-* 令牌', () => {
  const css = readFileSync(path.join(REPO, 'web/assets/css/input.css'), 'utf8');
  for (const n of SHELL_REGIONS) {
    const r = extractRegion(css, n).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(r, /#[0-9a-fA-F]{3,8}\b/, n);
    assert.doesNotMatch(r, /var\(--m-/, n);
    assert.doesNotMatch(r, /rgba\((?!0,0,0,)/, n + '：除阴影外不许写死 rgba');
  }
});

test('抽屉：tonal 当前项、毛玻璃面板、手机宽度由顶栏 token 算', () => {
  const s = files['shell.css'];
  assert.match(s, /\.sgx-drawer-item\[aria-current="page"\][^{]*\{ background: var\(--sgx-nav-selected\); color: var\(--sgx-on-nav-selected\)/);
  // 毛玻璃两行分开：基础规则只写 -webkit-，标准属性在 @supports 里单独一条（压缩器合并同值两行会丢掉其中一行）
  assert.match(s, /\.sgx-drawer-sheet \{[^}]*background: var\(--sgx-mat\); -webkit-backdrop-filter: var\(--sgx-mat-filter\);/);
  assert.match(s, /@supports \(backdrop-filter: blur\(1px\)\) \{\s*\.sgx-drawer-sheet \{ backdrop-filter: var\(--sgx-mat-filter\); \}/);
  assert.match(s, /@supports \(backdrop-filter: blur\(1px\)\) \{\s*\.sgx-tb-pill, \.sgx-tb-nav, \.sgx-tb-end \{ backdrop-filter: var\(--sgx-mat-filter\); \}/);
  // 2026-10-22：手机竖屏恢复 #163 之前的宽度（扣半个 --sgx-tb-ic，412 → 290，和子站一致）
  assert.match(s, /\.sgx-drawer-sheet \{ width: calc\(100% - var\(--sgx-tb-inset\) - 1\.5 \* var\(--sgx-tb-btn\) - var\(--sgx-tb-gap\) - var\(--sgx-tb-ic\) \/ 2\); \}/);
  // 阴影往右投、清楚可见，深色加深
  assert.match(s, /--sgx-drawer-shadow: 4px 0 12px rgba\(0,0,0,\.10\), 16px 0 48px rgba\(0,0,0,\.24\)/);
  assert.match(s, /\.dark \{ --sgx-drawer-shadow: 4px 0 12px rgba\(0,0,0,\.22\), 16px 0 48px rgba\(0,0,0,\.5\)/);
  assert.match(s, /\.sgx-drawer-sheet \{[^}]*box-shadow: var\(--sgx-drawer-shadow\)/);
  // 抽屉三段（v7）：面板竖排 flex，[头部：只有大号站名][导航列表：自己滚][底栏：钉住的整宽搜索框长条（52px，图标 + 文字一组居中）]
  assert.match(s, /--sgx-drawer-brand-size: 32px; --sgx-drawer-brand-weight: 800; --sgx-drawer-head-gap: 32px; --sgx-drawer-search-h: 52px;/);
  assert.match(s, /\.sgx-drawer-sheet \{[^}]*overflow: hidden;[^}]*display: flex; flex-direction: column;/);
  assert.match(s, /\.sgx-drawer-head \{ flex: 0 0 auto; margin: 0 0 var\(--sgx-drawer-head-gap\);/);
  assert.match(s, /\.sgx-drawer-brand \{[^}]*font-size: var\(--sgx-drawer-brand-size\);\s*font-weight: var\(--sgx-drawer-brand-weight\)/);
  assert.match(s, /\.sgx-drawer-body \{ flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;/);
  assert.match(s, /\.sgx-drawer-foot \{ flex: 0 0 auto;[^}]*env\(safe-area-inset-bottom/);
  assert.match(s, /\.sgx-drawer-search \{ width: 100%; height: var\(--sgx-drawer-search-h\); border-radius: 999px; display: flex; align-items: center; justify-content: center;[^}]*background-color: color-mix\(in srgb, var\(--sgx-surface-container-lowest\) 72%, transparent\); border: 1px solid var\(--sgx-mat-line\);/);
  assert.match(s, /\.dark \.sgx-drawer-search \{ background-color: var\(--sgx-surface-bright\); \}/);
  assert.match(s, /\.sgx-drawer-search-label \{ flex: 0 1 auto;/);
  // 主站专有的东西不进共享外壳：抽屉淡出、导航项下的分隔线；旧的窗帘 / 加宽已删
  assert.doesNotMatch(s, /is-fading|sgx-drawer-sep|is-curtain|--sgx-curtain/);
});

test('nav.json：首页 / 奇趣 / 日刻 / 博客，没有设置；抽屉头搜索框；图标都在', () => {
  const nav = JSON.parse(files['nav.json']);
  assert.deepEqual(nav.items.map((i) => i.id), ['home', 'curio', 'daymark', 'blog']);
  // 2026-10-21：书签项换成子站 珍格 Curio（主站书签功能下线）
  const curio = nav.items.find((i) => i.id === 'curio');
  assert.deepEqual([curio.icon, curio.origin, curio.path, curio.en], ['nav-curio', 'https://curio.styrigx.com', '/', 'Curio']);
  // 2026-10-21：设置从抽屉挪到主站快捷面板顶栏，外壳不再要求有设置项（子站之后同步）
  assert.deepEqual(nav.footer, []);
  assert.ok(![...nav.items, ...nav.footer].some((i) => i.id === 'settings'));
  assert.equal(nav.search.icon, 'ai-search');
  assert.equal(nav.search.path, '/search/');
  assert.equal(nav.search.layer, 'search.js');
  // 2026-10-22：抽屉头头像（子站链到主站）
  assert.deepEqual(nav.me, { zh: '账号', en: 'Account', href: 'https://styrigx.com/settings/account/', avatar: 'https://styrigx.com/avatar/192.webp' });
  assert.match(nav.icons['ai-search'], /^<svg[\s\S]*M14\.9 9\.6A6 6 0 1 1 11\.6 7\.2[\s\S]*<\/svg>$/);
  assert.deepEqual(nav.items.map((i) => i.zh), ['首页', '奇趣', '日刻', '博客']);
  for (const i of [...nav.items, ...nav.footer]) assert.match(nav.icons[i.icon], /^<svg[\s\S]*<\/svg>$/, i.icon);
  assert.ok(nav.icons['apps-grid']);
});

test('palettes.json：33 个预设（单色 17 + 撞色 16，每项带 group），种子和 tokens.css 的 --sgx-seed 一致', () => {
  const p = JSON.parse(files['palettes.json']);
  assert.equal(p.presets.length, 33);
  for (const x of p.presets) assert.ok(x.group === 'mono' || x.group === 'clash', x.id);
  assert.equal(p.default, 'lake');
  for (const { id, seed } of p.presets) {
    const sel = id === 'lake' ? ':root,\n:root[data-palette="lake"] {' : `:root[data-palette="${id}"] {`;
    assert.ok(files['tokens.css'].includes(`${sel}\n  --sgx-seed: ${seed};`), id);
  }
});

test('顶栏 v8（2026-10-22）：九宫格圆 | 只有页名的长条 | 右圆 .sgx-tb-end（每站自定义），三块同材质；头像在抽屉头 .sgx-drawer-me（52px）', () => {
  assert.deepEqual(SHELL_REGIONS, ['topbar-frame', 'drawer', 'search']);
  const s = files['shell.css'];
  assert.match(s, /\.sgx-tb-pill, \.sgx-tb-nav, \.sgx-tb-end \{\s*background: var\(--sgx-mat\);/);
  assert.match(s, /\.sgx-tb-nav, \.sgx-tb-end \{ width: var\(--sgx-tb-btn\); height: var\(--sgx-tb-btn\); border-radius: 999px;/);
  assert.match(s, /\.sgx-tb-title \{[^}]*text-align: center;[^}]*text-overflow: ellipsis;/);
  assert.doesNotMatch(s, /\.sgx-tb-me\b|\.sgx-tb-ic\b/);
  assert.match(s, /\.sgx-drawer-head \{[^}]*align-items: center;\s*justify-content: space-between;/);
  assert.match(s, /:root \{ --sgx-drawer-me: var\(--sgx-tb-btn\); \}/);
  assert.match(s, /\.sgx-drawer-me \{[^}]*width: var\(--sgx-drawer-me\); height: var\(--sgx-drawer-me\); border-radius: 999px;[^}]*box-shadow: var\(--sgx-mat-shadow\);/);
  const base = readFileSync(path.join(REPO, 'web/layouts/_default/baseof.html'), 'utf8');
  assert.match(base, /<div class="sgx-tb-pill"><span class="sgx-tb-title">\{\{ \$pageName \}\}<\/span><\/div>\n\s*\{\{ partial "topbar-end\.html"/);
  const end = readFileSync(path.join(REPO, 'web/layouts/partials/topbar-end.html'), 'utf8');
  assert.match(end, /<button type="button" class="sgx-tb-end sgx-tb-quick"/);
});

test('搜索层：search.js 原样复制 shell/search-layer.js、不 import 任何东西；shell.css 有 search 段；引擎表和 engines.js 一致', async () => {
  const src = readFileSync(path.join(REPO, 'web/assets/js/shell/search-layer.js'), 'utf8');
  assert.equal(files['search.js'], src);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /^\s*import\s|\bimport\s*\(/m);
  assert.match(files['shell.css'], /\/\* ---- search ---- \*\/[\s\S]*\.sgx-srch \{ position: fixed; inset: 0;/);
  assert.match(files['shell.css'], /\.sgx-drawer\.sgx-srch-ghost \{ z-index: 60;/);
  const engSrc = readFileSync(path.join(REPO, 'web/assets/js/shell/engines.js'), 'utf8');
  const { ENGINES, looksLikeUrl } = await import('../../../web/assets/js/shell/search-layer.js');
  for (const [id, e] of Object.entries(ENGINES)) {
    assert.ok(engSrc.includes(`${id}: { n: '${e.n}', u: '${e.u}'`), id);
  }
  assert.equal(looksLikeUrl('example.com'), true);
  assert.equal(looksLikeUrl('github.com/styrigx'), true);
  assert.equal(looksLikeUrl('猫.com'), false);
  assert.equal(looksLikeUrl('hello world'), false);
  assert.equal(looksLikeUrl('a.b'), false);
});
