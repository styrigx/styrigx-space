// 博客跟随主站设置（sgx-ui cookie：调色板（深浅跟着调色板，2026-11-12 调色板 v4）/ 语言）。
// 契约以主站为准（docs/specs/ui-cookie.md）；博客内联的读端就是共享外壳 ui-cookie-read.js 原样，
// 下面用主站契约夹具 tests/fixtures/ui-cookie-contract.json（sync-shell 同步、勿手改）逐条跑「共享读端 + 博客胶水」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bootLang } from '../../space/web/assets/shell/js/i18n/lang-boot.js';

/* 首帧前的内联脚本：space/web/layouts/partials/blog/sgx-inherit.html 三个 <script>：
   ① 首帧语言跳转（共享外壳 lang-boot.js，四站同一份，语言清理 2026-11-07）② 共享读端（ui-cookie-read.js 压缩版）③ 博客胶水（只管外观） */
const partial = readFileSync(new URL('../../space/web/layouts/partials/blog/sgx-inherit.html', import.meta.url), 'utf8');
const scripts = [...partial.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.equal(scripts.length, 3, 'sgx-inherit.html 应有三个 <script>');
assert.match(scripts[0], /resources\.Get "shell\/js\/i18n\/lang-boot\.js" \| js\.Build/, '第一个 <script> 内联首帧语言跳转');
assert.match(scripts[1], /resources\.Get "shell\/js\/prefs\/ui-cookie-read\.js"|\$reader\.Content/, '第二个 <script> 内联共享读端');
const glue = scripts[2];
const READER = readFileSync(new URL('../../space/web/assets/shell/js/prefs/ui-cookie-read.js', import.meta.url), 'utf8');
/* 模块那一半（entries/inherit.ts：数字健康、自定义色引擎）v6 P4 / 调色板 v4 先后删完，文件已删 */
const HEAD = readFileSync(new URL('../../space/web/layouts/partials/blog/head.html', import.meta.url), 'utf8');
const palettes = JSON.parse(
  readFileSync(new URL('../../space/web/data/shell/palettes.json', import.meta.url), 'utf8'),
);
const fx = JSON.parse(readFileSync(new URL('../fixtures/ui-cookie-contract.json', import.meta.url), 'utf8'));
const SEEDS = Object.fromEntries(palettes.presets.map((p) => [p.id, p.seed]));

function enc(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 最小 DOM 桩：<html> 的 class / attribute / style，<head> 里的 <style>，localStorage，matchMedia */
function makeEl(tag) {
  const attrs = new Map();
  const classes = new Set();
  const props = new Map();
  const el = {
    tagName: tag,
    id: '',
    textContent: '',
    children: [],
    parentNode: null,
    attrs,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    style: {
      fontSize: '',
      colorScheme: '',
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
      getPropertyValue: (k) => props.get(k) || '',
    },
    appendChild(c) {
      c.parentNode = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      el.children.splice(el.children.indexOf(c), 1);
      c.parentNode = null;
      return c;
    },
  };
  return el;
}

function run({
  cookie = '',
  local = {},
  dark = false,
  lang = 'zh-CN',
  path = '/blog/',
  hash = '',
  alt = {},
  ua = 'Mozilla/5.0',
  navLang = 'zh-CN',
} = {}) {
  const html = makeEl('html');
  html.setAttribute('lang', lang);
  const head = html.appendChild(makeEl('head'));
  const mqListeners = [];
  const winListeners = {};
  const replaced = [];
  let cookieWrites = 0;
  const mq = {
    get matches() {
      return ctx.__dark;
    },
    addEventListener: (_t, cb) => mqListeners.push(cb),
  };
  const ctx = {
    __dark: dark,
    atob: (s) => Buffer.from(s, 'base64').toString('latin1'),
    btoa: (s) => Buffer.from(s, 'latin1').toString('base64'),
    escape,
    unescape,
    localStorage: {
      getItem: (k) => (k in local ? local[k] : null),
      setItem: (k, v) => (local[k] = String(v)),
      removeItem: (k) => delete local[k],
    },
    matchMedia: () => mq,
    addEventListener: (t, cb) => (winListeners[t] = winListeners[t] || []).push(cb),
    location: { pathname: path, hash, replace: (u) => replaced.push(u) },
    navigator: { userAgent: ua, language: navLang },
    document: {
      documentElement: html,
      head,
      get cookie() {
        return cookie;
      },
      set cookie(_v) {
        cookieWrites++;
      },
      createElement: (t) => makeEl(t),
      getElementById: (id) => head.children.find((c) => c.id === id) || null,
      querySelector: (sel) => {
        const m = sel.match(/sgx-alt-(zh|en)/);
        return m && alt[m[1]] ? { getAttribute: () => alt[m[1]] } : null;
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(READER, ctx, { filename: 'ui-cookie-read.js' });
  vm.runInContext(glue, ctx, { filename: 'sgx-inherit.html#glue' });
  const style = () => head.children.find((c) => c.id === 'sgx-accent-roles') || null;
  return {
    html,
    attrs: Object.fromEntries(html.attrs),
    has: (c) => html.classList.contains(c),
    seed: html.style.getPropertyValue('--sgx-seed'),
    style,
    local,
    replaced,
    ctx,
    mqListeners,
    get cookieWrites() {
      return cookieWrites;
    },
    flip(d) {
      ctx.__dark = d;
      for (const cb of mqListeners) cb();
    },
  };
}

/** <html> 状态，和夹具 root 同形 */
function rootState(html) {
  return {
    dark: html.classList.contains('dark'),
    'data-dark': html.getAttribute('data-dark'),
    'data-font-size': html.getAttribute('data-font-size'),
    fontSize: html.style.fontSize,
    'data-palette': html.getAttribute('data-palette'),
    'reduced-motion': html.classList.contains('reduced-motion'),
    'data-reduced-motion': html.getAttribute('data-reduced-motion'),
  };
}

test('内联读端 = 共享外壳 ui-cookie-read.js 原样，和本仓库色板数据同一版本', () => {
  const r = run();
  const U = r.ctx.SgxUI;
  assert.ok(U, 'window.SgxUI');
  assert.deepEqual([...U.VERSIONS], [1, 2]);
  assert.equal(U.DEFAULT_PAL, palettes.default);
  assert.deepEqual([...U.DARK], palettes.presets.filter((p) => p.mode === 'dark').map((p) => p.id), '读端深套表 = palettes.json');
  assert.deepEqual({ ...U.PRESETS }, SEEDS, '读端预设种子 = palettes.json');
  assert.match(partial, /resources\.Get "shell\/js\/prefs\/ui-cookie-read\.js"/);
  assert.doesNotMatch(partial, /data-sgx-seed|dataset\.sgxSeed|ui\.theme/);
});

test('契约夹具不能是空的（主站 tests/fixtures/ui-cookie-contract.json）', () => {
  assert.ok(fx.cases.length >= 20, String(fx.cases.length));
  const names = fx.cases.map((c) => c.name).join('|');
  for (const k of ['未知版本', 'theme 别名', '旧自定义主题色残留', '浅套 dustyblue \\+ mode dark', '深套 lake \\+ mode light']) assert.match(names, new RegExp(k), k);
});

for (const c of fx.cases) {
  test(`契约：${c.name}`, () => {
    for (const sys of ['light', 'dark']) {
      const r = run({ cookie: 'sgx-space-session=x; sgx-ui=' + c.cookie + '; other=1', dark: sys === 'dark' });
      assert.deepEqual(rootState(r.html), c[sys].root, sys + ' <html>');
      /* 博客自己的样式钩子跟着 dark 走 */
      const d = c[sys].resolve.dark;
      assert.equal(r.attrs['data-theme'], d ? 'dark' : 'light', sys + ' data-theme');
      assert.equal(r.html.style.colorScheme, d ? 'dark' : 'light', sys + ' color-scheme');
      assert.equal(r.cookieWrites, 0, '博客不许写 sgx-ui');
      assert.deepEqual(r.replaced, [], '外观用例不跳语言');
    }
  });
}

test('无 cookie：默认调色板 terra（深套），系统深浅不影响，契约属性都写上', () => {
  for (const dark of [false, true]) {
    const r = run({ dark });
    assert.equal(r.attrs['data-theme'], 'dark');
    assert.equal(r.attrs['data-theme-mode'], undefined);
    assert.equal(r.attrs['data-dark'], '1');
    assert.equal(r.attrs['data-font-size'], 'standard');
    assert.equal(r.attrs['data-reduced-motion'], '0');
    assert.ok(r.has('dark'), '共享外壳的角色认 <html class="dark">');
    assert.equal(r.attrs['data-palette'], undefined);
    assert.equal(r.seed, '');
    assert.equal(r.html.style.fontSize, '');
  }
});
test('应用主站 pal / fs / rm；旧 cookie 的 mode 忽略（深浅看调色板）', () => {
  const r = run({
    cookie: 'a=1; sgx-ui=' + enc({ v: 2, mode: 'light', pal: 'matcha', fs: 'large', rm: 1, mat: 5 }),
  });
  assert.equal(r.attrs['data-theme'], 'dark', 'matcha 是深套');
  assert.equal(r.attrs['data-palette'], 'matcha');
  assert.equal(r.html.style.fontSize, '112.5%');
  assert.equal(r.attrs['data-font-size'], 'large');
  assert.ok(r.has('reduced-motion'));
  assert.equal(r.attrs['data-reduced-motion'], '1');
  assert.equal(run({ cookie: 'sgx-ui=' + enc({ v: 2, mode: 'dark', pal: 'sage' }) }).attrs['data-theme'], 'light', 'sage 是浅套');
});
test('校验 v：缺失 / 字符串 / 未知版本 → 当没有 cookie（不再无视版本）', () => {
  for (const v of [undefined, '2', 3, 0]) {
    const r = run({ cookie: 'sgx-ui=' + enc({ v, pal: 'sage' }) });
    assert.equal(r.attrs['data-theme'], 'dark', String(v) + ' 默认 terra');
    assert.equal(r.attrs['data-palette'], undefined, String(v));
  }
  assert.equal(run({ cookie: 'sgx-ui=' + enc({ v: 1, pal: 'sage' }) }).attrs['data-theme'], 'light');
});
test('不跟系统：不挂系统深浅色监听；快捷面板换调色板（sgx-theme-changed）时 data-theme / color-scheme 跟着重落；theme 别名不认', () => {
  const alias = run({ cookie: 'sgx-ui=' + enc({ v: 2, theme: 'light' }) });
  assert.equal(alias.attrs['data-theme'], 'dark');
  const r = run({ cookie: 'sgx-ui=' + enc({ v: 2, pal: 'sage' }), dark: true });
  assert.equal(r.mqListeners.length, 0, '不挂系统深浅色监听');
  assert.equal(r.attrs['data-theme'], 'light');
  r.flip(false);
  assert.equal(r.html.getAttribute('data-theme'), 'light');
  assert.doesNotMatch(glue, /prefers-color-scheme|matchMedia/);
  assert.match(glue, /addEventListener\('sgx-theme-changed', sync\)/);
});
test('博客已没有外观开关：旧的 navfolio-theme / sgx-theme-at，以及 v4 删掉的 sgx-theme-mode / sgx-accent / sgx-accent-css 清掉', () => {
  const r = run({
    cookie: 'sgx-ui=' + enc({ v: 2, pal: 'lake' }),
    local: { 'navfolio-theme': 'light', 'sgx-theme-at': '999', 'sgx-theme-mode': 'light', 'sgx-accent': '#123456', 'sgx-accent-css': 'x' },
  });
  assert.equal(r.attrs['data-theme'], 'dark');
  for (const k of ['navfolio-theme', 'sgx-theme-at', 'sgx-theme-mode', 'sgx-accent', 'sgx-accent-css']) assert.equal(r.local[k], undefined, k);
});
test('旧 cookie 的 accent 一律忽略（自定义主题色 2026-11-12 删除）：不写 --sgx-seed、不插角色 <style>，旧缓存清掉', () => {
  for (const accent of ['#ffd54f', '#2f5f86', '#FFD54F', 'rose', 'red;x']) {
    const r = run({ cookie: 'sgx-ui=' + enc({ v: 2, pal: 'teal', accent }), local: { 'sgx-shell-accent-css': 'old|#ffd54f\nX' } });
    assert.equal(r.attrs['data-palette'], 'teal');
    assert.equal(r.seed, '', accent);
    assert.equal(r.style(), null, accent);
    assert.equal(r.local['sgx-shell-accent-css'], undefined);
  }
});
/* 语言（语言清理 2026-11-07）：四站同一份 lang-boot.js；博客每页都跳（不只首页），只去本页 <meta name="sgx-alt-<语言>"> 声明过的地址 */
function boot({ local = {}, cookie = '', path = '/blog/', hash = '', alt = null, ua = 'Mozilla/5.0', navLang = 'zh-CN' } = {}) {
  const replaced = [];
  const metas = alt ? Object.entries(alt).map(([l, u]) => ({ name: 'sgx-alt-' + l, content: u })) : [{ name: 'sgx-alt-none', content: '' }];
  const session = {};
  const w = {
    localStorage: { getItem: (k) => (k in local ? local[k] : null) },
    sessionStorage: { setItem: (k, v) => (session[k] = v) },
    navigator: { userAgent: ua, language: navLang, languages: [navLang] },
    location: { pathname: path, hash, search: '', replace: (u) => replaced.push(u) },
    document: {
      cookie,
      referrer: '',
      querySelectorAll: () => metas,
      querySelector: (sel) => {
        const m = sel.match(/sgx-alt-([a-z]+)/);
        const hit = m && metas.find((x) => x.name === 'sgx-alt-' + m[1]);
        return hit ? { getAttribute: () => hit.content } : null;
      },
    },
  };
  bootLang(w);
  return { replaced, session, w };
}

test('lang：偏好和页面不同且有对应版本 → 跳过去（带 hash）；英文 /blog/、中文 /blog/zh/', () => {
  const ck = 'sgx-ui=' + enc({ v: 2, lang: 'zh' });
  assert.deepEqual(boot({ cookie: ck, navLang: 'en-US', path: '/blog/', hash: '#topics', alt: { zh: '/blog/zh/', en: '/blog/' } }).replaced, ['/blog/zh/#topics']);
  assert.deepEqual(boot({ local: { 'sgx-lang': 'zh' }, navLang: 'en-US', path: '/blog/post/x/', alt: { zh: '/blog/zh/post/x/', en: '/blog/post/x/' } }).replaced, ['/blog/zh/post/x/']);
  /* 没有中文版本（文章只有英文 / 标签页 / 404）：留在原页 */
  assert.deepEqual(boot({ cookie: ck, path: '/blog/post/x/', alt: { en: '/blog/post/x/' } }).replaced, []);
  assert.deepEqual(boot({ cookie: ck, path: '/blog/tags/ai/' }).replaced, []);
  /* 已是中文页 */
  assert.deepEqual(boot({ cookie: ck, path: '/blog/zh/', alt: { zh: '/blog/zh/', en: '/blog/' } }).replaced, []);
  /* zh → en */
  assert.deepEqual(boot({ local: { 'sgx-lang': 'en' }, path: '/blog/zh/post/a/', alt: { zh: '/blog/zh/post/a/', en: '/blog/post/a/' } }).replaced, ['/blog/post/a/']);
  /* 爬虫不跳 */
  assert.deepEqual(boot({ cookie: ck, path: '/blog/', alt: { zh: '/blog/zh/', en: '/blog/' }, ua: 'Googlebot' }).replaced, []);
  /* cookie 版本不合法：lang 不认 → 跟随系统（浏览器英文 → 不跳） */
  assert.deepEqual(boot({ cookie: 'sgx-ui=' + enc({ lang: 'zh' }), navLang: 'en-US', path: '/blog/post/a/', alt: { zh: '/blog/zh/post/a/', en: '/blog/post/a/' } }).replaced, []);
});

test('lang：跟随系统（明确存 system，或旧版的空 / 没有 = Auto）在博客不跳（2026-11-09：只在进主站首页时跳，深链 / 分享地址不动）；明确选择照旧跳、记 sgx-lang-hop', () => {
  const both = (p) => ({ zh: '/blog/zh' + p.slice(5), en: p });
  for (const local of [{}, { 'sgx-lang': 'system' }, { 'sgx-lang': '' }]) {
    assert.deepEqual(boot({ local, path: '/blog/', alt: both('/blog/') }).replaced, [], JSON.stringify(local));
    assert.deepEqual(boot({ local, path: '/blog/post/a/', alt: both('/blog/post/a/') }).replaced, [], '文章页不跳');
  }
  const r = boot({ local: { 'sgx-lang': 'zh' }, path: '/blog/post/a/', alt: both('/blog/post/a/'), navLang: 'en-US' });
  assert.deepEqual(r.replaced, ['/blog/zh/post/a/'], '明确选中文：文章页跳');
  assert.deepEqual(JSON.parse(r.session['sgx-lang-hop']), { go: '/blog/zh/post/a/', ref: '' });
  assert.equal(r.w.__sgxLangGo, 1);
  assert.deepEqual(boot({ local: { 'sgx-lang': 'en' }, path: '/blog/', alt: both('/blog/') }).replaced, []);
  assert.deepEqual(boot({ local: { 'styrigx-blog-lang': 'en' }, path: '/blog/', alt: both('/blog/') }).replaced, []);
});

test('坏 cookie / 非法或未知调色板不抛错，回到主站默认 terra（不写 data-palette；2026-11 PR-A 前是 dustyblue）；lake / dustyblue 是普通色板；旧撞色 xlake → lake', () => {
  assert.equal(palettes.default, 'terra');
  const pal = (p) => run({ cookie: 'sgx-ui=' + enc({ v: 2, pal: p }) }).attrs['data-palette'];
  assert.equal(pal('lake'), 'lake');
  assert.equal(pal('xlake'), 'lake');
  assert.equal(pal('terra'), undefined);
  assert.equal(pal('dustyblue'), 'dustyblue');
  assert.equal(run({ cookie: 'sgx-ui=%%%' }).attrs['data-palette'], undefined);
  assert.equal(pal('"><x'), undefined);
  assert.equal(pal('nosuch'), undefined);
});

test('博客 head 不再加载 inherit.ts / palette-scheme.js（自定义色引擎删了）；默认 color-scheme / theme-color 在共享读端之前', () => {
  assert.doesNotMatch(HEAD, /inherit\.ts|palette-scheme\.js/);
  const iMeta = HEAD.indexOf('<meta name="theme-color" content="{{ .tokens.background }}">');
  assert.ok(iMeta > 0 && iMeta < HEAD.indexOf('partial "blog/sgx-inherit.html"'));
  assert.doesNotMatch(HEAD, /#fdfdf9/);
});
test('共享外壳副本含 22 套预设（v4 起每套一段）和顶栏 / 快捷面板样式（2026-11-04 P5-1 抽屉删了）', () => {
  const shell = (readFileSync(new URL('../../space/web/assets/shell/css/tokens.css', import.meta.url), 'utf8') + readFileSync(new URL('../../space/web/assets/shell/css/shell.css', import.meta.url), 'utf8'));
  assert.equal(palettes.presets.length, 25);
  for (const { id } of palettes.presets) {
    assert.ok(shell.includes(`:root[data-palette="${id}"] {`), id);
    assert.ok(!shell.includes(`:root.dark[data-palette="${id}"] {`), id + ' 没有深色段');
  }
  assert.match(shell, /\.sgx-qp-tile\[aria-current="page"\]/); /* PR-4b：站点切换在九宫格导航面板（磁贴，当前站「开」态） */
  assert.match(shell, /\.sgx-topbar \{ position: fixed;/);
  assert.doesNotMatch(shell, /\.sgx-drawer-item/);
});

test('数字健康上报 v6 P4 整套删除（定稿 v5.5 §四）：博客不再上报 /api/wellbeing', () => {
  assert.doesNotMatch(HEAD + partial, /api\/wellbeing|initWbTrack|wb-track/);
});
