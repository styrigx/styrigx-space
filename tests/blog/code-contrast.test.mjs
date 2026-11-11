// 代码块配色对比度：代码高亮是固定主题（浅 / 深两档），不跟调色板。
// 记号和标题栏文字 ≥ 4.5:1（生成时按 4.6 留余量），正文 ≥ 7:1，行号 ≥ 3:1；背景含代码面和高亮行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GROUPS, OUT, THEMES, VARS, audit, render } from '../../space/scripts/blog/gen-code-tokens.mjs';

const css = readFileSync(OUT, 'utf8');

test('code-tokens.css 是最新生成的（改了配色请跑 node space/scripts/blog/gen-code-tokens.mjs）', () => {
  assert.equal(css, render());
});

test('浅 / 深两档都有，变量齐全', () => {
  assert.deepEqual(Object.keys(THEMES), ['light', 'dark']);
  for (const t of Object.values(THEMES)) for (const k of VARS) assert.match(t[k], /^#[0-9a-f]{6}$/i, k);
  assert.ok(css.includes(':root {') && css.includes(':root.dark {'));
});

test('所有检查项过门槛（记号 4.5、正文 7、行号 3）', () => {
  const bad = audit().filter((r) => r.ratio < (r.min === 4.6 ? 4.5 : r.min));
  assert.deepEqual(bad.map((r) => `${r.mode} ${r.what} on ${r.on}: ${r.ratio.toFixed(2)}`), []);
});

test('每类记号在两档下都覆盖到（代码面 + 高亮行）', () => {
  const rows = audit();
  for (const mode of ['light', 'dark']) for (const g of GROUPS) for (const on of ['surface', 'hl']) {
    assert.ok(rows.some((r) => r.mode === mode && r.what === g.id && r.on === on), `${mode} ${g.id} ${on}`);
  }
});

test('不再引用调色板角色（固定主题）', () => {
  assert.doesNotMatch(css, /var\(--sgx-/);
});
