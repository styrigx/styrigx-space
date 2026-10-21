/**
 * 调色板一致性（v1.4）：data/palettes.yaml、data/features.yaml 的 palette 选项、
 * input.css 的 --sgx-* 预设段必须一一对应；旧的按色板手写 --m-* 块已收口成别名（2026-10-21 撞色）。
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

test('旧 --m-* 色板块已收口：input.css 不再按色板手写 --m-*，色板相关的 --m-* 只在别名块里指向 --sgx-* 角色', () => {
  for (const id of ids) {
    assert.ok(!css.includes(`    [data-palette="${id}"] {`), `${id} 还有旧的 --m-* 浅色块`);
    assert.ok(!css.includes(`    .dark[data-palette="${id}"] {`), `${id} 还有旧的 --m-* 深色块`);
  }
  const fam = ['primary', 'on-primary', 'primary-container', 'on-primary-container', 'secondary', 'on-secondary', 'secondary-container',
    'on-secondary-container', 'tertiary', 'on-tertiary', 'tertiary-container', 'on-tertiary-container', 'on-surface', 'on-surface-variant', 'wallpaper'];
  for (const k of fam) {
    const defs = [...css.matchAll(new RegExp(`--m-${k}:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());
    assert.equal(defs.length, 1, `--m-${k} 定义了 ${defs.length} 次`);
    assert.match(defs[0], /^var\(--sgx-[a-z0-9-]+\)$/, `--m-${k} = ${defs[0]}`);
  }
});

test('每个色板都有 --sgx-* 角色（gen-palettes 生成的浅色 + 深色两段），色块 c = 角色 JSON 的种子', () => {
  const roles = JSON.parse(readFileSync(new URL('../../../web/data/palette-roles.json', import.meta.url), 'utf8')).presets;
  for (const id of custom) {
    assert.ok(css.includes(`:root[data-palette="${id}"] {`), id);
    assert.ok(css.includes(`:root.dark[data-palette="${id}"] {`), id + ' dark');
  }
  for (const id of ids) {
    const c = yaml.split(`- id: ${id}\n`)[1].match(/c: "(#[0-9a-f]{6})"/)[1];
    assert.equal(c, roles[id].seed, id);
  }
});
