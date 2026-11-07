/**
 * 共享外壳 space/web/shared/shell（space/scripts/gen-shell.mjs 生成，子站 sync-shell.mjs 同步）：
 * 生成物必须和源头一致；外壳 CSS 只用色彩角色，不写死颜色；导航项 / 图标齐全；顶栏标记 topbar.html 四站一份（2026-11-04 P5-1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderAll, OUT_DIR, SHELL_REGIONS, extractRegion } from '../../../../space/scripts/gen-shell.mjs';
import yaml from 'js-yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const files = renderAll();
const ROLES = JSON.parse(readFileSync(path.join(REPO, 'space/web/data/palette-roles.json'), 'utf8'));

test('space/web/shared/shell 和源头一致（改了源头要重跑 node space/scripts/gen-shell.mjs）', () => {
  for (const [k, v] of Object.entries(files)) assert.equal(readFileSync(path.join(OUT_DIR, k), 'utf8'), v, k);
});

test('宽屏平铺（Gray 2026-11-07）：只在桌面布局——内容区通栏、去卡片公共件 .sgx-flat / .sgx-wide-cols；手机布局不变；交互模块不挂', () => {
  const s = files['shell.css'];
  // 桌面外壳框通栏（不对齐顶栏），手机仍 640；顶栏宽不变
  assert.match(s, /:root\[data-sgx-layout="desktop"\] \{ --sgx-content-max: 100%;/);
  assert.match(s, /:root\[data-sgx-layout="phone"\] \{ --sgx-content-max: 640px; \}/);
  assert.doesNotMatch(s, /--sgx-content-max: 1440px/);
  // 公共件只在桌面布局生效
  for (const sel of ['.sgx-flat', '.sgx-wide-cols', '.sgx-wide-h']) {
    const rules = s.match(new RegExp('[^}]*\\' + sel + ' \\{', 'g')) || [];
    assert.ok(rules.length > 0, sel);
    for (const r of rules) assert.match(r, /:root\[data-sgx-layout="desktop"\] \S+ \{$/, sel + ' 只在桌面布局');
  }
  assert.match(s, /\.sgx-flat \{ background: transparent; border: 0; border-radius: 0; box-shadow: none;/);
  // 交互模块保留卡片：风格页（调色板）、数字健康（屏幕时间）、安全页、旷野页的屏幕时间不挂 .sgx-flat
  const web = path.join(REPO, 'space/web/layouts');
  for (const f of ['partials/setcat-theme.html', 'partials/setcat-wellbeing.html', '_default/security.html', '_default/security-lock.html', '_default/account.html']) {
    assert.doesNotMatch(readFileSync(path.join(web, f), 'utf8'), /sgx-flat/, f);
  }
  const home = readFileSync(path.join(web, 'index.html'), 'utf8');
  assert.match(home, /id="w-profile" class="widget sgx-flat /);
  assert.match(home, /id="w-daymark" [^>]*class="widget sgx-flat /);
  assert.doesNotMatch(home, /id="w-screen"[^>]*sgx-flat/);
});

test('manifest 的 sha256 对得上每个文件', () => {
  const m = JSON.parse(files['manifest.json']);
  for (const [k, h] of Object.entries(m.files)) assert.equal(createHash('sha256').update(files[k]).digest('hex'), h, k);
});

test('外壳 CSS 段只用 --sgx-* 角色：没有十六进制颜色、没有旧 --m-* 令牌', () => {
  const css = readFileSync(path.join(REPO, 'space/web/assets/css/input.css'), 'utf8');
  for (const n of SHELL_REGIONS) {
    const r = extractRegion(css, n).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(r, /#[0-9a-fA-F]{3,8}\b/, n);
    assert.doesNotMatch(r, /var\(--m-/, n);
    assert.doesNotMatch(r, /rgba\((?!0,0,0,)/, n + '：除阴影外不许写死 rgba');
  }
});

test('快捷面板（P5-1，替代抽屉；PR-4b 单页 + 导航面板）：非模态窗口在顶栏下面、毛玻璃面板、导航磁贴当前站「开」态；两页 / 抽屉样式全删', () => {
  const s = files['shell.css'];
  assert.match(s, /\.sgx-qp \{ position: fixed; top: var\(--sgx-qp-top\);[^}]*z-index: 45;/, '遮罩在顶栏（z 50+）下面');
  // 毛玻璃两行分开：基础规则只写 -webkit-，标准属性在 @supports 里单独一条（压缩器合并同值两行会丢掉其中一行）
  assert.match(s, /\.sgx-qp-sheet \{[^}]*background: var\(--sgx-mat\); -webkit-backdrop-filter: var\(--sgx-mat-filter\);/);
  assert.match(s, /@supports \(backdrop-filter: blur\(1px\)\) \{\s*\.sgx-qp-sheet \{ backdrop-filter: var\(--sgx-mat-filter\); \}/);
  assert.match(s, /@supports \(backdrop-filter: blur\(1px\)\) \{\s*\.sgx-topbar \{ backdrop-filter: var\(--sgx-mat-filter\); \}/);
  assert.match(s, /--sgx-qp-shadow: 0 4px 12px rgba\(0,0,0,\.10\), 0 16px 48px rgba\(0,0,0,\.24\)/);
  assert.match(s, /\.dark \{ --sgx-qp-shadow: 0 4px 12px rgba\(0,0,0,\.22\), 0 16px 48px rgba\(0,0,0,\.5\)/);
  // 宽屏 400px（AI 440px），右缘对齐外壳框
  // （P4-3 顶栏长度统一：和顶栏一样按 --sgx-tb-w 对齐，100vw 算，不随滚动条变）
  assert.match(s, /:root\[data-sgx-layout="desktop"\] \.sgx-qp-sheet \{ left: auto; right: calc\(\(100% - var\(--sgx-tb-w\)\) \/ 2\); width: min\(400px, var\(--sgx-tb-w\)\); margin: 0; \}\s*:root\[data-sgx-layout="desktop"\] \.sgx-ai \.sgx-qp-sheet \{ width: min\(440px, var\(--sgx-tb-w\)\); \}/);
  // PR-4b：快捷面板只有一页（分段 / 双页滑动删除）；导航面板磁贴复用快捷面板磁贴，当前站 = 「开」态
  assert.doesNotMatch(s, /\.sgx-qp-(tab|tabs|pages|page|nav-item)\b|scroll-snap/, '两页页签 / 横向滑动 / 导航列表样式删了');
  assert.match(s, /\.sgx-qp-tile\[aria-pressed="true"\], \.sgx-qp-tile\[aria-current="page"\] \{ background: var\(--sgx-primary-container\); color: var\(--sgx-on-primary-container\);/);
  assert.doesNotMatch(s, /\.sgx-drawer-(item|sheet|head|brand|body|foot|search|me|sep)\b|--sgx-drawer-/, '抽屉样式全删');
  assert.doesNotMatch(s, /is-fading|is-curtain|--sgx-curtain/);
});

test('nav.json：旷野 / 奇趣 / 日刻 / 博客（PR-4b：主站一项改名旷野，各带一行副标题），没有设置；顶栏 / 磁贴 / AI 图标都在', () => {
  const nav = JSON.parse(files['nav.json']);
  assert.deepEqual(nav.items.map((i) => i.id), ['home', 'curio', 'daymark', 'blog']);
  // 2026-10-21：书签项换成子站 奇趣 Curio（主站书签功能下线）
  const curio = nav.items.find((i) => i.id === 'curio');
  // 合并 PR3：三站和主站同在 styrigx.com（导航页里子站互相是相对地址 /curio/，见 partials/shell-topbar.html）
  assert.deepEqual([curio.icon, curio.origin, curio.path], ['nav-curio', 'https://styrigx.com', '/curio/']);
  // 语言包化（2026-11-07）：nav.json 不再带任何语言的文字，名字 / 副标题在外壳字符串表 i18n-<语言>.yaml 的 nav.<id>.title / sub
  assert.ok(!/"(zh|en|subzh|suben)"\s*:/.test(files['nav.json']), 'nav.json 不带 zh / en 文本');
  assert.ok(!JSON.stringify(nav).includes('atlas.styrigx.com'));
  assert.deepEqual(nav.footer, []);
  assert.ok(![...nav.items, ...nav.footer].some((i) => i.id === 'settings'));
  // P4-2b：搜索层删了，nav.json 没有 search 段，也没有它的 ai-search 图标
  assert.equal(nav.search, undefined);
  assert.equal(nav.icons['ai-search'], undefined);
  // 顶栏头像（子站链到主站账号页）；2026-11-07 个人资料：me.email = data/profile.yaml 的对外联系邮箱（gen-shell 注入，子站 AI 窗口「联系我」默认值）
  const prof = yaml.load(readFileSync(path.join(REPO, 'space/web/data/profile.yaml'), 'utf8'));
  assert.deepEqual(nav.me, { href: 'https://styrigx.com/account/', avatar: 'https://styrigx.com/avatar/192.webp', email: prof.email });
  assert.equal(prof.email, 'styrigx@gmail.com');
  const tr = { en: yaml.load(files['i18n-en.yaml']), zh: yaml.load(files['i18n-zh.yaml']) };
  assert.deepEqual(nav.items.map((i) => tr.zh.nav[i.id].title), ['旷野', '奇趣', '日刻', '博客']);
  assert.deepEqual(nav.items.map((i) => tr.en.nav[i.id].title), ['Space', 'Curio', 'Daymark', 'Blog']);
  for (const i of nav.items) for (const l of ['en', 'zh']) assert.ok(tr[l].nav[i.id].sub, i.id + ' 副标题 ' + l);
  for (const i of [...nav.items, ...nav.footer]) assert.match(nav.icons[i.icon], /^<svg[\s\S]*<\/svg>$/, i.icon);
  for (const k of ['tb-grid', 'tb-sliders', 'tb-chat', 'tb-moon', 'sun', 'tb-globe', 'lock', 'tb-undo', 'share', 'tb-send', 'tb-newchat', 'tb-history']) assert.match(nav.icons[k], /^<svg[\s\S]*<\/svg>$/, k);
  assert.equal(nav.icons['apps-grid'], undefined, '旧九宫格（九个点）不用；PR-4b 的九宫格是 tb-grid');
});

test('palettes.json：22 套七色调色板（每项带 group / bg / 6 前景 + 亮暗 Shell + Semantic token），种子和 tokens.css 的 --sgx-seed 一致', () => {
  const p = JSON.parse(files['palettes.json']);
  assert.equal(p.presets.length, 22);
  assert.deepEqual(p.groups.map((g) => g.id), ['cool', 'nature', 'warm', 'floral', 'neutral']);
  for (const x of p.presets) {
    assert.ok(p.groups.some((g) => g.id === x.group), x.id);
    assert.match(x.bg, /^#[0-9a-f]{6}$/, x.id);
    assert.equal(x.fg.length, 6, x.id);
    assert.equal(x.seed, x.fg[0], x.id + ' 种子 = 前景 1');
    assert.ok(!/^x[a-z]/.test(x.id), x.id + ' 撞色 x* id 已删除');
    for (const m of ['light', 'dark']) {
      const t = x.tokens[m];
      for (const k of ['bg-1', 'bg-7', 'surface', 'topbar-glass', 'primary', 'on-primary', 'primary-container', 'secondary', 'nav-selected', 'link', 'outline-variant', 'text-primary', 'text-secondary', 'chart-1', 'chart-6', 'tag-bg', 'tag-fg'])
        assert.ok(typeof t[k] === 'string' && t[k], `${x.id} ${m} ${k}`);
      // chart-N = 引擎生成的角色（本色 → ink 回退，对比度 / 区分度单测在 palette-scheme.test.mjs）
      for (let i = 1; i <= 6; i++) assert.equal(t['chart-' + i], ROLES.presets[x.id][m]['chart-' + i], `${x.id} ${m} chart-${i}`);
      // 完整导出：填充档、固定状态色、焦点环、状态层、前景四档都在
      for (const k of ['primary-fill', 'on-primary-fill', 'focus-ring', 'danger', 'on-danger-container', 'success', 'success-container', 'warning', 'on-warning',
        'warning-container', 'info', 'on-info-container', 'state-color', 'state-hover', 'state-pressed', 'fg-1-on', 'fg-6-on', 'night-card', 'switch-track-on'])
        assert.ok(t[k] !== undefined && t[k] !== '', `${x.id} ${m} ${k}`);
      // tokens.css 里同名变量同值
      assert.ok(files['tokens.css'].includes(`--sgx-bg-1: ${t['bg-1']};`), `${x.id} ${m} bg-1 in tokens.css`);
    }
  }
  assert.equal(p.default, 'dustyblue');
  assert.equal(p.rulesVersion, 'palette-rules-1');
  assert.equal(JSON.parse(files['manifest.json']).rulesVersion, 'palette-rules-1');
  assert.equal(p.presets[0].id, 'dustyblue');
  for (const { id, seed } of p.presets) {
    const sel = id === 'dustyblue' ? ':root,\n:root[data-palette="dustyblue"] {' : `:root[data-palette="${id}"] {`;
    assert.ok(files['tokens.css'].includes(`${sel}\n  --sgx-seed: ${seed};`), id);
  }
  // 调色板派生 token（tag）在 tokens.css；chart-1..6 是每套生成的角色
  assert.match(files['tokens.css'], /--sgx-chart-1: #[0-9a-f]{6};/);
  assert.doesNotMatch(files['tokens.css'], /--sgx-chart-1: var\(--sgx-fg-1\);/);
  assert.match(files['tokens.css'], /--sgx-tag-bg: var\(--sgx-fg-4-tint\);/);
});

test('顶栏（P5-1 起一整条胶囊；PR-4b 定稿）：[字标][页名胶囊][九宫格 · 快捷设置 · AI]，头像不在顶栏；同一份标记 topbar.html 四站共用', () => {
  assert.deepEqual(SHELL_REGIONS, ['topbar-frame', 'panel', 'entries', 'wide']);
  const s = files['shell.css'];
  assert.match(s, /\.sgx-topbar \{ position: fixed;[^}]*left: 0; right: 0; margin: 0 auto; width: var\(--sgx-tb-w\);[^}]*border-radius: 999px;[^}]*background: var\(--sgx-mat\);/);
  // 三列网格：字标 | 中间 | 图标组（PR-4b 定稿）
  assert.match(s, /\.sgx-topbar \{[^}]*display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  // 右边三颗圆按钮：40 × 40、图标 20px、间距 6px、没有公共底；整组 132px
  assert.match(s, /--sgx-tb-icw: 40px;/);
  assert.match(s, /--sgx-tb-acts-w: calc\(3 \* var\(--sgx-tb-icw\) \+ 2 \* 6px\);/);
  assert.match(s, /\.sgx-tb-btn \{ width: var\(--sgx-tb-icw\); height: var\(--sgx-tb-ic\);[^}]*border-radius: 999px;[^}]*background-color: transparent;[^}]*color: var\(--sgx-on-surface-variant\);/);
  assert.match(s, /\.sgx-tb-acts \{ justify-self: end; display: flex; align-items: center; gap: 6px; \}/);
  assert.match(s, /\.sgx-tb-btn svg \{ width: 20px; height: 20px; \}/);
  // 颜色：九宫格 / 快捷 打开 = 浅一档；AI 平时浅一档、打开深一档（填充档）
  assert.match(s, /\.sgx-tb-btn\[aria-expanded="true"\], \.sgx-tb-ai \{ background-color: var\(--sgx-primary-container\); color: var\(--sgx-on-primary-container\); \}/);
  assert.match(s, /\.sgx-tb-ai\[aria-expanded="true"\] \{ background-color: var\(--sgx-primary-fill\); color: var\(--sgx-on-primary-fill\); \}/);
  // 中间：前后弹簧，内容按整条顶栏居中；放不下贴字标
  assert.match(s, /\.sgx-tb-pill::before \{ flex-basis: max\(0px, var\(--sgx-tb-acts-w\) - var\(--sgx-tb-logo-w\)\); \}/);
  assert.match(s, /\.sgx-tb-pill::after \{ flex-basis: max\(0px, var\(--sgx-tb-logo-w\) - var\(--sgx-tb-acts-w\)\); \}/);
  assert.match(s, /\.sgx-tb-title \{[^}]*max-width: 100%;[^}]*border-radius: 999px;[^}]*text-overflow: ellipsis; background-color: var\(--sgx-nav-selected\); color: var\(--sgx-on-nav-selected\);/);
  // 手机布局：中间整块不显示（只留阅读进度细线），不按像素
  assert.match(s, /:root:not\(\[data-sgx-layout="desktop"\]\) \.sgx-tb-pill > :not\(\.sgx-tb-progress\) \{ display: none; \}/);
  assert.doesNotMatch(s.replace(/\/\*[\s\S]*?\*\//g, ''), /\.sgx-tb-pill \{ display: none; \}/, '不再按像素藏页名胶囊');
  assert.doesNotMatch(s, /grid-template-columns: 1fr min\(var\(--sgx-tb-mid\)|--sgx-tb-mid/, 'PR-4a 宽屏三段网格定宽中段删了');
  assert.doesNotMatch(s, /\.sgx-tb-nav\b|\.sgx-tb-end\b|\.sgx-tb-gbtn\b|\.sgx-drawer|\.sgx-tb-me\b|\.sgx-tb-avatar\b|\.sgx-tb-mark\b/);
  // 标记：topbar.html = 主站 partials/shell-topbar.html 原样
  const src = readFileSync(path.join(REPO, 'space/web/layouts/partials/shell-topbar.html'), 'utf8');
  assert.equal(files['topbar.html'], src);
  assert.doesNotMatch(src.replace(/\{\{-? \/\*[\s\S]*?\*\/ -?\}\}/g, ''), /\bpartial |site\.Data|hugo\.Data|resources\.Get/, '只用参数，不调别的 partial / 数据');
  const order = ['class="sgx-tb-logo"', 'class="sgx-tb-pill', 'sgx-tb-grid', 'sgx-tb-quick', 'sgx-tb-ai"'].map((k) => src.indexOf(k));
  assert.ok(order.every((x, n) => x > 0 && (n === 0 || x > order[n - 1])), '字标 → 页名 → 九宫格 → 快捷设置 → AI');
  const header = src.slice(src.indexOf('<header'), src.indexOf('</header>'));
  assert.doesNotMatch(header, /sgx-tb-me|<img/, '顶栏没有头像');
  assert.doesNotMatch(header, /sgx-tb-mark/, '没有窄屏图标版 logo');
  assert.match(src, /<dialog id="sgx-nav" class="sgx-qp sgx-nav"/);
  assert.match(src, /<dialog id="sgx-qp" class="sgx-qp"/);
  assert.match(src, /<dialog id="sgx-ai" class="sgx-qp sgx-ai"/);
  const base = readFileSync(path.join(REPO, 'space/web/layouts/_default/baseof.html'), 'utf8');
  /* 主站中间：只有页名（旷野页是「旷野」），没有标签（PR-4b 定稿：页名胶囊只做一件事） */
  assert.match(base, /\{\{ \$center := printf "<span class=\\"sgx-tb-title\\">%s<\/span>" \(htmlEscape \$pageName\) \}\}/);
  assert.doesNotMatch(base.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, ''), /topbar-tabs|\$tabCur/);
  assert.match(base, /\{\{ partial "shell-topbar\.html" \(dict/);
  assert.doesNotMatch(base, /sgx-drawer|sgx-tb-nav|topbar-end\.html/);
  assert.doesNotMatch(s, /sgx-tb-tab/);
  assert.ok(!existsSync(path.join(REPO, 'space/web/layouts/partials/topbar-end.html')), 'topbar-end.html 已删');
});

test('P4-2b：搜索层整套删除——没有 search.js、shell.css 没有 search 段、主站没有 search-layer / search-host', () => {
  assert.equal(files['search.js'], undefined);
  assert.doesNotMatch(files['shell.css'], /---- search ----|\.sgx-srch/);
  for (const f of ['space/web/assets/js/shell/search-layer.js', 'space/web/assets/js/shell/search-host.js', 'space/web/shared/shell/search.js', 'space/web/static/opensearch.xml'])
    assert.ok(!existsSync(path.join(REPO, f)), f);
});

test('头像在 AI 窗口头部（PR-4b）：圆形 + 主题色环（同主页名片头像环，不是白圈）；锁屏顶栏抄按钮时类名照抄、没有头像', () => {
  const css = files['shell.css'].replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = css.match(/(^|\})\s*\.sgx-ai-avatar \{([^}]*)\}/m);
  assert.ok(rule, 'shell.css 里要有 .sgx-ai-avatar 规则');
  assert.match(rule[2], /border-radius:\s*999px/);
  assert.match(rule[2], /object-fit:\s*cover/);
  assert.match(rule[2], /box-shadow: 0 0 0 2px var\(--sgx-primary-fill\), 0 0 0 5px color-mix\(in srgb, var\(--sgx-primary-fill\) 22%, transparent\)/);
  assert.doesNotMatch(rule[2], /#fff|white/);
  const src = readFileSync(path.join(REPO, 'space/web/layouts/partials/shell-topbar.html'), 'utf8');
  const head = src.slice(src.indexOf('<div class="sgx-ai-head">'), src.indexOf('<div class="sgx-ai-hist"'));
  const order = ['sgx-ai-title', 'data-ai-clear', 'data-ai-history', 'class="sgx-ai-me" href="{{ .acct }}"'].map((k) => head.indexOf(k));
  assert.ok(order.every((x, n) => x > 0 && (n === 0 || x > order[n - 1])), 'Gray AI → 新对话 → 历史 → 头像');
  assert.match(head, /<img src="\{\{ \.avatar \}\}" alt="" width="36" height="36" class="sgx-ai-avatar" data-sgx-avatar="192">/);
  assert.doesNotMatch(src, /sgx-ai-actions|sgx-ai-pill/, '新对话 / 历史 / 联系按钮行删了');
  /* 2026-11-07：邮箱由调用方传参 email（主站 profile.yaml、子站 nav.json me.email），外壳不写死 */
  assert.match(src, /<a class="sgx-ai-contact" data-ai-contact\{\{ with \.email \}\} href="mailto:\{\{ \. \}\}"\{\{ end \}\}>\{\{ \$t\.topbar\.contact \}\}<\/a>/);
  assert.doesNotMatch(src, /styrigx@gmail\.com/);
  assert.doesNotMatch(src, /ai@styrigx\.com/);
  const lock = readFileSync(path.join(REPO, 'space/web/assets/js/shell/lock.js'), 'utf8');
  assert.match(lock, /'<span class="' \+ b\.className \+ '">'/, 'lock.js 抄顶栏按钮要带原类名');
  assert.match(lock, /querySelectorAll\('#site-nav \.sgx-tb-acts \.sgx-tb-btn'\)/);
  assert.match(lock, /document\.querySelector\('\.sgx-ai-avatar'\)/, '锁屏头像取 AI 窗口头部那张');
  assert.doesNotMatch(lock, /sgx-tb-me|sgx-tb-avatar/);
});
