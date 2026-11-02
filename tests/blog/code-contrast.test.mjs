// 代码块配色对比度（像主站的调色板对比度报告）：每类记号在 13 套预设 × 亮 / 暗、以及一批随机自定义种子下，
// 对代码面（surface-container-high）和高亮行背景都 ≥ 4.5:1（生成时按 4.6 留余量）；行号 ≥ 3:1。
// 配色由 scripts/gen-code-tokens.mjs 从色彩角色生成，这里逐个调色板复算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GROUPS, GUTTER, OUT, allPalettes, contrast, hex, mix, paletteColors, render, solve,
} from '../../scripts/blog/gen-code-tokens.mjs';

const { palettes, presets } = await allPalettes();
const css = readFileSync(OUT, 'utf8');
const pct = (id) => {
  const m = css.match(new RegExp(`--blog-code-${id}: (?:color-mix\\(in srgb, var\\(--sgx-[a-z-]+\\) (\\d+)%|var\\(--sgx-([a-z-]+)\\))`));
  assert.ok(m, 'code-tokens.css 里没有 --blog-code-' + id);
  return m[1] ? +m[1] : m[2] === 'text-primary' ? 0 : 100;
};

test('code-tokens.css 是最新生成的（改了角色 / 分组请跑 node scripts/gen-code-tokens.mjs）', () => {
  assert.equal(css, render(solve(palettes)));
});

test(`覆盖 ${presets.length} 套预设 × 亮 / 暗 + 自定义种子`, () => {
  assert.equal(presets.length, 22);
  assert.ok(palettes.filter((p) => p.custom).length >= 80);
});

test('每类记号在每个调色板下都 ≥ 4.5:1（代码面和高亮行）', () => {
  const bad = [];
  let worst = Infinity;
  for (const g of GROUPS) {
    const p = pct(g.id) / 100;
    for (const pal of palettes) {
      const c = paletteColors(pal.roles);
      const fg = mix(c.role(g.role), c.text, p);
      for (const [bgName, bg] of [['code', c.surface], ['hl', c.hl]]) {
        const v = contrast(fg, bg);
        worst = Math.min(worst, v);
        if (v < 4.5) bad.push(`${g.id} @ ${pal.name} on ${bgName}: ${v.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
  console.log('最低对比度', worst.toFixed(2));
});

test('正文色（没有高亮的纯文本代码）≥ 7:1', () => {
  for (const pal of palettes) {
    const c = paletteColors(pal.roles);
    assert.ok(contrast(c.text, c.surface) >= 7, pal.name);
  }
});

test('行号（装饰）≥ 3:1', () => {
  const p = pct(GUTTER.id) / 100;
  for (const pal of palettes) {
    const c = paletteColors(pal.roles);
    assert.ok(contrast(mix(c.role(GUTTER.role), c.text, p), c.surface) >= 3, pal.name);
  }
});

test('预设的角色值 = 共享外壳 tokens.css 里实际下发的值（测的就是页面上的颜色）', () => {
  const shell = readFileSync(new URL('../../web/blog/assets/css/sgx-shell.css', import.meta.url), 'utf8');
  const roles = ['surface-container-high', 'text-primary', ...new Set([...GROUPS, GUTTER].map((g) => g.role))];
  for (const pal of palettes.filter((p) => !p.custom)) {
    const [id, mode] = pal.name.split('/');
    const sel = mode === 'dark' ? `:root.dark[data-palette="${id}"] {` : `:root[data-palette="${id}"] {`;
    const at = shell.indexOf(sel);
    assert.ok(at >= 0, sel);
    const block = shell.slice(at, shell.indexOf('}', at));
    for (const r of roles) {
      const m = block.match(new RegExp(`--sgx-${r}: (#[0-9a-f]{6});`, 'i'));
      assert.ok(m, `${pal.name} 缺 --sgx-${r}`);
      assert.deepEqual(hex(m[1]), hex(pal.roles[r]), `${pal.name} --sgx-${r}`);
    }
  }
});
