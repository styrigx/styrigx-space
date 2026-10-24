/**
 * 快捷面板 / 设置页调色板模板（2026-10-21）：
 * - 快捷面板磁贴只剩 深色模式 | 跟随系统、语言 | 立即锁定；减弱动效、字体大小 2026-10-23 PR-E 起整个删除（字体靠浏览器缩放，动效跟系统）。
 * - 默认色板 lake 不放色块（快捷面板 + 设置页单色组），改成标题行右端「恢复默认」，初始 aria-disabled；
 *   点它走 setPalette('lake')（与点色块同一条路，自定义主题色一起清掉）。
 * - 磁贴 / 行 / 恢复默认 = 中性玻璃（--sgx-qp-glass，2026-10-23 PR-G 修订；不再铺 --m-secondary-container）。
 * - 2026-10-24 PR4：顶部「快捷面板」标题和齿轮（全部设置）删除；dialog 用 aria-label 保留读屏名字。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');
const base = rd('web/layouts/_default/baseof.html');
const qpHtml = base.slice(base.indexOf('<dialog id="sgx-qp"'), base.indexOf('</dialog>', base.indexOf('<dialog id="sgx-qp"')));
const theme = rd('web/layouts/partials/setcat-theme.html');
const qpJs = rd('web/assets/js/shell/quick-panel.js');
const setJs = rd('web/assets/js/apps/settings.js');
const css = rd('web/assets/css/input.css');
const feats = rd('web/data/features.yaml');

test('快捷面板磁贴：dark / system / lang / lock，没有减弱动效和字体大小', () => {
  const tiles = [...qpHtml.matchAll(/data-qp="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tiles, ['dark', 'system', 'lang', 'lock']);
  assert.ok(!qpHtml.includes('reduced-motion'));
  assert.ok(!qpHtml.includes('font-size'));
  assert.ok(!/setReducedMotion|setFontSize|reducedMotionPref|fontSize\(/.test(qpJs));
  /* 2026-10-23 PR-E：设置本身也删了 */
  assert.doesNotMatch(feats, /- id: reduced-motion/);
  assert.doesNotMatch(feats, /- id: font-size/);
  assert.doesNotMatch(setJs, /setReducedMotion|setFontSize|seg-font|row-motion/);
});

test('七色调色板（PR-G）：两处都是 22 个 .pal-tile、不分单色 / 撞色；都有「恢复默认」，初始 aria-disabled，点了 setPalette(DEFAULT_PALETTE = dustyblue)', () => {
  assert.match(qpHtml, /\{\{ range site\.Data\.palettes\.palettes \}\}<button type="button" class="sgx-qp-sw pal-tile"/);
  assert.doesNotMatch(qpHtml, /swatch-clash|"group" "mono"|"group" "clash"/);
  assert.doesNotMatch(theme, /swatch-clash|data-pal-tab|palette-dots-clash/);
  assert.match(theme, /range site\.Data\.palettes\.groups/);
  assert.match(qpHtml, /<button type="button" class="palette-reset" data-qp-reset aria-disabled="true">/);
  assert.match(theme, /<button type="button" class="palette-reset" id="palette-reset" aria-disabled="true">/);
  assert.match(qpHtml, /恢复默认/);
  assert.match(theme, /Reset/);
  for (const js of [qpJs, setJs]) {
    assert.match(js, /setPalette\(DEFAULT_PALETTE\)/);
    assert.match(js, /=== DEFAULT_PALETTE && !accent\(\)/);
    assert.doesNotMatch(js, /'lake'/);
  }
});

test('配色（2026-10-23 PR-G 修订）：磁贴 / 行 / 恢复默认 = 中性玻璃（不铺 secondary-container）；开着读 primary-container + 填充档图标圆；选中分段 = 填充档', () => {
  const rule = (sel) => {
    const i = css.indexOf('\n' + sel + ' {');
    assert.ok(i >= 0, sel);
    return css.slice(i, css.indexOf('}', i));
  };
  assert.match(css, /--sgx-qp-glass: color-mix\(in srgb, var\(--sgx-surface-container-lowest\) 62%, transparent\)/);
  assert.match(rule('.sgx-qp-tile'), /background: var\(--sgx-qp-glass\)/);
  assert.match(rule('.sgx-qp-row'), /background: var\(--sgx-qp-glass\)/);
  assert.match(rule('.palette-reset'), /background: var\(--sgx-qp-glass\)/);
  for (const sel of ['.sgx-qp-tile', '.sgx-qp-row', '.palette-reset']) assert.doesNotMatch(rule(sel), /secondary-container/, sel);
  assert.match(rule('.sgx-qp-tile[aria-pressed="true"]'), /background: var\(--m-primary-container\)/);
  assert.match(rule('.sgx-qp-tile[aria-pressed="true"] .sgx-qp-ic'), /background: var\(--m-primary-fill\); color: var\(--m-on-primary-fill\)/);
  assert.match(rule('.sgx-qp-seg button[aria-pressed="true"]'), /background: var\(--m-primary-fill\); color: var\(--m-on-primary-fill\)/);
  assert.match(rule('.palette-reset[aria-disabled="true"]'), /opacity: \.38/);
});

test('PR4：快捷面板没有标题和齿轮（模板、样式、脚本都删干净）；读屏名字在 dialog 的 aria-label', () => {
  const open = base.slice(base.indexOf('<dialog id="sgx-qp"'), base.indexOf('>', base.indexOf('<dialog id="sgx-qp"')) + 1);
  assert.match(open, /aria-label="\{\{ if \$isEn \}\}Quick panel\{\{ else \}\}快捷面板\{\{ end \}\}"/);
  assert.doesNotMatch(open, /aria-labelledby/);
  assert.doesNotMatch(qpHtml, /sgx-qp-head|sgx-qp-title|sgx-qp-set|"gear"/);
  assert.match(qpHtml, /<div class="sgx-qp-sheet" tabindex="-1" autofocus>\s*<div class="sgx-qp-grid">/);
  assert.doesNotMatch(css, /\.sgx-qp-(head|title|set)\b/);
  assert.doesNotMatch(qpJs, /sgx-qp-set|sgxNavigate/);
});
