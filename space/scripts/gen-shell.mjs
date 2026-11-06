#!/usr/bin/env node
/**
 * 共享外壳（shared shell）：主站是唯一来源，子站（blog / curio / daymark）用 atlas/scripts/<站>/sync-shell.mjs 一条命令同步。
 *
 * 生成 space/web/shared/shell/（勿手改，改源头后重跑本脚本）：
 *   tokens.css         22 套七色调色板的色彩角色 + 色调 token（--sgx-bg-1..7 / --sgx-fg-1..6；space/web/data/palette-roles.json，和 input.css 里 @gen-palettes 同一个函数）
 *                      + 调色板派生 token（tag / chart）+ 组件别名层
 *   shell.css          顶栏（全大椭圆）、快捷面板 + AI 窗口、原地搜索层：input.css 里 /* @shell:begin <名> *\/ … /* @shell:end <名> *\/ 之间的原文
 *   palette-scheme.js  自定义 #rrggbb 种子 → 整套角色的引擎（space/web/assets/js/lib/palette-scheme.js 原样复制）
 *   share.js           子站快捷面板的「分享本页」磁贴（space/web/assets/js/shell/share-button.js 原样复制；不 import 任何东西）
 *   topbar.html        顶栏 + 快捷面板 + AI 窗口的标记（space/web/layouts/partials/shell-topbar.html 原样复制；Hugo partial，只用参数，2026-11-04 P5-1）
 *   topbar.js          顶栏两个窗口的开合 / 互斥 / 两页 / 磁贴（space/web/assets/js/shell/topbar-panel.js 原样复制；不 import，依赖由调用方传入）
 *   modal-sheet.js     窗口开合状态机（space/web/assets/js/shell/modal-sheet.js 原样复制；不 import）
 *   ai.js              AI 窗口内容（space/web/assets/js/shell/ai-panel.js 原样复制；不 import）
 *   vk.js              键盘高度订阅（space/web/assets/js/shell/vk.js 原样复制；不 import；入口把 onKeyboardHeight 传给 mountTopbar，转给 AI 窗口跟键盘，P4-3 PR-3）
 *   prefs-write.js     外观写端（space/web/assets/js/lib/prefs-write.js 原样复制；不 import；子站快捷设置用，定案第 5 条）
 *   nav.json           快捷面板导航页的项（space/web/data/shell-nav.json）+ 用到的图标 SVG（space/web/layouts/partials/icon.html）
 *                      + 字标 SVG wordmark（space/web/layouts/partials/shell-wordmark.html；brand 文字照旧保留）
 *   palettes.json      预设 id / 名字 / 分组 / 种子 / 背景色 / 6 前景 + 每套亮暗的 Shell + Semantic token 值（含 bg-1..7、chart-1..6）
 *                      + 默认值 + 子站自定义色缓存版本号（子站只消费，不自己定义主题色）
 *   ui-cookie-read.js  sgx-ui cookie 只读解析器（space/web/assets/js/lib/ui-cookie-read.js 原样复制；经典脚本 ES5，子站内联进 <head>）
 *                      源文件里 @ui-cookie-presets 段（预设 id → 种子 + 引擎版本）由本脚本按 palette-roles.json 重写
 *   layout-mode.js     布局模式（手机 / 桌面）唯一规则 __sgxLayout()（space/web/assets/js/lib/layout-mode.js 原样复制；经典脚本 ES5，四站内联进 <head>，P4-3 PR-4b）
 *   ui-cookie-contract.json  写端真实产出的 cookie + 读端期望（tests/fixtures/ui-cookie-contract.json 原样复制，gen-ui-cookie-contract.mjs 生成）
 *   favicon.js / favicon.svg  标签页图标跟主题色（space/web/assets/js/shell/favicon.js、space/web/static/favicon.svg 原样复制）
 *   manifest.json      上面每个文件的 sha256（子站同步时逐个校验）
 *   README.md          说明
 *
 * 用法：node space/scripts/gen-shell.mjs          重新生成
 *       node space/scripts/gen-shell.mjs --check  只核对（不一致 exit 1，单测 / CI 用）
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBlock } from './gen-palettes.mjs';
import { DEFAULT_ID, GROUPS } from '../web/assets/js/lib/palette-scheme.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT_DIR = path.join(REPO, 'space/web/shared/shell');
const SRC = {
  roles: path.join(REPO, 'space/web/data/palette-roles.json'),
  css: path.join(REPO, 'space/web/assets/css/input.css'),
  scheme: path.join(REPO, 'space/web/assets/js/lib/palette-scheme.js'),
  nav: path.join(REPO, 'space/web/data/shell-nav.json'),
  icons: path.join(REPO, 'space/web/layouts/partials/icon.html'),
  wordmark: path.join(REPO, 'space/web/layouts/partials/shell-wordmark.html'),
  share: path.join(REPO, 'space/web/assets/js/shell/share-button.js'),
  topbar: path.join(REPO, 'space/web/layouts/partials/shell-topbar.html'),
  topbarJs: path.join(REPO, 'space/web/assets/js/shell/topbar-panel.js'),
  modalSheet: path.join(REPO, 'space/web/assets/js/shell/modal-sheet.js'),
  ai: path.join(REPO, 'space/web/assets/js/shell/ai-panel.js'),
  vk: path.join(REPO, 'space/web/assets/js/shell/vk.js'),
  prefsWrite: path.join(REPO, 'space/web/assets/js/lib/prefs-write.js'),
  reader: path.join(REPO, 'space/web/assets/js/lib/ui-cookie-read.js'),
  layoutMode: path.join(REPO, 'space/web/assets/js/lib/layout-mode.js'),
  contract: path.join(REPO, 'tests/fixtures/ui-cookie-contract.json'),
  favicon: path.join(REPO, 'space/web/assets/js/shell/favicon.js'),
  faviconSvg: path.join(REPO, 'space/web/static/favicon.svg'),
};
export const READER_SRC = SRC.reader;
/** shell.css 里按这个顺序拼 input.css 的标记段 */
export const SHELL_REGIONS = ['topbar-frame', 'panel'];
/* 导航项以外外壳要用的图标（2026-11-04 P5-1）：顶栏（快捷面板滑块、AI 聊天）、快捷设置磁贴（深色 / 跟随系统 / 语言 / 锁定 / 恢复默认 / 分享）、AI 发送。
   都要是不含模板语法的完整内联 SVG（P4-2 删搜索层时 ai-search 随 nav.json 的 search 项一起删了） */
export const EXTRA_ICONS = ['tb-grid', 'tb-sliders', 'tb-chat', 'tb-moon', 'sun', 'tb-globe', 'lock', 'tb-undo', 'share', 'tb-send', 'tb-newchat', 'tb-history'];
const HEAD = (src) =>
  `/* 由 styrigx-space space/scripts/gen-shell.mjs 从 ${src} 生成，勿手改；子站用 atlas/scripts/<站>/sync-shell.mjs 同步。 */\n`;

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
    '/* 22 套七色调色板（1 背景色 + 6 前景撞色）：<html data-palette="<id>">（默认 dustyblue 不写），深色 <html class="dark">；自定义种子在运行时用 palette-scheme.js 的 rolesCss() 覆盖。 */\n' +
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
  return (
    JSON.stringify({ _generated: 'styrigx-space space/scripts/gen-shell.mjs ← space/web/data/shell-nav.json + icon.html + shell-wordmark.html；勿手改', ...nav, wordmark, icons }, null, 2) +
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

/** 顶栏 partial：原样复制；只能用参数（子站没有主站的 partial 和 data），不许 partial / site.Data / resources */
export function renderTopbar() {
  const src = readFileSync(SRC.topbar, 'utf8');
  const code = src.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '');
  if (/\{\{-?\s*partial(Cached)?\s/.test(code) || /site\.Data|hugo\.Data|resources\.|\.Site\b|\$\.Page\b/.test(code)) throw new Error('shell-topbar.html 只能用传进来的参数（不能调 partial / 读 site.Data / resources）');
  if (!/<header id="site-nav"/.test(src) || !/id="sgx-nav"/.test(src) || !/id="sgx-qp"/.test(src) || !/id="sgx-ai"/.test(src)) throw new Error('shell-topbar.html 缺 header#site-nav / #sgx-nav / #sgx-qp / #sgx-ai');
  return src;
}

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

/* 生成物里写的来源路径（下面 README、HEAD()、_generated、manifest 的 dir）按仓库根写全路径（space/web/…、space/scripts/…）。2026-11-06 分包时改成现路径，外壳版本号随之更新、三站副本重新同步。 */
const README = `# space/web/shared/shell（生成物，勿手改）

主站（styrigx-space）和子站（styrigx-blog、styrigx-daymark、styrigx-curio）共用的外壳：色彩角色、顶栏（全大椭圆）+ 快捷面板 + AI 窗口、原地搜索层、自定义主题色引擎、导航项、外观 cookie 读端与写端、标签页图标。

- 源头：\`space/web/data/palette-roles.json\`、\`space/web/assets/css/input.css\` 的 \`@shell:begin/end\` 段、\`space/web/assets/js/lib/palette-scheme.js\`、
  \`space/web/data/shell-nav.json\`、\`space/web/layouts/partials/icon.html\`、\`space/web/layouts/partials/shell-wordmark.html\`（抽屉头字标，进 nav.json 的 \`wordmark\`）。改源头后跑 \`node space/scripts/gen-shell.mjs\`；CI 用 \`--check\` 核对。
- 子站同步：在子站仓库跑 \`node space/scripts/sync-shell.mjs\`（默认 ref=main，可 \`--ref <分支或提交>\`），
  它按 \`manifest.json\` 从 raw.githubusercontent.com 拉这些文件、逐个校验 sha256，写进子站的标记段 / 供应商目录。
- 主题跨站：主站把外观写进 \`sgx-ui\` cookie（Domain=styrigx.com）：\`pal\` = 预设 id，\`accent\` = 当前种子 #rrggbb。
  子站：\`accent\` 等于该预设种子 → 只设 \`data-palette\`；不等 → 自定义色，用 \`palette-scheme.js\` 的 \`rolesCss(seed)\` 算整套角色。
  旧撞色 id \`x<id>\`（2026-10-23 PR-G 前）读端自动迁到 \`<id>\`，cookie 里旧版本的种子也认作预设。
- 调色板（2026-10-23 PR-G 七色）：22 套 = 1 背景色 + 6 前景撞色。子站只消费主站给的 token，不自己定义主题色；当前色板由主站决定。
  \`palettes.json\` 每套带 \`tokens.light\` / \`tokens.dark\`（Shell：bg-1..7、表面 / 容器、玻璃、遮罩；Semantic：主 / 辅 / 第三色族、选中、链接、边线、文字；
  外加 fg-1..6（-tint / -ink）、chart-1..6、tag-bg / tag-fg），和 \`tokens.css\` 里同名 \`--sgx-*\` 变量一样。怎么用见主站 \`docs/palette-usage.md\`。

## 子站读外观：ui-cookie-read.js（只读；写由 prefs-write.js 负责，见下）

经典脚本、ES5、无依赖，挂 \`window.SgxUI\`。\`<head>\` 里、样式表之后、任何内容之前，**原样内联**，紧跟一行调用：

\`\`\`html
<script>/* ui-cookie-read.js 原文（Hugo：resources.Get … | minify，.Content | safeJS） */</script>
<script>SgxUI.apply(document.documentElement, { onMiss: function (seed) { /* 异步加载 palette-scheme.js，算好 SgxUI.setRoles(seed, rolesCss(seed)) */ } });</script>
\`\`\`

- \`SgxUI.read()\` → 校验过的 \`{v, mode, pal, accent, fs, rm, mat, lang}\`；没有 / 乱码 / 版本不认识 → \`null\`。
- 语言跟随：\`read().lang\` 是主站用户明确选的 \`'zh'\` / \`'en'\`（跟随系统 = \`''\`）；非空且和当前页语言不同时，子站自己跳到另一种语言的同一页（\`apply()\` 不管语言）。
- \`SgxUI.apply(root, opts)\` → \`<html>\` 落成和主站一样：\`class="dark"\`、\`data-theme-mode\`、\`data-dark\`、\`font-size\` + \`data-font-size\`、
  \`data-palette\`（默认 dustyblue 不写）、自定义色时内联 \`--sgx-seed\` + \`<style id="sgx-accent-roles">\`（本站 localStorage \`sgx-shell-accent-css\` 缓存，首行「SCHEME_VER|#种子」）、
  \`class="reduced-motion"\` + \`data-reduced-motion\`。跟随系统时自动监听 \`prefers-color-scheme\`。cookie 坏了 = 默认 dustyblue + 跟随系统，不抛错、不跳转。
  \`opts.rolesCss\`：同步可用的引擎；\`opts.onMiss(seed)\`：没缓存时回调；\`opts.watch: false\`：不监听。
- 子站要的 CSS：\`tokens.css\`（22 套七色调色板 + tag / chart 派生 token + 别名层）+ \`shell.css\`（含字标 \`.wm-dot\` = \`--sgx-primary\`）。抽屉头用 \`nav.json\` 的 \`wordmark\` SVG。
- 读端不认 \`theme\` 别名和大写 accent（写端从不写）；自定义色的种子在内联 \`--sgx-seed\`（不再用 \`data-sgx-seed\`）。
  站点自己的样式钩子（如博客的 \`data-theme\` / \`color-scheme\`）用 \`apply()\` 的返回值 \`{mode, dark, pal, fs, rm, seed}\` 自己补。
- sync-shell 的 SITE.targets 加：\`ui-cookie-read.js\`（kind \`file\`）、\`ui-cookie-contract.json\`（kind \`json\`，原样）、
  \`favicon.js\`（kind \`file\`）、\`favicon.svg\`（要原样写进 \`space/web/static/\`：kind \`file\` 会在顶上加 /* */ 注释，SVG 不认，用 \`json\` 或加一个 raw 类型）。
- 标签页图标：\`favicon.svg\` 放站点根 \`/favicon.svg\`（\`<link rel="icon" type="image/svg+xml" href="/favicon.svg">\`），
  打包 \`favicon.js\`（ES 模块）后调 \`initFavicon()\`：色板 / 自定义色 / 深浅色变了就换成当前主题色。
- 契约测试：\`ui-cookie-contract.json\` 是主站写端真实写出的 cookie + 期望；子站单测对每个 case 断言 \`SgxUI.read(\'sgx-ui=\' + c.cookie)\` 等于 \`c.read\`、
  \`SgxUI.resolve(c.read, 系统深色)\` 等于 \`c.light/c.dark.resolve\`（apply 后 \`<html>\` 等于 \`.root\`）。sync-shell 拉新版本后跑一遍。
## 顶栏 + 导航面板 + 快捷面板 + AI 窗口（topbar.html / topbar.js / modal-sheet.js / ai.js / vk.js + shell.css topbar-frame、panel 段；2026-11-04 P5-1，P4-3 PR-4b 定稿，四个站一样）

\`topbar.html\` 是 Hugo partial（主站 partials/shell-topbar.html 原样），子站同步成 \`layouts/partials/sgx-shell-topbar.html\`，只用参数、不调别的 partial：

\`\`\`html
<header id="site-nav">
  <div class="sgx-topbar">                                   <!-- 一整条胶囊，材质在它身上 -->
    <a class="sgx-tb-logo" href="本站首页">字标（真 SVG，各宽度都完整）</a>
    <div class="sgx-tb-pill">页名胶囊 / 标签 / 分段（在空余区居中）</div>
    <div class="sgx-tb-acts">                                <!-- 紧凑、靠右；头像不在顶栏 -->
      <button class="sgx-tb-btn sgx-tb-grid" aria-controls="sgx-nav">九宫格</button>
      <button class="sgx-tb-btn sgx-tb-quick" aria-controls="sgx-qp">滑块</button>
      <button class="sgx-tb-btn sgx-tb-ai" aria-controls="sgx-ai">聊天</button>
    </div>
  </div>
</header>
<dialog id="sgx-nav">2×2 站点磁贴（nav.json items：图标 + 站名 + 副标题，当前站「开」态）</dialog>
<dialog id="sgx-qp">只有快捷设置一页：深色 / 跟随系统 / 分享本页 / 立即锁定 · 语言（行内展开单选）· 调色板 · 布局</dialog>
<dialog id="sgx-ai">头部 Gray AI · 新对话 · 历史 · 头像（账号页，主题色环）· 消息列表 · 输入框 · 「仅公开内容 · 联系我」</dialog>
\`\`\`
- 参数（dict）：\`isEn\`、\`home\`、\`center\`（HTML）、\`pillClass\`、\`headerClass\`、\`headerAttrs\`、\`nav\`（nav.json）、\`site\`（当前站 id）、\`icons\`（nav.json 的 icons）、
  \`wordmark\`、\`acct\`、\`avatar\`、\`langHref\`（另一种语言的同一页）、\`pal\`（[{id, zh, en, style}]，style = --pl-b1..7 / --pl-f1..6 / --pd-*）。
  快捷面板四站完全相同，没有按站开关的磁贴（PR-4b 起删了 \`tiles\` / \`layout\` 参数）。
- JS：\`import { mountTopbar } from './topbar.js'\`，把依赖传进去（这几个文件都不 import 任何东西）：
  \`mountTopbar({ modalSheet, prefs, ai: mountAiChat, share: mountShare, keyboard: onKeyboardHeight })\`（\`onKeyboardHeight\` 来自 \`vk.js\`：AI 窗口输入框聚焦时跟键盘，P4-3 PR-3）；prefs 用 \`prefs-write.js\` 的
  \`isDark / themeMode / setThemeMode / toggleFollowSystem / palette / setPalette / DEFAULT_PALETTE / hasAccent / langPref / layoutPref / layoutNarrow / setLayout\`，
  \`setLang: v => (setLangPref(v), '')\`（实际语言变了就去语言行的 data-href）。不传 \`onLock\` 时「立即锁定」点两下确认后 POST /api/lock-now 回锁屏。
- 三个窗口是非模态 \`<dialog>\`，从顶栏下方落下、互斥；系统返回 / Esc / 点遮罩关闭，焦点回到图标。
- AI：POST /api/ai（同源）→ SSE hits / delta / done；历史只在本地 \`sgx-ai-history\`（最多 50 条，不进云同步）。

## 子站外观写端（prefs-write.js；改写原「主站写、子站只读」，定案第 5 条）

四站共用一个写端：主站的 cookie 写法（syncUiCookie）就在这个文件里，子站快捷设置调它的 setter：写 localStorage（同源同一份）→ \`SgxUI.apply\` 重落 \`<html>\` → 写 \`sgx-ui\` cookie。
子站写入的外观在本设备生效（回主站即同步）；跨设备以账号云同步为准，云同步覆盖这些设置之前不承诺跨设备。上面「子站读外观」一节的读端照旧。

## 分享本页（share.js，快捷面板磁贴；PR-4b 起四站都有）

- JS：\`mountShare({ button: 磁贴 })\`（topbar.js 会对 \`[data-qp="share"]\` 调传进来的 mountShare）。
  POST https://styrigx.com/api/share（credentials: include；进门二值，不分角色）
  \`{action:'create', reuse:true, name:页面标题(24 字), to:当前页(去 lock/why/return/share), hours:24, session:43200}\`
  → 带临时会话的短链（服务端同页同档位还剩 ≥ 12 小时就复用）→ \`navigator.share\`；没有 / 被拒（不是取消）→ 复制 + toast「已复制分享链接」。
  生成中磁贴 \`aria-busy\` + \`.is-busy\`，再点不理；失败只 toast，不会把原地址当短链分享。
  服务端回 401 reauth（生成 / 复用短链要锁侧复验，P2-3）→ share.js 自带的最小复验步骤 \`lockReauthStep()\`（\`<dialog class="sgx-share-reauth">\`，
  只有锁屏通行密钥 / 解锁密码，设了哪个显示哪个；同源 POST /api/lock-reauth status、/api/lock-password、/api/lock-passkey）→ 通过后自动重试一次；取消 = 不分享。
  toast 是 \`.sgx-share-toast\`（share.js 自己建）；复验弹层样式 \`.sgx-share-reauth*\` 在 shell.css 的 topbar-frame 段。
- 尺寸体系（2026-10-23）：\`--sgx-page-m\`、\`--sgx-tb-btn\`（顶栏高 52 → 56）、\`--sgx-tb-gap\`、\`--sgx-content-max\`（外壳框最宽）、
  \`--sgx-shell-w\` = min(100% − 2 × 页边距, 最宽)。子站自己的页面外框用 \`width: var(--sgx-shell-w); margin: 0 auto\`（顶栏不再定内容栏，P4-3 PR-4b）。
- 布局模式（P4-3 PR-4b，Gray 2026-11-07）：只有手机 \`phone\` / 桌面 \`desktop\` 两种（自动里视口 < 720 CSS px 落手机，这是唯一的像素线）。唯一规则在 \`layout-mode.js\` 的 \`__sgxLayout()\`：
  偏好 \`sgx-layout\` = phone / auto / desktop（旧值 mobile → phone、dex / pc → desktop），自动 = \`navigator.userAgentData.mobile\`（没有就看 UA 的 Mobi / Android…Mobile / iPhone）；
  \`?layout=auto\` 逃生口。**四站 \`<head>\` 原样内联这一份**（Hugo：resources.Get … | minify，.Content | safeJS），结果写进 \`<html data-sgx-layout="phone|desktop">\`，
  各站自己的 layout-* 类也按它（tests/space/ui/shell/topbar-length.test.mjs 核对四站内联的是同一份、结果一样）。**子站不许再自己改 \`--sgx-content-max\` / 顶栏宽。**
- 顶栏宽 \`--sgx-tb-w\`（shell.css）：手机 = min(100% − 2 × 16px, 640px)；桌面 = min(960px, 100% − 2 × 24px)，居中（两侧取安全区和 16 / 24 的大者）。
  按 100%（固定定位包含块 = 不含滚动条的窗口宽）算，不用 100vw；\`:root { overflow-x: clip }\` 横向不滚。窗口 < 380px 藏掉页名胶囊（唯一阈值）。
  自动模式下算出桌面但视口 < 720 CSS px → 手机；matchMedia 听 720 线和横竖屏重算，不刷新。

`;

/** @returns {Record<string,string>} 文件名 → 内容 */
export function renderAll() {
  const data = JSON.parse(readFileSync(SRC.roles, 'utf8'));
  const schemeSrc = readFileSync(SRC.scheme, 'utf8');
  const reader = renderReader(data, schemeSrc);
  /* 契约文件缺了不能静默写成空串：--check 会拿空串和空串比，假通过 */
  if (!existsSync(SRC.contract)) {
    throw new Error('gen-shell: missing ' + path.relative(REPO, SRC.contract) + ' (run space/scripts/gen-ui-cookie-contract.mjs first)');
  }
  const files = {
    'tokens.css': renderTokens(data),
    'shell.css': renderShell(),
    'palette-scheme.js': schemeSrc,
    'share.js': renderShare(),
    'topbar.html': renderTopbar(),
    'topbar.js': renderStandalone(SRC.topbarJs, 'topbar-panel.js', 'mountTopbar'),
    'modal-sheet.js': renderStandalone(SRC.modalSheet, 'modal-sheet.js', 'modalSheet'),
    'ai.js': renderStandalone(SRC.ai, 'ai-panel.js', 'mountAiChat'),
    'vk.js': renderStandalone(SRC.vk, 'vk.js', 'onKeyboardHeight'),
    'prefs-write.js': renderStandalone(SRC.prefsWrite, 'prefs-write.js', 'syncUiCookie'),
    'nav.json': renderNav(),
    'palettes.json': renderPalettes(data, schemeSrc),
    'ui-cookie-read.js': reader,
    'layout-mode.js': readFileSync(SRC.layoutMode, 'utf8'),
    'ui-cookie-contract.json': readFileSync(SRC.contract, 'utf8'),
    'favicon.js': readFileSync(SRC.favicon, 'utf8'),
    'favicon.svg': readFileSync(SRC.faviconSvg, 'utf8'),
    'README.md': README,
  };
  const manifest = {
    _generated: 'styrigx-space space/scripts/gen-shell.mjs；勿手改',
    source: 'styrigx/styrigx-space',
    dir: 'space/web/shared/shell',
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])),
  };
  manifest.version = sha(JSON.stringify(manifest.files)).slice(0, 12);
  manifest.rulesVersion = RULES_VERSION;
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
    if (readFileSync(SRC.reader, 'utf8') !== files['ui-cookie-read.js']) bad.push('space/web/assets/js/lib/ui-cookie-read.js 的 @ui-cookie-presets 段');
    const extra = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => !(f in files)) : [];
    if (bad.length || extra.length) {
      console.error('space/web/shared/shell 和源头不一致：' + [...bad, ...extra.map((f) => f + '（多余）')].join('、') + '；运行 node space/scripts/gen-shell.mjs');
      process.exit(1);
    }
    console.log('shared shell in sync:', JSON.parse(files['manifest.json']).version);
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    if (readFileSync(SRC.reader, 'utf8') !== files['ui-cookie-read.js']) writeFileSync(SRC.reader, files['ui-cookie-read.js']);
    for (const [k, v] of Object.entries(files)) writeFileSync(path.join(OUT_DIR, k), v);
    console.log('space/web/shared/shell regenerated:', Object.keys(files).join(', '), JSON.parse(files['manifest.json']).version);
  }
}
