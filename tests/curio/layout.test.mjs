// 页面模板（space/web/layouts/curio）：共享外壳顶栏（页名胶囊：首页 = 站名、子页 = 子页名）、首页 = 发现（2026-11 对齐 PR-C2：页头 + 下划线 tab + 封面卡）、各子页部件都在、条目页、不被搜索引擎收录。
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
const part = (n) => read('space/web/layouts/partials/curio/' + n + '.html');
const findsMain = part('finds-main');
const finds = page('finds') + '\n' + findsMain, devices = page('devices'), games = page('games'), movies = page('movies'), music = page('music');
const parts = ['common', 'item-page', 'signin', 'page-head', 'list'].map(part).join('\n');
/** 部件 id 在模板源码里：直接写的 id="…"，或 page-head 命令链 / list 的 dict "id" "…"、id 前缀 pre "…" */
const hasId = (src, id) => new RegExp('id="' + id + '"|"id" "' + id + '"').test(src) || (/^(cu|dv|gm|mv)-(chips|list|empty)$/.test(id) && new RegExp('"pre" "' + id.split('-')[0] + '"').test(src));

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
  for (const m of ['../../../js/shell/topbar-panel.js', '../../../js/shell/modal-sheet.js', '../../../js/shell/ai-panel.js', '../../../js/shell/vk.js', '../../../js/lib/prefs-write.js']) {
    assert.match(host, new RegExp("from '" + m.replace(/[.\/]/g, '\\$&') + "'"), m);
  }
  assert.doesNotMatch(host, /share-button|mountShare/, 'v6 P4：分享本页磁贴拿掉');
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

test('导航：九宫格导航面板（PR-4b；原快捷面板第 1 页）用主站共享外壳的 nav.json（顶栏 v3：主页 / 博客 / 奇趣 / 日刻；05 旷野 2026-11-12 删除），模板不写死项；奇趣是当前项；主站项走 https://styrigx.com', () => {
  const nav = JSON.parse(readFileSync(path.join(REPO, 'space/web/data/shell/nav.json'), 'utf8'));
  /* 语言包化（2026-11-07）：nav.json 只有 id / 图标 / 地址，站名在外壳字符串表（sync-shell 同步到 data/sgx-shell-i18n/<语言>.yaml） */
  const trZh = /** @type {any} */ (yaml.load(readFileSync(path.join(REPO, 'space/web/data/sgx-shell-i18n/zh.yaml'), 'utf8')));
  assert.deepEqual(nav.items.map((i) => trZh.nav[i.id].title), ['主页', '博客', '奇趣', '日刻']); /* 顶栏 v3 NAVIGATE 01–04 */
  assert.deepEqual(nav.footer, []);
  assert.equal(nav.me.href, 'https://styrigx.com/account/');
  assert.match(base, /\{\{ \$shellNav := site\.Data\.shell\.nav \}\}/); /* 合站：直接读主站 data/shell/nav.json，没有副本 */
  assert.match(base, /"nav" \$shellNav\n/);
  assert.match(base, /"mainOrigin" "https:\/\/styrigx\.com"/);
  /* 2026-11-12：logo 四站统一回主站首页（同主站 sgx-lang-path，英文 /、中文 /zh/），不再回本站首页 */
  assert.match(base, /"home" \(partial "sgx-lang-path\.html" \(dict "path" "\/" "lang" \.Lang\)\)/);
  assert.doesNotMatch(base, /"home" \(site\.GetPage/);
  /* 项、页脚、当前项高亮都在共享外壳 partial 里（range .nav.items / with .nav.footer / eq .id $.site） */
  const tb = read('space/web/layouts/partials/shell-topbar.html');
  assert.match(tb, /range \.nav\.items/);
  assert.match(tb, /if eq \.id \$\.site \}\} aria-current="page"/);
  /* 导航页不放搜索框（定案第 2 条） */
  assert.doesNotMatch(tb, /type="search"|role="search"|sgx-drawer-search|nav\.search/);
  assert.doesNotMatch(base, /主页|书库/);
});

test('首页（2026-11 对齐 PR-C2，设计稿 pg=curio）：就是「发现」（和 /curio/finds/ 同一份 finds-main.html，命令写 ls curio/）；平铺入口删掉；脚本 curio-home.js（旧 hash）→ curio.js → curio-list.js', () => {
  assert.doesNotMatch(index, /sgx-entries/);
  assert.match(index, /partial "curio\/finds-main\.html" \(dict "page" \. "tr" \$tr "lang" \$lang "home" true\)/);
  assert.match(page('finds'), /partial "curio\/finds-main\.html" \(dict "page" \. "tr" \$tr "lang" \$lang "home" false\)/);
  const a = index.indexOf('js/curio-home.js'), b = index.indexOf('js/curio.js'), c = index.indexOf('js/curio-list.js');
  assert.ok(a > 0 && a < b && b < c, '脚本顺序');
  assert.doesNotMatch(index, /curio-items|curio-tabs/);
  const head = part('page-head');
  assert.match(head, /cond \(\.home \| default false\) "ls curio\/" \(printf "ls curio\/%s\/" \$cur\)/, '首页命令 ls curio/，子页 ls curio/<分区>/');
  assert.match(head, /range \(slice "finds" "devices" "games" "movies" "music"\)/, '五个 tab，音乐最后');
  assert.match(head, /href="\{\{ partial "sgx-lang-path\.html" \(dict "path" \(printf "\/curio\/%s\/" \.\) "lang" \$lang\) \}\}"/, 'tab 地址走 sgx-lang-path');
  const css = read('space/web/assets/curio/css/input.css');
  assert.doesNotMatch(css, /cu-music-ok|mu-denied/, 'v5 S3：音乐歌单公开，tab 不按权限藏，没有「仅本人可见」卡');
  assert.doesNotMatch(css, /\.cu-fab|\.it-view|\.cu-tile|\.it-card|\.sgx-ent|#cu-segs/, '旧浮动按钮 / 详情弹层 / 格子 / 旧卡片 / 入口 / 段式标签样式删除');
  /* 子页内容：中英各一份，layout 指到 _default/<分区>.html */
  for (const id of ['finds', 'devices', 'games', 'movies', 'music']) {
    assert.match(read(`space/web/content/curio/${id}.md`), new RegExp('^layout: ' + id + '$', 'm'));
    assert.match(read(`space/web/content/curio/${id}.zh.md`), new RegExp('^layout: ' + id + '$', 'm'));
  }
});

test('发现：分类 chips、封面卡网格、分页条（排序 最近收藏 / 我的顺序 / 名称）、页头命令链（收藏 / 管理分类 / 导入 / 导出）、编辑弹层、确认；没有「⋯」菜单和浮动按钮；加载 curio.js → curio-list.js', () => {
  for (const id of ['cu-chips', 'cu-list', 'cu-empty', 'cu-fab', 'menu-cats', 'menu-import', 'menu-export',
    'f-url', 'f-fill', 'f-name', 'f-name2', 'f-desc', 'f-desc2', 'f-cats', 'f-cat-name', 'f-icon', 'f-private', 'f-up', 'f-down', 'edit-del', 'edit-save',
    'cats-list', 'cats-new', 'imp-file', 'imp-private', 'imp-go']) {
    assert.ok(hasId(finds, id), id);
  }
  assert.doesNotMatch(finds, /cu-menu-btn|menu-wrap|class="cu-fab/);
  assert.match(parts, /id="confirm-ok"/);
  assert.match(parts, /id="bk-toast"/);
  assert.match(findsMain, /\(dict "id" "cu-fab" "k" "touch curio\/finds\/ \+" "d" \$tr\.cmd\.addFind\)/);
  assert.match(findsMain, /\(dict "id" "menu-export" "k" "export" "d" \$tr\.cmd\.export "href" \(printf "%s\?lang=%s" \("curio\/api\/export" \| relURL\) \$lang\) "dl" true\)/);
  assert.match(findsMain, /"sorts" \(slice\s+\(dict "v" "recent" "label" \$tr\.sort\.recent\) \(dict "v" "order" "label" \$tr\.sort\.order\) \(dict "v" "name" "label" \$tr\.sort\.name\)/);
  assert.match(finds, /id="imp-private"[^>]*checked/);
  assert.match(finds, /<section id="cu-pane-finds" class="cu-pane" aria-label="\{\{ \$tr\.finds\.finds \}\}">/);
  assert.deepEqual([strings('curio', 'en').finds.finds, strings('curio', 'zh').finds.finds], ['Finds', '发现']);
  assert.ok(finds.indexOf('js/curio.js') > 0 && finds.indexOf('js/curio.js') < finds.indexOf('js/curio-list.js'));
  assert.doesNotMatch(finds, /curio-items|curio-tabs|dv-|gm-/);
  const list = part('list');
  assert.match(list, /<div id="\{\{ \$pre \}\}-list" class="sgx-cgrid cu-grid" data-cu-grid/);
  assert.match(list, /<nav class="sgx-pg cu-pg" data-cu-pager/);
  assert.match(list, /<b data-pg-count translate="no">-- 0 \/ 0 --<\/b><span class="sgx-pg-hint">\{\{ \$tr\.list\.more \}\}<\/span>/);
  assert.match(list, /<select data-cu-sort/);
});

test('设备 / 游戏子页：各自只有自己的面板和编辑弹层；条目页（#cu-item，取代旧详情弹层）；命令链新建；脚本 curio.js → curio-list.js → curio-items.js；没有 hidden 面板、没有 curio-tabs.js', () => {
  for (const id of ['dv-chips', 'dv-list', 'dv-empty', 'dv-fab',
    'dv-photo', 'dv-photo-del', 'dv-name', 'dv-kind', 'dv-bought', 'dv-os', 'dv-specs', 'dv-acc', 'dv-notes', 'dv-retired', 'dv-retired-at', 'dv-replaced', 'dv-private', 'dv-del', 'dv-save']) {
    assert.ok(hasId(devices, id), id);
  }
  for (const id of ['gm-chips', 'gm-list', 'gm-empty', 'gm-fab', 'gm-photo', 'gm-title', 'gm-status', 'gm-platform', 'gm-platforms', 'gm-device', 'gm-edition', 'gm-rating', 'gm-review', 'gm-private', 'gm-del', 'gm-save']) {
    assert.ok(hasId(games, id), id);
  }
  assert.ok(!existsSync(path.join(REPO, 'space/web/layouts/partials/curio/item-view.html')), '旧详情弹层删除');
  assert.match(parts, /<section id="cu-item" class="cu-item" hidden aria-live="polite"><\/section>/);
  assert.match(parts, /<script id="cu-posts" type="application\/json">/, '相关文章候选');
  assert.doesNotMatch(parts, /it-view/);
  assert.match(devices, /id="dv-bought" type="date"/);
  assert.match(devices, /\(dict "id" "dv-fab" "k" "touch curio\/devices\/ \+"/);
  assert.match(games, /\(dict "id" "gm-fab" "k" "touch curio\/games\/ \+"/);
  assert.doesNotMatch(devices, /id="gm-/);
  assert.doesNotMatch(games, /id="dv-/);
  for (const t of [devices, games]) {
    assert.doesNotMatch(t, /hidden inert|curio-tabs|<button id="(dv|gm)-fab"/);
    assert.match(t, /partial "curio\/item-page\.html"/);
    const a = t.indexOf('js/curio.js'), l = t.indexOf('js/curio-list.js'), b = t.indexOf('js/curio-items.js');
    assert.ok(a > 0 && a < l && l < b);
  }
});

test('电影 / 音乐子页：部件都在；电影条目页 + 脚本 curio.js → curio-list.js → curio-items.js（借裁剪 / 条目文案）→ curio-movies.js；音乐 curio.js → music-core.js → curio-music.js，只看模式的锁标、上传上限说明，上传是页头命令', () => {
  for (const id of ['mv-list', 'mv-empty', 'mv-fab', 'mv-edit-wrap', 'mv-photo', 'mv-photo-prev', 'mv-title', 'mv-original', 'mv-year', 'mv-director', 'mv-watched', 'mv-rating', 'mv-review', 'mv-del', 'mv-save']) {
    assert.ok(hasId(movies, id), id);
  }
  assert.match(movies, /partial "curio\/item-page\.html"/);
  const a = movies.indexOf('js/curio.js'), l = movies.indexOf('js/curio-list.js'), b = movies.indexOf('js/curio-items.js'), c = movies.indexOf('js/curio-movies.js');
  assert.ok(a > 0 && a < l && l < b && b < c);
  for (const id of ['cu-pane-music', 'mu-app', 'mu-upload', 'mu-covers', 'mu-tracks', 'mu-play-all', 'mu-player', 'mu-lyrics', 'mu-seek', 'mu-speed', 'mu-prev', 'mu-toggle', 'mu-next', 'mu-audio',
    'mu-up-wrap', 'mu-up-name', 'mu-up-artist', 'mu-up-year', 'mu-up-audio', 'mu-up-cover', 'mu-up-lrc', 'mu-up-go']) {
    assert.ok(hasId(music, id), id);
  }
  assert.match(music, /"grep" false "cmds" \(slice \(dict "id" "mu-upload"/);
  assert.match(music, /id="mu-up-audio"[^>]*multiple/);
  assert.match(music, /95 MB/);
  assert.ok(!hasId(music, 'mu-denied'), 'v5 S3：没有「仅本人可见」卡');
  assert.equal((music.match(/class="mu-ic-lock"/g) || []).length, 2, '播放整张 / 播放键各带一个锁标（只看模式）');
  assert.match(music, /id="mu-app" class="hidden"/);
  assert.ok(music.indexOf('js/curio.js') < music.indexOf('js/music-core.js'), '共用核在 curio.js 之后');
  assert.ok(music.indexOf('js/music-core.js') < music.indexOf('js/curio-music.js'), '共用核（第二步 2a）在 curio-music.js 之前');
});

test('弹出播放器页（音乐第二步 2b）：地址 /curio/music/player/、/curio/zh/music/player/；部件都在；脚本 curio.js → music-core.js → music-player.js；不管上传 / 删除', () => {
  const player = page('player');
  assert.match(read('space/web/content/curio/music-player.md'), /^url: \/curio\/music\/player\/$/m);
  assert.match(read('space/web/content/curio/music-player.zh.md'), /^url: \/curio\/zh\/music\/player\/$/m);
  for (const f of ['music-player.md', 'music-player.zh.md']) assert.match(read('space/web/content/curio/' + f), /^layout: player$/m);
  for (const id of ['mp-app', 'mp-cover', 'mp-title', 'mp-artist', 'mp-album', 'mp-note', 'mp-signin', 'mp-lyrics', 'mp-seek', 'mp-time', 'mp-dur',
    'mp-shuffle', 'mp-prev', 'mp-toggle', 'mp-next', 'mp-speed', 'mp-mute', 'mp-volume', 'mp-tracks', 'mp-albums-btn', 'mp-albums', 'mp-audio']) {
    assert.ok(hasId(player, id), id);
  }
  assert.match(player, /id="mp-app" class="mp-app hidden"/);
  assert.equal((player.match(/class="mu-ic-lock"/g) || []).length, 1, '播放键带锁标（没进站 / 登录过期）');
  for (const id of ['mu-upload', 'mu-up-wrap', 'mu-album-del']) assert.ok(!hasId(player, id), '播放器不管理：' + id);
  const a = player.indexOf('js/curio.js'), b = player.indexOf('js/music-core.js'), c = player.indexOf('js/music-player.js');
  assert.ok(a > 0 && a < b && b < c, '共用核在 music-player.js 之前');
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

test('head 内联脚本不打包整份 palettes.json（预设表 / 深套表在共享读端里；自定义色引擎 2026-11-12 删除）', () => {
  for (const f of ['space/web/assets/curio/js/sgx/ui-inherit-run.js', 'space/web/assets/curio/js/sgx/topbar-host.js']) {
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
  /* 调色板 v4：<head> 里的 color-scheme / theme-color 默认值取默认调色板 terra 的 mode / 底色（只读两项，不整份输出） */
  assert.deepEqual([...base.matchAll(/[^\n]*site\.Data\.shell\.palettes[^\n]*/g)].map((m) => m[0]), ['{{- range site.Data.shell.palettes.presets }}{{ if eq .id "terra" }}', '{{ range site.Data.shell.palettes.presets }}']);
  assert.doesNotMatch(base, /palettes\.json[^\n]*jsonify/);
  assert.match(base, /<script>\{\{ \(resources\.Get "js\/lib\/ui-cookie-read\.js" \| minify\)\.Content \| safeJS \}\}<\/script>/);
  assert.match(base, /js\/sgx\/ui-inherit-run\.js" \| js\.Build \(dict "format" "iife" "minify" true "target" "es2018"\)\)/);
});

test('测试构建不问新加的读接口（对齐 PR-C2）：SGX_TEST_NO_WEATHER=1 时 <html data-sgx-test-no-api>，curio-list.js 不问 tab 计数（e2e 设 __sgxCurioApi 才问）；生产构建不加属性', () => {
  assert.match(base, /\{\{ if eq \(getenv "SGX_TEST_NO_WEATHER"\) "1" \}\} data-sgx-test-no-api\{\{ end \}\}>/);
  const js = read('space/web/assets/curio/js/curio-list.js');
  assert.match(js, /hasAttribute\('data-sgx-test-no-api'\) && !G\.__sgxCurioApi\) return;/);
});
