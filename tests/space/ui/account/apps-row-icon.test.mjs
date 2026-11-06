/**
 * 账号页「应用授权」行图标（图标两处修正 §2，2026-11-07）：
 * 从九宫格 apps-grid 换成三点连线 apps-linked（Google 账号「关联的应用」）；只换这一行，其他行图标不动，apps-grid 定义保留。
 *
 * 运行：node --test tests/space/ui/account/apps-row-icon.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const acct = readFileSync(join(root, 'space/web/layouts/_default/account.html'), 'utf8');
const icons = readFileSync(join(root, 'space/web/layouts/partials/icon.html'), 'utf8');

/** icon.html 里某个图标的 SVG（{{ if/else if eq $name "x" }} 之后、可选的注释行之后的第一行 <svg>） */
function iconSvg(name) {
  const i = icons.indexOf(`eq $name "${name}" }}`);
  assert.ok(i >= 0, `icon.html 里有 ${name}`);
  const m = icons.slice(i).match(/\n(<svg[^\n]*<\/svg>)/);
  return m[1];
}

test('「应用授权」行用 apps-linked，不再用 apps-grid', () => {
  const row = acct.slice(acct.indexOf('id="acct-apps-row"'), acct.indexOf('</a>', acct.indexOf('id="acct-apps-row"')));
  assert.match(row, /\{\{ partial "icon\.html" "apps-linked" \}\}/);
  assert.doesNotMatch(row, /apps-grid/);
  assert.doesNotMatch(acct, /"apps-grid"/, '账号页别处也没有用九宫格');
});

test('其他行图标不变：设备 device、账号安全 shield-user、云同步 cloud、AI 模型 sparkles', () => {
  for (const [id, ic] of [['acct-dev-row', 'device'], ['acct-sec-row', 'shield-user'], ['acct-sync-row', 'cloud'], ['acct-ai-row', 'sparkles']]) {
    const at = acct.indexOf(`id="${id}"`);
    assert.ok(at >= 0, id);
    const row = acct.slice(at, acct.indexOf('</a>', at) > 0 ? acct.indexOf('</a>', at) : at + 600);
    assert.ok(row.includes(`{{ partial "icon.html" "${ic}" }}`), `${id} 仍是 ${ic}`);
  }
});

test('apps-linked 图形：三个点 + 两条连线，24 网格、20px、currentColor（和同卡线框图标一个规格）', () => {
  const svg = iconSvg('apps-linked');
  assert.equal((svg.match(/<circle /g) || []).length, 3, '三个点');
  const d = svg.match(/<path[^>]* d="([^"]+)"/)[1];
  assert.equal((d.match(/[Mm]/g) || []).length, 2, '两条线');
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /width="20" height="20"/);
  assert.match(svg, /currentColor/);
  assert.doesNotMatch(svg, /#[0-9a-fA-F]{3,8}\b/, '不写死颜色');
  assert.match(svg, /aria-hidden="true"/);
});

test('apps-grid 定义保留（别处若用到不受影响）', () => {
  assert.equal((iconSvg('apps-grid').match(/<circle /g) || []).length, 9);
});
