#!/usr/bin/env node
/**
 * 主题色角色 token：把手调好的 33 套色板（单色 17 + 撞色 16；web/data/palette-roles.json，亮 / 暗各 87 个角色 + 状态层）
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
 *       node scripts/gen-palettes.mjs --roles  先用引擎（palette-scheme.js）按 PRESETS 重建 JSON 里的全部预设（含元数据）、重算 8 个校验种子的角色值，
 *                                              再生成 input.css（改了 PRESETS / 亮度阶梯 / 别名后用；校验种子的元数据不动）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleDecls, presetRoles, rolesFor, swatchTones, PRESETS } from '../web/assets/js/lib/palette-scheme.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_PATH = path.join(REPO, 'web/data/palette-roles.json');
const CSS_PATH = path.join(REPO, 'web/assets/css/input.css');
const BEGIN = '/* @gen-palettes:begin（scripts/gen-palettes.mjs 由 web/data/palette-roles.json 生成，勿手改） */';
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

/** 引擎重算：预设整份按 palette-scheme.js 的 PRESETS 重建（id / 名字 / 种子 / mood + 角色，顺序同 PRESETS），
 *  校验种子保留元数据、重算角色。 @param {any} data @returns {any} */
export function recomputeRoles(data) {
  const presets = {};
  for (const x of PRESETS) {
    const r = presetRoles(x.id);
    presets[x.id] = { id: x.id, zh: x.zh, en: x.en, seed: x.seed, group: x.group, mood: x.mood, swatch: swatchTones(x.id), light: r.light, lightState: r.lightState, dark: r.dark, darkState: r.darkState };
  }
  data.presets = presets;
  for (const seed of Object.keys(data.custom || {})) {
    const c = data.custom[seed], r = rolesFor(seed);
    Object.assign(c, { derivedFrom: r.derivedFrom, light: r.light, lightState: r.lightState, dark: r.dark, darkState: r.darkState, seedPrimary: r.seedPrimary });
  }
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
      console.error('input.css 的色板角色和 web/data/palette-roles.json 不一致：运行 node scripts/gen-palettes.mjs');
      process.exit(1);
    }
    console.log('palettes in sync');
  } else {
    writeFileSync(CSS_PATH, next);
    console.log('input.css palettes regenerated:', Object.keys(data.presets).length, 'presets');
  }
}
