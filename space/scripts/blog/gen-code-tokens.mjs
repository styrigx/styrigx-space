#!/usr/bin/env node
/**
 * 代码高亮配色：固定主题，浅底 / 深底各一档，不跟调色板（2026-11 调色板 v3 定稿）。
 * 输出 Chroma 的 class 配色 space/web/assets/blog/css/blog/code-tokens.css：
 *   :root 下是浅档，:root.dark 下是深档；代码块底色、正文、标题栏文字、记号、行号、高亮行全部固定。
 * 对比度（WCAG AA）：记号和标题栏文字 ≥ 4.6:1（4.5 留余量），代码正文 ≥ 7:1，行号 ≥ 3:1；
 * 背景同时算代码面和高亮行（高亮行上的行号改用关键字色，不按行号色算）。
 *
 * 用法：node space/scripts/blog/gen-code-tokens.mjs           重新生成
 *       node space/scripts/blog/gen-code-tokens.mjs --check   只核对（不一致 exit 1，CI 用）
 * tests/blog/code-contrast.test.mjs 用 audit() 复算，低于门槛就失败。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const OUT = path.join(REPO, 'space/web/assets/blog/css/blog/code-tokens.css');

export const TEXT_MIN = 4.6;
export const FG_MIN = 7;
export const GUTTER_MIN = 3;

/**
 * 两档固定配色。surface 代码面 · hl 高亮行 · fg 代码正文 · muted 标题栏 / 次要 · line 标题栏分隔线（装饰）
 * 记号：kw 关键字 · fn 函数 / 类型 · str 字符串 · num 数字 / 常量 · cm 注释 · op 运算符 / 标点 · hd 标题 · ln 行号
 */
export const THEMES = {
  light: {
    surface: '#f6f7f9', hl: '#fdf3c8', fg: '#1f2328', muted: '#59636e', line: '#d8dde3',
    kw: '#cf222e', fn: '#7340d0', str: '#0a3069', num: '#0550ae', cm: '#59636e', op: '#59636e', hd: '#0550ae', ln: '#818b97',
  },
  dark: {
    surface: '#18191c', hl: '#2f2b1f', fg: '#e6edf3', muted: '#9aa2ab', line: '#30343a',
    kw: '#ff7b72', fn: '#d2a8ff', str: '#a5d6ff', num: '#79c0ff', cm: '#9aa2ab', op: '#9aa2ab', hd: '#79c0ff', ln: '#6e7681',
  },
};

/** 记号分组：Chroma class → 颜色键 + 字形 */
export const GROUPS = [
  { id: 'kw', label: '关键字', cls: ['k', 'kc', 'kd', 'kn', 'kp', 'kr', 'kt', 'ow', 'nt'], style: 'font-weight: 600' },
  { id: 'fn', label: '函数 / 类型 / 属性', cls: ['nf', 'fm', 'nc', 'nn', 'nd', 'ne', 'nb', 'bp', 'na', 'py'], style: '' },
  { id: 'str', label: '字符串', cls: ['s', 's1', 's2', 'sa', 'sb', 'sc', 'dl', 'sd', 'sh', 'si', 'sx', 'gi'], style: '' },
  { id: 'num', label: '数字 / 常量 / 转义 / 正则', cls: ['m', 'mb', 'mf', 'mh', 'mi', 'il', 'mo', 'l', 'ld', 'se', 'sr', 'ss', 'no', 'vc', 'gd', 'gr', 'gt', 'err'], style: '' },
  { id: 'cm', label: '注释', cls: ['c', 'ch', 'cm', 'c1', 'cs', 'cp', 'cpf'], style: 'font-style: italic' },
  { id: 'op', label: '运算符 / 标点 / 提示符 / 输出', cls: ['o', 'p', 'gp', 'go'], style: '' },
  { id: 'hd', label: '标题', cls: ['gh', 'gu'], style: 'font-weight: 700' },
];
/** 写成 CSS 变量的键（--blog-code-<键>） */
export const VARS = ['surface', 'hl', 'fg', 'muted', 'line', ...GROUPS.map((g) => g.id), 'ln'];

/* ---------- 对比度 ---------- */
export function hex(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) throw new Error('bad hex ' + h);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a, b) {
  const [x, y] = [lum(hex(a)), lum(hex(b))].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** 全部检查项：[{ mode, what, on, ratio, min }] */
export function audit(themes = THEMES) {
  const rows = [];
  for (const [mode, t] of Object.entries(themes)) {
    rows.push({ mode, what: 'muted', on: 'surface', ratio: contrast(t.muted, t.surface), min: TEXT_MIN });
    for (const on of ['surface', 'hl']) {
      rows.push({ mode, what: 'fg', on, ratio: contrast(t.fg, t[on]), min: FG_MIN });
      for (const g of GROUPS) rows.push({ mode, what: g.id, on, ratio: contrast(t[g.id], t[on]), min: TEXT_MIN });
    }
    rows.push({ mode, what: 'ln', on: 'surface', ratio: contrast(t.ln, t.surface), min: GUTTER_MIN });
  }
  return rows;
}

function block(sel, t) {
  return [`${sel} {`, ...VARS.map((k) => `  --blog-code-${k}: ${t[k]};`), '}'];
}

export function render(themes = THEMES) {
  const worst = Math.min(...audit(themes).filter((r) => r.min === TEXT_MIN).map((r) => r.ratio));
  const lines = [
    '/* 由 space/scripts/blog/gen-code-tokens.mjs 生成，勿手改。代码高亮是固定主题（浅 / 深两档，按 html.dark 取），不跟调色板。',
    `   记号 ≥ ${TEXT_MIN}:1（实测最低 ${worst.toFixed(2)}:1），正文 ≥ ${FG_MIN}:1，行号 ≥ ${GUTTER_MIN}:1；背景含代码面和高亮行。 */`,
    ...block(':root', themes.light),
    ...block(':root.dark', themes.dark),
  ];
  for (const g of GROUPS) {
    const sel = g.cls.map((c) => `.chroma .${c}`).join(', ');
    lines.push(`${sel} { color: var(--blog-code-${g.id});${g.style ? ' ' + g.style + ';' : ''} }`);
  }
  lines.push('.chroma .ge { font-style: italic; }', '.chroma .gs { font-weight: 700; }', '.chroma .gl { text-decoration: underline; }');
  return lines.join('\n') + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const bad = audit().filter((r) => r.ratio < r.min);
  if (bad.length) {
    for (const r of bad) console.error(`${r.mode} ${r.what} on ${r.on}: ${r.ratio.toFixed(2)} < ${r.min}`);
    process.exit(1);
  }
  const css = render();
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== css) {
      console.error('code-tokens.css 和 gen-code-tokens.mjs 不一致：运行 node space/scripts/blog/gen-code-tokens.mjs');
      process.exit(1);
    }
    console.log('code tokens in sync');
  } else {
    writeFileSync(OUT, css);
    console.log(css);
  }
}
