/**
 * 调色板一致性（v1.4）：data/palettes.yaml、data/features.yaml 的 palette 选项、
 * input.css 两处色板块（回退块 + light-dark 块）必须一一对应，防止加色漏改一处。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yaml = readFileSync(new URL('../../../web/data/palettes.yaml', import.meta.url), 'utf8');
const feats = readFileSync(new URL('../../../web/data/features.yaml', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../../web/assets/css/input.css', import.meta.url), 'utf8');

const ids = [...yaml.matchAll(/^\s*- id: ([a-z]+)$/gm)].map((m) => m[1]);
const custom = ids.filter((id) => id !== 'lake');

test('palettes.yaml 至少 12 个色板且 id 不重复', () => {
  assert.ok(ids.length >= 12, `只有 ${ids.length} 个`);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'lake');
});

test('features.yaml palette 选项与 palettes.yaml 一致', () => {
  const block = feats.split('- id: palette')[1].split('default:')[0];
  const opts = [...block.matchAll(/\{id: ([a-z]+),/g)].map((m) => m[1]);
  assert.deepEqual(opts, ids);
});

test('每个色板在 input.css 有回退块和 light-dark 块（浅色 + 深色）', () => {
  for (const id of custom) {
    const light = css.split(`    [data-palette="${id}"] {`).length - 1;
    const dark = css.split(`    .dark[data-palette="${id}"] {`).length - 1;
    assert.equal(light, 2, `${id} 浅色块数量 ${light}`);
    assert.equal(dark, 2, `${id} 深色块数量 ${dark}`);
    const ld = css.split(`    [data-palette="${id}"] {`)[2].split('}')[0];
    for (const k of ['primary', 'on-primary', 'primary-container', 'secondary', 'tertiary', 'on-tertiary-container']) {
      assert.match(ld, new RegExp(`--m-${k}: light-dark\\(#[0-9a-f]{6}, #[0-9a-f]{6}\\);`), `${id} 缺 ${k}`);
    }
  }
});

test('色块颜色等于浅色 primary', () => {
  for (const id of custom) {
    const c = yaml.split(`- id: ${id}\n`)[1].match(/c: "(#[0-9a-f]{6})"/)[1];
    const ld = css.split(`    [data-palette="${id}"] {`)[2].split('}')[0];
    const primary = ld.match(/--m-primary: light-dark\((#[0-9a-f]{6}),/)[1];
    assert.equal(c, primary, id);
  }
});
