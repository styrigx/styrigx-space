/**
 * 快捷面板 / 设置页调色板模板（2026-10-21）：
 * - 快捷面板磁贴只剩 深色模式 | 跟随系统、语言 | 立即锁定；减弱动效、字体大小 2026-10-23 PR-E 起整个删除（字体靠浏览器缩放，动效跟系统）。
 * - 默认色板 lake 不放色块（快捷面板 + 设置页单色组），改成标题行右端「恢复默认」，初始 aria-disabled；
 *   点它走 setPalette('lake')（与点色块同一条路，自定义主题色一起清掉）。
 * - 磁贴 / 行 / 恢复默认 = 中性玻璃（--sgx-qp-glass，2026-10-23 PR-G 修订；不再铺 --m-secondary-container）。
 * - 2026-10-24 PR4：顶部「快捷面板」标题和齿轮（全部设置）删除；dialog 用 aria-label 保留读屏名字。
 * - 2026-11-04 P5-1：快捷面板标记搬进顶栏单一来源 partials/shell-topbar.html（四站共用），分两页（导航 / 快捷设置）；
 *   磁贴按 tiles 参数输出，主站 = dark / system / lang / lock（+ 调色板、布局两行），没有分享；样式进 @shell panel 段，只用 --sgx-* 角色。
 * - 2026-11-07 P4-3 PR-4b（Gray 定稿）：快捷面板只有一页、四站同一套（没有 tiles 参数）：磁贴 深色 / 跟随系统 / 分享本页 / 立即锁定（两行 2×2），
 *   语言整行（行内展开单选），调色板、布局；导航搬到九宫格面板 #sgx-nav。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const base = rd('space/web/layouts/_default/baseof.html');
const tb = rd('space/web/layouts/partials/shell-topbar.html');
const qpHtml = tb.slice(tb.indexOf('<dialog id="sgx-qp"'), tb.indexOf('</dialog>', tb.indexOf('<dialog id="sgx-qp"')));
const tbJs = rd('space/web/assets/js/shell/topbar-panel.js');
const theme = rd('space/web/layouts/partials/setcat-theme.html');
const qpJs = rd('space/web/assets/js/shell/quick-panel.js');
const setJs = rd('space/web/assets/js/apps/space.js');
const css = rd('space/web/assets/css/input.css');
const feats = rd('space/web/data/features.yaml');

test('快捷面板磁贴（PR-4b 四站同一套）：dark / system / share / lock 两行 2×2 + 语言整行；没有按站开关、没有减弱动效和字体大小', () => {
  const tiles = [...qpHtml.matchAll(/data-qp="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tiles, ['dark', 'system', 'share', 'lock', 'lang']);
  assert.doesNotMatch(qpHtml, /\.tiles\b|\$tiles|\{\{ with \.layout \}\}/, '磁贴不再按 tiles / layout 参数开关');
  assert.doesNotMatch(base, /\$tbTiles|"tiles"|"layout" \(index/, '主站不再传 tiles / layout');
  assert.match(qpHtml, /<button type="button" class="sgx-qp-line" data-qp="lang" aria-expanded="false" aria-controls="sgx-qp-lang-opts"/);
  /* 语言包化（2026-11-07）：选项 = 跟随系统 + hugo.yaml languages 的每种语言（语言名用它自己的写法、translate="no"），不写死 zh / en */
  assert.match(qpHtml, /<button type="button" class="sgx-qp-opt" role="radio" data-qp-lang="system" aria-checked="false"><span class="sgx-qp-opt-tx">\{\{ \$t\.topbar\.followSystem \}\}<\/span>/);
  assert.match(qpHtml, /\{\{- range \.langs \}\}\s*<button type="button" class="sgx-qp-opt" role="radio" data-qp-lang="\{\{ \.code \}\}" lang="\{\{ \.code \}\}" aria-checked="false"><span class="sgx-qp-opt-tx" translate="no">\{\{ \.name \}\}<\/span>/);
  assert.doesNotMatch(qpHtml, /"v" "(zh|en)"/);
  assert.match(qpHtml, /<div class="sgx-qp-opts" id="sgx-qp-lang-opts" role="radiogroup"[^>]*hidden>/);
  assert.match(qpHtml, /data-qp-seg="layout"/);
  assert.match(qpJs, /share: mountShare/, '主站也接分享本页');
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
  assert.match(qpHtml, /<span>\{\{ \$t\.topbar\.reset \}\}<\/span>/);
  assert.match(rd('space/web/data/sgx-shell-i18n/zh.yaml'), /\n  reset: 恢复默认\n/);
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
  assert.match(rule('.sgx-qp-tile[aria-pressed="true"], .sgx-qp-tile[aria-current="page"]'), /background: var\(--sgx-primary-container\)/);
  assert.match(rule('.sgx-qp-tile[aria-pressed="true"] .sgx-qp-ic, .sgx-qp-tile[aria-current="page"] .sgx-qp-ic'), /background: var\(--sgx-primary-fill\); color: var\(--sgx-on-primary-fill\)/);
  assert.match(rule('.sgx-qp-seg button[aria-pressed="true"]'), /background: var\(--sgx-primary-fill\); color: var\(--sgx-on-primary-fill\)/);
  assert.match(rule('.palette-reset[aria-disabled="true"]'), /opacity: \.38/);
});

test('PR4：快捷面板没有标题和齿轮（模板、样式、脚本都删干净）；读屏名字在 dialog 的 aria-label；PR-4b 起没有页签 / 两页', () => {
  const open = tb.slice(tb.indexOf('<dialog id="sgx-qp"'), tb.indexOf('>', tb.indexOf('<dialog id="sgx-qp"')) + 1);
  assert.match(open, /aria-label="\{\{ \$t\.topbar\.quick \}\}"/);
  assert.doesNotMatch(open, /aria-labelledby/);
  assert.doesNotMatch(qpHtml, /sgx-qp-head|sgx-qp-title|"gear"/);
  assert.doesNotMatch(qpHtml, /class="sgx-qp-set"/);
  assert.match(qpHtml, /<div class="sgx-qp-sheet" tabindex="-1" autofocus>\s*<div class="sgx-qp-grid">/);
  assert.doesNotMatch(qpHtml, /role="tab"|role="tabpanel"|data-qp-tab|data-qp-page|sgx-qp-nav/);
  assert.doesNotMatch(tbJs, /data-qp-tab|data-qp-pages|scrollend/);
  assert.doesNotMatch(css, /\.sgx-qp-(head|title|set)\b/);
  assert.doesNotMatch(qpJs + tbJs, /sgx-qp-set\b/);
});
