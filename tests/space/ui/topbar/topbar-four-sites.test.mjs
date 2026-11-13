/**
 * 四站顶栏一致（2026-11-04 P5-1，方案 6.2–6.5）：主站 / 博客 / 奇趣 / 日刻同一个顶栏。
 * - 标记单一来源：主站 partials/common/frame/topbar.html → 共享外壳 topbar.html → 三个子站 layouts/partials/common/frame/topbar.html，一字不差；
 * - 四个调用点都传齐必需参数；磁贴按定案（调色板 v4 起没有深浅 MODE）：主站 lang + 调色板 + 布局、没有分享；子站 lang + 调色板；
 * - 子站的主站项 / 账号 / 头像用 https://styrigx.com 绝对地址（子站单独起服务时也能到主站），子站之间同源相对；
 * - 真实构建（有 public/ 时）：四站首页（中英）的顶栏骨架一样 —— P4-3 PR-4b 定稿胶囊 [字标][页名胶囊][九宫格 · 快捷设置 · AI]，头像在 AI 窗口头部；
 *   九宫格导航面板四项同序、当前站「开」态；快捷面板单页、四站同一套磁贴；抽屉 / 右圆分享都不在。
 * 运行：node --test tests/space/ui/topbar/topbar-four-sites.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameFiles } from '../../../../space/scripts/gen/gen-common.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(path.join(REPO, p), 'utf8');
const SRC = rd('space/web/layouts/partials/common/frame/topbar.html');
const SUBS = ['blog', 'curio', 'daymark'];
/** 每站调用 shell-topbar 的模板 */
const CALLERS = {
  atlas: 'space/web/layouts/_default/baseof.html',
  blog: 'space/web/layouts/partials/blog/topnav.html',
  curio: 'space/web/layouts/curio/baseof.html',
  daymark: 'space/web/layouts/daymark/baseof.html',
};
const REQUIRED = ['lang', 'tr', 'langs', 'home', 'center', 'nav', 'site', 'icons', 'wordmark', 'acct', 'avatar', 'pal', 'security', 'status'];

/** 取 `partial "...topbar.html" (dict ... )` 的参数段 */
function callArgs(site) {
  const t = rd(CALLERS[site]);
  const name = 'common/frame/topbar.html'; // 2026-11 合站：四站都调主站这一份
  const i = t.indexOf(`partial "${name}" (dict`);
  assert.ok(i >= 0, `${site}: 调 ${name}`);
  return t.slice(i, t.indexOf('\n)', i) + 2);
}

test('标记单一来源：四站都用主站 frame/topbar.html 和 topbar/panel.js（2026-11 合站后没有子站副本）', () => {
  assert.equal(frameFiles()['topbar.html'], SRC);
  for (const s of SUBS) {
    assert.ok(!existsSync(path.join(REPO, 'space/web/layouts/partials', s, 'frame/topbar.html')), s + ' 没有顶栏标记副本');
    assert.ok(!existsSync(path.join(REPO, 'space/web/assets', s, 'js/sgx/shell/topbar.js')), s + ' 没有顶栏 JS 副本');
  }
  /* 子站顶栏入口直接 import 主站的 topbar/panel.js */
  assert.match(rd('space/web/assets/blog/js/entries/topnav.ts'), /from '\.\.\/\.\.\/..\/common\/js\/frame\/topbar\/panel\.js'/);
  for (const s of ['curio', 'daymark']) assert.match(rd(`space/web/assets/${s}/js/sgx/topbar-host.js`), /from '\.\.\/\.\.\/..\/common\/js\/frame\/topbar\/panel\.js'/, s);
});

test('四个调用点：必需参数都传；site 是本站；PR-4b 起快捷面板四站同一套，谁都不传 tiles / layout', () => {
  for (const site of Object.keys(CALLERS)) {
    const a = callArgs(site);
    for (const k of REQUIRED) assert.match(a, new RegExp(`\\n\\s*"${k}" `), `${site}: 传 ${k}`);
    /* 主站：首页 = home、其余（状态页等）没有当前项（$navSite，顶栏 v3；05 旷野 2026-11-12 删除） */
    if (site === 'atlas') assert.match(a, /"site" \$navSite/, 'atlas: 当前项');
    else assert.match(a, new RegExp(`"site" "${site}"`), `${site}: 当前站`);
    assert.doesNotMatch(a, /"tiles" |\n\s*"layout" /, `${site}: 不按站开关磁贴`);
  }
  assert.doesNotMatch(rd(CALLERS.atlas), /\$tbTiles/);
});

test('子站地址：主站项 / 账号 / 头像走 https://styrigx.com，中文账号页 /zh/account/（lang-path.html，P4-3 PR-4c）；主站自己全是同源相对', () => {
  for (const s of SUBS) {
    const a = callArgs(s);
    assert.match(a, /"mainOrigin" "https:\/\/styrigx\.com"/, s);
    assert.match(a, /"acct" \(partial "common\/lang-path\.html" \(dict "path" \$\w+\.me\.href "lang" (\.Lang|\$lang)\)\)/, s);
    assert.match(a, /"avatar" \$\w+\.me\.avatar/, s);
    assert.match(a, /"langHref" \$langHref/, s + '：语言磁贴去另一种语言的同一页');
  }
  const m = callArgs('atlas');
  assert.doesNotMatch(m, /mainOrigin/);
  assert.match(m, /"avatar" "\/avatar\/192\.webp"/);
});

/* ---------------- 真实构建 ---------------- */

const PUB = { atlas: 'space/web/public', blog: 'space/web/public/blog', curio: 'space/web/public/curio', daymark: 'space/web/public/daymark' };
const built = Object.values(PUB).every((d) => existsSync(path.join(REPO, d, 'index.html')));

/** 顶栏骨架（顶栏 v3）：去掉中间内容，只留结构上的 class / id / data-*，按出现顺序 */
function skeleton(html) {
  const h = html.replace(/"/g, '');
  const hdr = h.slice(h.indexOf('<header id=site-nav'), h.indexOf('</header>'));
  /* 顶栏 v6（Gray 2026-11-13）：右侧 调色盘 · 九宫格 · 音乐 · 盾牌 · | · >_ · 头像（原 v5 S6：盾牌 · 调色盘 · 九宫格 · | · >_ · 头像） */
  const order = ['sgx-topbar', 'sgx-tb-logo', 'sgx-tb-cu', 'sgx-tb-pill', 'sgx-tb-acts', 'sgx-tb-quick', 'sgx-tb-grid', 'sgx-tb-music', 'sgx-tb-shield', 'sgx-tb-sep', 'sgx-tb-term', 'sgx-tb-av', 'sgx-tb-prog', 'sgx-tb-ai'];
  const pos = order.map((c) => hdr.search(new RegExp(`class=[^>]*\\b${c}\\b`)));
  order.forEach((c, n) => assert.ok(pos[n] >= 0, '顶栏有 ' + c));
  const qp = h.slice(h.indexOf('<dialog id=sgx-qp'), h.indexOf('</dialog>', h.indexOf('<dialog id=sgx-qp')));
  const ai = h.slice(h.indexOf('<dialog id=sgx-ai'), h.indexOf('</dialog>', h.indexOf('<dialog id=sgx-ai')));
  const nav = h.slice(h.indexOf('<dialog id=sgx-nav'), h.indexOf('</dialog>', h.indexOf('<dialog id=sgx-nav')));
  const foot = h.slice(h.indexOf('<footer class=sgx-foot'), h.indexOf('</footer>', h.indexOf('<footer class=sgx-foot')));
  return {
    sorted: pos.every((x, n) => n === 0 || x > pos[n - 1]),
    nav: [...nav.matchAll(/data-nav=([a-z]+)/g)].map((x) => x[1]),
    current: [...nav.matchAll(/data-nav=([a-z]+) aria-current=page/g)].map((x) => x[1]),
    count: (nav.match(/data-nav-count>(\d\d\/\d\d)</) || [])[1],
    logo: (h.match(/class="?sgx-tb-logo"? href="?([^"\s>]+)/) || [])[1],
    stGo: (h.match(/<a href="?([^"\s>]+)"? class="?sgx-nav-st-go/) || [])[1],
    langs: [...nav.matchAll(/data-qp-lang=([a-z]+)/g)].map((x) => x[1]),
    layout: [...nav.matchAll(/<button type=button data-v=([a-z]+)/g)].map((x) => x[1]),
    acts: [...nav.matchAll(/data-qp=([a-z]+)/g)].map((x) => x[1]),
    status: [...nav.matchAll(/data-st=([a-z-]+)/g)].map((x) => x[1]),
    modes: [...qp.matchAll(/data-qp-mode=([a-z]+)/g)].map((x) => x[1]),
    swatches: (qp.match(/class=sgx-th-pal /g) || []).length,
    /* 2026-11 PR-5：头像在顶栏最右（点开账号下拉 #sgx-acct）；AI 窗口头部不再有头像 */
    me: /class=sgx-tb-av/.test(hdr) && !/class=sgx-ai-me/.test(ai) && /id=sgx-acct/.test(h),
    /* 2026-11 PR-2：字标是 SVG（四站都传 wordmark）；终端抽屉四站都有 */
    wordmark: /class=sgx-tb-name[^>]*><svg class=sgx-wordmark/.test(hdr),
    term: /<dialog id=sgx-term /.test(h) && /data-sgx-term=drawer/.test(h),
    win: [...foot.matchAll(/data-win=([a-z]+)/g)].map((x) => x[1]),
    winCur: [...foot.matchAll(/data-win=([a-z]+) aria-current=page/g)].map((x) => x[1]),
    ai: ['data-ai-list', 'data-ai-form', 'data-ai-in', 'data-ai-scope', 'data-ai-clear', 'data-ai-history', 'data-ai-hist', 'data-ai-contact'].every((k) => ai.includes(k)),
    legacy: /sgx-drawer|sgx-tb-nav\b|sgx-tb-end\b|sgx-tb-share\b|apps-grid|sgx-tb-mark\b|sgx-tb-tl\b|sgx-qp-tile/.test(h.replace(/<script[\s\S]*?<\/script>/g, '')),
  };
}

test('真实构建：四站首页（中英）顶栏 v3 骨架一致 —— 字标 · 调色盘 · 九宫格 · 音乐 · 盾牌 · | · >_ · 头像 · 进度条 · AI 浮钮；NAVIGATE 四项同序、logo 回主站首页、STATUS 有跳转按钮且当前项「开」态；外观面板同一套；tmux 页脚当前窗口', (t) => {
  if (!built) { t.skip('还没构建（先 npm run build）'); return; }
  const CUR = { atlas: 'home', blog: 'blog', curio: 'curio', daymark: 'daymark' };
  const NO = { home: '01', blog: '02', curio: '03', daymark: '04' };
  for (const site of Object.keys(PUB)) {
    for (const f of ['index.html', 'zh/index.html']) {
      const sk = skeleton(readFileSync(path.join(REPO, PUB[site], f), 'utf8'));
      const at = `${site}/${f}`;
      assert.ok(sk.sorted, at + '：顶栏顺序');
      assert.ok(sk.me, at + '：头像在顶栏最右、账号下拉在（AI 窗口头部没有头像）');
      assert.deepEqual(sk.nav, ['home', 'blog', 'curio', 'daymark'], at);
      assert.deepEqual(sk.current, [CUR[site]], at + '：当前项高亮');
      assert.equal(sk.count, NO[CUR[site]] + '/04', at + '：计数');
      assert.deepEqual(sk.langs, ['en', 'system', 'zh'], at + '：lang EN / Auto / 中文（2026-11-09 Auto 在中间）');
      assert.deepEqual(sk.layout, ['phone', 'auto', 'desktop'], at + '：layout Mobile / Auto / DeX（2026-11-09 Auto 在中间）');
      assert.deepEqual(sk.acts, ['term'], at + '：terminal（v5 S6 去掉 lock；v6 P4 拿掉分享磁贴，Gray 11-11 17:47）');
      assert.deepEqual(sk.status, ['space', 'blog', 'curio', 'daymark', 'gray-ai', 'auth'], at + '：STATUS 六个单元');
      assert.deepEqual(sk.modes, [], at + '：没有 MODE（调色板 v4：每套一个模式，2026-11-12）');
      assert.equal(sk.swatches, 25, at + '：25 套色板');
      assert.deepEqual(sk.win, ['home', 'blog', 'curio', 'daymark'], at + '：页脚窗口');
      assert.equal(sk.logo, f.startsWith('zh/') ? '/zh/' : '/', at + '：logo 回主站首页（2026-11-12 四站统一）');
      assert.equal(sk.stGo, f.startsWith('zh/') ? (site === 'atlas' ? '/zh/status/' : 'https://styrigx.com/zh/status/') : (site === 'atlas' ? '/status/' : 'https://styrigx.com/status/'), at + '：STATUS 区跳转按钮去状态页');
      assert.deepEqual(sk.winCur, [CUR[site]], at + '：页脚当前窗口');
      assert.ok(sk.ai, at + '：AI 窗口齐全');
      assert.equal(sk.legacy, false, at + '：没有旧导航抽屉 / 右圆分享 / :~$ / 旧磁贴');
      assert.ok(sk.wordmark, at + '：字标是 SVG（❯ Styrigx _）');
      assert.ok(sk.term, at + '：全站终端抽屉 #sgx-term');
    }
  }
});
