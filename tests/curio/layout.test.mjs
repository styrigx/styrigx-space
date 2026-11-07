// 页面模板（space/web/layouts/curio）：共享外壳顶栏（页名胶囊：首页 = 站名、子页 = 子页名）、首页只有平铺入口、各子页部件都在、不被搜索引擎收录。
// 只读模板源码，不用构建；构建后的行为在手机 E2E（tests/curio/e2e）。
// 运行：node --test tests/curio/layout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strings } from '../fixtures/strings.mjs';
import yaml from 'js-yaml';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const base = read('space/web/layouts/curio/baseof.html');
const index = read('space/web/layouts/curio/section.html');
const page = (n) => read('space/web/layouts/curio/' + n + '.html');
const finds = page('finds'), devices = page('devices'), games = page('games'), movies = page('movies'), music = page('music');
const parts = ['common', 'item-view', 'signin'].map((n) => read('space/web/layouts/partials/curio/' + n + '.html')).join('\n');

test('顶栏（2026-11-04 P5-1，四站同一个）：共享外壳 shell-topbar.html；中间 = 页名胶囊（首页 = 站名）；右边九宫格 · 快捷设置 · AI（PR-4b，头像在 AI 窗口头部）；没有抽屉、右圆分享', () => {
  assert.match(base, /\{\{ partial "shell-topbar\.html" \(dict\n/);
  assert.match(base, /"site" "curio"/);
  /* P4-3 奇趣拆页：页名胶囊只显示页名——首页 = 站名，子页 = 子页名（内容文件的 title），404 = 页名；不再有 data-sgx-titles（没有页内分区） */
  assert.match(base, /\{\{ if \$isHome \}\}\{\{ \$pageName = \$tr\.site\.name \}\}\{\{ end \}\}/); /* 合站：本站首页是分区页，用 $isHome 判断 */
  assert.deepEqual([strings('curio', 'en').site.name, strings('curio', 'zh').site.name], ['Curio', '奇趣']);
  assert.match(base, /\{\{ \$center = printf "<span class=\\"sgx-tb-title\\">%s<\/span>" \(htmlEscape \$pageName\) \}\}/);
  assert.doesNotMatch(base, /data-sgx-titles/);
  assert.doesNotMatch(base, /sgx-seg|data-cu-seg|role=\\"tab/);
  /* 九宫格、导航抽屉、右圆分享和它们的脚本都删了（标记在共享外壳，本站模板里不再手写顶栏） */
  assert.doesNotMatch(base, /sgx-tb-nav|sgx-drawer|sgx-tb-end|sgx-tb-share|<header|apps-grid|sgx-tb-end-group|sgx-tb-gbtn|guestbook/);
  const code = base.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, ''); /* 去掉模板注释（注释里会提到被取代的旧文件） */
  assert.doesNotMatch(code, /share-host\.js|js\/topbar\.js|search-host\.js|shell-nav-href/);
  assert.equal(existsSync(path.join(REPO, 'space/web/assets/curio/js/sgx/share-host.js')), false);
  assert.equal(existsSync(path.join(REPO, 'space/web/assets/curio/js/topbar.js')), false);
  assert.equal(existsSync(path.join(REPO, 'space/web/layouts/partials/curio/shell-nav-href.html')), false);
  assert.match(base, /resources\.Get "curio\/js\/sgx\/topbar-host\.js" \| js\.Build/);
  /* P4-3 PR-4b：快捷面板四站同一套（分享本页、立即锁定、布局都有），不再按站传 tiles */
  assert.doesNotMatch(base, /"tiles" /);
  const host = read('space/web/assets/curio/js/sgx/topbar-host.js');
  /* 合站：直接引主站的共享外壳源文件（没有 js/sgx/shell/ 副本） */
  for (const m of ['../../../js/shell/topbar-panel.js', '../../../js/shell/modal-sheet.js', '../../../js/shell/ai-panel.js', '../../../js/shell/vk.js', '../../../js/lib/prefs-write.js', '../../../js/shell/share-button.js']) {
    assert.match(host, new RegExp("from '" + m.replace(/[.\/]/g, '\\$&') + "'"), m);
  }
});

test('没有版权页脚（© / Powered by），样式也删干净', () => {
  const css = read('space/web/assets/curio/css/input.css');
  assert.doesNotMatch(base, /<footer|©|Powered by/);
  assert.doesNotMatch(css.slice(css.indexOf('@import "../../css/shell/shell.css";')), /(^|[\s,}])footer\b|sgx-powered|sgx-tb-me/);
});

test('留言板撤了（2026-10-24）：没有 /guestbook/ 页面、模板、脚本、Giscus 配置和样式', async () => {
  const { existsSync } = await import('node:fs');
  for (const f of ['space/web/layouts/curio/guestbook.html', 'space/web/content/curio/guestbook.md', 'space/web/content/curio/en/guestbook.md', 'space/web/assets/curio/js/guestbook.js']) {
    assert.equal(existsSync(new URL('../../' + f, import.meta.url)), false, f);
  }
  assert.doesNotMatch(read('space/web/hugo.yaml'), /guestbook|giscus/i);
  const css = read('space/web/assets/curio/css/input.css');
  assert.doesNotMatch(css.slice(css.indexOf('@import "../../css/shell/shell.css";')), /cu-gb-|giscus|guestbook/);
});

test('导航：九宫格导航面板（PR-4b；原快捷面板第 1 页）用主站共享外壳的 nav.json（主站 / 奇趣 / 日刻 / 博客），模板不写死项；奇趣是当前项；主站项走 https://styrigx.com', () => {
  const nav = JSON.parse(readFileSync(path.join(REPO, 'space/web/data/shell/nav.json'), 'utf8'));
  /* 语言包化（2026-11-07）：nav.json 只有 id / 图标 / 地址，站名在外壳字符串表（sync-shell 同步到 data/sgx-shell-i18n/<语言>.yaml） */
  const trZh = /** @type {any} */ (yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/zh.yaml'), 'utf8')));
  assert.deepEqual(nav.items.map((i) => trZh.nav[i.id].title), ['旷野', '奇趣', '日刻', '博客']);
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

test('首页（P4-3 奇趣拆页）：只有平铺入口（共享外壳），五个入口链到子页、地址走 sgx-lang-path；音乐排最后；没有面板；脚本只有 curio-home.js', () => {
  assert.match(index, /partial "sgx-entries\.html"/);
  const ids = [...index.matchAll(/\(dict "id" "([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['finds', 'devices', 'games', 'movies', 'music']);
  for (const id of ids) assert.match(index, new RegExp('"href" \\(partial "sgx-lang-path\\.html" \\(dict "path" "/curio/' + id + '/" "lang" \\$lang\\)\\)'), id);
  assert.doesNotMatch(index, /cu-pane|cu-panes|"href" "#/);
  assert.match(index, /js\/curio-home\.js/);
  assert.doesNotMatch(index, /js\/curio\.js|curio-items|curio-tabs/);
  const css = read('space/web/assets/curio/css/input.css');
  assert.match(css, /html:not\(\.cu-music-ok\) #cu-entries \.sgx-ent-li:has\(> \[data-entry="music"\]\) \{ display: none; \}/);
  /* 子页内容：中英各一份，layout 指到 _default/<分区>.html */
  for (const id of ids) {
    assert.match(read(`space/web/content/curio/${id}.md`), new RegExp('^layout: ' + id + '$', 'm'));
    assert.match(read(`space/web/content/curio/${id}.zh.md`), new RegExp('^layout: ' + id + '$', 'm'));
  }
});

test('发现子页：分类条、格子、收藏按钮、更多菜单（分类 / 导入 / 导出）、编辑弹层、确认；只加载 curio.js', () => {
  for (const id of ['cu-chips', 'cu-menu-btn', 'cu-list', 'cu-empty', 'cu-fab', 'menu-cats', 'menu-import', 'menu-export',
    'f-url', 'f-fill', 'f-name', 'f-name2', 'f-desc', 'f-desc2', 'f-cats', 'f-cat-name', 'f-icon', 'f-private', 'f-up', 'f-down', 'edit-del', 'edit-save',
    'cats-list', 'cats-new', 'imp-file', 'imp-private', 'imp-go']) {
    assert.match(finds, new RegExp('id="' + id + '"'), id);
  }
  assert.match(parts, /id="confirm-ok"/);
  assert.match(parts, /id="bk-toast"/);
  assert.match(finds, /id="menu-export"[^>]*href="\{\{ "curio\/api\/export" \| relURL \}\}/);
  assert.match(finds, /id="imp-private"[^>]*checked/);
  assert.match(finds, /<section id="cu-pane-finds" class="cu-pane" aria-label="\{\{ \$tr\.finds\.finds \}\}">/);
  assert.deepEqual([strings('curio', 'en').finds.finds, strings('curio', 'zh').finds.finds], ['Finds', '发现']);
  assert.match(finds, /js\/curio\.js/);
  assert.doesNotMatch(finds, /curio-items|curio-tabs|dv-|gm-/);
});

test('设备 / 游戏子页：各自只有自己的面板和编辑弹层；详情弹层共用；脚本 curio.js → curio-items.js；没有 hidden 面板、没有 curio-tabs.js', () => {
  for (const id of ['dv-chips', 'dv-list', 'dv-empty', 'dv-fab',
    'dv-photo', 'dv-photo-del', 'dv-name', 'dv-kind', 'dv-bought', 'dv-os', 'dv-specs', 'dv-acc', 'dv-notes', 'dv-retired', 'dv-retired-at', 'dv-replaced', 'dv-private', 'dv-del', 'dv-save']) {
    assert.match(devices, new RegExp('id="' + id + '"'), id);
  }
  for (const id of ['gm-chips', 'gm-list', 'gm-empty', 'gm-fab', 'gm-photo', 'gm-title', 'gm-status', 'gm-platform', 'gm-platforms', 'gm-device', 'gm-edition', 'gm-rating', 'gm-review', 'gm-private', 'gm-del', 'gm-save']) {
    assert.match(games, new RegExp('id="' + id + '"'), id);
  }
  for (const id of ['it-view-wrap', 'it-view-edit', 'it-view-body']) assert.match(parts, new RegExp('id="' + id + '"'), id);
  assert.match(devices, /id="dv-bought" type="date"/);
  assert.doesNotMatch(devices, /id="gm-/);
  assert.doesNotMatch(games, /id="dv-/);
  for (const t of [devices, games]) {
    assert.doesNotMatch(t, /hidden inert|curio-tabs/);
    assert.match(t, /partial "curio\/item-view\.html"/);
    const a = t.indexOf('js/curio.js'), b = t.indexOf('js/curio-items.js');
    assert.ok(a > 0 && a < b);
  }
});

test('电影 / 音乐子页：部件都在；电影脚本 curio.js → curio-items.js（借裁剪）→ curio-movies.js；音乐 curio.js → curio-music.js，有「仅本人可见」和上传上限说明', () => {
  for (const id of ['mv-list', 'mv-empty', 'mv-fab', 'mv-edit-wrap', 'mv-photo', 'mv-photo-prev', 'mv-title', 'mv-original', 'mv-year', 'mv-director', 'mv-watched', 'mv-rating', 'mv-review', 'mv-del', 'mv-save']) {
    assert.match(movies, new RegExp('id="' + id + '"'), id);
  }
  const a = movies.indexOf('js/curio.js'), b = movies.indexOf('js/curio-items.js'), c = movies.indexOf('js/curio-movies.js');
  assert.ok(a > 0 && a < b && b < c);
  for (const id of ['cu-pane-music', 'mu-denied', 'mu-app', 'mu-upload', 'mu-covers', 'mu-tracks', 'mu-play-all', 'mu-player', 'mu-lyrics', 'mu-seek', 'mu-speed', 'mu-prev', 'mu-toggle', 'mu-next', 'mu-audio',
    'mu-up-wrap', 'mu-up-name', 'mu-up-artist', 'mu-up-year', 'mu-up-audio', 'mu-up-cover', 'mu-up-lrc', 'mu-up-go']) {
    assert.match(music, new RegExp('id="' + id + '"'), id);
  }
  assert.match(music, /id="mu-up-audio"[^>]*multiple/);
  assert.match(music, /95 MB/);
  assert.match(music, /id="mu-denied" class="mu-denied hidden"/);
  assert.match(music, /id="mu-app" class="hidden"/);
  assert.ok(music.indexOf('js/curio.js') < music.indexOf('js/curio-music.js'));
});

test('不被收录、外观和语言跟主站（ui-inherit-run 在样式前）', () => {
  assert.match(base, /<meta name="robots" content="noindex">/);
  assert.ok(base.indexOf('ui-inherit-run.js') < base.indexOf('css/main.css'));
  assert.doesNotMatch(base + index + finds + devices + games + movies + music, /daymark|日刻分区|dm-/);
  /* 站点地图只列首页（子页、尤其电影 / 音乐不进） */
  const sm = read('space/web/layouts/curio/section.curiositemap.xml');
  assert.doesNotMatch(sm, /music|movies|\.Pages|RegularPages/);
});

test('robots.txt 只在图志根（root/robots.txt，Disallow: /）：本站不生成（Hugo 内置 robots 模板关掉），space/web/static/curio 里也不放', () => {
  /* 合站后只有一份 hugo.yaml（space/web/hugo.yaml），robots.txt 只出在根上：本站没有自己的 robots 模板 */
  assert.equal(existsSync(path.join(REPO, 'space/web/layouts/curio/robots.txt')), false);
  assert.equal(existsSync(path.join(REPO, 'space/web/static/curio/robots.txt')), false);
  assert.match(read('space/web/static/robots.txt'), /^User-agent: \*\nDisallow: \/$/m);
});

test('head 内联脚本和自定义色引擎不打包整份 palettes.json（预设表在共享读端里，引擎版本用读端的 SCHEME_VER）', () => {
  for (const f of ['space/web/assets/curio/js/sgx/ui-inherit-run.js', 'space/web/assets/curio/js/sgx/shell-accent.js', 'space/web/assets/curio/js/sgx/topbar-host.js']) {
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
