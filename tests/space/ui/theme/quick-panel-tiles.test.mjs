/**
 * 快捷面板 / 设置页调色板模板（2026-10-21）：
 * - 快捷面板磁贴只剩 深色模式 | 跟随系统、语言 | 立即锁定；减弱动效、字体大小 2026-10-23 PR-E 起整个删除（字体靠浏览器缩放，动效跟系统）。
 * - 默认色板 lake 不放色块（快捷面板 + 设置页单色组），改成标题行右端「恢复默认」，初始 aria-disabled；
 *   点它走 setPalette('lake')（与点色块同一条路，自定义主题色一起清掉）。
 * - 磁贴 / 行 / 恢复默认 = 中性玻璃（--sgx-qp-glass，2026-10-23 PR-G 修订；不再铺 --m-secondary-container）。
 * - 2026-10-24 PR4：顶部「快捷面板」标题和齿轮（全部设置）删除；dialog 用 aria-label 保留读屏名字。
 * - 2026-11-04 P5-1：快捷面板标记搬进顶栏单一来源 partials/common/frame/topbar.html（四站共用），分两页（导航 / 快捷设置）；
 *   磁贴按 tiles 参数输出，主站 = dark / system / lang / lock（+ 调色板、布局两行），没有分享；样式进 @shell panel 段，只用 --sgx-* 角色。
 * - 2026-11-07 P4-3 PR-4b（Gray 定稿）：快捷面板只有一页、四站同一套（没有 tiles 参数）：磁贴 深色 / 跟随系统 / 分享本页 / 立即锁定（两行 2×2），
 *   语言整行（行内展开单选），调色板、布局；导航搬到九宫格面板 #sgx-nav。
 * - 2026-11 UI 重设计 PR-1（顶栏 v3）：调色盘按钮打开外观面板 #sgx-qp = MODE（跟随系统 / 深 / 浅）+ PALETTE 列表 + 恢复默认；
 *   语言 / 布局分段、分享 / 立即锁定搬进 NAVIGATE #sgx-nav（>_ 按钮）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const base = rd('space/web/layouts/_default/baseof.html');
const tb = rd('space/web/layouts/partials/common/frame/topbar.html');
const qpHtml = tb.slice(tb.indexOf('<dialog id="sgx-qp"'), tb.indexOf('</dialog>', tb.indexOf('<dialog id="sgx-qp"')));
const navHtml = tb.slice(tb.indexOf('<dialog id="sgx-nav"'), tb.indexOf('</dialog>', tb.indexOf('<dialog id="sgx-nav"')));
const tbJs = rd('space/web/assets/common/js/frame/topbar/panel.js');
import { existsSync } from 'node:fs';
const qpJs = rd('space/web/assets/common/js/frame/topbar/quick-panel.js');
const setJs = rd('space/web/assets/common/js/frame/apps/space.js');
const css = rd('space/web/assets/common/css/input.css');
const feats = rd('space/web/data/common/features.yaml');

test('顶栏 v3 控件（四站同一套）：外观面板 = PALETTE（2026-11-12 调色板 v4 删 MODE 三段）；NAVIGATE = lang / layout 分段 + terminal（v5 S6 去掉 lock；v6 P4 拿掉 share）；没有按站开关、没有减弱动效和字体大小', () => {
  assert.doesNotMatch(qpHtml, /data-qp-mode|data-qp-seg="mode"|sgx-th-mode|sgx-th-seg/, 'v4：没有 MODE 段');
  /* 2026-11 PR-2：加「$ terminal」（打开全站终端抽屉） */
  assert.deepEqual([...navHtml.matchAll(/data-qp="([a-z]+)"/g)].map((m) => m[1]), ['term'], 'v6 P4：分享磁贴拿掉（Gray 11-11 17:47）');
  assert.doesNotMatch(qpHtml + navHtml, /\.tiles\b|\$tiles|\{\{ with \.layout \}\}/, '不按 tiles / layout 参数开关');
  assert.doesNotMatch(base, /\$tbTiles|"tiles"|"layout" \(index/, '主站不再传 tiles / layout');
  /* 语言包化（2026-11-07）：选项 = hugo.yaml languages 的每种语言（短名用它自己的写法、translate="no"），不写死 zh / en */
  /* 2026-11-09：EN | Auto | 中文——Auto（data-qp-lang="system"，跟随浏览器语言）插在第一种语言后面，文字同 layout 行的 Auto（两种语言都是 Auto） */
  assert.match(navHtml, /\{\{- range \$i, \$l := sort \.langs "code" \}\}\{\{ if eq \$i 1 \}\}<button type="button" role="radio" data-qp-lang="system" aria-checked="false" aria-label="\{\{ \$t\.topbar\.langAuto \}\}" translate="no">\{\{ \$t\.topbar\.auto \}\}<\/button>\{\{ end \}\}<button type="button" role="radio" data-qp-lang="\{\{ \$l\.code \}\}" lang="\{\{ \$l\.code \}\}"[^>]*translate="no">\{\{ \$l\.short \| default \$l\.name \}\}<\/button>/);
  assert.doesNotMatch(navHtml, /"v" "(zh|en)"/);
  assert.match(navHtml, /data-qp-seg="layout"/);
  assert.doesNotMatch(qpJs, /mountShare|share-button/, 'v6 P4：分享本页删了');
  assert.ok(!(qpHtml + navHtml).includes('reduced-motion'));
  assert.ok(!(qpHtml + navHtml).includes('font-size'));
  assert.ok(!/setReducedMotion|setFontSize|reducedMotionPref|fontSize\(/.test(qpJs + tbJs));
  assert.doesNotMatch(tbJs + qpJs, /setTheme|themeMode|toggleFollowSystem|hasAccent|prefers-color-scheme/, 'v4：深浅模式 / 自定义色删了');
  /* 2026-10-23 PR-E：设置本身也删了 */
  assert.doesNotMatch(feats, /- id: reduced-motion/);
  assert.doesNotMatch(feats, /- id: font-size/);
  assert.doesNotMatch(setJs, /setReducedMotion|setFontSize|seg-font|row-motion/);
});

test('七色调色板（PR-G）：外观面板 22 行色板 / 设置页 22 个 .pal-tile、不分单色 / 撞色；都有「恢复默认」，初始 aria-disabled，点了 setPalette(DEFAULT_PALETTE = terra)', () => {
  assert.match(qpHtml, /\{\{- range \.pal \}\}<button type="button" class="sgx-th-pal" data-qp-palette="\{\{ \.id \}\}"/);
  assert.match(base, /\{\{ range \(index site\.Data\.common "palette-source"\)\.palettes \}\}\{\{ \$tbPal = \$tbPal \| append/, '主站色块来自 data/common/palette-source.yaml（22 个）');
  assert.doesNotMatch(qpHtml, /swatch-clash|"group" "mono"|"group" "clash"/);
  /* 外观面板（2026-11 PR-A 照稿）：PALETTE 标题行右侧一行小字命令 reset，读屏念「恢复默认」 */
  assert.match(qpHtml, /<button type="button" class="sgx-th-reset" data-qp-reset aria-disabled="true" aria-label="\{\{ \$t\.topbar\.reset \}\}"/);
  assert.match(rd('space/web/data/common/frame/i18n/zh.yaml'), /\n  reset: 恢复默认\n/);
  /* 对齐 PR-C：风格页 /theme/ 退役——色板 / 恢复默认只在外观弹层，旷野页模块不再管调色板网格 */
  assert.ok(!existsSync(new URL('../../../../space/web/layouts/partials/setcat-theme.html', import.meta.url)), 'setcat-theme.html 已删');
  assert.doesNotMatch(setJs, /palette-reset|pal-tile|setPalette/);
  /* 快捷面板的逻辑在 topbar/panel.js（四站共用，依赖由 quick-panel.js 传入） */
  assert.match(tbJs, /P\.setPalette\(P\.DEFAULT_PALETTE\)/);
  assert.match(tbJs, /p === P\.DEFAULT_PALETTE \? 'true' : 'false'/);
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

test('PR4：外观面板没有齿轮 / 页签；读屏名字在 dialog 的 aria-label（顶栏 v3：外观）', () => {
  const open = tb.slice(tb.indexOf('<dialog id="sgx-qp"'), tb.indexOf('>', tb.indexOf('<dialog id="sgx-qp"')) + 1);
  assert.match(open, /aria-label="\{\{ \$t\.topbar\.theme \}\}"/);
  assert.doesNotMatch(open, /aria-labelledby/);
  assert.doesNotMatch(qpHtml, /sgx-qp-head|sgx-qp-title|"gear"/);
  assert.doesNotMatch(qpHtml, /class="sgx-qp-set"/);
  assert.match(qpHtml, /<div class="sgx-qp-sheet" tabindex="-1" autofocus>\s*(\{\{-[^}]*\}\}\s*)*<div class="sgx-th-hrow">\s*<p class="sgx-th-h"/);
  assert.doesNotMatch(qpHtml, /role="tab"|role="tabpanel"|data-qp-tab|data-qp-page|sgx-qp-nav/);
  assert.doesNotMatch(tbJs, /data-qp-tab|data-qp-pages|scrollend/);
  assert.doesNotMatch(css, /\.sgx-qp-(head|title|set)\b/);
  assert.doesNotMatch(qpJs + tbJs, /sgx-qp-set\b/);
});
