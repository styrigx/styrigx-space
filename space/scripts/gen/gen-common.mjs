#!/usr/bin/env node
/**
 * 共享外壳（shared shell）：主站是唯一来源。2026-11 合站起主站和三个子站（blog / curio / daymark）是同一个 Hugo 站（space/web/），
 * 子站直接用主站的 partial（frame/topbar.html、frame/page-head.html、tr.html、lang-path.html；平铺入口 sgx-entries.html、段式标签 sgx-segtabs.html 对齐 PR-C2 退役）
 * 和 JS（assets/common/js/ 各组），没有副本、没有同步脚本、没有 lock。
 *
 * 只剩四个由源头算出来、没法直接引用的派生文件由本脚本生成（勿手改，改源头后重跑本脚本）：
 *   space/web/assets/common/css/tokens.css  25 套七色调色板的色彩角色 + 色调 token（--sgx-bg-1..7 / --sgx-fg-1..6；space/web/data/common/palette-roles.json，和 input.css 里 @gen-palettes 同一个函数）
 *                                          + 调色板派生 token（tag / chart）+ 组件别名层
 *   space/web/assets/common/css/frame.css   顶栏（全大椭圆）、快捷面板 + AI 窗口、页头 / 子页共用件、宽屏平铺：input.css 里 /* @shell:begin <名> *\/ … /* @shell:end <名> *\/ 之间的原文
 *                                          （子站样式表 @import 这两份：assets/blog/css/input.css、assets/curio/css/input.css、assets/daymark/css/input.css）
 *   space/web/data/common/frame/nav.json          快捷面板导航页的项（space/web/data/common/frame/nav-source.json）+ 用到的图标 SVG（space/web/layouts/partials/common/icon.html）
 *                                          + me.email：对外联系邮箱（space/web/data/common/profile.yaml 的 email；子站 AI 窗口「联系我」的默认值）
 *                                          + 字标 SVG wordmark（space/web/layouts/partials/common/frame/wordmark.html）；子站模板读 site.Data.common.frame.nav
 *   space/web/data/common/palette-list.json     预设 id / 名字 / 分组 / 种子 / 背景色 / 6 前景 + 每套亮暗的 Shell + Semantic token 值（含 bg-1..7、chart-1..6）
 *                                          + 默认值 + 子站自定义色缓存版本号；子站模板读 index site.Data.common "palette-list"
 * 另外：space/web/assets/common/js/prefs/ui-cookie-read.js 的 @ui-cookie-presets 段（预设 id → 种子 + 引擎版本）由本脚本按 palette-roles.json 就地重写。
 * 子站直接用的那几个 partial / JS 仍按原来的约束核对（只用参数、不 import 等），违反就失败。
 *
 * 用法：node space/scripts/gen/gen-common.mjs          重新生成
 *       node space/scripts/gen/gen-common.mjs --check  只核对（不一致 exit 1，单测 / CI 用）
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { renderBlock } from './gen-palettes.mjs';
import { DEFAULT_ID, GROUPS } from '../../web/assets/common/js/ui/palette-scheme.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** 派生文件 → 仓库里的位置（同一个 Hugo 站里，子站直接引用） */
export const OUT = Object.freeze({
  'tokens.css': 'space/web/assets/common/css/tokens.css',
  'frame.css': 'space/web/assets/common/css/frame.css',
  'nav.json': 'space/web/data/common/frame/nav.json',
  'palette-list.json': 'space/web/data/common/palette-list.json',
});
const SRC = {
  roles: path.join(REPO, 'space/web/data/common/palette-roles.json'),
  css: path.join(REPO, 'space/web/assets/common/css/input.css'),
  nav: path.join(REPO, 'space/web/data/common/frame/nav-source.json'),
  profile: path.join(REPO, 'space/web/data/common/profile.yaml'),
  icons: path.join(REPO, 'space/web/layouts/partials/common/icon.html'),
  wordmark: path.join(REPO, 'space/web/layouts/partials/common/frame/wordmark.html'),
  topbar: path.join(REPO, 'space/web/layouts/partials/common/frame/topbar.html'),
  pageHeader: path.join(REPO, 'space/web/layouts/partials/common/frame/page-head.html'),
  footer: path.join(REPO, 'space/web/layouts/partials/common/frame/footer.html'),
  topbarJs: path.join(REPO, 'space/web/assets/common/js/frame/topbar/panel.js'),
  terminal: path.join(REPO, 'space/web/assets/common/js/frame/term/terminal.js'),
  modalSheet: path.join(REPO, 'space/web/assets/common/js/ui/modal-sheet.js'),
  ai: path.join(REPO, 'space/web/assets/common/js/frame/ai/panel.js'),
  vk: path.join(REPO, 'space/web/assets/common/js/ui/vk.js'),
  prefsWrite: path.join(REPO, 'space/web/assets/common/js/prefs/prefs-write.js'),
  reader: path.join(REPO, 'space/web/assets/common/js/prefs/ui-cookie-read.js'),
  layoutMode: path.join(REPO, 'space/web/assets/common/js/ui/layout-mode.js'),
  langPath: path.join(REPO, 'space/web/assets/common/js/i18n/lang-path.js'),
  langBoot: path.join(REPO, 'space/web/assets/common/js/i18n/lang-boot.js'),
  shellI18n: path.join(REPO, 'space/web/data/common/frame/i18n'),
};
export const READER_SRC = SRC.reader;
/** frame.css 里按这个顺序拼 input.css 的标记段 */
export const SHELL_REGIONS = ['topbar-frame', 'panel', 'inpage', 'wide', 'terminal', 'music'];
/* 导航项以外外壳要用的图标（2026-11-04 P5-1；2026-11 顶栏 v3；v5 S6 顶栏 E）：顶栏（盾牌、外观调色盘、四格 NAVIGATE、>_ 终端）、AI 浮钮、NAVIGATE 的 lock、外观面板恢复默认、AI 发送 / 新对话 / 历史。
   都要是不含模板语法的完整内联 SVG（P4-2 删搜索层时 ai-search 随 nav.json 的 search 项一起删了） */
export const EXTRA_ICONS = ['tb-palette', 'tb-shield', 'tb-term', 'tb-grid', 'tb-music', 'tb-chat', 'lock', 'tb-undo', 'tb-send', 'tb-newchat', 'tb-history'];
const HEAD = (src) =>
  `/* 由 space/scripts/gen/gen-common.mjs 从 ${src} 生成，勿手改；主站和子站同一个 Hugo 站，子站样式表直接 @import。 */\n`;

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

/** 抽屉头字标（2026-10-21）：partials/common/frame/wordmark.html 是单行内联 SVG（不含模板语法），子站把它放进 .sgx-drawer-brand 代替 brand 文字 */
export function readWordmark() {
  const svg = readFileSync(SRC.wordmark, 'utf8').trim();
  if (!/^<svg class="sgx-wordmark"[^>]* role="img" aria-label="Styrigx">[\s\S]*<\/svg>$/.test(svg) || svg.includes('\n')) throw new Error('frame/wordmark.html 必须是单行 <svg class="sgx-wordmark" … role="img" aria-label="Styrigx">');
  if (/\{\{/.test(svg)) throw new Error('frame/wordmark.html 含模板语法，不能共享');
  if (!/class="wm-letters"/.test(svg) || !/class="wm-dot"/.test(svg)) throw new Error('字标缺 wm-letters / wm-dot');
  return svg;
}

const PRESETS_BEGIN = '  /* @ui-cookie-presets:begin（space/scripts/gen/gen-common.mjs 按 space/web/data/common/palette-roles.json + palette-scheme.js 生成，勿手改） */';
const PRESETS_END = '  /* @ui-cookie-presets:end */';

/** ui-cookie-read.js 的 @ui-cookie-presets 段：预设 id → 种子（= palette-list.json 的顺序）+ 深套 id 列表（DARK，首帧据此设 dark 类）+ 每套底色（BG） */
export function renderReader(data, src = readFileSync(SRC.reader, 'utf8')) {
  const a = src.indexOf(PRESETS_BEGIN);
  const b = src.indexOf(PRESETS_END);
  if (a < 0 || b < a) throw new Error('ui-cookie-read.js 里找不到 @ui-cookie-presets:begin / end');
  const seeds = Object.fromEntries(Object.keys(data.presets).map((id) => [id, data.presets[id].seed]));
  const dark = Object.keys(data.presets).filter((id) => data.presets[id].mode === 'dark');
  const bg = Object.fromEntries(Object.keys(data.presets).map((id) => [id, data.presets[id].tones['bg-1']]));
  const body = `  var PRESETS = ${JSON.stringify(seeds)};\n  /* 深套（底色 OKLCH L < 0.6）：dark 类只表示「当前是深套」 */\n  var DARK = ${JSON.stringify(dark)};\n` +
    `  /* 每套页面底色：<meta name="theme-color"> 用 */\n  var BG = ${JSON.stringify(bg)};\n`;
  return src.slice(0, a) + PRESETS_BEGIN + '\n' + body + src.slice(b);
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
  const derived = css.match(/\/\* 调色板派生 token（tag \/ chart[^*]*\*\/\n\s*(:root \{[\s\S]*?\n\s*\})/);
  if (!derived) throw new Error('input.css 里找不到调色板派生 token（tag / chart）');
  const derivedCss = derived[1]
    .split('\n')
    .map((l) => l.replace(/^ {2}/, ''))
    .join('\n');
  return (
    HEAD('space/web/data/common/palette-roles.json') +
    '/* 25 套七色调色板：<html data-palette="<id>">（默认 terra 不写）；每套只有一个模式（浅套 / 深套由底色决定），深套时 <html class="dark">。 */\n' +
    block +
    '\n/* 调色板派生 token（tag / chart）：只引用上面的色调 token */\n' +
    derivedCss +
    '\n/* 组件角色（别名层）：只引用上面的角色 */\n' +
    aliasCss +
    '\n'
  );
}

function renderShell() {
  const css = readFileSync(SRC.css, 'utf8');
  const parts = SHELL_REGIONS.map((n) => `/* ---- ${n} ---- */\n` + extractRegion(css, n));
  return (
    HEAD('space/web/assets/common/css/input.css 的 @shell 标记段') +
    '/* 依赖 tokens.css 的 --sgx-* 角色；不进任何 @layer。 */\n' +
    parts.join('\n') +
    '\n'
  );
}

function renderNav() {
  const nav = JSON.parse(readFileSync(SRC.nav, 'utf8'));
  const html = readFileSync(SRC.icons, 'utf8');
  const names = [...new Set([...nav.items, ...(nav.footer || [])].map((i) => i.icon).concat(EXTRA_ICONS))];
  const icons = {};
  for (const n of names) icons[n] = extractIcon(html, n);
  const wordmark = readWordmark();
  /* 2026-11-07 个人资料：对外联系邮箱的默认值（profile.yaml 是唯一来源，子站从 me.email 传给顶栏） */
  const prof = yaml.load(readFileSync(SRC.profile, 'utf8')) || {};
  if (typeof prof.email !== 'string' || !prof.email) throw new Error('space/web/data/common/profile.yaml 缺 email');
  nav.me = Object.assign({}, nav.me || {}, { email: prof.email });
  return (
    JSON.stringify({ _generated: 'styrigx-space space/scripts/gen/gen-common.mjs ← space/web/data/common/frame/nav-source.json + profile.yaml（me.email）+ icon.html + frame/wordmark.html；勿手改', ...nav, wordmark, icons }, null, 2) +
    '\n'
  );
}

/** 终端公共件目录（终端统一 T1）：terminal.js、ai/panel.js 只许 import 这里面的文件 */
export const TERM_DIR = path.join(REPO, 'space/web/assets/common/js/frame/term');

/**
 * 一份源码的 import 路径（去掉注释后）：静态 import + 字面量路径的 import()（终端统一 T5：man 页懒加载）；import() 的参数不是字符串字面量就报错
 * @param {string} code @param {string} label
 */
function staticImports(code, label) {
  const dyn = [...code.matchAll(/\bimport\s*\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  if ((code.match(/\bimport\s*\(/g) || []).length !== dyn.length) throw new Error(label + ' 不能动态 import() 非字面量路径');
  return (code.match(/^\s*import\s[^;]*;/gm) || []).map((l) => {
    const m = /from\s+'([^']+)';$/.exec(l.trim()) || /^import\s+'([^']+)';$/.exec(l.trim());
    if (!m) throw new Error(label + ' 的 import 写法认不出：' + l.trim());
    return m[1];
  }).concat(dyn);
}

/**
 * 核对 import（含字面量 import()）只落在 term/** 里，并顺着 term/** 里的文件往下查（它们也只许互相 import）
 * @param {string} file @param {string} label @param {string} [termDir] 单测换成临时目录 @param {Set<string>} [seen]
 */
export function checkTermImports(file, label, termDir = TERM_DIR, seen = new Set()) {
  if (seen.has(file)) return;
  seen.add(file);
  const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const spec of staticImports(code, label)) {
    const to = path.resolve(path.dirname(file), spec);
    if (!spec.startsWith('.') || !to.startsWith(termDir + path.sep) || !to.endsWith('.js')) {
      throw new Error(label + ' 只能 import term/** 里的 .js（终端统一 T1）：' + spec);
    }
    if (!existsSync(to)) throw new Error(label + ' import 的文件不存在：' + spec);
    checkTermImports(to, path.relative(REPO, to), termDir, seen);
  }
}

/**
 * 自成一体的 JS 组件：原样复制（不能 import；必须导出 exportName）。
 * opts.term：只许 import term/**（终端统一 T1 起 terminal.js、ai/panel.js；同一次 Hugo 构建打包，子站没有原样副本）
 * @param {string} file @param {string} label @param {string} exportName @param {{term?: boolean}} [opts]
 */
export function renderStandalone(file, label, exportName, opts = {}) {
  const src = readFileSync(file, 'utf8');
  if (opts.term) checkTermImports(file, label);
  else if (/^\s*import\s/m.test(src) || /\bimport\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))) throw new Error(label + ' 不能 import 任何东西（子站原样复制）');
  if (!new RegExp('^export (async )?function ' + exportName + '\\(', 'm').test(src)) throw new Error(label + ' 必须导出 ' + exportName);
  return src;
}

/** 首帧语言跳转（语言清理 2026-11-07，四站同一份）：原样复制；只许 import 同目录的 ./lang-path.js（子站也放在一起） */
export function renderLangBoot() {
  const src = readFileSync(SRC.langBoot, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const imports = code.match(/^\s*import\s[^;]*;/gm) || [];
  if (imports.some((l) => !/from '\.\/lang-path\.js';$/.test(l.trim())) || /\bimport\s*\(/.test(code)) throw new Error('lang-boot.js 只能 import ./lang-path.js');
  if (!/^export function bootLang\(/m.test(src) || !/^export function langBootTarget\(/m.test(src)) throw new Error('lang-boot.js 必须导出 bootLang / langBootTarget');
  return src;
}

/** 外壳字符串表（语言包化 2026-11-07）：space/web/data/common/frame/i18n/<语言>.yaml 原样复制成 i18n-<语言>.yaml（有几种语言复制几份；必须有 en.yaml） */
export function renderShellI18n() {
  const names = readdirSync(SRC.shellI18n).filter((f) => /^[a-z]{2,3}\.yaml$/.test(f)).sort();
  if (!names.includes('en.yaml')) throw new Error('space/web/data/common/frame/i18n/ 必须有 en.yaml（英文是源文本、缺键回退英文）');
  return Object.fromEntries(names.map((f) => ['i18n-' + f, readFileSync(path.join(SRC.shellI18n, f), 'utf8')]));
}

/** 顶栏 partial：原样复制；只能用参数（子站没有主站的 partial 和 data），不许 partial / site.Data / resources */
export function renderTopbar() {
  const src = readFileSync(SRC.topbar, 'utf8');
  const code = src.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '');
  if (/\{\{-?\s*partial(Cached)?\s/.test(code) || /site\.Data|hugo\.Data|resources\.|\.Site\b|\$\.Page\b/.test(code)) throw new Error('frame/topbar.html 只能用传进来的参数（不能调 partial / 读 site.Data / resources）');
  if (!/<header id="site-nav"/.test(src) || !/id="sgx-nav"/.test(src) || !/id="sgx-qp"/.test(src) || !/id="sgx-ai"/.test(src) || !/id="sgx-term"/.test(src)) throw new Error('frame/topbar.html 缺 header#site-nav / #sgx-nav / #sgx-qp / #sgx-ai / #sgx-term');
  return src;
}

/** 页头 sgx-ph（2026-11 对齐 PR-C）：原样复制；同顶栏，只能用传进来的参数 */
function renderParamsOnly(file, name, mark) {
  const src = readFileSync(file, 'utf8');
  const code = src.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '');
  if (/\{\{-?\s*partial(Cached)?\s/.test(code) || /site\.Data|hugo\.Data|resources\.|\.Site\b|\$\.Page\b/.test(code)) throw new Error(name + ' 只能用传进来的参数（不能调 partial / 读 site.Data / resources）');
  if (!src.includes(mark)) throw new Error(name + ' 缺 ' + mark);
  return src;
}
export const renderPageHeader = () => renderParamsOnly(SRC.pageHeader, 'frame/page-head.html', 'class="sgx-ph"');
/** tmux 页脚（2026-11 UI 重设计 PR-1）：四站同一个，同上只能用传进来的参数 */
export const renderFooter = () => renderParamsOnly(SRC.footer, 'frame/footer.html', 'class="sgx-foot"');

/** 调色板用法规则版本（填充 vs ink、大面积块中性化、固定状态色、图表 3:1 回退、合成底审计；docs/design/palette.md） */
export const RULES_VERSION = 'palette-rules-2';

/* palette-list.json 每套带的 token（子站只消费这些，不自己定义主题色）：
   Shell = 页面底 / 光晕（bg-1..7）、材质（表面、容器、玻璃、遮罩）；Semantic = 主 / 辅 / 第三色族、选中、链接、边线、文字；
   另加前景 6 色（fg-N / -tint / -ink）和 chart-1..6（= fg-1..6 本色，卡片上不到 3:1 的逐色退到 ink）、tag-bg / tag-fg（= fg-4 tint / ink）。 */
const SHELL_KEYS = ['bg-1', 'bg-2', 'bg-3', 'bg-4', 'bg-5', 'bg-6', 'bg-7', 'background', 'surface', 'surface-dim', 'surface-bright',
  'surface-container-lowest', 'surface-container-low', 'surface-container', 'surface-container-high', 'surface-container-highest',
  'topbar-glass', 'glass-tint', 'glass-edge', 'scrim'];
const SEMANTIC_KEYS = ['primary', 'on-primary', 'primary-container', 'on-primary-container', 'secondary', 'on-secondary', 'secondary-container',
  'on-secondary-container', 'tertiary', 'on-tertiary', 'tertiary-container', 'on-tertiary-container', 'nav-selected', 'on-nav-selected',
  'chip-selected', 'on-chip-selected', 'link', 'link-visited', 'focus-ring', 'outline', 'outline-variant', 'divider',
  'text-primary', 'text-secondary', 'text-tertiary', 'danger', 'on-danger',
  /* 2026-10-23 PR-G 修订：填充档（前景 1 本色 + 自动 on 色）、固定成功色 */
  'primary-fill', 'on-primary-fill', 'success', 'on-success', 'success-container', 'on-success-container',
  'warning', 'on-warning', 'warning-container', 'on-warning-container', 'info', 'on-info', 'info-container', 'on-info-container'];
/** 完整导出（2026-10-23 PR-G 修订：「按需索取」；2026-11-12 v4 起每套只有一个模式）：每套 = 全部角色（Shell + Semantic + 交互 / 功能 / 固定状态色 / chart）
 *  + 全部色调 token（bg-1..7、fg-1..6 本色 / -tint / -ink / -on）+ tag + 状态层（state-color 解析成颜色）。
 *  SHELL_KEYS / SEMANTIC_KEYS 只用来给子站文档分组，值不再筛掉。
 *  @param {any} p 预设 */
export function sharedTokens(p) {
  const roles = p.roles, tones = p.tones, st = p.state, out = {};
  for (const k of SHELL_KEYS) out[k] = k in tones ? tones[k] : roles[k];
  for (const k of SEMANTIC_KEYS) out[k] = roles[k];
  for (const [k, v] of Object.entries(roles)) {
    if (k === 'bg-gradient') { v.forEach((c, i) => { out['bg-gradient-' + (i + 1)] = c; }); continue; }
    if (!(k in out)) out[k] = v;
  }
  for (const [k, v] of Object.entries(tones)) if (!(k in out)) out[k] = v;
  out['tag-bg'] = tones['fg-4-tint']; out['tag-fg'] = tones['fg-4-ink'];
  if (st) {
    out['state-color'] = st.color === 'primary' ? roles.primary : roles['text-primary'];
    for (const k of ['hover', 'focus', 'pressed', 'selected', 'dragged']) out['state-' + k] = st[k];
  }
  return out;
}

function renderPalettes(data) {
  /* 顺序 = palette-roles.json（= palette-scheme.js PRESETS = 设置页网格顺序，按 group 分组）；2026-10-23 PR-G 起 25 套七色调色板，
     group = cool / nature / warm / floral / neutral，每项带 bg / fg、mode（light = 浅套 / dark = 深套）和本套 tokens */
  const ids = Object.keys(data.presets);
  return (
    JSON.stringify(
      {
        _generated: 'styrigx-space space/scripts/gen/gen-common.mjs ← space/web/data/common/palette-roles.json；勿手改',
        default: DEFAULT_ID,
        /* 子站据此判断自己消费的是哪一版调色板用法规则（docs/design/palette.md）；规则变了手动加一 */
        rulesVersion: RULES_VERSION,
        groups: GROUPS,
        presets: ids.map((id) => {
          const p = data.presets[id];
          return { id, zh: p.zh, en: p.en, seed: p.seed, group: p.group, bg: p.bg, fg: p.fg, mode: p.mode, tokens: sharedTokens(p) };
        }),
      },
      null,
      2,
    ) + '\n'
  );
}

/** @returns {{files: Record<string,string>, reader: string}} 派生文件名 → 内容；reader = ui-cookie-read.js 应有的全文 */
export function renderAll() {
  const data = JSON.parse(readFileSync(SRC.roles, 'utf8'));
  const reader = renderReader(data);
  /* 子站直接引用的 partial / JS：只核对约束（结果不落盘） */
  renderTopbar();
  renderPageHeader();
  renderFooter();
  renderStandalone(SRC.topbarJs, 'topbar/panel.js', 'mountTopbar');
  renderStandalone(SRC.terminal, 'terminal.js', 'createShell', { term: true });
  renderStandalone(SRC.modalSheet, 'modal-sheet.js', 'modalSheet');
  renderStandalone(SRC.ai, 'ai/panel.js', 'mountAiChat', { term: true });
  renderStandalone(SRC.vk, 'vk.js', 'onKeyboardHeight');
  renderStandalone(SRC.prefsWrite, 'prefs-write.js', 'syncUiCookie');
  renderStandalone(SRC.langPath, 'lang-path.js', 'langPath');
  renderLangBoot();
  renderShellI18n();
  return {
    files: {
      'tokens.css': renderTokens(data),
      'frame.css': renderShell(),
      'nav.json': renderNav(),
      'palette-list.json': renderPalettes(data),
    },
    reader,
  };
}

/**
 * 共享外壳的全部文件（合站前 shared/shell 里那一套的名字）→ 仓库里的位置：四个派生文件 + 子站直接用的主站源文件。
 * 只是索引（测试和文档按名字找文件用），没有副本。
 */
export const SHELL_FILES = Object.freeze({
  ...OUT,
  'topbar.html': 'space/web/layouts/partials/common/frame/topbar.html',
  'page-header.html': 'space/web/layouts/partials/common/frame/page-head.html',
  'footer.html': 'space/web/layouts/partials/common/frame/footer.html',
  'topbar.js': 'space/web/assets/common/js/frame/topbar/panel.js',
  'terminal.js': 'space/web/assets/common/js/frame/term/terminal.js',
  'modal-sheet.js': 'space/web/assets/common/js/ui/modal-sheet.js',
  'ai.js': 'space/web/assets/common/js/frame/ai/panel.js',
  'vk.js': 'space/web/assets/common/js/ui/vk.js',
  'prefs-write.js': 'space/web/assets/common/js/prefs/prefs-write.js',
  'ui-cookie-read.js': 'space/web/assets/common/js/prefs/ui-cookie-read.js',
  'layout-mode.js': 'space/web/assets/common/js/ui/layout-mode.js',
  'lang-path.js': 'space/web/assets/common/js/i18n/lang-path.js',
  'lang-boot.js': 'space/web/assets/common/js/i18n/lang-boot.js',
  'lang-path.html': 'space/web/layouts/partials/common/lang-path.html',
  'tr.html': 'space/web/layouts/partials/common/tr.html',
  'i18n-en.yaml': 'space/web/data/common/frame/i18n/en.yaml',
  'i18n-zh.yaml': 'space/web/data/common/frame/i18n/zh.yaml',
  'favicon.js': 'space/web/assets/common/js/ui/favicon.js',
  'favicon.svg': 'space/web/static/favicon.svg',
});

/** @returns {Record<string,string>} 共享外壳文件名 → 内容（派生文件按源头现算，其余读源文件） */
export function shellFiles() {
  const { files } = renderAll();
  const out = {};
  for (const [k, p] of Object.entries(SHELL_FILES)) out[k] = k in files ? files[k] : readFileSync(path.join(REPO, p), 'utf8');
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { files, reader } = renderAll();
  if (process.argv.includes('--check')) {
    const bad = [];
    for (const [k, v] of Object.entries(files)) {
      const p = path.join(REPO, OUT[k]);
      if (!existsSync(p) || readFileSync(p, 'utf8') !== v) bad.push(OUT[k]);
    }
    if (readFileSync(SRC.reader, 'utf8') !== reader) bad.push('space/web/assets/common/js/prefs/ui-cookie-read.js 的 @ui-cookie-presets 段');
    if (bad.length) {
      console.error('共享外壳派生文件和源头不一致：' + bad.join('、') + '；运行 node space/scripts/gen/gen-common.mjs');
      process.exit(1);
    }
    console.log('shared shell in sync:', Object.values(OUT).join(', '));
  } else {
    if (readFileSync(SRC.reader, 'utf8') !== reader) writeFileSync(SRC.reader, reader);
    for (const [k, v] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(REPO, OUT[k])), { recursive: true });
      writeFileSync(path.join(REPO, OUT[k]), v);
    }
    console.log('shared shell regenerated:', Object.values(OUT).join(', '));
  }
}
