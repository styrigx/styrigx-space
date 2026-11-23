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
/* 奇趣重组 PR 2：奇趣 = 发现（finds.html 删了，首页 section.html 就是发现）；游戏搬成第五个子站 layouts/games/（curio/games.html 删了） */
const finds = index + '\n' + findsMain, devices = page('devices'), movies = page('movies');
const games = read('space/web/layouts/games/section.html'), gamesBase = read('space/web/layouts/games/baseof.html');
/* music 搬家第 3 步：音乐页搬到第四个子站 layouts/music/（页头 / 弹层 / curio.js 照旧借奇趣的） */
const music = read('space/web/layouts/music/section.html'), musicBase = read('space/web/layouts/music/baseof.html');
const parts = ['common', 'item-page', 'signin', 'page-head', 'list'].map(part).join('\n');
/** 部件 id 在模板源码里：直接写的 id="…"，或 page-head 命令链 / list 的 dict "id" "…"、id 前缀 pre "…" */
const hasId = (src, id) => new RegExp('id="' + id + '"|"id" "' + id + '"').test(src) || (/^(cu|dv|gm|mv)-(chips|list|empty)$/.test(id) && new RegExp('"pre" "' + id.split('-')[0] + '"').test(src));

test('顶栏（2026-11-04 P5-1，四站同一个）：共享外壳 frame/topbar.html；中间 = 页名胶囊（首页 = 站名）；右边九宫格 · 快捷设置 · AI（PR-4b，头像在 AI 窗口头部）；没有抽屉、右圆分享', () => {
  assert.match(base, /\{\{ partial "common\/frame\/topbar\.html" \(dict\n/);
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
  for (const m of ['../../../common/js/frame/topbar/panel.js', '../../../common/js/ui/modal-sheet.js', '../../../common/js/frame/ai/panel.js', '../../../common/js/ui/vk.js', '../../../common/js/prefs/prefs-write.js']) {
    assert.match(host, new RegExp("from '" + m.replace(/[.\/]/g, '\\$&') + "'"), m);
  }
  assert.doesNotMatch(host, /share-button|mountShare/, 'v6 P4：分享本页磁贴拿掉');
});

test('没有版权页脚（© / Powered by），样式也删干净', () => {
  const css = read('space/web/assets/curio/css/input.css');
  assert.doesNotMatch(base, /<footer|©|Powered by/);
  assert.doesNotMatch(css.slice(css.indexOf('@import "../../common/css/frame.css";')), /(^|[\s,}])footer\b|sgx-powered|sgx-tb-me/);
});

test('留言板撤了（2026-10-24）：没有 /guestbook/ 页面、模板、脚本、Giscus 配置和样式', async () => {
  const { existsSync } = await import('node:fs');
  for (const f of ['space/web/layouts/curio/guestbook.html', 'space/web/content/curio/guestbook.md', 'space/web/content/curio/en/guestbook.md', 'space/web/assets/curio/js/guestbook.js']) {
    assert.equal(existsSync(new URL('../../' + f, import.meta.url)), false, f);
  }
  assert.doesNotMatch(read('space/web/hugo.yaml'), /guestbook|giscus/i);
  const css = read('space/web/assets/curio/css/input.css');
  assert.doesNotMatch(css.slice(css.indexOf('@import "../../common/css/frame.css";')), /cu-gb-|giscus|guestbook/);
});

test('导航：九宫格导航面板（PR-4b；原快捷面板第 1 页）用主站共享外壳的 nav.json（顶栏 v3：主页 / 博客 / 日刻 / 音乐 / 奇趣 / 游戏；旧 05 旷野 2026-11-12 删除，奇趣重组 PR 2 追加 05 游戏），模板不写死项；奇趣是当前项；主站项走 https://styrigx.com', () => {
  const nav = JSON.parse(readFileSync(path.join(REPO, 'space/web/data/common/frame/nav.json'), 'utf8'));
  /* 语言包化（2026-11-07）：nav.json 只有 id / 图标 / 地址，站名在外壳字符串表（sync-shell 同步到 data/common/frame/i18n/<语言>.yaml） */
  const trZh = /** @type {any} */ (yaml.load(readFileSync(path.join(REPO, 'space/web/data/common/frame/i18n/zh.yaml'), 'utf8')));
  assert.deepEqual(nav.items.map((i) => trZh.nav[i.id].title), ['主页', '博客', '日刻', '音乐', '奇趣', '游戏']); /* 顶栏 v3 NAVIGATE 00–05（Gray 2026-11-21：加音乐、重排，编号从 00 起；奇趣重组 PR 2 追加 05 游戏） */
  assert.deepEqual(nav.footer, []);
  assert.equal(nav.me.href, 'https://styrigx.com/account/');
  assert.match(base, /\{\{ \$frameNav := site\.Data\.common\.frame\.nav \}\}/); /* 合站：直接读主站 data/common/frame/nav.json，没有副本 */
  assert.match(base, /"nav" \$frameNav\n/);
  assert.match(base, /"mainOrigin" "https:\/\/styrigx\.com"/);
  /* 2026-11-12：logo 四站统一回主站首页（同主站 sgx-lang-path，英文 /、中文 /zh/），不再回本站首页 */
  assert.match(base, /"home" \(partial "common\/lang-path\.html" \(dict "path" "\/" "lang" \.Lang\)\)/);
  assert.doesNotMatch(base, /"home" \(site\.GetPage/);
  /* 项、页脚、当前项高亮都在共享外壳 partial 里（range .nav.items / with .nav.footer / eq .id $.site） */
  const tb = read('space/web/layouts/partials/common/frame/topbar.html');
  assert.match(tb, /range \.nav\.items/);
  assert.match(tb, /if eq \.id \$\.site \}\} aria-current="page"/);
  /* 导航页不放搜索框（定案第 2 条） */
  assert.doesNotMatch(tb, /type="search"|role="search"|sgx-drawer-search|nav\.search/);
  assert.doesNotMatch(base, /主页|书库/);
});

test('首页（2026-11 对齐 PR-C2，设计稿 pg=curio）：就是「发现」（finds-main.html，命令写 ls curio/；奇趣重组 PR 2 起 /curio/finds/ 不再有页，301 到首页）；平铺入口删掉；脚本 curio-home.js（旧 hash）→ curio.js → curio-list.js', () => {
  assert.doesNotMatch(index, /sgx-entries/);
  assert.match(index, /partial "curio\/finds-main\.html" \(dict "page" \. "tr" \$tr "lang" \$lang "home" true\)/);
  for (const f of ['finds', 'games']) {
    assert.ok(!existsSync(path.join(REPO, `space/web/layouts/curio/${f}.html`)), `curio/${f}.html 删了`);
    for (const md of [`${f}.md`, `${f}.zh.md`]) assert.ok(!existsSync(path.join(REPO, 'space/web/content/curio', md)), 'content/curio/' + md + ' 删了');
  }
  const redir = read('space/web/static/_redirects');
  for (const [a, b] of [['/curio/finds/', '/curio/'], ['/curio/zh/finds/', '/curio/zh/'], ['/curio/games/', '/games/'], ['/curio/zh/games/', '/games/zh/']]) {
    assert.match(redir, new RegExp('^' + a.replace(/\//g, '\\/') + '\\s+' + b.replace(/\//g, '\\/') + '\\s+301$', 'm'), a);
  }
  const a = index.indexOf('js/curio-home.js'), b = index.indexOf('js/curio.js'), c = index.indexOf('js/curio-list.js');
  assert.ok(a > 0 && a < b && b < c, '脚本顺序');
  assert.doesNotMatch(index, /curio-items|curio-tabs/);
  const head = part('page-head');
  assert.match(head, /cond \(\.home \| default false\) "ls curio\/" \(printf "ls curio\/%s\/" \$cur\)/, '首页命令 ls curio/，子页 ls curio/<分区>/');
  /* 奇趣重组 PR 2：页头的分区 tab 行（含计数）去掉；#cu-tabs 外层留给 grep 一行 */
  const headCode = head.replace(/\{\{-? ?\/\*[\s\S]*?\*\/ ?-?\}\}/g, '');
  assert.doesNotMatch(headCode, /data-ctab|data-cu-count|range \(slice "finds"/, '没有分区 tab 行');
  assert.match(head, /<div class="sgx-ctab" id="cu-tabs">/);
  assert.doesNotMatch(headCode, /music|games/, '页头不再有 music / games');
  for (const l of ['en', 'zh']) assert.doesNotMatch(read(`space/web/data/curio/i18n/${l}.yaml`), /^  music:/m, '奇趣 entries 没有 music（' + l + '）');
  /* 旧 /curio/music/ → /music/ 的 301 照旧 */
  assert.match(read('space/web/static/_redirects'), /^\/curio\/music\/?\*?\s+\/music\//m);
  const css = read('space/web/assets/curio/css/input.css');
  assert.doesNotMatch(css, /cu-music-ok|mu-denied/, 'v5 S3：音乐歌单公开，tab 不按权限藏，没有「仅本人可见」卡');
  assert.doesNotMatch(css, /\.cu-fab|\.it-view|\.cu-tile|\.it-card|\.sgx-ent|#cu-segs/, '旧浮动按钮 / 详情弹层 / 格子 / 旧卡片 / 入口 / 段式标签样式删除');
  /* 子页内容：中英各一份，layout 指到 _default/<分区>.html */
  for (const id of ['devices', 'movies']) {
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

test('设备子页 / 游戏子站：各自只有自己的面板和编辑弹层；条目页（#cu-item，取代旧详情弹层）；命令链新建；设备脚本 curio.js → curio-list.js → curio-items.js，游戏 games-ui.js → games-list.js → games-page.js；没有 hidden 面板、没有 curio-tabs.js', () => {
  for (const id of ['dv-chips', 'dv-list', 'dv-empty', 'dv-fab',
    'dv-photo', 'dv-photo-del', 'dv-name', 'dv-kind', 'dv-bought', 'dv-os', 'dv-specs', 'dv-acc', 'dv-notes', 'dv-retired', 'dv-retired-at', 'dv-replaced', 'dv-private', 'dv-del', 'dv-save']) {
    assert.ok(hasId(devices, id), id);
  }
  /* 奇趣重组 PR 2：游戏页 layouts/games/section.html；「在哪台设备上」（gm-device）去掉；「sort games/」调整顺序 */
  for (const id of ['gm-chips', 'gm-list', 'gm-empty', 'gm-fab', 'gm-order-open', 'gm-photo', 'gm-title', 'gm-status', 'gm-platform', 'gm-platforms', 'gm-edition', 'gm-rating', 'gm-review', 'gm-private', 'gm-del', 'gm-save']) {
    assert.ok(hasId(games, id), id);
  }
  assert.ok(!hasId(games, 'gm-device'), '没有「在哪台设备上」');
  assert.match(games, /partial "common\/frame\/page-head\.html" \(dict "cmd" "ls games\/"/);
  assert.match(games, /<section id="cu-item" class="cu-item" hidden aria-live="polite"><\/section>/);
  assert.match(games, /<script id="cu-posts" type="application\/json">/, '游戏条目页的相关文章候选');
  assert.match(gamesBase, /"site" "games"/);
  assert.ok(!existsSync(path.join(REPO, 'space/web/layouts/partials/curio/item-view.html')), '旧详情弹层删除');
  assert.match(parts, /<section id="cu-item" class="cu-item" hidden aria-live="polite"><\/section>/);
  assert.match(parts, /<script id="cu-posts" type="application\/json">/, '相关文章候选');
  assert.doesNotMatch(parts, /it-view/);
  assert.match(devices, /id="dv-bought" type="date"/);
  assert.match(devices, /\(dict "id" "dv-fab" "k" "touch curio\/devices\/ \+"/);
  assert.match(games, /id="gm-fab"><span class="sgx-cmd-k" translate="no">touch games\/ \+<\/span>/);
  assert.doesNotMatch(devices, /id="gm-/);
  assert.doesNotMatch(games, /id="dv-/);
  assert.doesNotMatch(devices + games, /hidden inert|curio-tabs|<button id="(dv|gm)-fab"/);
  assert.match(devices, /partial "curio\/item-page\.html"/);
  const a = devices.indexOf('js/curio.js'), l = devices.indexOf('js/curio-list.js'), b = devices.indexOf('js/curio-items.js');
  assert.ok(a > 0 && a < l && l < b);
  const g1 = games.indexOf('js/games-ui.js'), g2 = games.indexOf('js/games-list.js'), g3 = games.indexOf('js/games-page.js');
  assert.ok(g1 > 0 && g1 < g2 && g2 < g3, '游戏脚本顺序');
  assert.doesNotMatch(games, /js\/curio(-items|-list)?\.js/, '游戏页不加载奇趣脚本');
});

test('电影 / 音乐子页：部件都在；电影条目页 + 脚本 curio.js → curio-list.js → curio-items.js（借裁剪 / 条目文案）→ curio-movies.js；音乐 music-ui.js → music-core.js → music-tags.js → music-page.js（打磨 6.2 不再加载 curio.js），只看模式的锁标、上传上限说明，上传是页头命令；音乐页不出声', () => {
  for (const id of ['mv-list', 'mv-empty', 'mv-fab', 'mv-edit-wrap', 'mv-photo', 'mv-photo-prev', 'mv-title', 'mv-original', 'mv-year', 'mv-director', 'mv-watched', 'mv-rating', 'mv-review', 'mv-del', 'mv-save']) {
    assert.ok(hasId(movies, id), id);
  }
  assert.match(movies, /partial "curio\/item-page\.html"/);
  const a = movies.indexOf('js/curio.js'), l = movies.indexOf('js/curio-list.js'), b = movies.indexOf('js/curio-items.js'), c = movies.indexOf('js/curio-movies.js');
  assert.ok(a > 0 && a < l && l < b && b < c);
  assert.ok(!existsSync(path.join(REPO, 'space/web/layouts/curio/music.html')), '奇趣下没有音乐页模板了');
  for (const id of ['cu-pane-music', 'mu-app', 'mu-upload', 'mu-covers', 'mu-tracks', 'mu-play-all',
    'mu-up-wrap', 'mu-up-name', 'mu-up-artist', 'mu-up-year', 'mu-up-audio', 'mu-up-cover', 'mu-up-lrc', 'mu-up-go', 'mu-up-album', 'mu-up-aname', 'mu-up-list', 'mu-up-cover-img']) {
    assert.ok(hasId(music, id), id);
  }
  /* 搬家设计稿 v1.1 3.3：播放条、<audio>、同步歌词条删了 */
  for (const id of ['mu-player', 'mu-lyrics', 'mu-seek', 'mu-speed', 'mu-shuffle', 'mu-prev', 'mu-toggle', 'mu-next', 'mu-audio']) assert.ok(!hasId(music, id), '没有 ' + id);
  assert.doesNotMatch(music.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, ''), /<audio\b/);
  /* 打磨 6.1：音乐自己的页头（共享外壳 page-head，站名 / 一句话取本站 data/music/i18n site），不再借奇趣的页头；命令链只有「上传专辑」，没有 su 那一条（#cu-signin） */
  assert.match(music, /partial "common\/frame\/page-head\.html" \(dict "cmd" "ls music\/" "title" \$tr\.site\.name "desc" \$tr\.site\.description/);
  assert.doesNotMatch(music, /partial "curio\/page-head\.html"/);
  assert.match(music, /<button type="button" class="sgx-cmd hidden" id="mu-upload"><span class="sgx-cmd-k" translate="no">cp \*\.flac music\/ \+<\/span>/);
  assert.ok(!hasId(music, 'cu-signin'), '没有 su 那一条（Gray 2026-11-22：访客不提示 su）');
  assert.doesNotMatch(music, /\$cu\b/);
  assert.doesNotMatch(musicBase, /\$cu\b|ns" "curio"/);
  assert.match(musicBase, /<title>\{\{ if eq \$docTitle \$tr\.site\.name \}\}/);
  /* M2：分段「单首 | 批量」，默认单首（音频单选，批量时 JS 改成多选） */
  assert.match(music, /id="mu-up-kind"[\s\S]*data-kind="one" aria-selected="true"[\s\S]*data-kind="batch" aria-selected="false"/);
  assert.doesNotMatch(music, /id="mu-up-audio"[^>]*multiple/);
  assert.match(music, /95 MB/);
  assert.ok(!hasId(music, 'mu-denied'), 'v5 S3：没有「仅本人可见」卡');
  assert.equal((music.match(/class="mu-ic-lock"/g) || []).length, 1, '「播放整张」带锁标（只看模式）；播放条随页内播放删了');
  assert.match(music, /id="mu-app" class="hidden"/);
  // 2026-11 第 7 步：共用核进 Platform（assets/common/js/music/，对外 /js/music/）
  assert.match(music, /resources\.Get "common\/js\/music\/music-core\.js" \| resources\.Copy "js\/music\/music-core\.js"/);
  /* 打磨 6.2：确认框、提示条、sudo / sudoTicket 在本站 music-ui.js（+ partials/music/common.html），不再加载奇趣的 curio.js */
  assert.ok(music.indexOf('js/curio.js') < 0, '不再加载 curio.js');
  assert.doesNotMatch(music, /partial "curio\/common\.html"/);
  assert.match(music, /partial "music\/common\.html"/);
  assert.ok(music.indexOf('music/js/music-ui.js') > 0 && music.indexOf('music/js/music-ui.js') < music.indexOf('js/music/music-core.js'), 'music-ui.js 在共用核之前');
  assert.ok(music.indexOf('js/music/music-core.js') < music.indexOf('music/js/music-page.js'), '共用核在 music-page.js 之前');
  assert.ok(music.indexOf('music/js/music-tags.js') > 0 && music.indexOf('music/js/music-tags.js') < music.indexOf('music/js/music-page.js'), '上传预填（M2）在 music-page.js 之前');
  assert.match(read('space/web/content/music/_index.md'), /^outputs: \[HTML, musicsitemap\]$/m);
  assert.match(read('space/web/content/music/_index.zh.md'), /^url: \/music\/zh\/$/m);
  assert.match(musicBase, /errorf "合站：中文页 %s 的地址 %s 不在 \/music\/zh\/ 下/);
});

test('弹出播放器页（音乐第二步 2b；2026-11 第 7 步进 Platform；music 搬家第 3 步起 /music/player/、/music/zh/player/）：部件都在；脚本 music-core.js → music-player.js，不再借奇趣的 curio.js；不管上传 / 删除', () => {
  const player = read('space/web/layouts/common/player.html');
  assert.ok(!existsSync(path.join(REPO, 'space/web/layouts/curio/player.html')), '奇趣下没有播放器模板了');
  for (const f of ['music-player.md', 'music-player.zh.md']) assert.ok(!existsSync(path.join(REPO, 'space/web/content/curio', f)), '奇趣下没有 ' + f);
  assert.match(read('space/web/content/music/player.md'), /^url: \/music\/player\/$/m);
  assert.match(read('space/web/content/music/player.zh.md'), /^url: \/music\/zh\/player\/$/m);
  for (const f of ['player.md', 'player.zh.md']) {
    const c = read('space/web/content/music/' + f);
    assert.match(c, /^type: common$/m); assert.match(c, /^layout: player$/m); assert.match(c, /^navSite: music$/m);
  }
  for (const id of ['mp-app', 'mp-cover', 'mp-title', 'mp-artist', 'mp-album', 'mp-year', 'mp-note', 'mp-signin', 'mp-lyrics', 'mp-line', 'mp-seek', 'mp-time', 'mp-dur',
    'mp-shuffle', 'mp-prev', 'mp-toggle', 'mp-next', 'mp-speed', 'mp-mute', 'mp-volume', 'mp-audio',
    /* 打磨 6.4：两页 + 页点、顶行选歌 / ⋯、队列键、歌词页小播放条、两个悬浮卡片 */
    'mp-pager', 'mp-dots', 'mp-pg-player', 'mp-pg-lyrics', 'mp-pick', 'mp-more-btn', 'mp-queue-btn', 'mp-d-toggle', 'mp-queue', 'mp-q-list', 'mp-q-mode', 'mp-more', 'mp-m-list']) {
    assert.ok(hasId(player, id), id);
  }
  assert.match(player, /id="mp-app" class="mp-app hidden"/);
  /* 打磨 6.4（v2 稿）：播放器没有曲目列表、没有专辑列表（选歌只在 /music/） */
  for (const id of ['mp-tracks', 'mp-albums-btn', 'mp-albums']) assert.ok(!hasId(player, id), '播放器不选歌：' + id);
  /* 队列、⋯ 是非模态悬浮卡片（同上传窗 .sgx-qp），不是底部抽屉 */
  assert.match(player, /<dialog id="mp-queue" class="sgx-qp mp-dlg mp-queue"/);
  assert.match(player, /<dialog id="mp-more" class="sgx-qp mp-dlg mp-more"/);
  assert.equal((player.match(/class="mu-ic-lock"/g) || []).length, 2, '两颗播放键（播放页 + 歌词页小播放条）都带锁标（没进站 / 登录过期）');
  for (const id of ['mu-upload', 'mu-up-wrap', 'mu-album-del']) assert.ok(!hasId(player, id), '播放器不管理：' + id);
  assert.doesNotMatch(player, /curio\/js\/|partial "curio\//, 'Platform 页不引产品的脚本 / partial（规则 23）');
  const b = player.indexOf('js/music/music-core.js'), c = player.indexOf('js/music/music-player.js');
  assert.ok(b > 0 && b < c, '共用核在 music-player.js 之前');
  assert.match(player, /<script id="sgx-i18n-curioPlayer"/);
});

test('收录按 R-23：公开页（含电影，Gray 2026-11-16）不带 noindex，只有 404 带；外观和语言跟主站（ui-inherit-run 在样式前）', () => {
  assert.match(base, /\{\{ if \$is404 \}\}<meta name="robots" content="noindex">\n\{\{ end -\}\}/);
  assert.doesNotMatch(base, /eq \.Layout "movies"/, '电影页不再单独 noindex');
  assert.equal((base.match(/<meta name="robots"/g) || []).length, 1, 'robots 只有这一处、带条件');
  assert.ok(base.indexOf('ui-inherit-run.js') < base.indexOf('css/main.css'));
  assert.doesNotMatch(base + index + finds + devices + games + movies + music, /daymark|日刻分区|dm-/);
  /* 站点地图只列首页（子页、尤其电影 / 音乐不进） */
  const sm = read('space/web/layouts/curio/section.curiositemap.xml');
  assert.doesNotMatch(sm, /music|movies|\.Pages|RegularPages/);
});

test('robots.txt 只在图志根（root/robots.txt；R-23 起放开收录，挡 /curio/api/、列本站 sitemap）：本站不生成（Hugo 内置 robots 模板关掉），space/web/static/curio 里也不放', () => {
  /* 合站后只有一份 hugo.yaml（space/web/hugo.yaml），robots.txt 只出在根上：本站没有自己的 robots 模板 */
  assert.equal(existsSync(path.join(REPO, 'space/web/layouts/curio/robots.txt')), false);
  assert.equal(existsSync(path.join(REPO, 'space/web/static/curio/robots.txt')), false);
  const robots = read('space/web/static/robots.txt');
  assert.match(robots, /^Disallow: \/curio\/api\/$/m);
  assert.match(robots, /^Disallow: \/music\/api\/$/m, 'music 搬家第 3 步：音乐接口也挡');
  assert.match(robots, /^Sitemap: https:\/\/styrigx\.com\/music\/sitemap\.xml$/m);
  assert.match(robots, /^Sitemap: https:\/\/styrigx\.com\/curio\/sitemap\.xml$/m);
});

test('head 内联脚本不打包整份 palette-list.json（预设表 / 深套表在共享读端里；自定义色引擎 2026-11-12 删除）', () => {
  for (const f of ['space/web/assets/curio/js/sgx/ui-inherit-run.js', 'space/web/assets/curio/js/sgx/topbar-host.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /^import .*palette-list\.json/m, f);
    assert.doesNotMatch(src, /@params/, f);
  }
  /* 2026-11-04 P5-1：快捷设置页的调色板色块在构建时从 palette-list.json 算出 CSS 变量（只进 style 属性），
     不进 <head>、不进任何 <script>，也不整份输出（不 jsonify） */
  const head = base.slice(0, base.indexOf('</head>'));
  assert.doesNotMatch(head, /palette-list\.json/);
  const uses = [...base.matchAll(/[^\n]*palette-list\.json[^\n]*/g)].map((m) => m[0]).filter((l) => !/^\{\{\/\*/.test(l));
  /* 合站：色块直接读主站 data/common/palette-list.json（site.Data），模板里不再 resources.Get 副本 */
  assert.deepEqual(uses, []);
  /* 调色板 v4：<head> 里的 color-scheme / theme-color 默认值取默认调色板 terra 的 mode / 底色（只读两项，不整份输出） */
  assert.deepEqual([...base.matchAll(/[^\n]*index site\.Data\.common "palette-list"[^\n]*/g)].map((m) => m[0]), ['{{- range (index site.Data.common "palette-list").presets }}{{ if eq .id "terra" }}', '{{ range (index site.Data.common "palette-list").presets }}']);
  assert.doesNotMatch(base, /palette-list\.json[^\n]*jsonify/);
  assert.match(base, /<script>\{\{ \(resources\.Get "common\/js\/prefs\/ui-cookie-read\.js" \| minify\)\.Content \| safeJS \}\}<\/script>/);
  assert.match(base, /js\/sgx\/ui-inherit-run\.js" \| js\.Build \(dict "format" "iife" "minify" true "target" "es2018"\)\)/);
});

test('测试构建不问新加的读接口（对齐 PR-C2）：SGX_TEST_NO_WEATHER=1 时 <html data-sgx-test-no-api>；生产构建不加属性；奇趣重组 PR 2 起 curio-list.js 没有 tab 计数，不再问别的分区接口', () => {
  for (const b of [base, gamesBase]) assert.match(b, /\{\{ if eq \(getenv "SGX_TEST_NO_WEATHER"\) "1" \}\} data-sgx-test-no-api\{\{ end \}\}>/);
  const js = read('space/web/assets/curio/js/curio-list.js');
  assert.doesNotMatch(js, /countSources|data-cu-count|\/curio\/api\/(links|items|movies)/, 'curio-list.js 不问接口');
});

test('打磨 6.2：音乐样式不再 @import curio-tail.css（只在奇趣 main.css 里引一次，奇趣那份先引）；歌词框等宽这条排在后面、同权重，所以生效', () => {
  const muCss = read('space/web/assets/music/css/input.css');
  assert.doesNotMatch(muCss.replace(/\/\*[\s\S]*?\*\//g, ''), /@import\s+["'][^"']*curio-tail\.css/);
  assert.match(muCss, /^\.mu-ed-lrc textarea \{ min-height: 9\.5em; font-family: var\(--sgx-font-mono\); font-size: 14px;[^}]*white-space: pre; overflow-wrap: normal; overflow-x: auto; \}$/m);
  assert.match(read('space/web/layouts/music/section.html'), /<textarea id="mu-ed-lrc" rows="7" wrap="off"/);
  assert.match(read('space/web/assets/curio/css/input.css'), /^@import "\.\/curio-tail\.css";$/m);
  assert.ok(musicBase.indexOf('"curio/css/main.css"') > 0 && musicBase.indexOf('"curio/css/main.css"') < musicBase.indexOf('"music/css/main.css"'), '奇趣 main.css 在音乐 main.css 之前');
});
