// 页面模板（atlas/web/curio/layouts）：沉浸式 app 顶栏（长条是 发现 / 设备 / 游戏 分段滑块，没有搜索栏）、抽屉同主站、首页部件都在、不被搜索引擎收录。
// 只读模板源码，不用构建；构建后的行为在手机 E2E（tests/curio/e2e）。
// 运行：node --test tests/curio/layout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const base = read('atlas/web/curio/layouts/_default/baseof.html');
const index = read('atlas/web/curio/layouts/index.html');

test('顶栏（2026-11-04 P5-1，四站同一个）：共享外壳 sgx-shell-topbar.html；中间 = 首页分段滑块 / 其他页页名；右边快捷面板 · AI · 头像；没有九宫格、抽屉、右圆分享', () => {
  assert.match(base, /\{\{ partial "sgx-shell-topbar\.html" \(dict\n/);
  assert.match(base, /"site" "curio"/);
  for (const [id, zh, en, hash] of [['finds', '发现', 'Finds', ''], ['devices', '设备', 'Devices', '#devices'], ['games', '游戏', 'Games', '#games']]) {
    assert.match(base, new RegExp('\\(dict "id" "' + id + '" "zh" "' + zh + '" "en" "' + en + '" "hash" "' + hash + '"\\)'), id);
  }
  /* 中间原样搬进来：首页分段滑块（role=tablist、页签 role=tab），其他页（404）只有页名 */
  assert.match(base, /\{\{ if \.IsHome \}\}\n\{\{ \$center = printf "<div class=\\"sgx-seg\\" role=\\"tablist\\"[^\n]*data-cu-seg/);
  assert.match(base, /role=\\"tab\\" class=\\"sgx-seg-btn\\"[^\n]*data-cu-tab=/);
  assert.match(base, /\{\{ else \}\}\n\{\{ \$center = printf "<span class=\\"sgx-tb-title\\">%s<\/span>" \(htmlEscape \$pageName\) \}\}/);
  assert.doesNotMatch(base, /sgx-seg--none/);
  /* 九宫格、导航抽屉、右圆分享和它们的脚本都删了（标记在共享外壳，本站模板里不再手写顶栏） */
  assert.doesNotMatch(base, /sgx-tb-nav|sgx-drawer|sgx-tb-end|sgx-tb-share|<header|apps-grid|sgx-tb-end-group|sgx-tb-gbtn|guestbook/);
  const code = base.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, ''); /* 去掉模板注释（注释里会提到被取代的旧文件） */
  assert.doesNotMatch(code, /share-host\.js|js\/topbar\.js|search-host\.js|shell-nav-href/);
  assert.equal(existsSync(path.join(REPO, 'atlas/web/curio/assets/js/sgx/share-host.js')), false);
  assert.equal(existsSync(path.join(REPO, 'atlas/web/curio/assets/js/topbar.js')), false);
  assert.equal(existsSync(path.join(REPO, 'atlas/web/curio/layouts/partials/shell-nav-href.html')), false);
  assert.match(base, /resources\.Get "js\/sgx\/topbar-host\.js" \| js\.Build/);
  /* 本站页面原来都有分享按钮 → 快捷设置页都有「分享本页」磁贴；立即锁定、布局只在主站（定案第 4、5 条） */
  assert.match(base, /"tiles" \(dict "theme" true "lang" true "palette" true "share" true\)/);
  const host = read('atlas/web/curio/assets/js/sgx/topbar-host.js');
  for (const m of ['./shell/topbar.js', './shell/modal-sheet.js', './shell/ai.js', './shell/vk.js', './shell/prefs-write.js', './shell/share.js']) {
    assert.match(host, new RegExp("from '" + m.replace(/[.\/]/g, '\\$&') + "'"), m);
  }
});

test('没有版权页脚（© / Powered by），样式也删干净', () => {
  const css = read('atlas/web/curio/assets/css/input.css');
  assert.doesNotMatch(base, /<footer|©|Powered by/);
  assert.doesNotMatch(css.slice(css.indexOf('/* @sgx-shell:end */')), /(^|[\s,}])footer\b|sgx-powered|sgx-tb-me/);
});

test('留言板撤了（2026-10-24）：没有 /guestbook/ 页面、模板、脚本、Giscus 配置和样式', async () => {
  const { existsSync } = await import('node:fs');
  for (const f of ['atlas/web/curio/layouts/_default/guestbook.html', 'atlas/web/curio/content/guestbook.md', 'atlas/web/curio/content/en/guestbook.md', 'atlas/web/curio/assets/js/guestbook.js']) {
    assert.equal(existsSync(new URL('../../' + f, import.meta.url)), false, f);
  }
  assert.doesNotMatch(read('atlas/web/curio/hugo.yaml'), /guestbook|giscus/i);
  const css = read('atlas/web/curio/assets/css/input.css');
  assert.doesNotMatch(css.slice(css.indexOf('/* @sgx-shell:end */')), /cu-gb-|giscus|guestbook/);
});

test('导航：快捷面板第 1 页用主站共享外壳的 nav.json（主站 / 奇趣 / 日刻 / 博客），模板不写死项；奇趣是当前项；主站项走 https://styrigx.com', () => {
  const nav = JSON.parse(readFileSync(path.join(REPO, 'atlas/web/curio/assets/sgx-shell/nav.json'), 'utf8'));
  assert.deepEqual(nav.items.map((i) => i.zh), ['主站', '奇趣', '日刻', '博客']);
  assert.deepEqual(nav.footer, []);
  assert.equal(nav.me.href, 'https://styrigx.com/account/');
  assert.match(base, /\{\{ \$shellNav := resources\.Get "sgx-shell\/nav\.json" \| transform\.Unmarshal \}\}/);
  assert.match(base, /"nav" \$shellNav\n/);
  assert.match(base, /"mainOrigin" "https:\/\/styrigx\.com"/);
  /* 项、页脚、当前项高亮都在共享外壳 partial 里（range .nav.items / with .nav.footer / eq .id $.site） */
  const tb = read('atlas/web/curio/layouts/partials/sgx-shell-topbar.html');
  assert.match(tb, /range \.nav\.items/);
  assert.match(tb, /with \.nav\.footer/);
  assert.match(tb, /if eq \.id \$\.site \}\} aria-current="page"/);
  /* 导航页不放搜索框（定案第 2 条） */
  assert.doesNotMatch(tb, /type="search"|role="search"|sgx-drawer-search|nav\.search/);
  assert.doesNotMatch(base, /主页|书库/);
});

test('首页部件：分类条、格子、收藏按钮、更多菜单（分类 / 导入 / 导出）、编辑弹层、确认', () => {
  for (const id of ['cu-chips', 'cu-menu-btn', 'cu-list', 'cu-empty', 'cu-fab', 'menu-cats', 'menu-import', 'menu-export',
    'f-url', 'f-fill', 'f-name', 'f-name2', 'f-desc', 'f-desc2', 'f-cats', 'f-cat-name', 'f-icon', 'f-private', 'f-up', 'f-down', 'edit-del', 'edit-save',
    'cats-list', 'cats-new', 'imp-file', 'imp-private', 'imp-go', 'confirm-ok']) {
    assert.match(index, new RegExp('id="' + id + '"'), id);
  }
  assert.match(index, /id="menu-export"[^>]*href="\{\{ "api\/export" \| relURL \}\}/);
  assert.match(index, /id="imp-private"[^>]*checked/);
});

test('三个面板 + 设备 / 游戏的部件：筛选条、列表、新建按钮、详情、编辑弹层（照片、日期、退役、关联设备、状态、评分）', () => {
  assert.match(index, /<section id="cu-pane-finds" class="cu-pane" role="tabpanel" aria-labelledby="cu-tab-finds">/);
  assert.match(index, /<section id="cu-pane-devices"[^>]*hidden inert>/);
  assert.match(index, /<section id="cu-pane-games"[^>]*hidden inert>/);
  for (const id of ['dv-chips', 'dv-list', 'dv-empty', 'dv-fab', 'gm-chips', 'gm-list', 'gm-empty', 'gm-fab',
    'it-view-wrap', 'it-view-edit', 'it-view-body',
    'dv-photo', 'dv-photo-del', 'dv-name', 'dv-kind', 'dv-bought', 'dv-os', 'dv-specs', 'dv-acc', 'dv-notes', 'dv-retired', 'dv-retired-at', 'dv-replaced', 'dv-private', 'dv-del', 'dv-save',
    'gm-photo', 'gm-title', 'gm-status', 'gm-platform', 'gm-platforms', 'gm-device', 'gm-edition', 'gm-rating', 'gm-review', 'gm-private', 'gm-del', 'gm-save']) {
    assert.match(index, new RegExp('id="' + id + '"'), id);
  }
  assert.match(index, /id="dv-bought" type="date"/);
  /* 脚本顺序：curio.js（确认框等）→ curio-items.js → curio-tabs.js */
  const a = index.indexOf('js/curio.js'), b = index.indexOf('js/curio-items.js'), c = index.indexOf('js/curio-tabs.js');
  assert.ok(a > 0 && a < b && b < c);
});

test('不被收录、外观和语言跟主站（ui-inherit-run 在样式前）', () => {
  assert.match(base, /<meta name="robots" content="noindex">/);
  assert.ok(base.indexOf('ui-inherit-run.js') < base.indexOf('css/main.css'));
  assert.doesNotMatch(base + index, /daymark|日刻分区|dm-/);
});

test('robots.txt 只在图志根（root/robots.txt，Disallow: /）：本站不生成（Hugo 内置 robots 模板关掉），atlas/web/curio/static 里也不放', () => {
  assert.match(read('atlas/web/curio/hugo.yaml'), /^enableRobotsTXT: false$/m);
  assert.equal(existsSync(path.join(REPO, 'atlas/web/curio/static/robots.txt')), false);
  assert.match(read('space/web/static/robots.txt'), /^User-agent: \*\nDisallow: \/$/m);
});

test('head 内联脚本和自定义色引擎不打包整份 palettes.json（预设表在共享读端里，引擎版本用读端的 SCHEME_VER）', () => {
  for (const f of ['atlas/web/curio/assets/js/sgx/ui-inherit-run.js', 'atlas/web/curio/assets/js/sgx/shell-accent.js', 'atlas/web/curio/assets/js/sgx/topbar-host.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /^import .*palettes\.json/m, f);
    assert.doesNotMatch(src, /@params/, f);
  }
  /* 2026-11-04 P5-1：快捷设置页的调色板色块在构建时从 palettes.json 算出 CSS 变量（只进 style 属性），
     不进 <head>、不进任何 <script>，也不整份输出（不 jsonify） */
  const head = base.slice(0, base.indexOf('</head>'));
  assert.doesNotMatch(head, /palettes\.json/);
  const uses = [...base.matchAll(/[^\n]*palettes\.json[^\n]*/g)].map((m) => m[0]).filter((l) => !/^\{\{\/\*/.test(l));
  assert.deepEqual(uses, ['{{ range (resources.Get "sgx-shell/palettes.json" | transform.Unmarshal).presets }}']);
  assert.doesNotMatch(base, /palettes\.json[^\n]*jsonify/);
  assert.match(base, /<script>\{\{ \(resources\.Get "js\/sgx\/shell\/ui-cookie-read\.js" \| minify\)\.Content \| safeJS \}\}<\/script>/);
  assert.match(base, /js\/sgx\/ui-inherit-run\.js" \| js\.Build \(dict "format" "iife" "minify" true "target" "es2018"\)\)/);
});
