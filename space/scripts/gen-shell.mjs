#!/usr/bin/env node
/**
 * 共享外壳（shared shell）：主站是唯一来源。2026-11 合站起主站和三个子站（blog / curio / daymark）是同一个 Hugo 站（space/web/），
 * 子站直接用主站的 partial（shell-topbar.html、sgx-entries.html、sgx-page-hero.html、sgx-segtabs.html、sgx-tr.html、sgx-lang-path.html）
 * 和 JS（assets/js/shell/*、assets/js/lib/*），没有副本、没有同步脚本、没有 lock。
 *
 * 只剩四个由源头算出来、没法直接引用的派生文件由本脚本生成（勿手改，改源头后重跑本脚本）：
 *   space/web/assets/css/shell/tokens.css  22 套七色调色板的色彩角色 + 色调 token（--sgx-bg-1..7 / --sgx-fg-1..6；space/web/data/palette-roles.json，和 input.css 里 @gen-palettes 同一个函数）
 *                                          + 调色板派生 token（tag / chart）+ 组件别名层
 *   space/web/assets/css/shell/shell.css   顶栏（全大椭圆）、快捷面板 + AI 窗口、平铺入口、标题带 / 段式标签、宽屏平铺：input.css 里 /* @shell:begin <名> *\/ … /* @shell:end <名> *\/ 之间的原文
 *                                          （子站样式表 @import 这两份：assets/blog/css/input.css、assets/curio/css/input.css、assets/daymark/css/input.css）
 *   space/web/data/shell/nav.json          快捷面板导航页的项（space/web/data/shell-nav.json）+ 用到的图标 SVG（space/web/layouts/partials/icon.html）
 *                                          + me.email：对外联系邮箱（space/web/data/profile.yaml 的 email；子站 AI 窗口「联系我」的默认值）
 *                                          + 字标 SVG wordmark（space/web/layouts/partials/shell-wordmark.html）；子站模板读 site.Data.shell.nav
 *   space/web/data/shell/palettes.json     预设 id / 名字 / 分组 / 种子 / 背景色 / 6 前景 + 每套亮暗的 Shell + Semantic token 值（含 bg-1..7、chart-1..6）
 *                                          + 默认值 + 子站自定义色缓存版本号；子站模板读 site.Data.shell.palettes
 * 另外：space/web/assets/js/lib/ui-cookie-read.js 的 @ui-cookie-presets 段（预设 id → 种子 + 引擎版本）由本脚本按 palette-roles.json 就地重写。
 * 子站直接用的那几个 partial / JS 仍按原来的约束核对（只用参数、不 import 等），违反就失败。
 *
 * 用法：node space/scripts/gen-shell.mjs          重新生成
 *       node space/scripts/gen-shell.mjs --check  只核对（不一致 exit 1，单测 / CI 用）
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { renderBlock } from './gen-palettes.mjs';
import { DEFAULT_ID, GROUPS } from '../web/assets/js/lib/palette-scheme.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 派生文件 → 仓库里的位置（同一个 Hugo 站里，子站直接引用） */
export const OUT = Object.freeze({
  'tokens.css': 'space/web/assets/css/shell/tokens.css',
  'shell.css': 'space/web/assets/css/shell/shell.css',
  'nav.json': 'space/web/data/shell/nav.json',
  'palettes.json': 'space/web/data/shell/palettes.json',
});
const SRC = {
  roles: path.join(REPO, 'space/web/data/palette-roles.json'),
  css: path.join(REPO, 'space/web/assets/css/input.css'),
  scheme: path.join(REPO, 'space/web/assets/js/lib/palette-scheme.js'),
  nav: path.join(REPO, 'space/web/data/shell-nav.json'),
  profile: path.join(REPO, 'space/web/data/profile.yaml'),
  icons: path.join(REPO, 'space/web/layouts/partials/icon.html'),
  wordmark: path.join(REPO, 'space/web/layouts/partials/shell-wordmark.html'),
  share: path.join(REPO, 'space/web/assets/js/shell/share-button.js'),
  topbar: path.join(REPO, 'space/web/layouts/partials/shell-topbar.html'),
  entries: path.join(REPO, 'space/web/layouts/partials/sgx-entries.html'),
  pageHero: path.join(REPO, 'space/web/layouts/partials/sgx-page-hero.html'),
  segtabs: path.join(REPO, 'space/web/layouts/partials/sgx-segtabs.html'),
  footer: path.join(REPO, 'space/web/layouts/partials/sgx-footer.html'),
  topbarJs: path.join(REPO, 'space/web/assets/js/shell/topbar-panel.js'),
  terminal: path.join(REPO, 'space/web/assets/js/shell/terminal.js'),
  modalSheet: path.join(REPO, 'space/web/assets/js/shell/modal-sheet.js'),
  ai: path.join(REPO, 'space/web/assets/js/shell/ai-panel.js'),
  vk: path.join(REPO, 'space/web/assets/js/shell/vk.js'),
  prefsWrite: path.join(REPO, 'space/web/assets/js/lib/prefs-write.js'),
  reader: path.join(REPO, 'space/web/assets/js/lib/ui-cookie-read.js'),
  layoutMode: path.join(REPO, 'space/web/assets/js/lib/layout-mode.js'),
  langPath: path.join(REPO, 'space/web/assets/js/lib/lang-path.js'),
  langBoot: path.join(REPO, 'space/web/assets/js/lib/lang-boot.js'),
  shellI18n: path.join(REPO, 'space/web/data/sgx-shell-i18n'),
};
export const READER_SRC = SRC.reader;
/** shell.css 里按这个顺序拼 input.css 的标记段 */
export const SHELL_REGIONS = ['topbar-frame', 'panel', 'entries', 'inpage', 'wide', 'terminal'];
/* 导航项以外外壳要用的图标（2026-11-04 P5-1；2026-11 顶栏 v3）：顶栏（外观调色盘、盾牌、>_ NAVIGATE）、AI 浮钮、NAVIGATE 的 share / lock、外观面板恢复默认、AI 发送 / 新对话 / 历史。
   都要是不含模板语法的完整内联 SVG（P4-2 删搜索层时 ai-search 随 nav.json 的 search 项一起删了） */
export const EXTRA_ICONS = ['tb-palette', 'tb-shield', 'tb-term', 'tb-chat', 'lock', 'tb-undo', 'share', 'tb-send', 'tb-newchat', 'tb-history'];
const HEAD = (src) =>
  `/* 由 space/scripts/gen-shell.mjs 从 ${src} 生成，勿手改；主站和子站同一个 Hugo 站，子站样式表直接 @import。 */\n`;

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

/** 抽屉头字标（2026-10-21）：partials/shell-wordmark.html 是单行内联 SVG（不含模板语法），子站把它放进 .sgx-drawer-brand 代替 brand 文字 */
export function readWordmark() {
  const svg = readFileSync(SRC.wordmark, 'utf8').trim();
  if (!/^<svg class="sgx-wordmark"[^>]* role="img" aria-label="Styrigx">[\s\S]*<\/svg>$/.test(svg) || svg.includes('\n')) throw new Error('shell-wordmark.html 必须是单行 <svg class="sgx-wordmark" … role="img" aria-label="Styrigx">');
  if (/\{\{/.test(svg)) throw new Error('shell-wordmark.html 含模板语法，不能共享');
  if (!/class="wm-letters"/.test(svg) || !/class="wm-dot"/.test(svg)) throw new Error('字标缺 wm-letters / wm-dot');
  return svg;
}

const PRESETS_BEGIN = '  /* @ui-cookie-presets:begin（space/scripts/gen-shell.mjs 按 space/web/data/palette-roles.json + palette-scheme.js 生成，勿手改） */';
const PRESETS_END = '  /* @ui-cookie-presets:end */';

/** ui-cookie-read.js 的 @ui-cookie-presets 段：预设 id → 种子（= palettes.json 的顺序）+ 引擎版本（= palettes.json schemeVersion） */
export function renderReader(data, schemeSrc, src = readFileSync(SRC.reader, 'utf8')) {
  const a = src.indexOf(PRESETS_BEGIN);
  const b = src.indexOf(PRESETS_END);
  if (a < 0 || b < a) throw new Error('ui-cookie-read.js 里找不到 @ui-cookie-presets:begin / end');
  const seeds = Object.fromEntries(Object.keys(data.presets).map((id) => [id, data.presets[id].seed]));
  const body = `  var PRESETS = ${JSON.stringify(seeds)};\n  var SCHEME_VER = '${sha(schemeSrc).slice(0, 12)}';\n`;
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
    HEAD('space/web/data/palette-roles.json') +
    '/* 22 套七色调色板（1 背景色 + 6 前景撞色）：<html data-palette="<id>">（默认 terra 不写），深色 <html class="dark">；自定义种子在运行时用 palette-scheme.js 的 rolesCss() 覆盖。 */\n' +
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
    HEAD('space/web/assets/css/input.css 的 @shell 标记段') +
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
  if (typeof prof.email !== 'string' || !prof.email) throw new Error('space/web/data/profile.yaml 缺 email');
  nav.me = Object.assign({}, nav.me || {}, { email: prof.email });
  return (
    JSON.stringify({ _generated: 'styrigx-space space/scripts/gen-shell.mjs ← space/web/data/shell-nav.json + profile.yaml（me.email）+ icon.html + shell-wordmark.html；勿手改', ...nav, wordmark, icons }, null, 2) +
    '\n'
  );
}

/** 子站顶栏分享按钮：原样复制（不能 import，必须导出 mountShare） */
export function renderShare() {
  const src = readFileSync(SRC.share, 'utf8');
  if (/^\s*import\s/m.test(src) || /\bimport\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))) throw new Error('share-button.js 不能 import 任何东西（子站原样复制）');
  if (!/^export function mountShare\(/m.test(src)) throw new Error('share-button.js 必须导出 mountShare');
  return src;
}

/** 自成一体的 JS 组件：原样复制（不能 import；必须导出 exportName） @param {string} file @param {string} label @param {string} exportName */
export function renderStandalone(file, label, exportName) {
  const src = readFileSync(file, 'utf8');
  if (/^\s*import\s/m.test(src) || /\bimport\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))) throw new Error(label + ' 不能 import 任何东西（子站原样复制）');
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

/** 外壳字符串表（语言包化 2026-11-07）：space/web/data/sgx-shell-i18n/<语言>.yaml 原样复制成 i18n-<语言>.yaml（有几种语言复制几份；必须有 en.yaml） */
export function renderShellI18n() {
  const names = readdirSync(SRC.shellI18n).filter((f) => /^[a-z]{2,3}\.yaml$/.test(f)).sort();
  if (!names.includes('en.yaml')) throw new Error('space/web/data/sgx-shell-i18n/ 必须有 en.yaml（英文是源文本、缺键回退英文）');
  return Object.fromEntries(names.map((f) => ['i18n-' + f, readFileSync(path.join(SRC.shellI18n, f), 'utf8')]));
}

/** 顶栏 partial：原样复制；只能用参数（子站没有主站的 partial 和 data），不许 partial / site.Data / resources */
export function renderTopbar() {
  const src = readFileSync(SRC.topbar, 'utf8');
  const code = src.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '');
  if (/\{\{-?\s*partial(Cached)?\s/.test(code) || /site\.Data|hugo\.Data|resources\.|\.Site\b|\$\.Page\b/.test(code)) throw new Error('shell-topbar.html 只能用传进来的参数（不能调 partial / 读 site.Data / resources）');
  if (!/<header id="site-nav"/.test(src) || !/id="sgx-nav"/.test(src) || !/id="sgx-qp"/.test(src) || !/id="sgx-ai"/.test(src) || !/id="sgx-term"/.test(src)) throw new Error('shell-topbar.html 缺 header#site-nav / #sgx-nav / #sgx-qp / #sgx-ai / #sgx-term');
  return src;
}

/** 平铺入口组件（P4-3 PR-4b）：原样复制；和顶栏一样只能用传进来的参数 */
export function renderEntries() {
  const src = readFileSync(SRC.entries, 'utf8');
  const code = src.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '');
  if (/\{\{-?\s*partial(Cached)?\s/.test(code) || /site\.Data|hugo\.Data|resources\.|\.Site\b|\$\.Page\b/.test(code)) throw new Error('sgx-entries.html 只能用传进来的参数（不能调 partial / 读 site.Data / resources）');
  if (!/class="sgx-ents/.test(src)) throw new Error('sgx-entries.html 缺 .sgx-ents');
  return src;
}

/** 内容页标题带 / 段式标签（P4-3 §6.6）：原样复制；同平铺入口，只能用传进来的参数 */
function renderParamsOnly(file, name, mark) {
  const src = readFileSync(file, 'utf8');
  const code = src.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '');
  if (/\{\{-?\s*partial(Cached)?\s/.test(code) || /site\.Data|hugo\.Data|resources\.|\.Site\b|\$\.Page\b/.test(code)) throw new Error(name + ' 只能用传进来的参数（不能调 partial / 读 site.Data / resources）');
  if (!src.includes(mark)) throw new Error(name + ' 缺 ' + mark);
  return src;
}
export const renderPageHero = () => renderParamsOnly(SRC.pageHero, 'sgx-page-hero.html', 'class="sgx-hero');
export const renderSegtabs = () => renderParamsOnly(SRC.segtabs, 'sgx-segtabs.html', 'class="sgx-segs"');
/** tmux 页脚（2026-11 UI 重设计 PR-1）：四站同一个，同上只能用传进来的参数 */
export const renderFooter = () => renderParamsOnly(SRC.footer, 'sgx-footer.html', 'class="sgx-foot"');

/** 调色板用法规则版本（填充 vs ink、大面积块中性化、固定状态色、图表 3:1 回退、合成底审计；docs/palette-usage.md） */
export const RULES_VERSION = 'palette-rules-1';

/* palettes.json 每套带的 token（子站只消费这些，不自己定义主题色）：
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
/** 完整导出（2026-10-23 PR-G 修订：「按需索取」）：每套亮 / 暗 = 全部角色（Shell + Semantic + 交互 / 功能 / 固定状态色 / chart）
 *  + 全部色调 token（bg-1..7、fg-1..6 本色 / -tint / -ink / -on）+ tag + 状态层（state-color 解析成颜色）。
 *  SHELL_KEYS / SEMANTIC_KEYS 只用来给子站文档分组，值不再筛掉。
 *  @param {any} p 预设 @param {'light'|'dark'} m */
export function sharedTokens(p, m) {
  const roles = p[m], tones = p[m + 'Tones'], st = p[m + 'State'], out = {};
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

function renderPalettes(data, schemeSrc) {
  /* 顺序 = palette-roles.json（= palette-scheme.js PRESETS = 设置页网格顺序，按 group 分组）；2026-10-23 PR-G 起 22 套七色调色板，
     group = cool / nature / warm / floral / neutral，每项带 bg / fg 和亮暗 tokens */
  const ids = Object.keys(data.presets);
  return (
    JSON.stringify(
      {
        _generated: 'styrigx-space space/scripts/gen-shell.mjs ← space/web/data/palette-roles.json；勿手改',
        default: DEFAULT_ID,
        /* 子站缓存自定义色角色时用的版本号：引擎一变就变，旧缓存自动作废 */
        schemeVersion: sha(schemeSrc).slice(0, 12),
        /* 子站据此判断自己消费的是哪一版调色板用法规则（docs/palette-usage.md）；规则变了手动加一 */
        rulesVersion: RULES_VERSION,
        groups: GROUPS,
        presets: ids.map((id) => {
          const p = data.presets[id];
          return { id, zh: p.zh, en: p.en, seed: p.seed, group: p.group, bg: p.bg, fg: p.fg,
            tokens: { light: sharedTokens(p, 'light'), dark: sharedTokens(p, 'dark') } };
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
  const schemeSrc = readFileSync(SRC.scheme, 'utf8');
  const reader = renderReader(data, schemeSrc);
  /* 子站直接引用的 partial / JS：只核对约束（结果不落盘） */
  renderShare();
  renderTopbar();
  renderEntries();
  renderPageHero();
  renderSegtabs();
  renderFooter();
  renderStandalone(SRC.topbarJs, 'topbar-panel.js', 'mountTopbar');
  renderStandalone(SRC.terminal, 'terminal.js', 'createShell');
  renderStandalone(SRC.modalSheet, 'modal-sheet.js', 'modalSheet');
  renderStandalone(SRC.ai, 'ai-panel.js', 'mountAiChat');
  renderStandalone(SRC.vk, 'vk.js', 'onKeyboardHeight');
  renderStandalone(SRC.prefsWrite, 'prefs-write.js', 'syncUiCookie');
  renderStandalone(SRC.langPath, 'lang-path.js', 'langPath');
  renderLangBoot();
  renderShellI18n();
  return {
    files: {
      'tokens.css': renderTokens(data),
      'shell.css': renderShell(),
      'nav.json': renderNav(),
      'palettes.json': renderPalettes(data, schemeSrc),
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
  'palette-scheme.js': 'space/web/assets/js/lib/palette-scheme.js',
  'share.js': 'space/web/assets/js/shell/share-button.js',
  'topbar.html': 'space/web/layouts/partials/shell-topbar.html',
  'entries.html': 'space/web/layouts/partials/sgx-entries.html',
  'page-hero.html': 'space/web/layouts/partials/sgx-page-hero.html',
  'segtabs.html': 'space/web/layouts/partials/sgx-segtabs.html',
  'footer.html': 'space/web/layouts/partials/sgx-footer.html',
  'topbar.js': 'space/web/assets/js/shell/topbar-panel.js',
  'terminal.js': 'space/web/assets/js/shell/terminal.js',
  'modal-sheet.js': 'space/web/assets/js/shell/modal-sheet.js',
  'ai.js': 'space/web/assets/js/shell/ai-panel.js',
  'vk.js': 'space/web/assets/js/shell/vk.js',
  'prefs-write.js': 'space/web/assets/js/lib/prefs-write.js',
  'ui-cookie-read.js': 'space/web/assets/js/lib/ui-cookie-read.js',
  'layout-mode.js': 'space/web/assets/js/lib/layout-mode.js',
  'lang-path.js': 'space/web/assets/js/lib/lang-path.js',
  'lang-boot.js': 'space/web/assets/js/lib/lang-boot.js',
  'lang-path.html': 'space/web/layouts/partials/sgx-lang-path.html',
  'tr.html': 'space/web/layouts/partials/sgx-tr.html',
  'i18n-en.yaml': 'space/web/data/sgx-shell-i18n/en.yaml',
  'i18n-zh.yaml': 'space/web/data/sgx-shell-i18n/zh.yaml',
  'favicon.js': 'space/web/assets/js/shell/favicon.js',
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
    if (readFileSync(SRC.reader, 'utf8') !== reader) bad.push('space/web/assets/js/lib/ui-cookie-read.js 的 @ui-cookie-presets 段');
    if (bad.length) {
      console.error('共享外壳派生文件和源头不一致：' + bad.join('、') + '；运行 node space/scripts/gen-shell.mjs');
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
