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
  assert.match(s, /@supports \(backdrop-filter: blur\(1px\)\) \{\s*\.sgx-tb-pill, \.sgx-tb-nav \{ backdrop-filter: var\(--sgx-mat-filter\); \}/);
  assert.match(s, /width: calc\(100% - var\(--sgx-tb-inset\) - 1\.5 \* var\(--sgx-tb-btn\) - var\(--sgx-tb-gap\) - var\(--sgx-tb-ic\) \/ 2\)/);
});

test('nav.json：首页 / 书签 / 日刻 / 博客 + 设置，图标都在', () => {
  const nav = JSON.parse(files['nav.json']);
  assert.deepEqual(nav.items.map((i) => i.id), ['home', 'bookmarks', 'daymark', 'blog']);
  assert.deepEqual(nav.footer.map((i) => i.id), ['settings']);
  assert.deepEqual(nav.items.map((i) => i.zh), ['首页', '书签', '日刻', '博客']);
  for (const i of [...nav.items, ...nav.footer]) assert.match(nav.icons[i.icon], /^<svg[\s\S]*<\/svg>$/, i.icon);
  assert.ok(nav.icons['apps-grid']);
});

test('palettes.json：13 个预设，种子和 tokens.css 的 --sgx-seed 一致', () => {
  const p = JSON.parse(files['palettes.json']);
  assert.equal(p.presets.length, 13);
  assert.equal(p.default, 'lake');
  for (const { id, seed } of p.presets) {
    const sel = id === 'lake' ? ':root,\n:root[data-palette="lake"] {' : `:root[data-palette="${id}"] {`;
    assert.ok(files['tokens.css'].includes(`${sel}\n  --sgx-seed: ${seed};`), id);
  }
});
