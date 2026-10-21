#!/usr/bin/env node
/**
 * 共享外壳（shared shell）：主站是唯一来源，子站（blog / daymark）用各自仓库的 scripts/sync-shell.mjs 一条命令同步。
 *
 * 生成 web/shared/shell/（勿手改，改源头后重跑本脚本）：
 *   tokens.css         33 套预设（单色 17 + 撞色 16）的色彩角色（web/data/palette-roles.json，和 input.css 里 @gen-palettes 同一个函数）+ 组件别名层
 *   shell.css          顶栏（九宫格圆 / 只有页名的长条 / 右圆）、导航抽屉（含抽屉头头像）、原地搜索层：input.css 里 /* @shell:begin <名> *\/ … /* @shell:end <名> *\/ 之间的原文
 *   palette-scheme.js  自定义 #rrggbb 种子 → 整套角色的引擎（web/assets/js/lib/palette-scheme.js 原样复制）
 *   search.js          原地搜索层（web/assets/js/shell/search-layer.js 原样复制；不 import 任何东西，样式在 shell.css 的 search 段）
 *   nav.json           导航抽屉的项（web/data/shell-nav.json）+ 用到的图标 SVG（web/layouts/partials/icon.html）
 *                      + 抽屉头字标 SVG wordmark（web/layouts/partials/shell-wordmark.html；brand 文字照旧保留）
 *   palettes.json      预设 id / 名字 / 种子 + 默认值 + 子站自定义色缓存版本号
 *   ui-cookie-read.js  sgx-ui cookie 只读解析器（web/assets/js/lib/ui-cookie-read.js 原样复制；经典脚本 ES5，子站内联进 <head>）
 *                      源文件里 @ui-cookie-presets 段（预设 id → 种子 + 引擎版本）由本脚本按 palette-roles.json 重写
 *   ui-cookie-contract.json  写端真实产出的 cookie + 读端期望（tests/fixtures/ui-cookie-contract.json 原样复制，gen-ui-cookie-contract.mjs 生成）
 *   favicon.js / favicon.svg  标签页图标跟主题色（web/assets/js/shell/favicon.js、web/static/favicon.svg 原样复制）
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
  wordmark: path.join(REPO, 'web/layouts/partials/shell-wordmark.html'),
  search: path.join(REPO, 'web/assets/js/shell/search-layer.js'),
  reader: path.join(REPO, 'web/assets/js/lib/ui-cookie-read.js'),
  contract: path.join(REPO, 'tests/fixtures/ui-cookie-contract.json'),
  favicon: path.join(REPO, 'web/assets/js/shell/favicon.js'),
  faviconSvg: path.join(REPO, 'web/static/favicon.svg'),
};
export const READER_SRC = SRC.reader;
/** shell.css 里按这个顺序拼 input.css 的标记段 */
export const SHELL_REGIONS = ['topbar-frame', 'drawer', 'search'];
/* 抽屉项以外外壳要用的图标：九宫格（顶栏左圆）、AI 搜索（抽屉底栏钉住的搜索框长条） */
const EXTRA_ICONS = ['apps-grid', 'ai-search'];
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

/** 抽屉头字标（2026-10-21）：partials/shell-wordmark.html 是单行内联 SVG（不含模板语法），子站把它放进 .sgx-drawer-brand 代替 brand 文字 */
export function readWordmark() {
  const svg = readFileSync(SRC.wordmark, 'utf8').trim();
  if (!/^<svg class="sgx-wordmark"[^>]* role="img" aria-label="Styrigx">[\s\S]*<\/svg>$/.test(svg) || svg.includes('\n')) throw new Error('shell-wordmark.html 必须是单行 <svg class="sgx-wordmark" … role="img" aria-label="Styrigx">');
  if (/\{\{/.test(svg)) throw new Error('shell-wordmark.html 含模板语法，不能共享');
  if (!/class="wm-letters"/.test(svg) || !/class="wm-dot"/.test(svg)) throw new Error('字标缺 wm-letters / wm-dot');
  return svg;
}

const PRESETS_BEGIN = '  /* @ui-cookie-presets:begin（scripts/gen-shell.mjs 按 web/data/palette-roles.json + palette-scheme.js 生成，勿手改） */';
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
  return (
    HEAD('web/data/palette-roles.json') +
    '/* 33 套预设（单色 + 撞色）：<html data-palette="<id>">（默认 lake 不写），深色 <html class="dark">；自定义种子在运行时用 palette-scheme.js 的 rolesCss() 覆盖。 */\n' +
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
  const names = [...new Set([...nav.items, ...(nav.footer || [])].map((i) => i.icon).concat(EXTRA_ICONS))];
  const icons = {};
  for (const n of names) icons[n] = extractIcon(html, n);
  const wordmark = readWordmark();
  return (
    JSON.stringify({ _generated: 'styrigx-space scripts/gen-shell.mjs ← web/data/shell-nav.json + icon.html + shell-wordmark.html；勿手改', ...nav, wordmark, icons }, null, 2) +
    '\n'
  );
}

/** 原地搜索层：原样复制（必须自成一体：不能 import，子站直接当 ES module 用） */
export function renderSearch() {
  const src = readFileSync(SRC.search, 'utf8');
  if (/^\s*import\s/m.test(src) || /\bimport\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))) throw new Error('search-layer.js 不能 import 任何东西（子站原样复制）');
  if (!/^export function mountSearch\(/m.test(src)) throw new Error('search-layer.js 必须导出 mountSearch');
  return src;
}

function renderPalettes(data, schemeSrc) {
  /* 顺序 = palette-roles.json（= palette-scheme.js PRESETS：单色组在前、撞色组在后）；2026-10-21 起每项多一个 group（mono / clash），旧字段不变 */
  const ids = Object.keys(data.presets);
  return (
    JSON.stringify(
      {
        _generated: 'styrigx-space scripts/gen-shell.mjs ← web/data/palette-roles.json；勿手改',
        default: 'lake',
        /* 子站缓存自定义色角色时用的版本号：引擎一变就变，旧缓存自动作废 */
        schemeVersion: sha(schemeSrc).slice(0, 12),
        presets: ids.map((id) => ({ id, zh: data.presets[id].zh, en: data.presets[id].en, seed: data.presets[id].seed, group: data.presets[id].group || 'mono' })),
      },
      null,
      2,
    ) + '\n'
  );
}

const README = `# web/shared/shell（生成物，勿手改）

主站（styrigx-space）和子站（styrigx-blog、styrigx-daymark、styrigx-curio）共用的外壳：色彩角色、顶栏材质、导航抽屉、原地搜索层、自定义主题色引擎、抽屉项、外观 cookie 读端、标签页图标。

- 源头：\`web/data/palette-roles.json\`、\`web/assets/css/input.css\` 的 \`@shell:begin/end\` 段、\`web/assets/js/lib/palette-scheme.js\`、
  \`web/data/shell-nav.json\`、\`web/layouts/partials/icon.html\`、\`web/layouts/partials/shell-wordmark.html\`（抽屉头字标，进 nav.json 的 \`wordmark\`）。改源头后跑 \`node scripts/gen-shell.mjs\`；CI 用 \`--check\` 核对。
- 子站同步：在子站仓库跑 \`node scripts/sync-shell.mjs\`（默认 ref=main，可 \`--ref <分支或提交>\`），
  它按 \`manifest.json\` 从 raw.githubusercontent.com 拉这些文件、逐个校验 sha256，写进子站的标记段 / 供应商目录。
- 主题跨站：主站把外观写进 \`sgx-ui\` cookie（Domain=styrigx.com）：\`pal\` = 预设 id，\`accent\` = 当前种子 #rrggbb。
  子站：\`accent\` 等于该预设种子 → 只设 \`data-palette\`；不等 → 自定义色，用 \`palette-scheme.js\` 的 \`rolesCss(seed)\` 算整套角色。

## 子站读外观：ui-cookie-read.js（只读，永远不写 sgx-ui）

经典脚本、ES5、无依赖，挂 \`window.SgxUI\`。\`<head>\` 里、样式表之后、任何内容之前，**原样内联**，紧跟一行调用：

\`\`\`html
<script>/* ui-cookie-read.js 原文（Hugo：resources.Get … | minify，.Content | safeJS） */</script>
<script>SgxUI.apply(document.documentElement, { onMiss: function (seed) { /* 异步加载 palette-scheme.js，算好 SgxUI.setRoles(seed, rolesCss(seed)) */ } });</script>
\`\`\`

- \`SgxUI.read()\` → 校验过的 \`{v, mode, pal, accent, fs, rm, mat, tz1, tz2, h12, clock, wx, unit, loc, city, precise}\`；没有 / 乱码 / 版本不认识 → \`null\`。
- \`SgxUI.apply(root, opts)\` → \`<html>\` 落成和主站一样：\`class="dark"\`、\`data-theme-mode\`、\`data-dark\`、\`font-size\` + \`data-font-size\`、
  \`data-palette\`（lake 不写）、自定义色时内联 \`--sgx-seed\` + \`<style id="sgx-accent-roles">\`（本站 localStorage \`sgx-shell-accent-css\` 缓存，首行「SCHEME_VER|#种子」）、
  \`class="reduced-motion"\` + \`data-reduced-motion\`。跟随系统时自动监听 \`prefers-color-scheme\`。cookie 坏了 = lake + 跟随系统，不抛错、不跳转。
  \`opts.rolesCss\`：同步可用的引擎；\`opts.onMiss(seed)\`：没缓存时回调；\`opts.watch: false\`：不监听。
- 子站要的 CSS：\`tokens.css\`（33 套预设 + 别名层）+ \`shell.css\`（含字标 \`.wm-dot\` = \`--sgx-primary\`）。抽屉头用 \`nav.json\` 的 \`wordmark\` SVG。
- 读端不认 \`theme\` 别名和大写 accent（写端从不写）；自定义色的种子在内联 \`--sgx-seed\`（不再用 \`data-sgx-seed\`）。
  站点自己的样式钩子（如博客的 \`data-theme\` / \`color-scheme\`）用 \`apply()\` 的返回值 \`{mode, dark, pal, fs, rm, seed}\` 自己补。
- sync-shell 的 SITE.targets 加：\`ui-cookie-read.js\`（kind \`file\`）、\`ui-cookie-contract.json\`（kind \`json\`，原样）、
  \`favicon.js\`（kind \`file\`）、\`favicon.svg\`（要原样写进 \`web/static/\`：kind \`file\` 会在顶上加 /* */ 注释，SVG 不认，用 \`json\` 或加一个 raw 类型）。
- 标签页图标：\`favicon.svg\` 放站点根 \`/favicon.svg\`（\`<link rel="icon" type="image/svg+xml" href="/favicon.svg">\`），
  打包 \`favicon.js\`（ES 模块）后调 \`initFavicon()\`：色板 / 自定义色 / 深浅色变了就换成当前主题色。
- 契约测试：\`ui-cookie-contract.json\` 是主站写端真实写出的 cookie + 期望；子站单测对每个 case 断言 \`SgxUI.read(\'sgx-ui=\' + c.cookie)\` 等于 \`c.read\`、
  \`SgxUI.resolve(c.read, 系统深色)\` 等于 \`c.light/c.dark.resolve\`（apply 后 \`<html>\` 等于 \`.root\`）。sync-shell 拉新版本后跑一遍。
## 顶栏 + 抽屉头头像（2026-10-22 v8，三个站一样）

\`\`\`html
<div class="sgx-topbar">
  <button class="sgx-tb-nav" aria-controls="sgx-drawer">九宫格图标</button>
  <div class="sgx-tb-pill"><span class="sgx-tb-title">页名</span></div>   <!-- 只有页名，不放图标 -->
  <button class="sgx-tb-end …">本站自己的图标</button>                     <!-- 唯一按站点自定义的位置 -->
</div>
\`\`\`
- 右圆 \`.sgx-tb-end\`：52px 圆、材质 / 悬停 / 按下 / 焦点框都在 shell.css；里面放一个 22px 图标。主站 = 快捷面板（\`.sgx-tb-end.sgx-tb-quick\`，主站 partials/topbar-end.html）；
  子站换成自己的按钮或链接（\`<a class="sgx-tb-end" …>\` 也行），不要留空（两侧圆要对称）。
- 头像不在顶栏了：抽屉头 = 字标 + 右边的头像圆（\`<a class="sgx-drawer-me" href="{nav.me.href}"><img src="{nav.me.avatar}" alt=""></a>\`，52px，垂直居中）。
  主站链到账号页；子站用 nav.json 的 \`me.href\`（默认 https://styrigx.com/）和 \`me.avatar\`，aria-label 用 \`me.zh / me.en\`。
- 旧的 \`.sgx-tb-me\`（顶栏头像圆）、\`.sgx-tb-ic\`（长条里的图标）样式已从共享外壳删掉，子站同步时一起换新结构。

## 搜索层（search.js + shell.css 的 search 段）

点导航抽屉底栏的搜索框 → 抽屉原地淡掉，搜索框变形成屏幕底部的搜索栏（药丸 + ✕ 圆，贴键盘），上面是盖住当前页的磨砂结果层
（空输入时背景是放大镜 +「聚合搜索」；输入后是站内结果 / 「用 <引擎> 搜索」；不记搜索历史）。顶栏不动。✕ / 系统返回 / Esc 关闭。不跳页、最多占一条历史。

子站接入（文件原样复制，不改）：
1. \`node scripts/sync-shell.mjs\` 同步后，\`search.js\` 放进子站的 JS（建议单独打包、懒加载），\`shell.css\` 照旧整份引入（含 search 段）。
2. 抽屉底栏的搜索框保持 \`<a class="sgx-drawer-search" href="https://styrigx.com/search/">\`（没 JS 时进主站搜索）。
3. 打开抽屉时（或按下九宫格 / 搜索框的 pointerdown）\`import()\` search.js，拿到后 \`const s = mountSearch(cfg)\`（每页一次）。
4. 搜索框 click 里 **同步** 调用（安卓只在用户手势里同步 focus 才弹键盘）：
   \`e.preventDefault(); s.open({ from: a, ghost: drawerDialog, handoff: () => { 同步关掉抽屉 <dialog>（不要 history.back）; return 抽屉是否 push 过历史哨兵; } })\`
   handoff 返回 true 时搜索层把那条哨兵改成自己的（replaceState），不再新增历史。
5. 可选：页面带 \`?q=\` 时 \`s.open({ q, focus: true })\`（主站的 /search/?q= 和 opensearch 就是这样进来的）。

\`mountSearch(cfg)\` 配置（都可省）：
| 键 | 默认 | 说明 |
|---|---|---|
| lang | 按 \`<html lang>\` | 'zh' / 'en' 文案 |
| index | null | 站内索引地址（files-index.json 格式 \`{items:[{type,lang,title,subtitle,url}]}\`）；null = 只有引擎搜索 |
| types | [] | 要列出的索引类型和分组名，如 \`[{type:'post',zh:'博客',en:'Blog'}]\` |
| engineKey / engine | sgx-search-engine / — | 引擎设置（google / bing / duckduckgo / yahoo / ecosia）；engine() 优先 |
| navigate | location.href = url | 打开同源结果（先关层、退掉哨兵再调用）；跨源结果新标签打开 |
| strings | — | 覆盖文案 |
| root | document.body | 挂载点 |

返回 \`{ open(opts), close(after?), isOpen(), input, layer, bar }\`。open(opts)：from（变形起点元素）、ghost（正在关的抽屉 <dialog>）、handoff、q、focus（默认 true）。
回车：方向键选中的行 → 打开；标题和输入完全一样的站内结果 → 打开；像网址 → 新标签 https://；否则用引擎搜（新标签）。
`;

/** @returns {Record<string,string>} 文件名 → 内容 */
export function renderAll() {
  const data = JSON.parse(readFileSync(SRC.roles, 'utf8'));
  const schemeSrc = readFileSync(SRC.scheme, 'utf8');
  const reader = renderReader(data, schemeSrc);
  const files = {
    'tokens.css': renderTokens(data),
    'shell.css': renderShell(),
    'palette-scheme.js': schemeSrc,
    'search.js': renderSearch(),
    'nav.json': renderNav(),
    'palettes.json': renderPalettes(data, schemeSrc),
    'ui-cookie-read.js': reader,
    'ui-cookie-contract.json': existsSync(SRC.contract) ? readFileSync(SRC.contract, 'utf8') : '',
    'favicon.js': readFileSync(SRC.favicon, 'utf8'),
    'favicon.svg': readFileSync(SRC.faviconSvg, 'utf8'),
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
    if (readFileSync(SRC.reader, 'utf8') !== files['ui-cookie-read.js']) bad.push('web/assets/js/lib/ui-cookie-read.js 的 @ui-cookie-presets 段');
    const extra = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => !(f in files)) : [];
    if (bad.length || extra.length) {
      console.error('web/shared/shell 和源头不一致：' + [...bad, ...extra.map((f) => f + '（多余）')].join('、') + '；运行 node scripts/gen-shell.mjs');
      process.exit(1);
    }
    console.log('shared shell in sync:', JSON.parse(files['manifest.json']).version);
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    if (readFileSync(SRC.reader, 'utf8') !== files['ui-cookie-read.js']) writeFileSync(SRC.reader, files['ui-cookie-read.js']);
    for (const [k, v] of Object.entries(files)) writeFileSync(path.join(OUT_DIR, k), v);
    console.log('web/shared/shell regenerated:', Object.keys(files).join(', '), JSON.parse(files['manifest.json']).version);
  }
}
