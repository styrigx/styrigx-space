#!/usr/bin/env node
/**
 * 主题色角色 token：把手调好的 13 套色板（web/data/palette-roles.json，亮 / 暗各 84 个角色 + 状态层）
 * 生成进 web/assets/css/input.css 的 tokens 层（两行标记之间，见 BEGIN / END），值不手敲。
 *
 * 每个预设生成两段：
 *   :root[data-palette="<id>"]       浅色
 *   :root.dark[data-palette="<id>"]  深色（站点的深色是 <html class="dark">）
 * 默认色板 lake 不写 data-palette，所以 lake 写在 :root / :root.dark 上（同时兜住未知的 data-palette 值）。
 * 变量名：--sgx-<角色>（bg-gradient 拆成 --sgx-bg-gradient-1..3；状态层 --sgx-state-color / -hover / -focus / -pressed / -selected / -dragged），
 * 和自定义种子在运行时写的变量名同一个函数出（web/assets/js/lib/palette-scheme.js 的 roleDecls）。
 * 每个预设另写 --sgx-seed（= 色板种子，ui-cookie 把它同步给子站）。
 *
 * 用法：node scripts/gen-palettes.mjs          重新生成
 *       node scripts/gen-palettes.mjs --check  只核对（不一致 exit 1，单测 / CI 用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleDecls } from '../web/assets/js/lib/palette-scheme.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_PATH = path.join(REPO, 'web/data/palette-roles.json');
const CSS_PATH = path.join(REPO, 'web/assets/css/input.css');
const BEGIN = '/* @gen-palettes:begin（scripts/gen-palettes.mjs 由 web/data/palette-roles.json 生成，勿手改） */';
const END = '/* @gen-palettes:end */';
const ORDER = ['lake', 'forest', 'terra', 'violet', 'rose', 'cherry', 'tangerine', 'amber', 'matcha', 'teal', 'indigo', 'orchid', 'graphite'];

/** @param {any} data @returns {string} 标记之间的内容（含标记） */
export function renderBlock(data) {
  const ids = Object.keys(data.presets);
  ids.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  const ind = '  ';
  const lines = [ind + BEGIN];
  for (const id of ids) {
    const p = data.presets[id];
    const lightSel = id === 'lake' ? `:root,\n${ind}:root[data-palette="lake"]` : `:root[data-palette="${id}"]`;
    const darkSel = id === 'lake' ? `:root.dark,\n${ind}:root.dark[data-palette="lake"]` : `:root.dark[data-palette="${id}"]`;
    lines.push(`${ind}/* ${p.zh} · ${p.en}（${id}）：${p.mood && p.mood.zh ? p.mood.zh : ''} */`);
    lines.push(`${ind}${lightSel} {`);
    lines.push(`${ind}  --sgx-seed: ${p.seed};`);
    for (const d of roleDecls(p.light, p.lightState)) lines.push(`${ind}  ${d}`);
    lines.push(`${ind}}`);
    lines.push(`${ind}${darkSel} {`);
    for (const d of roleDecls(p.dark, p.darkState)) lines.push(`${ind}  ${d}`);
    lines.push(`${ind}}`);
  }
  lines.push(ind + END);
  return lines.join('\n');
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
  const css = readFileSync(CSS_PATH, 'utf8');
  const next = splice(css, renderBlock(data));
  if (process.argv.includes('--check')) {
    if (next !== css) {
      console.error('input.css 的色板角色和 web/data/palette-roles.json 不一致：运行 node scripts/gen-palettes.mjs');
      process.exit(1);
    }
    console.log('palettes in sync');
  } else {
    writeFileSync(CSS_PATH, next);
    console.log('input.css palettes regenerated:', Object.keys(data.presets).length, 'presets');
  }
}
