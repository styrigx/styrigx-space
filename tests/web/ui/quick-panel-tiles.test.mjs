/**
 * 快捷面板 / 设置页调色板模板（2026-10-21）：
 * - 快捷面板磁贴只剩 深色模式 | 跟随系统、语言 | 立即锁定；减弱动效、字体大小 2026-10-23 PR-E 起整个删除（字体靠浏览器缩放，动效跟系统）。
 * - 默认色板 lake 不放色块（快捷面板 + 设置页单色组），改成标题行右端「恢复默认」，初始 aria-disabled；
 *   点它走 setPalette('lake')（与点色块同一条路，自定义主题色一起清掉）。
 * - 磁贴 / 行 / 齿轮底色读色板容器（--m-secondary-container），不是 container-high。
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

test('lake 不放色块；两处都有「恢复默认」，初始 aria-disabled，点了 setPalette(lake)', () => {
  const lakeless = /range where \(where [^)]+"group" "mono"\) "id" "!=" "lake"/;
  assert.match(qpHtml, lakeless);
  assert.match(theme, lakeless);
  assert.match(qpHtml, /<button type="button" class="palette-reset" data-qp-reset aria-disabled="true">/);
  assert.match(theme, /<button type="button" class="palette-reset" id="palette-reset" aria-disabled="true">/);
  assert.match(qpHtml, /恢复默认/);
  assert.match(theme, /Reset/);
  for (const js of [qpJs, setJs]) {
    assert.match(js, /setPalette\('lake'\)/);
    assert.match(js, /=== 'lake' && !accent\(\)/);
  }
});

test('配色：磁贴 / 行 / 齿轮读 secondary-container，开着读 primary-container + 主色图标圆', () => {
  const rule = (sel) => {
    const i = css.indexOf('\n' + sel + ' {');
    assert.ok(i >= 0, sel);
    return css.slice(i, css.indexOf('}', i));
  };
  assert.match(rule('.sgx-qp-tile'), /background: var\(--m-secondary-container\)/);
  assert.match(rule('.sgx-qp-row'), /background: var\(--m-secondary-container\)/);
  assert.match(rule('.sgx-qp-set'), /background-color: var\(--m-secondary-container\)/);
  assert.match(rule('.sgx-qp-tile[aria-pressed="true"]'), /background: var\(--m-primary-container\)/);
  assert.match(rule('.sgx-qp-tile[aria-pressed="true"] .sgx-qp-ic'), /background: var\(--m-primary\)/);
  assert.match(rule('.palette-reset[aria-disabled="true"]'), /opacity: \.38/);
});
