#!/usr/bin/env node
/**
 * 共享外壳（shared shell）：主站是唯一来源，子站（blog / daymark）用各自仓库的 scripts/sync-shell.mjs 一条命令同步。
 *
 * 生成 web/shared/shell/（勿手改，改源头后重跑本脚本）：
 *   tokens.css         13 套预设的色彩角色（web/data/palette-roles.json，和 input.css 里 @gen-palettes 同一个函数）+ 组件别名层
 *   shell.css          顶栏圆 / 长条材质、头像圆、导航抽屉：input.css 里 /* @shell:begin <名> *\/ … /* @shell:end <名> *\/ 之间的原文
 *   palette-scheme.js  自定义 #rrggbb 种子 → 整套角色的引擎（web/assets/js/lib/palette-scheme.js 原样复制）
 *   nav.json           导航抽屉的项（web/data/shell-nav.json）+ 用到的图标 SVG（web/layouts/partials/icon.html）
 *   palettes.json      预设 id / 名字 / 种子 + 默认值 + 子站自定义色缓存版本号
 *   manifest.json      上面每个文件的 sha256（子站同步时逐个校验）
 *   README.md          说明
 *
 * 用法：node scripts/gen-shell.mjs          重新生成
 *       node scripts/gen-shell.mjs --check  只核对（不一致 exit 1，单测 / CI 用）
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBlock } from './gen-palettes.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(REPO, 'web/shared/shell');
const SRC = {
  roles: path.join(REPO, 'web/data/palette-roles.json'),
  css: path.join(REPO, 'web/assets/css/input.css'),
  scheme: path.join(REPO, 'web/assets/js/lib/palette-scheme.js'),
  nav: path.join(REPO, 'web/data/shell-nav.json'),
  icons: path.join(REPO, 'web/layouts/partials/icon.html'),
};
/** shell.css 里按这个顺序拼 input.css 的标记段 */
export const SHELL_REGIONS = ['topbar-frame', 'topbar-me', 'drawer'];
const EXTRA_ICONS = ['apps-grid'];
const HEAD = (src) =>
  `/* 由 styrigx-space scripts/gen-shell.mjs 从 ${src} 生成，勿手改；子站用 scripts/sync-shell.mjs 同步。 */\n`;

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** input.css 里抽出指定名字的标记段（不含标记行本身） */
export function extractRegion(css, name) {
  const re = new RegExp(`^/\\* @shell:begin ${name}(?:[（( ][^\\n]*)? \\*/\\n([\\s\\S]*?)^/\\* @shell:end ${name} \\*/$`, 'm');
  const m = css.match(re);
  if (!m) throw new Error(`input.css 里找不到 @shell:begin/end ${name}`);
  return m[1].replace(/\n$/, '');
}

/** icon.html 里抽出某个图标的 SVG（{{ if/else if eq $name "x" }} 下一行） */
export function extractIcon(html, name) {
  const re = new RegExp(`\\{\\{ (?:else )?if eq \\$name "${name}" \\}\\}\\n(<svg[^\\n]*</svg>)`);
  const m = html.match(re);
  if (!m) throw new Error(`icon.html 里找不到图标 ${name}`);
  if (/\{\{/.test(m[1])) throw new Error(`图标 ${name} 含模板语法，不能共享`);
  return m[1];
}

function renderTokens(data) {
  const block = renderBlock(data)
    .split('\n')
    .filter((l) => !/@gen-palettes:(begin|end)/.test(l))
    .map((l) => l.replace(/^ {2}/, ''))
    .join('\n');
  /* 组件别名层：和 input.css tokens 层里「组件角色（别名层）」同一份（只引用角色） */
  const css = readFileSync(SRC.css, 'utf8');
  const alias = css.match(/\/\* 组件角色（别名层）[\s\S]*?\*\/\n\s*(:root \{[\s\S]*?\n\s*\})/);
  if (!alias) throw new Error('input.css 里找不到组件角色（别名层）');
  const aliasCss = alias[1]
    .split('\n')
    .map((l) => l.replace(/^ {2}/, ''))
    .join('\n');
  return (
    HEAD('web/data/palette-roles.json') +
    '/* 13 套预设：<html data-palette="<id>">（默认 lake 不写），深色 <html class="dark">；自定义种子在运行时用 palette-scheme.js 的 rolesCss() 覆盖。 */\n' +
    block +
    '\n/* 组件角色（别名层）：只引用上面的角色 */\n' +
    aliasCss +
    '\n'
  );
}

function renderShell() {
  const css = readFileSync(SRC.css, 'utf8');
  const parts = SHELL_REGIONS.map((n) => `/* ---- ${n} ---- */\n` + extractRegion(css, n));
  return (
    HEAD('web/assets/css/input.css 的 @shell 标记段') +
    '/* 依赖 tokens.css 的 --sgx-* 角色；不进任何 @layer。 */\n' +
    parts.join('\n') +
    '\n'
  );
}

function renderNav() {
  const nav = JSON.parse(readFileSync(SRC.nav, 'utf8'));
  const html = readFileSync(SRC.icons, 'utf8');
  const names = [...new Set([...nav.items, ...nav.footer].map((i) => i.icon).concat(EXTRA_ICONS))];
  const icons = {};
  for (const n of names) icons[n] = extractIcon(html, n);
  return (
    JSON.stringify({ _generated: 'styrigx-space scripts/gen-shell.mjs ← web/data/shell-nav.json + icon.html；勿手改', ...nav, icons }, null, 2) +
    '\n'
  );
}

function renderPalettes(data, schemeSrc) {
  const order = ['lake', 'forest', 'terra', 'violet', 'rose', 'cherry', 'tangerine', 'amber', 'matcha', 'teal', 'indigo', 'orchid', 'graphite'];
  const ids = Object.keys(data.presets).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return (
    JSON.stringify(
      {
        _generated: 'styrigx-space scripts/gen-shell.mjs ← web/data/palette-roles.json；勿手改',
        default: 'lake',
        /* 子站缓存自定义色角色时用的版本号：引擎一变就变，旧缓存自动作废 */
        schemeVersion: sha(schemeSrc).slice(0, 12),
        presets: ids.map((id) => ({ id, zh: data.presets[id].zh, en: data.presets[id].en, seed: data.presets[id].seed })),
      },
      null,
      2,
    ) + '\n'
  );
}

const README = `# web/shared/shell（生成物，勿手改）

主站（styrigx-space）和子站（styrigx-blog、styrigx-daymark）共用的外壳：色彩角色、顶栏材质、导航抽屉、自定义主题色引擎、抽屉项。

- 源头：\`web/data/palette-roles.json\`、\`web/assets/css/input.css\` 的 \`@shell:begin/end\` 段、\`web/assets/js/lib/palette-scheme.js\`、
  \`web/data/shell-nav.json\`、\`web/layouts/partials/icon.html\`。改源头后跑 \`node scripts/gen-shell.mjs\`；CI 用 \`--check\` 核对。
- 子站同步：在子站仓库跑 \`node scripts/sync-shell.mjs\`（默认 ref=main，可 \`--ref <分支或提交>\`），
  它按 \`manifest.json\` 从 raw.githubusercontent.com 拉这些文件、逐个校验 sha256，写进子站的标记段 / 供应商目录。
- 主题跨站：主站把外观写进 \`sgx-ui\` cookie（Domain=styrigx.com）：\`pal\` = 预设 id，\`accent\` = 当前种子 #rrggbb。
  子站：\`accent\` 等于该预设种子 → 只设 \`data-palette\`；不等 → 自定义色，用 \`palette-scheme.js\` 的 \`rolesCss(seed)\` 算整套角色。
`;

/** @returns {Record<string,string>} 文件名 → 内容 */
export function renderAll() {
  const data = JSON.parse(readFileSync(SRC.roles, 'utf8'));
  const schemeSrc = readFileSync(SRC.scheme, 'utf8');
  const files = {
    'tokens.css': renderTokens(data),
    'shell.css': renderShell(),
    'palette-scheme.js': schemeSrc,
    'nav.json': renderNav(),
    'palettes.json': renderPalettes(data, schemeSrc),
    'README.md': README,
  };
  const manifest = {
    _generated: 'styrigx-space scripts/gen-shell.mjs；勿手改',
    source: 'styrigx/styrigx-space',
    dir: 'web/shared/shell',
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])),
  };
  manifest.version = sha(JSON.stringify(manifest.files)).slice(0, 12);
  files['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';
  return files;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const files = renderAll();
  if (process.argv.includes('--check')) {
    const bad = [];
    for (const [k, v] of Object.entries(files)) {
      const p = path.join(OUT_DIR, k);
      if (!existsSync(p) || readFileSync(p, 'utf8') !== v) bad.push(k);
    }
    const extra = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => !(f in files)) : [];
    if (bad.length || extra.length) {
      console.error('web/shared/shell 和源头不一致：' + [...bad, ...extra.map((f) => f + '（多余）')].join('、') + '；运行 node scripts/gen-shell.mjs');
      process.exit(1);
    }
    console.log('shared shell in sync:', JSON.parse(files['manifest.json']).version);
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const [k, v] of Object.entries(files)) writeFileSync(path.join(OUT_DIR, k), v);
    console.log('web/shared/shell regenerated:', Object.keys(files).join(', '), JSON.parse(files['manifest.json']).version);
  }
}
