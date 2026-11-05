/**
 * 四站顶栏一致（2026-11-04 P5-1，方案 6.2–6.5）：主站 / 博客 / 奇趣 / 日刻同一个顶栏。
 * - 标记单一来源：主站 partials/shell-topbar.html → 共享外壳 topbar.html → 三个子站 layouts/partials/sgx-shell-topbar.html，一字不差；
 * - 四个调用点都传齐必需参数；磁贴按定案：主站 dark / system / lang / lock + 调色板 + 布局、没有分享；子站 dark / system / lang / 调色板 + 分享，没有立即锁定和布局；
 * - 子站的主站项 / 账号 / 头像用 https://styrigx.com 绝对地址（子站单独起服务时也能到主站），子站之间同源相对；
 * - 真实构建（有 public/ 时）：四站首页（中英）的顶栏骨架一样 —— 胶囊 [logo][中间][快捷面板 · AI · 头像]，快捷面板两页、AI 窗口，
 *   导航页四项同序、当前站高亮；九宫格 / 抽屉 / 右圆分享都不在。
 * 运行：node --test tests/space/ui/topbar/topbar-four-sites.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAll } from '../../../../scripts/gen-shell.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(path.join(REPO, p), 'utf8');
const SRC = rd('web/atlas/layouts/partials/shell-topbar.html');
const SUBS = ['blog', 'curio', 'daymark'];
/** 每站调用 shell-topbar 的模板 */
const CALLERS = {
  atlas: 'web/atlas/layouts/_default/baseof.html',
  blog: 'web/blog/layouts/partials/topnav.html',
  curio: 'web/curio/layouts/_default/baseof.html',
  daymark: 'web/daymark/layouts/_default/baseof.html',
};
const REQUIRED = ['isEn', 'home', 'center', 'nav', 'site', 'icons', 'wordmark', 'acct', 'avatar', 'tiles', 'pal'];

/** 取 `partial "...topbar.html" (dict ... )` 的参数段 */
function callArgs(site) {
  const t = rd(CALLERS[site]);
  const name = site === 'atlas' ? 'shell-topbar.html' : 'sgx-shell-topbar.html';
  const i = t.indexOf(`partial "${name}" (dict`);
  assert.ok(i >= 0, `${site}: 调 ${name}`);
  return t.slice(i, t.indexOf('\n)', i) + 2);
}

test('标记单一来源：共享外壳 topbar.html = 主站 shell-topbar.html = 三个子站 sgx-shell-topbar.html（原样，不加注释头）', () => {
  assert.equal(renderAll()['topbar.html'], SRC);
  assert.equal(rd('web/atlas/shared/shell/topbar.html'), SRC);
  for (const s of SUBS) assert.equal(rd(`web/${s}/layouts/partials/sgx-shell-topbar.html`), SRC, s);
  /* 三站的顶栏 JS 也一份：topbar.js = 主站 shell/topbar-panel.js（sync-shell 前后各加一行标记 + 一行段名，比对去掉之后的正文） */
  const body = rd('web/atlas/shared/shell/topbar.js');
  assert.equal(body, rd('web/atlas/assets/js/shell/topbar-panel.js'));
  for (const s of SUBS) {
    const sub = rd(`web/${s}/assets/js/sgx/shell/topbar.js`).split('\n');
    assert.match(sub[0], /^\/\* @sgx-shell:begin /, s);
    assert.equal(sub.slice(2, -2).join('\n') + '\n', body, s + ' topbar.js');
  }
});

test('四个调用点：必需参数都传；site 是本站；磁贴按定案（主站无分享，子站无立即锁定 / 布局）', () => {
  const tiles = {};
  for (const site of Object.keys(CALLERS)) {
    const a = callArgs(site);
    for (const k of REQUIRED) assert.match(a, new RegExp(`\\n\\s*"${k}" `), `${site}: 传 ${k}`);
    assert.match(a, new RegExp(`"site" "${site === 'atlas' ? 'home' : site}"`), `${site}: 当前站`);
    const m = a.match(/"tiles" \(dict ([^)]*)\)/);
    tiles[site] = m ? m[1] : null;
  }
  /* 主站 tiles 由 $tbTiles 算好（受功能开关控制） */
  const mainTiles = rd(CALLERS.atlas).match(/\{\{ \$tbTiles := dict ([^}]*)\}\}/)[1];
  for (const k of ['theme', 'lang', 'lock', 'palette', 'layout']) assert.match(mainTiles, new RegExp(`"${k}" `), '主站 ' + k);
  assert.doesNotMatch(mainTiles, /share/, '主站模板层不输出分享磁贴（定案第 4 条）');
  for (const s of SUBS) {
    assert.equal(tiles[s], '"theme" true "lang" true "palette" true "share" true', s + '：深色 / 跟随系统 / 语言 / 调色板 + 分享本页');
  }
});

test('子站地址：主站项 / 账号 / 头像走 https://styrigx.com，英文账号页 /en/account/；主站自己全是同源相对', () => {
  for (const s of SUBS) {
    const a = callArgs(s);
    assert.match(a, /"mainOrigin" "https:\/\/styrigx\.com"/, s);
    assert.match(a, /"acct" \(cond \$isEn \(replace \$\w+\.me\.href "https:\/\/styrigx\.com\/" "https:\/\/styrigx\.com\/en\/"\) \$\w+\.me\.href\)/, s);
    assert.match(a, /"avatar" \$\w+\.me\.avatar/, s);
    assert.match(a, /"langHref" \$langHref/, s + '：语言磁贴去另一种语言的同一页');
  }
  const m = callArgs('atlas');
  assert.doesNotMatch(m, /mainOrigin/);
  assert.match(m, /"avatar" "\/avatar\/192\.webp"/);
});

/* ---------------- 真实构建 ---------------- */

const PUB = { atlas: 'web/atlas/public', blog: 'web/blog/public', curio: 'web/curio/public', daymark: 'web/daymark/public' };
const built = Object.values(PUB).every((d) => existsSync(path.join(REPO, d, 'index.html')));

/** 顶栏骨架：去掉中间内容，只留结构上的 class / id / data-qp，按出现顺序 */
function skeleton(html) {
  const h = html.replace(/"/g, '');
  const hdr = h.slice(h.indexOf('<header id=site-nav'), h.indexOf('</header>'));
  const tb = ['sgx-topbar', 'sgx-tb-logo', 'sgx-wordmark', 'sgx-tb-dot', 'sgx-tb-pill', 'sgx-tb-acts', 'sgx-tb-quick', 'sgx-tb-ai', 'sgx-tb-me', 'sgx-tb-avatar']
    .map((c) => [c, hdr.search(new RegExp(`class=[^>]*\\b${c}\\b`))]);
  for (const [c, i] of tb) assert.ok(i >= 0, '顶栏有 ' + c);
  const order = tb.map(([c]) => c).filter((c) => !['sgx-wordmark', 'sgx-tb-dot', 'sgx-tb-avatar'].includes(c));
  const pos = order.map((c) => tb.find((x) => x[0] === c)[1]);
  const qp = h.slice(h.indexOf('<dialog id=sgx-qp'), h.indexOf('</dialog>', h.indexOf('<dialog id=sgx-qp')));
  const ai = h.slice(h.indexOf('<dialog id=sgx-ai'), h.indexOf('</dialog>', h.indexOf('<dialog id=sgx-ai')));
  return {
    sorted: pos.every((x, n) => n === 0 || x > pos[n - 1]),
    tabs: [...qp.matchAll(/data-qp-tab=([a-z]+)/g)].map((x) => x[1]),
    pages: [...qp.matchAll(/data-qp-page=([a-z]+)/g)].map((x) => x[1]),
    nav: [...qp.matchAll(/data-nav=([a-z]+)/g)].map((x) => x[1]),
    current: [...qp.matchAll(/data-nav=([a-z]+) aria-current=page/g)].map((x) => x[1]),
    tiles: [...qp.matchAll(/data-qp=([a-z]+)/g)].map((x) => x[1]),
    swatches: (qp.match(/class=sgx-qp-sw pal-tile/g) || []).length,
    ai: ['data-ai-list', 'data-ai-form', 'data-ai-in', 'data-ai-scope', 'data-ai-clear'].every((k) => ai.includes(k)),
    legacy: /sgx-drawer|sgx-tb-nav\b|sgx-tb-end\b|sgx-tb-share\b|apps-grid/.test(h.replace(/<script[\s\S]*?<\/script>/g, '')),
  };
}

test('真实构建：四站首页（中英）顶栏骨架一致 —— 胶囊顺序、两页、导航四项同序且当前站高亮、AI 窗口；磁贴按站；没有九宫格 / 抽屉 / 右圆', (t) => {
  if (!built) { t.skip('还没构建（先 npm run build）'); return; }
  const CUR = { atlas: 'home', blog: 'blog', curio: 'curio', daymark: 'daymark' };
  for (const site of Object.keys(PUB)) {
    for (const f of ['index.html', 'en/index.html']) {
      const sk = skeleton(readFileSync(path.join(REPO, PUB[site], f), 'utf8'));
      const at = `${site}/${f}`;
      assert.ok(sk.sorted, at + '：logo → 中间 → 快捷面板 → AI → 头像');
      assert.deepEqual(sk.tabs, ['nav', 'set'], at);
      assert.deepEqual(sk.pages, ['nav', 'set'], at);
      assert.deepEqual(sk.nav, ['home', 'curio', 'daymark', 'blog'], at);
      assert.deepEqual(sk.current, [CUR[site]], at + '：当前站高亮');
      assert.deepEqual(sk.tiles, site === 'atlas' ? ['dark', 'system', 'lang', 'lock'] : ['dark', 'system', 'lang', 'share'], at + '：磁贴');
      assert.equal(sk.swatches, 22, at + '：22 个色块');
      assert.ok(sk.ai, at + '：AI 窗口齐全');
      assert.equal(sk.legacy, false, at + '：没有九宫格 / 抽屉 / 右圆分享');
    }
  }
});
