#!/usr/bin/env node
/**
 * 代码高亮配色：从主站色彩角色生成 Chroma 的 class 配色（atlas/web/blog/assets/css/blog/code-tokens.css），不用固定的 Chroma 主题。
 *
 * 每类记号 = 一个角色（primary / secondary / tertiary / danger / text-secondary）往 text-primary 方向混一点：
 *   color-mix(in srgb, var(--sgx-<角色>) <p>%, var(--sgx-text-primary))
 * p 取「所有调色板下都够对比度」的最大值：13 套预设 × 亮 / 暗（shared shell 的 presetRoles）+ 一批随机自定义种子（rolesFor），
 * 背景同时算代码面（--blog-code-surface = surface-container-high）和高亮行（surface-container-high 上叠 primary 14%）。
 * 记号文字 ≥ 4.6:1（WCAG AA 4.5 留一点余量）；行号是装饰，≥ 3:1。
 *
 * 用法：node atlas/scripts/blog/gen-code-tokens.mjs           重新生成
 *       node atlas/scripts/blog/gen-code-tokens.mjs --check   只核对（不一致 exit 1，CI 用）
 * tests/code-contrast.test.mjs 用同一套函数逐个调色板复算，低于门槛就失败。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 2026-11-02 并进 styrigx-space：仓库根是 REPO，博客页面包在 atlas/web/blog/ */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const OUT = path.join(REPO, 'atlas/web/blog/assets/css/blog/code-tokens.css');
const SCHEME = path.join(REPO, 'atlas/web/blog/assets/js/sgx/shell/palette-scheme.js');

export const TEXT_MIN = 4.6;
export const GUTTER_MIN = 3;
/** 高亮行：代码面上叠 primary 的比例 */
export const HL_PCT = 14;

/** 记号分组：Chroma class → 角色 + 字形 */
export const GROUPS = [
  { id: 'kw', role: 'primary', label: '关键字', cls: ['k', 'kc', 'kd', 'kn', 'kp', 'kr', 'kt', 'ow', 'nt'], style: 'font-weight: 600' },
  { id: 'fn', role: 'secondary', label: '函数 / 类型 / 属性', cls: ['nf', 'fm', 'nc', 'nn', 'nd', 'ne', 'nb', 'bp', 'na', 'py'], style: '' },
  { id: 'str', role: 'tertiary', label: '字符串', cls: ['s', 's1', 's2', 'sa', 'sb', 'sc', 'dl', 'sd', 'sh', 'si', 'sx', 'gi'], style: '' },
  { id: 'num', role: 'danger', label: '数字 / 常量 / 转义 / 正则', cls: ['m', 'mb', 'mf', 'mh', 'mi', 'il', 'mo', 'l', 'ld', 'se', 'sr', 'ss', 'no', 'vc', 'gd', 'gr', 'gt', 'err'], style: '' },
  { id: 'cm', role: 'text-secondary', label: '注释', cls: ['c', 'ch', 'cm', 'c1', 'cs', 'cp', 'cpf'], style: 'font-style: italic' },
  { id: 'op', role: 'text-secondary', label: '运算符 / 标点 / 提示符 / 输出', cls: ['o', 'p', 'gp', 'go'], style: '' },
  { id: 'hd', role: 'primary', label: '标题', cls: ['gh', 'gu'], style: 'font-weight: 700' },
];
/** 行号：装饰，安静一点 */
export const GUTTER = { id: 'ln', role: 'text-tertiary' };

/* ---------- 颜色计算（color-mix in srgb = 在 gamma 编码的 sRGB 上线性插值） ---------- */
export function hex(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) throw new Error('bad hex ' + h);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const mix = (a, b, p) => a.map((v, i) => v * p + b[i] * (1 - p));
function lum([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** 一个调色板（亮或暗）里算法要用到的颜色 */
export function paletteColors(roles) {
  const surface = hex(roles['surface-container-high']);
  const primary = hex(roles.primary);
  return {
    surface,
    hl: mix(primary, surface, HL_PCT / 100),
    text: hex(roles['text-primary']),
    role: (r) => hex(roles[r]),
  };
}

/** 所有要核对的调色板：13 套预设 × 亮 / 暗 + 随机自定义种子 × 亮 / 暗 */
export async function allPalettes({ seeds = 48 } = {}) {
  const scheme = await import(SCHEME + '?v=' + Date.now());
  const ids = scheme.PRESETS.map((p) => p.id);
  const out = [];
  for (const id of ids) {
    const r = scheme.presetRoles(id);
    out.push({ name: `${id}/light`, roles: r.light }, { name: `${id}/dark`, roles: r.dark });
  }
  /* 固定随机序列（结果可复现）：均匀撒在色相环上，饱和度 / 亮度各档都有 */
  let s = 20261021;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < seeds; i++) {
    const seed = '#' + [0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('');
    const r = scheme.rolesFor(seed);
    out.push({ name: `${seed}/light`, roles: r.light, custom: true }, { name: `${seed}/dark`, roles: r.dark, custom: true });
  }
  return { presets: ids, palettes: out };
}

/** 某个分组在比例 p 下、所有调色板里的最低对比度 */
export function minContrast(palettes, role, p) {
  let min = Infinity;
  let at = '';
  for (const pal of palettes) {
    const c = paletteColors(pal.roles);
    const fg = mix(c.role(role), c.text, p / 100);
    for (const bg of [c.surface, c.hl]) {
      const v = contrast(fg, bg);
      if (v < min) {
        min = v;
        at = pal.name;
      }
    }
  }
  return { min, at };
}

/** 每个分组取够对比度的最大比例（100 → 0，步长 5） */
export function solve(palettes) {
  const res = {};
  for (const g of [...GROUPS, GUTTER]) {
    const need = g === GUTTER ? GUTTER_MIN : TEXT_MIN;
    let pick = 0;
    for (let p = 100; p >= 0; p -= 5) {
      if (minContrast(palettes, g.role, p).min >= need) {
        pick = p;
        break;
      }
    }
    res[g.id] = { p: pick, ...minContrast(palettes, g.role, pick) };
  }
  return res;
}

const v = (g, p) => (p >= 100 ? `var(--sgx-${g.role})` : p <= 0 ? 'var(--sgx-text-primary)' : `color-mix(in srgb, var(--sgx-${g.role}) ${p}%, var(--sgx-text-primary))`);

export function render(sol) {
  const lines = [
    '/* 由 atlas/scripts/blog/gen-code-tokens.mjs 生成，勿手改。代码高亮配色 = 主站色彩角色往 text-primary 混一点，',
    `   比例按 13 套预设 × 亮 / 暗 + 随机自定义种子都 ≥ ${TEXT_MIN}:1 算出（行号 ≥ ${GUTTER_MIN}:1），背景含代码面和高亮行。 */`,
    ':root {',
    `  --blog-code-hl: color-mix(in srgb, var(--sgx-primary) ${HL_PCT}%, var(--blog-code-surface));`,
  ];
  for (const g of [...GROUPS, GUTTER]) {
    lines.push(`  /* ${g.label || '行号'}：${g.role} ${sol[g.id].p}%（最低 ${sol[g.id].min.toFixed(2)}:1 @ ${sol[g.id].at}） */`);
    lines.push(`  --blog-code-${g.id}: ${v(g, sol[g.id].p)};`);
  }
  lines.push('}');
  for (const g of GROUPS) {
    const sel = g.cls.map((c) => `.chroma .${c}`).join(', ');
    lines.push(`${sel} { color: var(--blog-code-${g.id});${g.style ? ' ' + g.style + ';' : ''} }`);
  }
  lines.push('.chroma .ge { font-style: italic; }', '.chroma .gs { font-weight: 700; }', '.chroma .gl { text-decoration: underline; }');
  return lines.join('\n') + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { palettes } = await allPalettes();
  const css = render(solve(palettes));
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== css) {
      console.error('code-tokens.css 和色彩角色不一致：运行 node atlas/scripts/blog/gen-code-tokens.mjs');
      process.exit(1);
    }
    console.log('code tokens in sync');
  } else {
    writeFileSync(OUT, css);
    console.log(css);
  }
}
