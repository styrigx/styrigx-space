/**
 * 调色板一致性（v1.4）：data/shell/palette-source.yaml、data/shell/features.yaml 的 palette 选项、
 * input.css 的 --sgx-* 预设段必须一一对应；旧的按色板手写 --m-* 块已收口成别名（2026-10-21 撞色）。
 * 2026-10-23 PR-G 七色调色板：22 套、默认 dustyblue、按 group 分组（冷调 / 自然 / 暖调 / 花色 / 中性），c = 背景色。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yaml = readFileSync(new URL('../../../../space/web/data/shell/palette-source.yaml', import.meta.url), 'utf8');
const feats = readFileSync(new URL('../../../../space/web/data/shell/features.yaml', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../../../space/web/assets/shell/css/input.css', import.meta.url), 'utf8');

const ids = [...yaml.matchAll(/^\s*- id: ([a-z]+)$/gm)].map((m) => m[1]);
const custom = ids.filter((id) => id !== 'dustyblue');

test('palette-source.yaml 22 个色板、id 不重复、先深后浅、段内按色相（2026-11-12；默认 2026-11 PR-A 起是 terra）；撞色 x* id 已删除', () => {
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ['cherry', 'tangerine', 'terra', 'amber', 'matcha', 'forest', 'teal', 'lake', 'indigo', 'violet', 'orchid', 'berry', 'rose', 'graphite', 'dustyrose', 'coral', 'cream', 'champagne', 'mustard', 'lime', 'sage', 'aqua', 'glacier', 'dustyblue', 'lilac']);
  for (const id of ids) assert.ok(!/^x(forest|terra|violet|rose|cherry|tangerine|amber|matcha|teal|indigo|orchid|dustyblue|mustard|sage|dustyrose|graphite)$/.test(id), id);
  for (const id of ['glacier', 'coral', 'berry', 'champagne', 'cream', 'lake']) assert.ok(ids.includes(id), id);
  assert.match(feats, /- id: palette[\s\S]*?default: terra/);
});

test('palette-source.yaml 分组：group 按设计稿（冷调 / 自然 / 暖调 / 花色 / 中性）；2026-11-12 起顺序按深浅 + 色相，同组不再连续（分组只作参考）', () => {
  const groups = [...yaml.matchAll(/^\s+group: ([a-z]+)$/gm)].map((m) => m[1]);
  assert.equal(groups.length, ids.length);
  const by = (g) => ids.filter((_, i) => groups[i] === g);
  assert.deepEqual(by('cool'), ['teal', 'lake', 'indigo', 'violet', 'aqua', 'glacier', 'dustyblue']);
  assert.deepEqual(by('nature'), ['matcha', 'forest', 'lime', 'sage']);
  assert.deepEqual(by('warm'), ['cherry', 'tangerine', 'terra', 'amber', 'coral', 'champagne', 'mustard']);
  assert.deepEqual(by('floral'), ['orchid', 'berry', 'rose', 'dustyrose', 'lilac']);
  assert.deepEqual(by('neutral'), ['graphite', 'cream']);
  assert.deepEqual([...yaml.matchAll(/- \{id: ([a-z]+), zh: /g)].map((m) => m[1]), ['cool', 'nature', 'warm', 'floral', 'neutral']);
});

test('features.yaml palette 选项与 palette-source.yaml 一致', () => {
  const block = feats.split('- id: palette')[1].split('default:')[0];
  const opts = [...block.matchAll(/\{id: ([a-z]+)\}/g)].map((m) => m[1]);
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

test('每个色板都有 --sgx-* 角色（gen-palettes 生成的一段，v4 起每套只有一个模式、没有 .dark 段），色块 c = 角色 JSON 的背景色', () => {
  const roles = JSON.parse(readFileSync(new URL('../../../../space/web/data/shell/palette-roles.json', import.meta.url), 'utf8')).presets;
  for (const id of custom) {
    assert.ok(css.includes(`:root[data-palette="${id}"] {`), id);
    assert.ok(!css.includes(`:root.dark[data-palette="${id}"] {`), id + ' 没有深色段');
  }
  for (const id of ids) {
    const c = yaml.split(`- id: ${id}\n`)[1].match(/c: "(#[0-9a-f]{6})"/)[1];
    assert.equal(c, roles[id].bg, id);
  }
});
