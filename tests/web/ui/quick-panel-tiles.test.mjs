/**
 * 快捷面板 / 设置页调色板模板（2026-10-21）：
 * - 快捷面板磁贴只剩 深色模式 | 跟随系统、语言 | 立即锁定；减弱动效、字体大小 2026-10-23 PR-E 起整个删除（字体靠浏览器缩放，动效跟系统）。
 * - 默认色板 lake 不放色块（快捷面板 + 设置页单色组），改成标题行右端「恢复默认」，初始 aria-disabled；
 *   点它走 setPalette('lake')（与点色块同一条路，自定义主题色一起清掉）。
 * - 磁贴 / 行 / 恢复默认 = 中性玻璃（--sgx-qp-glass，2026-10-23 PR-G 修订；不再铺 --m-secondary-container）。
 * - 2026-10-24 PR4：顶部「快捷面板」标题和齿轮（全部设置）删除；dialog 用 aria-label 保留读屏名字。
 * - 2026-11-04 P5-1：快捷面板标记搬进顶栏单一来源 partials/shell-topbar.html（四站共用），分两页（导航 / 快捷设置）；
 *   磁贴按 tiles 参数输出，主站 = dark / system / lang / lock（+ 调色板、布局两行），没有分享；样式进 @shell panel 段，只用 --sgx-* 角色。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8');
const base = rd('web/atlas/layouts/_default/baseof.html');
const tb = rd('web/atlas/layouts/partials/shell-topbar.html');
const qpHtml = tb.slice(tb.indexOf('<dialog id="sgx-qp"'), tb.indexOf('</dialog>', tb.indexOf('<dialog id="sgx-qp"')));
const tbJs = rd('web/atlas/assets/js/shell/topbar-panel.js');
const theme = rd('web/atlas/layouts/partials/setcat-theme.html');
const qpJs = rd('web/atlas/assets/js/shell/quick-panel.js');
const setJs = rd('web/atlas/assets/js/apps/settings.js');
const css = rd('web/atlas/assets/css/input.css');
const feats = rd('web/atlas/data/features.yaml');

test('快捷面板磁贴：dark / system / lang / lock / share（share 只给子站），没有减弱动效和字体大小；主站不传 share', () => {
  const tiles = [...qpHtml.matchAll(/data-qp="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tiles, ['dark', 'system', 'lang', 'lock', 'share']);
  const mainTiles = base.match(/\{\{ \$tbTiles := dict ([^}]*)\}\}/);
  assert.ok(mainTiles, '主站 baseof 算好 tiles 传给 shell-topbar');
  assert.match(mainTiles[1], /"lock" true/);
  assert.doesNotMatch(mainTiles[1], /share/, '主站模板层不输出分享磁贴（定案第 4 条）');
  assert.ok(!qpHtml.includes('reduced-motion'));
  assert.ok(!qpHtml.includes('font-size'));
  assert.ok(!/setReducedMotion|setFontSize|reducedMotionPref|fontSize\(/.test(qpJs + tbJs));
  /* 2026-10-23 PR-E：设置本身也删了 */
  assert.doesNotMatch(feats, /- id: reduced-motion/);
  assert.doesNotMatch(feats, /- id: font-size/);
  assert.doesNotMatch(setJs, /setReducedMotion|setFontSize|seg-font|row-motion/);
});

test('七色调色板（PR-G）：两处都是 22 个 .pal-tile、不分单色 / 撞色；都有「恢复默认」，初始 aria-disabled，点了 setPalette(DEFAULT_PALETTE = dustyblue)', () => {
  assert.match(qpHtml, /\{\{- range \.pal \}\}<button type="button" class="sgx-qp-sw pal-tile" data-qp-palette="\{\{ \.id \}\}"/);
  assert.match(base, /\{\{ range site\.Data\.palettes\.palettes \}\}\{\{ \$tbPal = \$tbPal \| append/, '主站色块来自 palettes.yaml（22 个）');
  assert.doesNotMatch(qpHtml, /swatch-clash|"group" "mono"|"group" "clash"/);
  assert.doesNotMatch(theme, /swatch-clash|data-pal-tab|palette-dots-clash/);
  assert.match(theme, /range site\.Data\.palettes\.groups/);
  assert.match(qpHtml, /<button type="button" class="palette-reset" data-qp-reset aria-disabled="true">/);
  assert.match(theme, /<button type="button" class="palette-reset" id="palette-reset" aria-disabled="true">/);
  assert.match(qpHtml, /恢复默认/);
  assert.match(theme, /Reset/);
  assert.match(setJs, /setPalette\(DEFAULT_PALETTE\)/);
  assert.match(setJs, /=== DEFAULT_PALETTE && !accent\(\)/);
  /* 快捷面板的逻辑在 topbar-panel.js（四站共用，依赖由 quick-panel.js 传入） */
  assert.match(tbJs, /P\.setPalette\(P\.DEFAULT_PALETTE\)/);
  assert.match(tbJs, /=== P\.DEFAULT_PALETTE && !P\.hasAccent\(\)/);
  assert.match(qpJs, /DEFAULT_PALETTE,/);
  for (const js of [qpJs, tbJs, setJs]) assert.doesNotMatch(js, /'lake'/);
});

test('配色（2026-10-23 PR-G 修订；P5-1 改用 --sgx-* 角色）：磁贴 / 行 / 恢复默认 = 中性玻璃（不铺 secondary-container）；开着读 primary-container + 填充档图标圆；选中分段 = 填充档', () => {
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
  assert.match(rule('.sgx-qp-tile[aria-pressed="true"]'), /background: var\(--sgx-primary-container\)/);
  assert.match(rule('.sgx-qp-tile[aria-pressed="true"] .sgx-qp-ic'), /background: var\(--sgx-primary-fill\); color: var\(--sgx-on-primary-fill\)/);
  assert.match(rule('.sgx-qp-seg button[aria-pressed="true"]'), /background: var\(--m-primary-fill\); color: var\(--m-on-primary-fill\)/);
  assert.match(rule('.palette-reset[aria-disabled="true"]'), /opacity: \.38/);
});

test('PR4：快捷面板没有标题和齿轮（模板、样式、脚本都删干净）；读屏名字在 dialog 的 aria-label；P5-1 两页页签', () => {
  const open = tb.slice(tb.indexOf('<dialog id="sgx-qp"'), tb.indexOf('>', tb.indexOf('<dialog id="sgx-qp"')) + 1);
  assert.match(open, /aria-label="\{\{ if \$en \}\}Quick panel\{\{ else \}\}快捷面板\{\{ end \}\}"/);
  assert.doesNotMatch(open, /aria-labelledby/);
  assert.doesNotMatch(qpHtml, /sgx-qp-head|sgx-qp-title|"gear"/);
  assert.doesNotMatch(qpHtml, /class="sgx-qp-set"/);
  assert.match(qpHtml, /<div class="sgx-qp-sheet" tabindex="-1" autofocus>\s*<div class="sgx-qp-tabs" role="tablist"/);
  assert.equal((qpHtml.match(/role="tab" /g) || []).length, 2, '两个页签：导航 / 快捷设置');
  assert.equal((qpHtml.match(/role="tabpanel"/g) || []).length, 2);
  assert.doesNotMatch(css, /\.sgx-qp-(head|title|set)\b/);
  assert.doesNotMatch(qpJs + tbJs, /sgx-qp-set\b/);
});
