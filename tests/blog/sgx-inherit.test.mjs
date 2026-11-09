// 博客跟随主站设置（sgx-ui cookie：外观 / 调色板 / 自定义主题色种子 / 语言）+ 数字健康区域键。
// 契约以主站为准（styrigx-space docs/ui-cookie-contract.md）；博客内联的读端就是共享外壳 ui-cookie-read.js 原样，
// 下面用主站契约夹具 tests/fixtures/ui-cookie-contract.json（sync-shell 同步、勿手改）逐条跑「共享读端 + 博客胶水」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bootLang } from '../../space/web/assets/js/lib/lang-boot.js';

/* 首帧前的内联脚本：space/web/layouts/partials/blog/sgx-inherit.html 三个 <script>：
   ① 首帧语言跳转（共享外壳 lang-boot.js，四站同一份，语言清理 2026-11-07）② 共享读端（ui-cookie-read.js 压缩版）③ 博客胶水（只管外观） */
const partial = readFileSync(new URL('../../space/web/layouts/partials/blog/sgx-inherit.html', import.meta.url), 'utf8');
const scripts = [...partial.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.equal(scripts.length, 3, 'sgx-inherit.html 应有三个 <script>');
assert.match(scripts[0], /resources\.Get "js\/lib\/lang-boot\.js" \| js\.Build/, '第一个 <script> 内联首帧语言跳转');
assert.match(scripts[1], /resources\.Get "js\/lib\/ui-cookie-read\.js"|\$reader\.Content/, '第二个 <script> 内联共享读端');
const glue = scripts[2];
const READER = readFileSync(new URL('../../space/web/assets/js/lib/ui-cookie-read.js', import.meta.url), 'utf8');
/* 模块那一半（数字健康、自定义色引擎按需加载）：space/web/assets/blog/js/entries/inherit.ts */
const inheritModule = readFileSync(new URL('../../space/web/assets/blog/js/entries/inherit.ts', import.meta.url), 'utf8');
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
    'data-theme-mode': html.getAttribute('data-theme-mode'),
    'data-dark': html.getAttribute('data-dark'),
    'data-font-size': html.getAttribute('data-font-size'),
    fontSize: html.style.fontSize,
    'data-palette': html.getAttribute('data-palette'),
    '--sgx-seed': html.style.getPropertyValue('--sgx-seed'),
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
  assert.equal(U.SCHEME_VER, palettes.schemeVersion, '读端引擎版本 = palettes.json schemeVersion（同一次 sync-shell）');
  assert.deepEqual({ ...U.PRESETS }, SEEDS, '读端预设种子 = palettes.json');
  assert.match(partial, /resources\.Get "js\/lib\/ui-cookie-read\.js"/);
  assert.doesNotMatch(partial, /data-sgx-seed|dataset\.sgxSeed|ui\.theme/);
});

test('契约夹具不能是空的（sync-shell 同步自主站 space/web/shared/shell/ui-cookie-contract.json）', () => {
  assert.ok(fx.cases.length >= 20, String(fx.cases.length));
  const names = fx.cases.map((c) => c.name).join('|');
  for (const k of ['未知版本', 'theme 别名', 'accent 大写', '旧种子', '自定义主题色']) assert.match(names, new RegExp(k), k);
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

test('无 cookie：跟系统深浅色，默认调色板，契约属性都写上', () => {
  const r = run();
  assert.equal(r.attrs['data-theme'], 'light');
  assert.equal(r.attrs['data-theme-mode'], 'system');
  assert.equal(r.attrs['data-dark'], '0');
  assert.equal(r.attrs['data-font-size'], 'standard');
  assert.equal(r.attrs['data-reduced-motion'], '0');
  assert.ok(!r.has('dark'));
  assert.equal(r.attrs['data-palette'], undefined);
  assert.equal(r.seed, '');
  assert.equal(r.html.style.fontSize, '');
  const d = run({ dark: true });
  assert.equal(d.attrs['data-theme'], 'dark');
  assert.equal(d.attrs['data-dark'], '1');
  assert.ok(d.has('dark'), '共享外壳的角色认 <html class="dark">');
});

test('应用主站 mode/pal/fs/rm', () => {
  const r = run({
    cookie: 'a=1; sgx-ui=' + enc({ v: 2, mode: 'dark', pal: 'matcha', fs: 'large', rm: 1, mat: 5 }),
  });
  assert.equal(r.attrs['data-theme'], 'dark');
  assert.equal(r.attrs['data-theme-mode'], 'dark');
  assert.equal(r.attrs['data-palette'], 'matcha');
  assert.equal(r.html.style.fontSize, '112.5%');
  assert.equal(r.attrs['data-font-size'], 'large');
  assert.ok(r.has('reduced-motion'));
  assert.equal(r.attrs['data-reduced-motion'], '1');
});

test('校验 v：缺失 / 字符串 / 未知版本 → 当没有 cookie（不再无视版本）', () => {
  for (const v of [undefined, '2', 3, 0]) {
    const r = run({ cookie: 'sgx-ui=' + enc({ v, mode: 'dark', pal: 'matcha' }) });
    assert.equal(r.attrs['data-theme'], 'light', String(v));
    assert.equal(r.attrs['data-palette'], undefined, String(v));
  }
  assert.equal(run({ cookie: 'sgx-ui=' + enc({ v: 1, mode: 'dark' }) }).attrs['data-theme'], 'dark');
});

test('mode=system 跟随系统，系统变了重落；theme 别名不再认', () => {
  assert.equal(run({ cookie: 'sgx-ui=' + enc({ v: 2, mode: 'system' }), dark: true }).attrs['data-theme'], 'dark');
  assert.equal(run({ cookie: 'sgx-ui=' + enc({ v: 2, mode: 'light' }), dark: true }).attrs['data-theme'], 'light');
  const alias = run({ cookie: 'sgx-ui=' + enc({ v: 2, theme: 'dark' }) });
  assert.equal(alias.attrs['data-theme'], 'light');
  assert.equal(alias.attrs['data-theme-mode'], 'system');

  const r = run({ cookie: 'sgx-ui=' + enc({ v: 2, mode: 'system' }), dark: false });
  assert.equal(r.mqListeners.length, 1, '只挂一个系统深浅色监听（读端 watch: false，博客自己挂）');
  r.flip(true);
  assert.equal(r.html.getAttribute('data-theme'), 'dark');
  assert.equal(r.html.getAttribute('data-dark'), '1');
  assert.ok(r.html.classList.contains('dark'));
});

test('博客已没有深浅色开关：旧的 navfolio-theme / sgx-theme-at 清掉，不再盖过主站', () => {
  const r = run({
    cookie: 'sgx-ui=' + enc({ v: 2, mode: 'dark', mat: 1 }),
    local: { 'navfolio-theme': 'light', 'sgx-theme-at': '999' },
  });
  assert.equal(r.attrs['data-theme'], 'dark');
  assert.equal(r.local['navfolio-theme'], undefined);
  assert.equal(r.local['sgx-theme-at'], undefined);
});

test('accent：预设种子 / 旧种子 → 预设；不同 → 内联 --sgx-seed（有缓存首帧插角色，没缓存留给模块脚本）；大写不认', () => {
  const preset = run({ cookie: 'sgx-ui=' + enc({ v: 2, pal: 'rose', accent: SEEDS.rose }) });
  assert.equal(preset.attrs['data-palette'], 'rose');
  assert.equal(preset.seed, '');
  assert.equal(preset.style(), null);

  /* PR-G 之前的旧种子（LEGACY_SEEDS）也算预设 */
  const legacy = run({ cookie: 'sgx-ui=' + enc({ v: 2, pal: 'lake', accent: '#2f5f86' }) });
  assert.equal(legacy.attrs['data-palette'], 'lake');
  assert.equal(legacy.seed, '');

  const noCache = run({ cookie: 'sgx-ui=' + enc({ v: 2, pal: 'lake', accent: '#ffd54f' }) });
  assert.equal(noCache.seed, '#ffd54f');
  assert.equal(noCache.attrs['data-sgx-seed'], undefined, '不再用 data-sgx-seed');
  assert.equal(noCache.style(), null, '没缓存：首帧先用预设');

  const css = 'html:root{--sgx-primary:#123}';
  const cached = run({
    cookie: 'sgx-ui=' + enc({ v: 2, pal: 'lake', accent: '#ffd54f' }),
    local: { 'sgx-shell-accent-css': palettes.schemeVersion + '|#ffd54f\n' + css },
  });
  assert.equal(cached.style().textContent, css);

  const stale = run({
    cookie: 'sgx-ui=' + enc({ v: 2, pal: 'lake', accent: '#ffd54f' }),
    local: { 'sgx-shell-accent-css': 'old|#ffd54f\n' + css },
  });
  assert.equal(stale.style(), null, '引擎版本变了：缓存作废');

  /* 大写 / 色板 id / 非法值 → 忽略，只看 pal（写端永远写小写） */
  for (const accent of ['#FFD54F', 'rose', 'red;x', '#12345', '#abc']) {
    const r = run({ cookie: 'sgx-ui=' + enc({ v: 2, pal: 'teal', accent }) });
    assert.equal(r.attrs['data-palette'], 'teal');
    assert.equal(r.seed, '', accent);
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

test('模块一半：自定义色没缓存时读 --sgx-seed，算好交给 SgxUI.setRoles（同一缓存格式）', () => {
  assert.match(inheritModule, /getPropertyValue\('--sgx-seed'\)/);
  assert.match(inheritModule, /UI\.setRoles\(seed, rolesCss\(seed\)\)/);
  assert.doesNotMatch(inheritModule, /sgxSeed|data-sgx-seed/);
});

test('共享外壳副本含 22 套预设（亮 / 暗）和顶栏 / 快捷面板样式（2026-11-04 P5-1 抽屉删了）', () => {
  const shell = (readFileSync(new URL('../../space/web/assets/css/shell/tokens.css', import.meta.url), 'utf8') + readFileSync(new URL('../../space/web/assets/css/shell/shell.css', import.meta.url), 'utf8'));
  assert.equal(palettes.presets.length, 22);
  for (const { id } of palettes.presets) {
    assert.ok(shell.includes(`:root[data-palette="${id}"] {`), id + ' light');
    assert.ok(shell.includes(`:root.dark[data-palette="${id}"] {`), id + ' dark');
  }
  assert.match(shell, /\.sgx-qp-tile\[aria-current="page"\]/); /* PR-4b：站点切换在九宫格导航面板（磁贴，当前站「开」态） */
  assert.match(shell, /\.sgx-topbar \{ position: fixed;/);
  assert.doesNotMatch(shell, /\.sgx-drawer-item/);
});

test('数字健康：文章页 post:<slug>，其他页 blog，上报主站', () => {
  assert.match(inheritModule, /key: 'post:' \+ m\[1\]/);
  assert.match(inheritModule, /key: 'blog'/);
  assert.match(inheritModule, /https:\/\/styrigx\.com\/api\/wellbeing/);
  assert.match(inheritModule, /idleMs: 180000/);
});
