// 页面模板（space/web/layouts/daymark）：沉浸式 app 顶栏、三页签、没有搜索 / 快捷面板 / 标签筛选、抽屉只有四个应用。
// 只读模板源码，不用构建；构建后的行为在手机 E2E（tests/daymark/e2e）。
// 运行：node --test tests/daymark/layout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strings } from '../fixtures/strings.mjs';
import yaml from 'js-yaml';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const base = read('space/web/layouts/daymark/baseof.html');
const index = read('space/web/layouts/daymark/section.html');
const css = read('space/web/assets/daymark/css/input.css');

test('顶栏（2026-11-04 P5-1，四站同一个）：共享外壳 shell-topbar.html；中间 = 页名胶囊（首页 = 站名）；右边九宫格 · 快捷设置 · AI（PR-4b，头像在 AI 窗口头部）；没有抽屉、右圆分享', () => {
  assert.match(base, /\{\{ partial "shell-topbar\.html" \(dict\n/);
  assert.match(base, /"site" "daymark"/);
  /* P4-3 PR-4b 定稿：页名胶囊只显示页名——首页 = 站名（data-sgx-titles = [站名, 后两个分区名]，脚本按 hash 换），其他页（404）= 页名；顶栏没有分段滑块 */
  assert.match(base, /\{\{ if \$isHome \}\}\n\{\{ \$titles := slice \(\$tr\.site\.name\) \(\$tr\.baseof\.trove\) \(\$tr\.baseof\.flavors\) \}\}/);
  { const en = strings('daymark', 'en'); const zh = strings('daymark', 'zh');
    assert.deepEqual([en.site.name, en.baseof.trove, en.baseof.flavors], ['Daymark', 'Trove', 'Flavors']);
    assert.deepEqual([zh.site.name, zh.baseof.trove, zh.baseof.flavors], ['日刻', '拾录', '百味']); }
  assert.match(base, /<span class=\\"sgx-tb-title\\" data-sgx-titles=\\"%s\\">%s<\/span>/);
  assert.match(base, /\{\{ else \}\}\n\{\{ \$center = printf "<span class=\\"sgx-tb-title\\">%s<\/span>" \(htmlEscape \$pageName\) \}\}/);
  assert.doesNotMatch(base, /sgx-seg|data-dm-seg|role=\\"tab/);
  /* 九宫格、导航抽屉、右圆分享和它们的脚本都删了（标记在共享外壳，本站模板里不再手写顶栏） */
  assert.doesNotMatch(base, /sgx-tb-nav|sgx-drawer|sgx-tb-end|sgx-tb-share|<header|apps-grid|sgx-tb-end-group|sgx-tb-gbtn|guestbook/);
  const code = base.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, ''); /* 去掉模板注释（注释里会提到被取代的旧文件） */
  assert.doesNotMatch(code, /share-host\.js|js\/topbar\.js|search-host\.js|shell-nav-href/);
  assert.equal(existsSync(path.join(REPO, 'space/web/assets/daymark/js/sgx/share-host.js')), false);
  assert.equal(existsSync(path.join(REPO, 'space/web/assets/daymark/js/topbar.js')), false);
  assert.equal(existsSync(path.join(REPO, 'space/web/layouts/partials/daymark/shell-nav-href.html')), false);
  assert.match(base, /resources\.Get "daymark\/js\/sgx\/topbar-host\.js" \| js\.Build/);
  /* P4-3 PR-4b：快捷面板四站同一套（分享本页、立即锁定、布局都有），不再按站传 tiles */
  assert.doesNotMatch(base, /"tiles" /);
  const host = read('space/web/assets/daymark/js/sgx/topbar-host.js');
  /* 合站：直接引主站的共享外壳源文件（没有 js/sgx/shell/ 副本） */
  for (const m of ['../../../js/shell/topbar-panel.js', '../../../js/shell/modal-sheet.js', '../../../js/shell/ai-panel.js', '../../../js/shell/vk.js', '../../../js/lib/prefs-write.js']) {
    assert.match(host, new RegExp("from '" + m.replace(/[.\/]/g, '\\$&') + "'"), m);
  }
  assert.doesNotMatch(host, /share-button|mountShare/, 'v6 P4：分享本页磁贴拿掉');
});

test('没有搜索；快捷面板只来自共享外壳（本站不自己写）；首页长条不放页名（页名只在 404）；也没有标签筛选条', () => {
  const code = base.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, '');
  for (const s of [code, index]) {
    assert.doesNotMatch(s, /sgx-tb-search|bk-cap|type="search"|role="search"/);
  }
  /* 2026-11-04 P5-1：快捷面板（#sgx-qp）只在共享外壳 partial 里，本站模板 / 首页不手写 */
  assert.doesNotMatch(code, /sgx-qp|sgx-tb-quick/);
  assert.doesNotMatch(index, /sgx-qp|sgx-tb-quick/);
  assert.doesNotMatch(index, /sgx-tb-title/);
  assert.doesNotMatch(index, /sgx-entries|sgx-segtabs/, '平铺入口 / 段式标签退役（对齐 PR-C2）');
  assert.match(index, /<a href="#\{\{ \$w \}\}">/, '窗标题进拾录 / 百味');
  assert.doesNotMatch(index, /id="dm-tags"/);
  assert.equal(existsSync(path.join(REPO, 'space/web/layouts/partials/daymark/sgx-qp.html')), false);
  assert.equal(existsSync(path.join(REPO, 'space/web/assets/daymark/js/sgx/shell/capsule-kb.js')), false);
  /* 快捷面板样式只在 @sgx-shell 同步段里（共享外壳 shell.css），本站自己的段不写 */
  const own = css.slice(css.indexOf('@import "../../css/shell/shell.css";'));
  assert.ok(css.indexOf('@import "../../css/shell/shell.css";') > 0);
  assert.doesNotMatch(css, /\.bk-cap/);
  assert.doesNotMatch(own, /\.sgx-qp/);
});

test('没有版权页脚（© / Powered by），样式也删干净', () => {
  assert.doesNotMatch(base, /<footer|©|Powered by/);
  assert.doesNotMatch(css.slice(css.indexOf('@import "../../css/shell/shell.css";')), /(^|[\s,}])footer\b|sgx-powered|sgx-tb-me/);
});

test('留言板撤了（2026-10-24）：没有 /guestbook/ 页面、模板、脚本、Giscus 配置和样式', async () => {
  const { existsSync } = await import('node:fs');
  for (const f of ['space/web/layouts/daymark/guestbook.html', 'space/web/content/daymark/guestbook.md', 'space/web/content/daymark/en/guestbook.md', 'space/web/assets/daymark/js/guestbook.js']) {
    assert.equal(existsSync(new URL('../../' + f, import.meta.url)), false, f);
  }
  assert.doesNotMatch(read('space/web/hugo.yaml'), /guestbook|giscus/i);
  assert.doesNotMatch(css.slice(css.indexOf('@import "../../css/shell/shell.css";')), /dm-gb-|giscus|guestbook/);
});

test('导航：九宫格导航面板（PR-4b；原快捷面板第 1 页）用主站共享外壳的 nav.json（顶栏 v3：主页 / 博客 / 奇趣 / 日刻 / 旷野），模板不写死项；日刻是当前项；主站项走 https://styrigx.com', () => {
  const nav = JSON.parse(readFileSync(path.join(REPO, 'space/web/data/shell/nav.json'), 'utf8'));
  /* 语言包化（2026-11-07）：nav.json 只有 id / 图标 / 地址，站名在外壳字符串表（sync-shell 同步到 data/sgx-shell-i18n/<语言>.yaml） */
  const trZh = /** @type {any} */ (yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/zh.yaml'), 'utf8')));
  assert.deepEqual(nav.items.map((i) => trZh.nav[i.id].title), ['主页', '博客', '奇趣', '日刻', '旷野']); /* 顶栏 v3 NAVIGATE 01–05 */
  assert.deepEqual(nav.footer, []);
  assert.equal(nav.me.href, 'https://styrigx.com/account/');
  assert.match(base, /\{\{ \$shellNav := site\.Data\.shell\.nav \}\}/); /* 合站：直接读主站 data/shell/nav.json，没有副本 */
  assert.match(base, /"nav" \$shellNav\n/);
  assert.match(base, /"mainOrigin" "https:\/\/styrigx\.com"/);
  /* 项、页脚、当前项高亮都在共享外壳 partial 里（range .nav.items / with .nav.footer / eq .id $.site） */
  const tb = read('space/web/layouts/partials/shell-topbar.html');
  assert.match(tb, /range \.nav\.items/);
  assert.match(tb, /if eq \.id \$\.site \}\} aria-current="page"/);
  /* 导航页不放搜索框（定案第 2 条） */
  assert.doesNotMatch(tb, /type="search"|role="search"|sgx-drawer-search|nav\.search/);
  assert.doesNotMatch(base, /主页|书库/);
});

test('首页三块面板 + 记一句弹层的各个部件都在；余响是稿的居中一屏（命令行 · 日期行 · 引句 · 命令链 · 13 格日期条 · 三窗 · 前后日卡）', () => {
  for (const id of ['dm-pane-echo', 'dm-pane-trove', 'dm-pane-flavors', 'dm-draw', 'dm-set-today', 'dm-back-today', 'dm-fab', 'dm-signin',
    'dm-cmd-day', 'dm-echo-day', 'dm-echo-body', 'dm-dcal', 'dm-nx',
    'dm-cols', 'dm-authors', 'dm-fl-back', 'ed-preview', 'f-text', 'f-trans-toggle', 'f-author-ac', 'f-author-recent',
    'f-stype', 'f-source-ac', 'f-cols', 'f-col-new-row', 'f-tagbox', 'f-tag-sugg', 'f-note', 'f-public', 'edit-del']) {
    assert.match(index, new RegExp('id="' + id + '"'), id);
  }
  for (const w of ['echo', 'trove', 'flavors']) assert.match(index, /id="dm-w-\{\{ \$w \}\}"/) && assert.match(index, /id="dm-n-\{\{ \$w \}\}"/);
  assert.match(index, /range \$w := slice "echo" "trove" "flavors"/, '三窗顺序 余响 / 拾录 / 百味');
  assert.match(index, /<section class="sgx-term sgx-term--static dm-win"/);
  assert.match(index, /<span class="sgx-cmd-k" translate="no">shuf -n1 ↻<\/span><i>\{\{ \$tr\.index\.drawAnother \}\}<\/i>/);
  assert.match(index, /<span class="sgx-cmd-k" translate="no">set today<\/span>/);
  assert.match(index, /<span class="sgx-cmd-k" translate="no">touch trove\/ \+<\/span><i>\{\{ \$tr\.index\.saveALine \}\}<\/i>/);
  /* 旧形式删除：右上分享图标、实心 / 描边按钮组、浮动按钮、页底提示、段式标签 */
  assert.doesNotMatch(index, /id="dm-share"|dm-btn|class="dm-fab|dm-echo-actions|sgx-segtabs/);
  assert.doesNotMatch(css, /\.dm-share|\.dm-btn\b|\.dm-fab|\.dm-echo-actions/);
  assert.match(css, /\.dm-dc \{[^}]*width: 30px; height: 38px;[^}]*border-radius: 7px;/, '日期格 30×38 圆角 7');
  assert.match(css, /\.dm-dc\.is-today \{ border-color: var\(--sgx-primary\);/);
  assert.match(css, /:root\[data-sgx-layout="desktop"\] \.dm-dcol \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /:root\[data-sgx-layout="desktop"\] \.dm-echo-body \.dm-text \{ font-size: 34px; \}/);
  assert.match(css, /\.dm-echo-body \.dm-text \{[^}]*font-size: 24px;/);
  assert.match(css, /\.dm-today \{ max-width: 720px;/);
  /* 百味只按作者自动分组：没有出处 / 标签分组 */
  assert.doesNotMatch(index, /dm-sources|dm-tags-sec|意境/);
});

test('外观和语言跟主站：baseof 在样式前内联 ui-inherit-run', () => {
  assert.ok(base.indexOf('ui-inherit-run.js') < base.indexOf('css/main.css'));
});

test('robots.txt 只在图志根（root/robots.txt，Disallow: /）：本站不生成（Hugo 内置 robots 模板关掉），space/web/static/daymark 里也不放', () => {
  /* 合站后只有一份 hugo.yaml（space/web/hugo.yaml），robots.txt 只出在根上：本站没有自己的 robots 模板 */
  assert.equal(existsSync(path.join(REPO, 'space/web/layouts/daymark/robots.txt')), false);
  assert.equal(existsSync(path.join(REPO, 'space/web/static/daymark/robots.txt')), false);
  assert.match(read('space/web/static/robots.txt'), /^User-agent: \*\nDisallow: \/$/m);
});

test('head 内联脚本和自定义色引擎不打包整份 palettes.json（预设表在共享读端里，引擎版本用读端的 SCHEME_VER）', () => {
  for (const f of ['space/web/assets/daymark/js/sgx/ui-inherit-run.js', 'space/web/assets/daymark/js/sgx/shell-accent.js', 'space/web/assets/daymark/js/sgx/topbar-host.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /^import .*palettes\.json/m, f);
    assert.doesNotMatch(src, /@params/, f);
  }
  /* 2026-11-04 P5-1：快捷设置页的调色板色块在构建时从 palettes.json 算出 CSS 变量（只进 style 属性），
     不进 <head>、不进任何 <script>，也不整份输出（不 jsonify） */
  const head = base.slice(0, base.indexOf('</head>'));
  assert.doesNotMatch(head, /palettes\.json/);
  const uses = [...base.matchAll(/[^\n]*palettes\.json[^\n]*/g)].map((m) => m[0]).filter((l) => !/^\{\{\/\*/.test(l));
  /* 合站：色块直接读主站 data/shell/palettes.json（site.Data），模板里不再 resources.Get 副本 */
  assert.deepEqual(uses, []);
  assert.deepEqual([...base.matchAll(/[^\n]*site\.Data\.shell\.palettes[^\n]*/g)].map((m) => m[0]), ['{{ range site.Data.shell.palettes.presets }}']);
  assert.doesNotMatch(base, /palettes\.json[^\n]*jsonify/);
  assert.match(base, /<script>\{\{ \(resources\.Get "js\/lib\/ui-cookie-read\.js" \| minify\)\.Content \| safeJS \}\}<\/script>/);
  assert.match(base, /js\/sgx\/ui-inherit-run\.js" \| js\.Build \(dict "format" "iife" "minify" true "target" "es2018"\)\)/);
});

test('测试构建不问 /api/days（对齐 PR-C2）：SGX_TEST_NO_WEATHER=1 时 <html data-sgx-test-no-api>，daymark.js ensureDays 不问（e2e 设 __sgxDaymarkApi 才问）；生产构建不加属性', () => {
  const b = readFileSync(path.join(REPO, 'space/web/layouts/daymark/baseof.html'), 'utf8');
  assert.match(b, /\{\{ if eq \(getenv "SGX_TEST_NO_WEATHER"\) "1" \}\} data-sgx-test-no-api\{\{ end \}\}>/);
  const js = readFileSync(path.join(REPO, 'space/web/assets/daymark/js/daymark.js'), 'utf8');
  assert.match(js, /hasAttribute\('data-sgx-test-no-api'\) && !G\.__sgxDaymarkApi\) return;/);
});
