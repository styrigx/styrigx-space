/**
 * 共享外壳（2026-11 合站后主站和三个子站同一个 Hugo 站，子站直接用主站的 partial / JS；space/scripts/gen-shell.mjs 只生成
 *   space/web/assets/shell/css/{tokens,shell}.css 和 space/web/data/shell/{nav,palettes}.json 四个派生文件）：
 * 生成物必须和源头一致；外壳 CSS 只用色彩角色，不写死颜色；导航项 / 图标齐全；顶栏标记 topbar.html 四站一份（2026-11-04 P5-1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderAll, OUT, SHELL_REGIONS, extractRegion } from '../../../../space/scripts/gen-shell.mjs';
import yaml from 'js-yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { files: generated } = renderAll();
/* 派生文件 + 子站直接用的源文件（合站前这些都在 shared/shell 里有一份副本） */
const files = {
  ...generated,
  'topbar.html': readFileSync(path.join(REPO, 'space/web/layouts/partials/shell/shell-topbar.html'), 'utf8'),
  'footer.html': readFileSync(path.join(REPO, 'space/web/layouts/partials/shell/sgx-footer.html'), 'utf8'),
  'i18n-en.yaml': readFileSync(path.join(REPO, 'space/web/data/shell/sgx-shell-i18n/en.yaml'), 'utf8'),
  'i18n-zh.yaml': readFileSync(path.join(REPO, 'space/web/data/shell/sgx-shell-i18n/zh.yaml'), 'utf8'),
};
const ROLES = JSON.parse(readFileSync(path.join(REPO, 'space/web/data/shell/palette-roles.json'), 'utf8'));

test('共享外壳的四个派生文件和源头一致（改了源头要重跑 node space/scripts/gen-shell.mjs）；没有 shared/shell 副本目录', () => {
  for (const [k, v] of Object.entries(generated)) assert.equal(readFileSync(path.join(REPO, OUT[k]), 'utf8'), v, OUT[k]);
  assert.deepEqual(Object.keys(OUT).sort(), ['nav.json', 'palettes.json', 'shell.css', 'tokens.css']);
  assert.equal(existsSync(path.join(REPO, 'space/web/shared')), false);
});

test('宽屏平铺（Gray 2026-11-07；2026-11 PR-A 起内容区回 1080）：只在桌面布局——去卡片公共件 .sgx-flat / .sgx-wide-cols；手机布局不变；交互模块不挂', () => {
  const s = files['shell.css'];
  // 桌面外壳框 = 内容宽 1080（2026-11 PR-A 照设计稿，和顶栏对齐），手机仍 640；顶栏宽不变
  assert.match(s, /:root\[data-sgx-layout="desktop"\] \{ --sgx-content-max: var\(--sgx-content-w\); \}/);
  assert.match(s, /:root\[data-sgx-layout="phone"\] \{ --sgx-content-max: 640px; \}/);
  assert.doesNotMatch(s, /--sgx-content-max: 1440px/);
  // 公共件只在桌面布局生效
  for (const sel of ['.sgx-flat', '.sgx-wide-cols', '.sgx-wide-h']) {
    const rules = s.match(new RegExp('[^}]*\\' + sel + ' \\{', 'g')) || [];
    assert.ok(rules.length > 0, sel);
    for (const r of rules) assert.match(r, /:root\[data-sgx-layout="desktop"\] \S+ \{$/, sel + ' 只在桌面布局');
  }
  assert.match(s, /\.sgx-flat \{ background: transparent; border: 0; border-radius: 0; box-shadow: none;/);
  // 交互模块保留卡片：状态页（_default/status.html，2026-11-12 起；原旷野页）、安全页不挂 .sgx-flat
  const web = path.join(REPO, 'space/web/layouts');
  /* 进站 v3 L1：安全页删了（盾牌下拉） */
  for (const f of ['_default/security.html', '_default/security-lock.html']) assert.ok(!existsSync(path.join(web, f)), f + ' 已删');
  for (const f of ['_default/status.html']) {
    assert.doesNotMatch(readFileSync(path.join(web, f), 'utf8'), /sgx-flat/, f);
  }
  const home = readFileSync(path.join(web, 'index.html'), 'utf8');
  /* 2026-11 PR-2 首屏终端：名片（#w-profile）并进居中 hero，不再是卡片；对齐 PR-B：日刻是强调线引言（.home-qt，本身无卡片底，不挂 .sgx-flat）（屏幕时间小卡 v6 P4 删除） */
  assert.match(home, /<div id="w-profile" class="home-id">/);
  assert.match(home, /id="w-daymark" [^>]*class="home-qt /);
  assert.doesNotMatch(home, /sgx-flat/, '主页不再用 .sgx-flat');
  assert.doesNotMatch(home, /id="w-screen"/);
});

test('外壳 CSS 段只用 --sgx-* 角色：没有十六进制颜色、没有旧 --m-* 令牌', () => {
  const css = readFileSync(path.join(REPO, 'space/web/assets/shell/css/input.css'), 'utf8');
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
  assert.match(s, /@supports \(backdrop-filter: blur\(1px\)\) \{\s*\.sgx-topbar \{ backdrop-filter: var\(--sgx-tb-filter\); \}/);
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

test('nav.json（顶栏 v3 NAVIGATE / tmux 页脚，2026-11 UI 重设计 PR-1）：01 主页 02 博客 03 奇趣 04 日刻（05 旷野 2026-11-12 删除），没有账号 / 设置项；终端路径提示、页脚外链；顶栏 / AI 图标都在', () => {
  const nav = JSON.parse(files['nav.json']);
  assert.deepEqual(nav.items.map((i) => i.id), ['home', 'blog', 'curio', 'daymark']);
  assert.deepEqual(nav.items.map((i) => i.hint), ['~', 'blog/', 'curio/', 'daymark/']);
  assert.ok(!nav.items.some((i) => i.id === 'wild' || /wild/.test(i.path)), '没有旷野项');
  // 2026-10-21：书签项换成子站 奇趣 Curio（主站书签功能下线）
  const curio = nav.items.find((i) => i.id === 'curio');
  // 合并 PR3：三站和主站同在 styrigx.com（导航里子站互相是相对地址 /curio/，见 partials/shell/shell-topbar.html）
  assert.deepEqual([curio.icon, curio.origin, curio.path], ['nav-curio', 'https://styrigx.com', '/curio/']);
  // 语言包化（2026-11-07）：nav.json 不再带任何语言的文字，名字在外壳字符串表 i18n-<语言>.yaml 的 nav.<id>.title
  assert.ok(!/"(zh|en|subzh|suben)"\s*:/.test(files['nav.json']), 'nav.json 不带 zh / en 文本');
  assert.ok(!JSON.stringify(nav).includes('atlas.styrigx.com'));
  assert.deepEqual(nav.footer, []);
  assert.ok(![...nav.items, ...nav.footer].some((i) => i.id === 'settings' || i.id === 'account'), '没有设置 / 账号项（账号走顶栏头像）');
  // P4-2b：搜索层删了，nav.json 没有 search 段，也没有它的 ai-search 图标
  assert.equal(nav.search, undefined);
  assert.equal(nav.icons['ai-search'], undefined);
  // 页脚外链（README 同一组）
  assert.deepEqual(nav.links, { github: 'https://github.com/styrigx', x: 'https://x.com/styrigx' });
  // 头像（子站链到主站账号页）；2026-11-07 个人资料：me.email = data/shell/profile.yaml 的对外联系邮箱（gen-shell 注入，子站 AI 窗口「联系我」默认值）
  const prof = yaml.load(readFileSync(path.join(REPO, 'space/web/data/shell/profile.yaml'), 'utf8'));
  assert.deepEqual(nav.me, { href: 'https://styrigx.com/account/', avatar: 'https://styrigx.com/avatar/192.webp', email: prof.email });
  assert.equal(prof.email, 'styrigx@gmail.com');
  const tr = { en: yaml.load(files['i18n-en.yaml']), zh: yaml.load(files['i18n-zh.yaml']) };
  assert.deepEqual(nav.items.map((i) => tr.zh.nav[i.id].title), ['主页', '博客', '奇趣', '日刻']);
  assert.deepEqual(nav.items.map((i) => tr.en.nav[i.id].title), ['Home', 'Blog', 'Curio', 'Daymark']);
  for (const i of nav.items) for (const l of ['en', 'zh']) assert.ok(tr[l].foot.win[i.id], i.id + ' 页脚窗口名 ' + l);
  for (const i of [...nav.items, ...nav.footer]) assert.match(nav.icons[i.icon], /^<svg[\s\S]*<\/svg>$/, i.icon);
  for (const k of ['tb-palette', 'tb-shield', 'tb-term', 'tb-chat', 'lock', 'tb-undo', 'tb-send', 'tb-newchat', 'tb-history']) assert.match(nav.icons[k], /^<svg[\s\S]*<\/svg>$/, k);
  assert.equal(nav.icons.share, undefined, 'v6 P4：分享磁贴拿掉，share 图标不再进外壳（Gray 11-11 17:47）');
  assert.equal(nav.icons['apps-grid'], undefined, '旧九宫格（九个点）不用');
});

test('palettes.json：22 套七色调色板（每项带 group / bg / 6 前景 / mode + 本套 Shell + Semantic token；2026-11-12 v4 起每套一个模式），种子和 tokens.css 的 --sgx-seed 一致', () => {
  const p = JSON.parse(files['palettes.json']);
  assert.equal(p.presets.length, 25);
  assert.deepEqual(p.groups.map((g) => g.id), ['cool', 'nature', 'warm', 'floral', 'neutral']);
  for (const x of p.presets) {
    assert.ok(p.groups.some((g) => g.id === x.group), x.id);
    assert.match(x.bg, /^#[0-9a-f]{6}$/, x.id);
    assert.equal(x.fg.length, 6, x.id);
    assert.equal(x.seed, x.fg[0], x.id + ' 种子 = 前景 1');
    assert.ok(!/^x[a-z]/.test(x.id), x.id + ' 撞色 x* id 已删除');
    assert.ok(x.mode === 'light' || x.mode === 'dark', x.id + ' mode');
    assert.equal(x.mode, ROLES.presets[x.id].mode, x.id + ' mode = palette-roles.json');
    assert.ok(!('light' in x.tokens) && !('dark' in x.tokens), x.id + ' tokens 不再分亮暗');
    {
      const m = x.mode, t = x.tokens;
      for (const k of ['bg-1', 'bg-7', 'surface', 'topbar-glass', 'primary', 'on-primary', 'primary-container', 'secondary', 'nav-selected', 'link', 'outline-variant', 'text-primary', 'text-secondary', 'chart-1', 'chart-6', 'tag-bg', 'tag-fg'])
        assert.ok(typeof t[k] === 'string' && t[k], `${x.id} ${m} ${k}`);
      // chart-N = 引擎生成的角色（本色 → ink 回退，对比度 / 区分度单测在 palette-scheme.test.mjs）
      for (let i = 1; i <= 6; i++) assert.equal(t['chart-' + i], ROLES.presets[x.id].roles['chart-' + i], `${x.id} ${m} chart-${i}`);
      // 完整导出：填充档、固定状态色、焦点环、状态层、前景四档都在
      for (const k of ['primary-fill', 'on-primary-fill', 'focus-ring', 'danger', 'on-danger-container', 'success', 'success-container', 'warning', 'on-warning',
        'warning-container', 'info', 'on-info-container', 'state-color', 'state-hover', 'state-pressed', 'fg-1-on', 'fg-6-on', 'night-card', 'switch-track-on'])
        assert.ok(t[k] !== undefined && t[k] !== '', `${x.id} ${m} ${k}`);
      // tokens.css 里同名变量同值
      assert.ok(files['tokens.css'].includes(`--sgx-bg-1: ${t['bg-1']};`), `${x.id} ${m} bg-1 in tokens.css`);
    }
  }
  assert.equal(p.default, 'terra');
  assert.equal(p.rulesVersion, 'palette-rules-2');
  assert.equal(p.schemeVersion, undefined, 'v4：没有自定义色，也就没有引擎版本');
  assert.equal(p.presets[0].id, 'cherry'); /* 2026-11-12 先深后浅、段内按色相 */
  for (const { id, seed } of p.presets) {
    const sel = id === 'terra' ? ':root,\n:root[data-palette="terra"] {' : `:root[data-palette="${id}"] {`;
    assert.ok(files['tokens.css'].includes(`${sel}\n  --sgx-seed: ${seed};`), id);
  }
  // 调色板派生 token（tag）在 tokens.css；chart-1..6 是每套生成的角色
  assert.match(files['tokens.css'], /--sgx-chart-1: #[0-9a-f]{6};/);
  assert.doesNotMatch(files['tokens.css'], /--sgx-chart-1: var\(--sgx-fg-1\);/);
  assert.match(files['tokens.css'], /--sgx-tag-bg: var\(--sgx-fg-4-tint\);/);
});

test('顶栏 v3（2026-11 UI 重设计 PR-1；PR-2 字标换 SVG、加终端抽屉；v5 S6 顶栏 E；顶栏 v6 加音乐、盾牌挪到分隔线前）：通栏 [字标 ❯ Styrigx_][页名（不显示）][外观 · 四格 · 音乐 · 盾牌 · | · >_ · 头像] + 进度条 + AI 浮钮；同一份标记四站共用', () => {
  assert.deepEqual(SHELL_REGIONS, ['topbar-frame', 'panel', 'inpage', 'wide', 'terminal']);
  const s = files['shell.css'];
  // 贴顶通栏：top 0、left 0 / right 0、底边 1px 线、毛玻璃材质；内容宽一个 token（1080）
  assert.match(s, /\.sgx-topbar \{ position: fixed; top: 0; left: 0; right: 0;[^}]*display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto;[^}]*padding: env\(safe-area-inset-top, 0px\) var\(--sgx-tb-pad\) 0; border-bottom: 1px solid var\(--sgx-term-line\);[^}]*background: var\(--sgx-tb-mat\);/);
  // 顶栏底照稿：页面底色 85% + 12px 模糊（2026-11 PR-A）
  assert.match(s, /--sgx-tb-mat: color-mix\(in srgb, var\(--sgx-bg-1\) 85%, transparent\); --sgx-tb-filter: blur\(12px\);/);
  assert.match(s, /--sgx-content-w: 1080px;/);
  assert.match(s, /--sgx-tb-pad: max\(var\(--sgx-page-m\), env\(safe-area-inset-left, 0px\), env\(safe-area-inset-right, 0px\), \(100% - var\(--sgx-content-w\)\) \/ 2\);/);
  assert.equal((s.match(/1080px/g) || []).length, 1, '1080 只写在 --sgx-content-w 一处');
  // 字标：光标 1.05s 步进闪，减弱动效常亮；没有副标题
  assert.match(s, /\.sgx-tb-cu \{[^}]*animation: sgx-tb-blink 1\.05s steps\(1\) infinite; \}/);
  assert.match(s, /@media \(prefers-reduced-motion: reduce\) \{ \.sgx-tb-cu \{ animation: none; \} \}/);
  // 按钮 40 × 40、圆角 10、图标 20；打开 = 主题色衬底 + 主题色
  assert.match(s, /--sgx-tb-icw: 40px;/);
  assert.match(s, /\.sgx-tb-btn \{ width: var\(--sgx-tb-icw\); height: var\(--sgx-tb-ic\);[^}]*border-radius: 10px;/);
  assert.match(s, /\.sgx-tb-btn svg \{ width: 20px; height: 20px; \}/);
  assert.match(s, /\.sgx-tb-btn\[aria-expanded="true"\] \{ background-color: var\(--sgx-surface-container-high\); color: var\(--sgx-primary\); \}/);
  assert.match(s, /\.sgx-tb-sep \{[^}]*width: 1px; height: 22px;/);
  assert.match(s, /\.sgx-tb-avatar \{[^}]*width: var\(--sgx-tb-av-d\); height: var\(--sgx-tb-av-d\); border-radius: 50%;/);
  /* 顶栏 v6（Gray 2026-11-13）：手机按钮 38、图标 20、间距 2、头像 30；桌面按钮 40、图标 22、间距 4、头像 32 */
  assert.match(s, /:root:not\(\[data-sgx-layout="desktop"\]\) \{ --sgx-tb-ic: 38px; --sgx-tb-icw: 38px; \}/);
  assert.match(s, /:root \{ --sgx-tb-ic-svg: 20px; --sgx-tb-av-d: 30px; --sgx-tb-acts-gap: 2px; \}/);
  assert.match(s, /:root\[data-sgx-layout="desktop"\] \{ --sgx-tb-ic-svg: 22px; --sgx-tb-av-d: 32px; --sgx-tb-acts-gap: 4px; \}/);
  assert.match(s, /\.sgx-tb-acts \.sgx-tb-btn svg \{ width: var\(--sgx-tb-ic-svg\); height: var\(--sgx-tb-ic-svg\); \}/);
  // AI 浮钮（右下角，主题实色）
  assert.match(s, /\.sgx-tb-ai \{ position: fixed;[^}]*width: 56px; height: 56px; border-radius: 18px;[^}]*background-color: var\(--sgx-primary-fill\); color: var\(--sgx-on-primary-fill\);/);
  // 页名不在顶栏显示（只在页面顶栏里藏；锁屏顶栏照旧用它当标题）
  assert.match(s, /#site-nav \.sgx-tb-pill \{ display: none; \}/);
  assert.doesNotMatch(s, /--sgx-tb-acts-w|--sgx-tb-logo-w|\.sgx-tb-pill::before/, '旧胶囊居中弹簧删了');
  assert.doesNotMatch(s, /\.sgx-tb-nav\b|\.sgx-tb-end\b|\.sgx-tb-gbtn\b|\.sgx-drawer|\.sgx-tb-me\b|\.sgx-tb-mark\b|sgx-tb-tab/);
  // 标记：topbar.html = 主站 partials/shell/shell-topbar.html 原样
  const src = readFileSync(path.join(REPO, 'space/web/layouts/partials/shell/shell-topbar.html'), 'utf8');
  assert.equal(files['topbar.html'], src);
  assert.doesNotMatch(src.replace(/\{\{-? \/\*[\s\S]*?\*\/ -?\}\}/g, ''), /\bpartial |site\.Data|hugo\.Data|resources\.Get/, '只用参数，不调别的 partial / 数据');
  const header = src.slice(src.indexOf('<header id="site-nav" class='), src.indexOf('</header>'));
  const order = ['class="sgx-tb-logo"', 'sgx-tb-ps', 'sgx-tb-name', 'sgx-tb-cu', 'class="sgx-tb-pill', 'sgx-tb-quick', 'sgx-tb-grid', 'sgx-tb-music', 'sgx-tb-shield', 'sgx-tb-sep', 'sgx-tb-term', 'class="sgx-tb-av"', 'sgx-tb-prog', 'sgx-tb-ai'].map((k) => header.indexOf(k));
  assert.ok(order.every((x, n) => x > 0 && (n === 0 || x > order[n - 1])), '字标（❯ SVG 字标 光标）→ 页名 → 外观 → 四格 → 音乐 → 盾牌 → 分隔 → >_ → 头像 → 进度条 → AI 浮钮（顶栏 v6，Gray 2026-11-13）');
  /* 四格 = NAVIGATE（tb-grid 图标），>_ = 终端（tb-term 图标，开 #sgx-term） */
  assert.match(header, /class="sgx-tb-btn sgx-tb-grid"[^>]*aria-controls="sgx-nav"[^>]*>\{\{ index \$i "tb-grid" \| safeHTML \}\}/);
  assert.match(header, /class="sgx-tb-btn sgx-tb-term"[^>]*aria-controls="sgx-term"[^>]*>\{\{ index \$i "tb-term" \| safeHTML \}\}/);
  /* PR-2（Gray 2026-11-08）：等宽文字 styrigx :~$ 换成 ❯ + SVG 字标（参数 .wordmark）+ 光标；没有 :~$、没有副标题 */
  assert.match(header, /<span class="sgx-tb-ps" aria-hidden="true">❯<\/span><span class="sgx-tb-name" aria-hidden="true" translate="no">\{\{ \.wordmark \| safeHTML \}\}<\/span><span class="sgx-tb-cu" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(header, /sgx-tb-tl|:~\$|<small/, '没有 :~$、没有副标题');
  // 终端抽屉 + NAVIGATE「$ terminal」
  assert.match(src, /<dialog id="sgx-term" class="sgx-term-dlg"/);
  assert.match(src, /data-qp="term"/);
  assert.match(header, /<a class="sgx-tb-btn sgx-tb-shield" href="\{\{ \.security \}\}"/);
  assert.match(header, /<a class="sgx-tb-av" href="\{\{ \.acct \}\}"[^>]*><img src="\{\{ \.avatar \}\}"/);
  assert.match(src, /<dialog id="sgx-nav" class="sgx-qp sgx-nav"/);
  assert.match(src, /<dialog id="sgx-qp" class="sgx-qp sgx-theme"/);
  assert.match(src, /<dialog id="sgx-ai" class="sgx-qp sgx-ai"/);
  const base = readFileSync(path.join(REPO, 'space/web/layouts/_default/baseof.html'), 'utf8');
  /* 主站中间：只有页名（状态页是「状态」），没有标签；v3 顶栏不显示，标记照给 */
  assert.match(base, /\{\{ \$center := printf "<span class=\\"sgx-tb-title\\">%s<\/span>" \(htmlEscape \$pageName\) \}\}/);
  assert.doesNotMatch(base.replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, ''), /topbar-tabs|\$tabCur/);
  assert.match(base, /\{\{ partial "shell\/shell-topbar\.html" \(dict/);
  assert.match(base, /\{\{ partial "shell\/sgx-footer\.html" \(dict/);
  assert.doesNotMatch(base, /sgx-drawer|sgx-tb-nav|topbar-end\.html|sgx-about-foot/);
  assert.ok(!existsSync(path.join(REPO, 'space/web/layouts/partials/topbar-end.html')), 'topbar-end.html 已删');
});

test('NAVIGATE / 外观 / 页脚（顶栏 v3）：NAVIGATE 五项 + lang / layout 分段（v5 S6 去掉 lock；v6 P4 拿掉 share）+ STATUS 占位 + systemctl status · esc 关闭；外观 = PALETTE 列表（v4 删 MODE 三段）；tmux 页脚', () => {
  const src = readFileSync(path.join(REPO, 'space/web/layouts/partials/shell/shell-topbar.html'), 'utf8');
  const navd = src.slice(src.indexOf('<dialog id="sgx-nav"'), src.indexOf('<dialog id="sgx-qp"'));
  const order = ['sgx-nav-h', 'class="sgx-nav-list"', 'data-qp-langs', 'data-qp-seg="layout"', 'data-nav-status', 'sgx-nav-flink', 'data-nav-close'].map((k) => navd.indexOf(k));
  assert.ok(order.every((x, n) => x > 0 && (n === 0 || x > order[n - 1])), '头 → 五项 → lang → layout → STATUS → systemctl status → esc');
  assert.doesNotMatch(navd, /data-sgx-share|data-qp="share"/, 'v6 P4：分享磁贴拿掉');
  assert.doesNotMatch(navd, /data-qp="lock"|data-qp-lock-state/, 'v5 S6：NAVIGATE 没有 lock 按钮（上锁走终端 lock / 已进站点盾牌）');
  assert.match(navd, /\{\{ printf "%02d\/%02d" \$cur \$n \}\}/, '01/05 计数');
  assert.match(navd, /<a class="sgx-nav-tile" href="\{\{ \$p \}\}" data-nav="\{\{ \.id \}\}"\{\{ if eq \.id \$\.site \}\} aria-current="page"\{\{ end \}\}><em class="sgx-nav-no"/);
  assert.match(navd, /range slice \(dict "v" "phone" "t" \$t\.topbar\.phone\) \(dict "v" "auto" "t" \$t\.topbar\.auto\) \(dict "v" "desktop" "t" \$t\.topbar\.desktop\)/, 'Mobile / Auto / DeX（2026-11-09 Auto 在中间）');
  assert.match(navd, /range slice "space" "blog" "curio" "daymark" "gray-ai" "auth"/, 'STATUS 六个单元');
  const qpd = src.slice(src.indexOf('<dialog id="sgx-qp"'), src.indexOf('<dialog id="sgx-ai"'));
  assert.doesNotMatch(qpd, /data-qp-mode|followSystem|schemeDark|schemeLight/);
  assert.match(qpd, /data-qp-palette="\{\{ \.id \}\}"/);
  assert.match(qpd, /data-qp-reset aria-disabled="true"/);
  assert.doesNotMatch(src, /data-qp="(dark|system|lang)"|sgx-qp-lang-opts|sgx-qp-tile/, '旧快捷面板磁贴 / 语言下拉删了');
  const foot = files['footer.html'];
  assert.equal(foot, readFileSync(path.join(REPO, 'space/web/layouts/partials/shell/sgx-footer.html'), 'utf8'));
  assert.doesNotMatch(foot.replace(/\{\{-? \/\*[\s\S]*?\*\/ -?\}\}/g, ''), /\bpartial |site\.Data|hugo\.Data|resources\.Get/, '页脚只用参数');
  assert.match(foot, /<span class="sgx-foot-ses" translate="no">space<\/span>/);
  assert.match(foot, /\{\{ \$k \}\}:\{\{ index \$t\.foot\.win \.id \}\}/, '窗口 0:home …');
  assert.match(foot, /data-sgx-clock/);
  assert.match(foot, /\{\{ \.rss \}\}[\s\S]*\{\{ \.nav\.links\.github \}\}[\s\S]*\{\{ \.nav\.links\.x \}\}/);
  assert.doesNotMatch(foot, /mailto:|foot\.contact/, '页脚只留 rss / github / x（Gray 2026-11-09：邮箱只在 AI 窗口）');
  assert.doesNotMatch(foot, /sitemap/i, '没有站点地图');
  const s = files['shell.css'];
  assert.match(s, /:root:not\(\[data-sgx-layout="desktop"\]\) \.sgx-foot-win a:not\(\[aria-current="page"\]\) \{ display: none; \}/, '手机只显示当前窗口');
  assert.match(s, /\.sgx-foot-win a\[aria-current="page"\]::after \{ content: "\*";/);
  // 进度条：3px 虚线段、宽 = --sgx-prog、流动；减弱动效静止
  assert.match(s, /\.sgx-tb-prog \{ position: absolute; left: 0; right: 0; bottom: -1px; height: 3px;/);
  assert.match(s, /width: var\(--sgx-prog, 0%\);[^}]*repeating-linear-gradient\(90deg, var\(--sgx-primary\) 0 14px, transparent 14px 22px\)[^}]*animation: sgx-tb-flow \.6s linear infinite;/);
  assert.match(s, /@media \(prefers-reduced-motion: reduce\) \{ \.sgx-tb-prog > i \{ animation: none; \} \}/);
});

test('P4-2b：搜索层整套删除——没有 search.js、shell.css 没有 search 段、主站没有 search-layer / search-host', () => {
  assert.equal(files['search.js'], undefined);
  assert.doesNotMatch(files['shell.css'], /---- search ----|\.sgx-srch/);
  for (const f of ['space/web/assets/shell/js/shell/search-layer.js', 'space/web/assets/shell/js/shell/search-host.js', 'space/web/shared/shell/search.js', 'space/web/static/opensearch.xml'])
    assert.ok(!existsSync(path.join(REPO, f)), f);
});

test('AI 窗口头部（2026-11 PR-5 按设计稿 ai-v1）：G 徽标 · Gray AI / 副标题 · 模型 · 新对话 · 历史 · ×，没有头像；底部邮箱由参数 email 来；锁屏界面删了（v5 S5）', () => {
  const src = readFileSync(path.join(REPO, 'space/web/layouts/partials/shell/shell-topbar.html'), 'utf8');
  const head = src.slice(src.indexOf('<div class="sgx-ai-head">'), src.indexOf('<div class="sgx-ai-models"'));
  const order = ['sgx-ai-badge', 'sgx-ai-title', 'data-ai-model', 'data-ai-clear', 'data-ai-history', 'data-ai-close'].map((k) => head.indexOf(k));
  assert.ok(order.every((x, n) => x > 0 && (n === 0 || x > order[n - 1])), 'G → Gray AI → 模型 → 新对话 → 历史 → ×');
  assert.doesNotMatch(head, /sgx-ai-me|sgx-ai-avatar/);
  assert.doesNotMatch(src, /sgx-ai-actions|sgx-ai-pill/, '新对话 / 历史 / 联系按钮行删了');
  /* 邮箱由调用方传参 email（主站 profile.yaml、子站 nav.json me.email），外壳不写死 */
  assert.match(src, /<a class="sgx-ai-contact" data-ai-contact title="\{\{ \$t\.topbar\.contact \}\}"\{\{ with \.email \}\} href="mailto:\{\{ \. \}\}"\{\{ end \}\}>/);
  assert.doesNotMatch(src, /styrigx@gmail\.com/);
  assert.doesNotMatch(src, /ai@styrigx\.com/);
  /* v5 S5：锁屏界面（shell/space/entry.js）删了，进站在终端里 */
  assert.ok(!existsSync(path.join(REPO, 'space/web/assets/shell/js/shell/space/entry.js')));
});
