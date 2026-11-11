/* 内容页共用件（共享外壳 @inpage 段，gen-shell 抽成 assets/css/shell/shell.css；原 segtabs.test.mjs，对齐 PR-C2 改名）：
   - 页头 sgx-ph.html（2026-11 对齐 PR-C 取代 sgx-page-hero.html；合站后四站直接用主站这一份）
   - 对齐 PR-C 共用件（chips / 文章行 / 分页条 / 两窗）、对齐 PR-C2 共用件（下划线 tab .sgx-ctab、grep、命令链 .sgx-cmd、封面卡 .sgx-cc、排序、条目页 .sgx-item / .sgx-spec）
   - 段式标签 sgx-segtabs.html / 平铺入口 sgx-entries.html 在对齐 PR-C2 退役（文件、样式、gen-shell 核对都删了）
   - 对比度审计：22 套预设（2026-11-12 调色板 v4 起每套一个模式，自定义色删除），nav-selected 这组角色（顶栏 / 锁屏还在用）放在页面底色 / 表面色上，非当前项文字 ≥ 4.5:1、当前项 ≥ 4.5:1 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { SHELL_REGIONS } from '../../../../space/scripts/gen-shell.mjs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const has = (p) => existsSync(new URL('../../../../' + p, import.meta.url));
const shell = rd('space/web/assets/css/shell/shell.css');

test('共享外壳：inpage 段进 shell.css；段式标签 / 平铺入口退役（对齐 PR-C2：组件、样式段、gen-shell 区段都删了）', () => {
  assert.ok(SHELL_REGIONS.includes('inpage'));
  assert.ok(!SHELL_REGIONS.includes('entries'));
  assert.match(shell, /\.sgx-ph-title \{/);
  assert.doesNotMatch(shell, /\.sgx-segs|\.sgx-ents|\.sgx-ent-/, '段式标签 / 平铺入口样式删除');
  for (const f of ['sgx-segtabs.html', 'sgx-entries.html']) assert.ok(!has('space/web/layouts/partials/' + f), f + ' 已删除');
  assert.doesNotMatch(rd('space/scripts/gen-shell.mjs'), /renderSegtabs|renderEntries|'segtabs\.html'|'entries\.html'/);
});

test('对齐 PR-C2 共用件（设计稿 tb4.html pg=curio / citem / day）：下划线 tab、grep、命令链、封面卡（桌面 3 栏 150px / 手机 2 栏 90px）、排序、条目页两栏（桌面 1fr 1fr、图 420 / 手机 220）、虚线 spec 表', () => {
  assert.match(shell, /\.sgx-ctab \{[^}]*gap: 22px;[^}]*border-bottom: 1px solid var\(--sgx-term-line\);[^}]*font-size: 13\.5px;/);
  assert.match(shell, /\.sgx-ctab-a\[aria-current="page"\] \{ color: var\(--sgx-text-primary\); border-bottom-color: var\(--sgx-primary\); \}/);
  assert.match(shell, /\.sgx-ctab-a i \{[^}]*font-size: 11px;/, '计数小字');
  assert.match(shell, /\.sgx-grep \{[^}]*margin-left: auto;/);
  assert.match(shell, /\.sgx-cmd \{[^}]*border: 1px dashed var\(--sgx-term-line\);/);
  assert.match(shell, /\.sgx-cmd-k \{ color: var\(--sgx-primary\); \}/);
  assert.match(shell, /\.sgx-cgrid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 14px;/);
  assert.match(shell, /:root\[data-sgx-layout="desktop"\] \.sgx-cgrid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(shell, /\.sgx-cc \{[^}]*border-radius: 12px;/);
  assert.match(shell, /\.sgx-cc-im \{[^}]*height: 90px;/);
  assert.match(shell, /:root\[data-sgx-layout="desktop"\] \.sgx-cc-im \{ height: 150px; \}/);
  assert.match(shell, /\.sgx-cc-k \{[^}]*color: var\(--sgx-warning\);/, '#标签黄色');
  assert.match(shell, /:root\[data-sgx-layout="desktop"\] \.sgx-item \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); gap: 36px; \}/);
  assert.match(shell, /\.sgx-item-im \{[^}]*height: 220px;/);
  assert.match(shell, /:root\[data-sgx-layout="desktop"\] \.sgx-item-im \{ height: 420px; \}/);
  assert.match(shell, /:root\[data-sgx-layout="desktop"\] \.sgx-item-t \{ font-size: 36px; \}/);
  assert.match(shell, /\.sgx-spec \{[^}]*font-size: 13px; line-height: 2\.05;/);
  assert.match(shell, /\.sgx-spec > div \{[^}]*border-bottom: 1px dashed var\(--sgx-term-line\);/);
});

test('页头 .sgx-ph（2026-11 对齐 PR-C，设计稿 .hero.ph）：$ 命令 · 标题_ · 一行说明，两种布局都显示（不再桌面视觉隐藏）；旧 .sgx-hero 标题带退役', () => {
  assert.doesNotMatch(shell, /\.sgx-hero(-title|-desc|--term)?\b/, '旧标题带样式删除');
  assert.doesNotMatch(shell, /\.sgx-ph[^{]*\{[^}]*(clip-path: inset\(50%\)|display: none)/, '页头不隐藏');
  assert.match(shell, /\.sgx-ph-title \{[^}]*font-family: var\(--sgx-font-mono\); font-size: 40px;/, '手机 40px');
  assert.match(shell, /:root\[data-sgx-layout="desktop"\] \.sgx-ph-title \{ font-size: 64px; \}/, '桌面 64px');
  assert.match(shell, /\.sgx-ph-title::after \{ content: "_" \/ ""; color: var\(--sgx-primary\); \}/, '「_」是 CSS ::after（读屏不念）');
  assert.doesNotMatch(shell, /\[data-sgx-layout="[a-z]+"\][^{]*\.sgx-segs[^{]*\{[^}]*display: none/, '段式标签不按布局隐藏');
  const ph = rd('space/web/layouts/partials/sgx-ph.html');
  assert.match(ph, /<header class="sgx-ph" data-sgx-ph>/);
  /* 环境提示符规则（进站 v3 L1）：谁登录显示谁（Gray 11-11 22:46）——三种都写，CSS 按 <html data-sgx-account-session> 只显示一种 */
  assert.match(ph, /<p class="sgx-ph-cmd" aria-hidden="true" translate="no"><span class="sgx-pr"><span class="sgx-envps-n" translate="no">nobody@space:~\$<\/span><span class="sgx-envps-g sgx-envps-u" translate="no">styrigx<\/span><span class="sgx-envps-g" translate="no">@space:~\$<\/span><span class="sgx-envps-r" translate="no">root@space:~#<\/span><\/span> \{\{ \.cmd \}\}<\/p>/);
  assert.ok(shell.includes('html[data-sgx-account-session="out"] .sgx-envps-n, html[data-sgx-account-session="in"] .sgx-envps-n,\nhtml:not([data-sgx-account-session="out"]) .sgx-envps-g, html:not([data-sgx-account-session="in"]) .sgx-envps-r { display: none; }'), '按登录身份只显示一种');
  assert.match(ph, /if not \.cmd \}\}\{\{ errorf "sgx-ph:/, '缺命令构建失败');
  assert.match(ph, /if not \.desc \}\}\{\{ warnf "sgx-ph:/, '缺说明只警告');
  assert.ok(!has('space/web/layouts/partials/sgx-page-hero.html'), 'sgx-page-hero.html 退役');
  /* 2026-11 合站：三个子站的样式表直接 @import 这份 shell.css（不再同步副本） */
  for (const site of ['blog', 'curio', 'daymark']) {
    assert.match(rd(`space/web/assets/${site}/css/input.css`), /@import ['"]\.\.\/\.\.\/css\/shell\/shell\.css['"];/, site + ' 引入共享外壳 shell.css');
  }
});

test('对齐 PR-C 共用件：chips（当前项 aria-current 主题色描边）、文章行（桌面 70px 1fr auto 60px，摘要两行）、less 分页条、两窗 1.25fr : 1fr', () => {
  assert.match(shell, /\.sgx-chip\[aria-current="true"\] \{ border-color: var\(--sgx-primary\); color: var\(--sgx-primary\);/);
  assert.match(shell, /\.sgx-chip--more \{ margin-left: auto; border-style: dashed; \}/);
  assert.match(shell, /\.sgx-pl \{ display: grid; grid-template-columns: 70px minmax\(0, 1fr\) auto 60px;/);
  assert.match(shell, /\.sgx-pl-ex \{[^}]*-webkit-line-clamp: 2;/);
  assert.match(shell, /\.sgx-pg-l b \{[^}]*background: var\(--sgx-text-primary\);/);
  assert.match(shell, /:root\[data-sgx-layout="desktop"\] \.sgx-tw \{ grid-template-columns: minmax\(0, 1\.25fr\) minmax\(0, 1fr\);/);
});

test('inpage 段只用 --sgx-* 角色，不写死颜色', () => {
  /* 只用 --sgx-* 角色，不写死颜色 */
  const region = shell.slice(shell.indexOf('/* ---- inpage ---- */'), shell.indexOf('/* ---- wide ---- */'));
  assert.ok(region.length > 200);
  assert.doesNotMatch(region, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});

test('共享外壳：sgx-ph.html 只有主站一份（2026-11 合站后三个子站直接调用，没有副本）', () => {
  for (const site of ['blog', 'curio', 'daymark']) {
    assert.ok(!has(`space/web/layouts/partials/${site}/sgx-shell-segtabs.html`), site);
    assert.ok(!has(`space/web/layouts/partials/${site}/sgx-shell-page-hero.html`), site);
  }
});

test('子站接入（对齐 PR-C2）：奇趣五个分区页同一个页头（页头 + 下划线 tab + grep + 命令链），日刻拾录 / 百味各一个页头 + cd ..；博客首页 / 目录页 / 标签页用 sgx-ph；都不用段式标签 / 平铺入口', () => {
  for (const id of ['devices', 'games', 'movies', 'music']) {
    assert.match(rd(`space/web/layouts/curio/${id}.html`), new RegExp(`partial "curio/page-head\\.html" \\(dict "page" \\. "id" "${id}"`), id);
  }
  assert.match(rd('space/web/layouts/partials/curio/finds-main.html'), /partial "curio\/page-head\.html" \(dict "page" \$p "id" "finds"/);
  for (const f of ['finds.html', 'section.html']) assert.match(rd('space/web/layouts/curio/' + f), /partial "curio\/finds-main\.html"/, f);
  for (const id of ['finds', 'devices', 'games', 'movies', 'music']) for (const f of [`${id}.md`, `${id}.zh.md`]) assert.match(rd(`space/web/content/curio/${f}`), /^description: '.+'$/m, f);
  const head = rd('space/web/layouts/partials/curio/page-head.html');
  assert.match(head, /partial "sgx-ph\.html"/);
  assert.match(head, /<div class="sgx-ctab" id="cu-tabs">/);
  assert.match(head, /range \(slice "finds" "devices" "games" "movies" "music"\)/);
  assert.match(head, /data-ctab="\{\{ \. \}\}"[^>]*\{\{ if eq \. \$cur \}\} aria-current="page"\{\{ end \}\}/);
  assert.match(head, /<i data-cu-count="\{\{ \. \}\}"><\/i>/);
  assert.match(head, /class="sgx-grep" data-cu-grep/);
  assert.match(head, /<div class="sgx-cmds" id="cu-cmds">/);
  /* v5 S3：音乐歌单公开，tab 不再按权限藏 */
  assert.doesNotMatch(rd('space/web/assets/curio/css/input.css'), /cu-music-ok/);
  const dm = rd('space/web/layouts/daymark/section.html');
  assert.equal((dm.match(/partial "sgx-ph\.html"/g) || []).length, 2, 'daymark');
  for (const id of ['trove', 'flavors']) assert.match(dm, new RegExp(`partial "sgx-ph\\.html" \\(dict "cmd" "ls daymark/${id}/" .*"tag" "h2"\\) \\}\\}\\n\\s*<div class="sgx-cmds">`), 'daymark ' + id);
  for (const f of ['layouts/daymark/section.html', 'layouts/curio/section.html', 'layouts/partials/curio/page-head.html', 'layouts/blog/section.html', 'layouts/blog/tree.html', 'layouts/blog/term.html']) {
    assert.doesNotMatch(rd('space/web/' + f), /sgx-segtabs|sgx-entries/, f);
  }
  for (const f of ['section.html', 'tree.html', 'term.html']) assert.match(rd(`space/web/layouts/blog/${f}`), /partial "sgx-ph\.html" \(dict "cmd" /, 'blog ' + f);
});

test('主站内容页：页头接入（带命令），front matter 都有 description（中英）', () => {
  /* 对齐 PR-B：数字健康 / 关于本站并进旷野页（旧内容删除）；对齐 PR-C：风格页 theme 退役；2026-11-12：旷野删除，状态单独成页 status */
  for (const p of ['wellbeing', 'about', 'wild', 'theme']) for (const f of [`space/web/content/${p}.md`, `space/web/content/zh/${p}.md`]) assert.ok(!has(f), f + ' 应已删除');
  /* 2026-11-08 账号整页删了（账号都在顶栏头像的账号终端里） */
  const pages = ['status'];
  /* 进站 v3 L1：安全页（/security/、/security/lock/、/security/tempkeys/）删了，盾牌下拉 */
  for (const p of ['security', 'security-lock', 'security-tempkeys']) for (const f of [`space/web/content/${p}.md`, `space/web/content/zh/${p}.md`, `space/web/layouts/_default/${p}.html`]) assert.ok(!has(f), f + ' 应已删除');
  /* 2026-11-08 云同步子页删除（Gray 04:47） */
  for (const f of ['space/web/content/account-sync.md', 'space/web/content/zh/account-sync.md', 'space/web/layouts/_default/account-sync.html']) assert.ok(!has(f), f + ' 应已删除');
  for (const p of pages) for (const f of [`space/web/content/${p}.md`, `space/web/content/zh/${p}.md`]) assert.match(rd(f), /^description: '.+'$/m, f);
  for (const l of pages) {
    assert.ok(has(`space/web/layouts/_default/${l}.html`), l);
    assert.match(rd(`space/web/layouts/_default/${l}.html`), /partial "sgx-ph\.html" \(dict "cmd" "[^"]+" "title" \.Title "desc" \.Description "path" \.File\.Path\)/, l);
  }
});

/* 对比度（同 topbar-pr4a.test.mjs 的算法；nav-selected 这组角色放在页面里：底 = 页面底色或表面色） */
const rgba = (h) => {
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  const a = /rgba?\(([^)]+)\)/.exec(h)[1].split(',').map(Number);
  return [a[0], a[1], a[2], a[3] ?? 1];
};
const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat(1);
const lum = (c) => { const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const cr = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const check = (t, label) => {
  for (const base of ['background', 'surface']) {
    const ns = rgba(t['nav-selected']);
    const bg = over([ns[0], ns[1], ns[2], 0.45], rgba(t[base]));
    assert.ok(cr(rgba(t['text-primary']), bg) >= 4.5, `${label} ${base} 非当前项`);
  }
  assert.ok(cr(rgba(t['on-nav-selected']), rgba(t['nav-selected'])) >= 4.5, `${label} 当前项`);
};

test('对比度：22 套预设（每套一个模式），nav-selected 非当前项 / 当前项文字 ≥ 4.5:1', () => {
  const { presets } = JSON.parse(rd('space/web/data/shell/palettes.json'));
  assert.equal(presets.length, 25);
  for (const p of presets) check(p.tokens, `${p.id} ${p.mode}`);
});
