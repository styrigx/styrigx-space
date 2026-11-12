#!/usr/bin/env node
/**
 * 调色板角色 token：把 25 套七色调色板（space/web/data/palette-roles.json，每套一个模式的角色 + 状态层 + 色调 token）
 * 生成进 space/web/assets/css/input.css 的 tokens 层（两行标记之间，见 BEGIN / END），值不手敲。
 *
 * 2026-11-12 调色板 v4：没有深浅模式了，每套只有一个模式（浅套 / 深套由底色决定，见 palette-scheme.js 的 paletteMode），
 * 每个预设生成一段 :root[data-palette="<id>"]。默认色板 terra（陶土）不写 data-palette，所以 terra 同时写在 :root 上（也兜住未知的 data-palette 值）。
 * 运行时 <html> 上的 dark 类只表示「当前是深套」（首帧按调色板查表设置），选择器里不再用它。
 * 变量名：--sgx-<角色>（bg-gradient 拆成 --sgx-bg-gradient-1..3；状态层 --sgx-state-color / -hover / -focus / -pressed / -selected / -dragged），
 * 由 space/web/assets/shell/js/lib/palette-scheme.js 的 roleDecls / toneDecls 出。每个预设另写 --sgx-seed（= 色板种子）。
 *
 * 用法：node space/scripts/gen-palettes.mjs          重新生成
 *       node space/scripts/gen-palettes.mjs --check  只核对（不一致 exit 1，单测 / CI 用）
 *       node space/scripts/gen-palettes.mjs --roles  先用引擎（palette-scheme.js）按 PRESETS 重建 JSON 里的全部预设（含元数据），再生成 input.css
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleDecls, toneDecls, presetRoles, PRESETS, DEFAULT_ID } from '../web/assets/shell/js/lib/palette-scheme.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSON_PATH = path.join(REPO, 'space/web/data/palette-roles.json');
const CSS_PATH = path.join(REPO, 'space/web/assets/css/input.css');
const BEGIN = '/* @gen-palettes:begin（space/scripts/gen-palettes.mjs 由 space/web/data/palette-roles.json 生成，勿手改） */';
const END = '/* @gen-palettes:end */';
const ORDER = PRESETS.map((p) => p.id);

/** @param {any} data @returns {string} 标记之间的内容（含标记） */
export function renderBlock(data) {
  const ids = Object.keys(data.presets);
  ids.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  const ind = '  ';
  const lines = [ind + BEGIN];
  for (const id of ids) {
    const p = data.presets[id];
    const sel = id === DEFAULT_ID ? `:root,\n${ind}:root[data-palette="${id}"]` : `:root[data-palette="${id}"]`;
    lines.push(`${ind}/* ${p.zh} · ${p.en}（${id}，${p.mode === 'dark' ? '深套' : '浅套'}）：${p.mood && p.mood.zh ? p.mood.zh : ''} */`);
    lines.push(`${ind}${sel} {`);
    lines.push(`${ind}  --sgx-seed: ${p.seed};`);
    for (const d of roleDecls(p.roles, p.state)) lines.push(`${ind}  ${d}`);
    for (const d of toneDecls(p.tones)) lines.push(`${ind}  ${d}`);
    lines.push(`${ind}}`);
  }
  lines.push(ind + END);
  return lines.join('\n');
}

/** 引擎重算：预设整份按 palette-scheme.js 的 PRESETS 重建（id / 名字 / 种子 / mood / 模式 + 角色，顺序同 PRESETS）。
 *  @param {any} data @returns {any} */
export function recomputeRoles(data) {
  const presets = {};
  for (const x of PRESETS) {
    const r = presetRoles(x.id);
    presets[x.id] = { id: x.id, zh: x.zh, en: x.en, seed: x.seed, group: x.group, bg: x.bg, fg: x.fg, fgNames: x.fgNames, mood: x.mood,
      mode: r.mode, roles: r.roles, state: r.state, tones: r.tones };
  }
  data.schema = 'styrigx-palette/3';
  data.presets = presets;
  delete data.custom;
  return data;
}

/** @param {string} css @param {string} block @returns {string} */
export function splice(css, block) {
  const a = css.indexOf(BEGIN);
  const b = css.indexOf(END);
  if (a < 0 || b < a) throw new Error('input.css 里找不到 @gen-palettes 标记');
  const lineStart = css.lastIndexOf('\n', a) + 1;
  return css.slice(0, lineStart) + block + css.slice(b + END.length);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  if (process.argv.includes('--roles')) {
    const before = JSON.stringify(data, null, 1);
    recomputeRoles(data);
    if (JSON.stringify(data, null, 1) !== before) {
      const d = new Date(Date.now() + 8 * 3600e3);
      data.generated = d.toISOString().slice(0, 16).replace('T', ' ') + ' CST (UTC+08:00)';
      writeFileSync(JSON_PATH, JSON.stringify(data, null, 1));
      console.log('palette-roles.json recomputed from palette-scheme.js');
    }
  }
  const css = readFileSync(CSS_PATH, 'utf8');
  const next = splice(css, renderBlock(data));
  if (process.argv.includes('--check')) {
    if (next !== css) {
      console.error('input.css 的色板角色和 space/web/data/palette-roles.json 不一致：运行 node space/scripts/gen-palettes.mjs');
      process.exit(1);
    }
    console.log('palettes in sync');
  } else {
    writeFileSync(CSS_PATH, next);
    console.log('input.css palettes regenerated:', Object.keys(data.presets).length, 'presets');
  }
}
