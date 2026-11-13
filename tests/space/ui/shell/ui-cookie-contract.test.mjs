/**
 * sgx-ui cookie 契约（2026-10-22）：主站写端 lib/ui-cookie.js ↔ 子站读端 lib/ui-cookie-read.js（共享外壳原样分发）。
 * 夹具 tests/fixtures/ui-cookie-contract.json 由 space/scripts/gen/gen-ui-cookie-contract.mjs 跑真写端生成；
 * 这里断言：夹具没过期、每个 cookie 经读端 read / resolve / apply 得到夹具里的期望、写端字段表 = 读端字段表、
 * 读端是 ES5 经典脚本且从不写 cookie。（过去主站改了 sgx-verified 格式、子站死循环——契约不许悄悄漂移。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { renderContract, FIXTURE } from '../../../../space/scripts/gen/gen-ui-cookie-contract.mjs';
import { frameFiles, READER_SRC } from '../../../../space/scripts/gen/gen-common.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const READER = readFileSync(READER_SRC, 'utf8');
const CORE = readFileSync(path.join(REPO, 'space/web/assets/common/js/frame/apps/core.js'), 'utf8');
/* 2026-11-04 P5-1：cookie 写法搬进外观写端 lib/prefs-write.js（共享外壳 prefs-write.js，四站一个写端）；v1.6 删 prefs/ui-cookie.js 垫片后，主站 frame/apps/core.js 直接先引读端、从 prefs-write.js 取 syncUiCookie */
const PREFS_WRITE = readFileSync(path.join(REPO, 'space/web/assets/common/js/prefs/prefs-write.js'), 'utf8');
const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const palettes = JSON.parse(readFileSync(path.join(REPO, 'space/web/data/common/palette-list.json'), 'utf8'));

/** 最小 DOM 桩：<html> 的 class / attribute / style，<head> 里的 <style>，localStorage，matchMedia */
function makeEl(tag) {
  const attrs = new Map();
  const classes = new Set();
  const props = new Map();
  const el = {
    tagName: tag, id: '', textContent: '', children: [], parentNode: null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    style: { fontSize: '', setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k), getPropertyValue: (k) => props.get(k) || '' },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { el.children.splice(el.children.indexOf(c), 1); c.parentNode = null; return c; },
  };
  return el;
}

function sandbox({ cookie = '', dark = false, store = {} } = {}) {
  const html = makeEl('html');
  const head = html.appendChild(makeEl('head'));
  const ls = new Map(Object.entries(store));
  const listeners = [];
  let cookieWrites = 0;
  const mq = { get matches() { return ctx.__dark; }, addEventListener: (_t, cb) => listeners.push(cb) };
  const ctx = {
    __dark: dark,
    atob: (s) => Buffer.from(s, 'base64').toString('latin1'),
    btoa: (s) => Buffer.from(s, 'latin1').toString('base64'),
    escape, unescape,
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) },
    matchMedia: () => mq,
    document: {
      documentElement: html, head,
      get cookie() { return cookie; },
      set cookie(_v) { cookieWrites++; },
      createElement: (t) => makeEl(t),
      getElementById: (id) => head.children.find((c) => c.id === id) || null,
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(READER, ctx, { filename: 'ui-cookie-read.js' });
  return {
    U: ctx.SgxUI, html, head, ls, ctx,
    setCookie: (c) => { cookie = c; },
    flip: (d) => { ctx.__dark = d; for (const cb of listeners) cb(); },
    get cookieWrites() { return cookieWrites; },
    listeners,
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
const plain = (o) => JSON.parse(JSON.stringify(o));

test('夹具没过期：写端真实产出 = tests/fixtures/ui-cookie-contract.json（改了写端要重跑 gen-ui-cookie-contract.mjs）', async () => {
  assert.equal(await renderContract(), readFileSync(FIXTURE, 'utf8'));
});

test('夹具覆盖：空 localStorage、旧 mode / accent 残留、深套 lake / 浅套 dustyblue、旧撞色 xforest 迁移、旧 v1 / v2、旧 cookie 的 mode 被忽略、未知版本、乱码', () => {
  const names = fx.cases.map((c) => c.name).join('|');
  for (const k of ['空 localStorage', '旧 sgx-theme-mode 残留', '旧自定义主题色残留', '湖蓝 lake', '雾霾蓝 dustyblue', '旧撞色 xforest', '旧 v1', '旧 v2', '浅套 dustyblue \\+ mode dark', '深套 lake \\+ mode light', '未知版本', '乱码']) assert.match(names, new RegExp(k), k);
  assert.ok(fx.cases.filter((c) => c.source === 'writer').length >= 8);
});
test('语言 lang：写端只写明确选的语言代码，跟随系统明确写 system（语言清理 2026-11-07）；读端只认小写语言代码，其余（旧空值 / 没有 / 不合法）读成 system，版本不认识整份不认', () => {
  const s = sandbox();
  const byLocal = (v) => fx.cases.find((c) => c.source === 'writer' && c.local['sgx-lang'] === v);
  assert.equal(s.U.decode(byLocal('en').cookie).lang, 'en');
  assert.equal(s.U.decode(byLocal('zh').cookie).lang, 'zh');
  assert.equal(s.U.decode(byLocal('system').cookie).lang, 'system');
  for (const c of fx.cases.filter((x) => x.source === 'writer' && !('sgx-lang' in x.local))) assert.equal(s.U.read('sgx-ui=' + c.cookie).lang, 'system', c.name);
  assert.equal(s.U.read('sgx-ui=' + s.U.encode({ v: 2, lang: '' })).lang, 'system');
  assert.equal(s.U.read('sgx-ui=' + s.U.encode({ v: 2, lang: 'en-US' })).lang, 'system');
  assert.equal(s.U.read('sgx-ui=' + s.U.encode({ v: 2, lang: 'EN' })).lang, 'system');
  assert.equal(s.U.read('sgx-ui=' + s.U.encode({ v: 3, lang: 'en' })), null);
});

for (const c of fx.cases) {
  test(`契约：${c.name}`, () => {
    for (const sys of ['light', 'dark']) {
      const s = sandbox({ cookie: 'sgx-space-session=x; sgx-ui=' + c.cookie + '; other=1', dark: sys === 'dark' });
      assert.deepEqual(plain(s.U.read()), c.read, 'read');
      assert.deepEqual(plain(s.U.read('sgx-ui=' + c.cookie)), c.read, 'read(串)');
      assert.deepEqual(plain(s.U.resolve(s.U.read())), c[sys].resolve, sys + ' resolve');
      const a = s.U.apply(s.html);
      assert.deepEqual(plain(a), c[sys].resolve, sys + ' apply 返回');
      assert.deepEqual(rootState(s.html), c[sys].root, sys + ' <html>');
      assert.equal(s.cookieWrites, 0, '读端不许写 cookie');
    }
    /* v4：深浅只由调色板决定，系统浅 / 深两份期望完全一样 */
    assert.deepEqual(c.light, c.dark, '系统深浅不影响结果');
  });
}

test('写端 → 读端往返：写端写出的字段 = 读端字段表（不多不少），值原样读回', () => {
  const s = sandbox();
  for (const c of fx.cases.filter((x) => x.source === 'writer')) {
    const raw = s.U.decode(c.cookie);
    assert.deepEqual(Object.keys(raw).sort(), Object.keys(c.read).sort(), c.name);
    assert.deepEqual(plain(s.U.normalize(raw)), plain(raw), c.name + '：写端写的都是合法值');
    assert.equal(s.U.encode(raw), c.cookie, c.name + '：编码一致');
  }
});

test('写端和读端共用一份常量 / 编解码（主站先 import ui-cookie-read.js；写端 prefs-write.js 用 window.SgxUI，不再自己 atob / 写死版本号）', () => {
  assert.match(CORE, /import '\.\.\/\.\.\/prefs\/ui-cookie-read\.js';/);
  assert.match(CORE, /import \{ paintPalette, syncUiCookie \} from '\.\.\/\.\.\/prefs\/prefs-write\.js';/);
  assert.doesNotMatch(PREFS_WRITE.replace(/\/\*[\s\S]*?\*\//g, ''), /^\s*import\s/m, '写端不 import（子站原样复制）');
  assert.match(PREFS_WRITE, /return \/\*\* @type \{any\} \*\/ \(window\)\.SgxUI \|\| null;/);
  assert.match(PREFS_WRITE, /v: u\.V,/);
  assert.match(PREFS_WRITE, /u\.encode\(payload\)/);
  assert.match(PREFS_WRITE, /if \(readCookie\(\) === b64\) return;/);
  assert.doesNotMatch(PREFS_WRITE, /atob|btoa|v: 2/);
  const s = sandbox();
  assert.equal(s.U.V, 2);
  assert.ok(s.U.VERSIONS.includes(s.U.V));
  assert.equal(s.U.NAME, 'sgx-ui');
});

test('读端预设表 / 深套表 / 底色表 = 共享外壳 palette-list.json（gen-common 生成段）；没有引擎版本 / 自定义色接口', () => {
  const s = sandbox();
  assert.deepEqual(plain(s.U.PRESETS), Object.fromEntries(palettes.presets.map((p) => [p.id, p.seed])));
  assert.deepEqual(plain(s.U.DARK), palettes.presets.filter((p) => p.mode === 'dark').map((p) => p.id));
  for (const p of palettes.presets) assert.equal(s.U.isDark(p.id), p.mode === 'dark', p.id);
  assert.equal(s.U.isDark('neon'), true, '不认识的 id 按默认 terra（深套）');
  assert.equal(s.U.DEFAULT_PAL, palettes.default);
  assert.equal(palettes.schemeVersion, undefined);
  assert.equal(palettes.rulesVersion, 'palette-rules-2');
  for (const k of ['SCHEME_VER', 'setRoles', 'CACHE_KEY', 'STYLE_ID', 'MODES']) assert.equal(s.U[k], undefined, k);
});
test('读端是 ES5 经典脚本：没有箭头函数 / let / const / 模板串 / 展开 / 可选链 / import / export，不写 cookie', () => {
  const code = READER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""');
  for (const [re, what] of [[/=>/, '箭头函数'], [/\blet\s/, 'let'], [/\bconst\s/, 'const'], [/`/, '模板串'], [/\.\.\./, '展开'], [/\?\./, '可选链'], [/\?\?/, '??'], [/^\s*(import|export)\b/m, 'ESM'], [/\bclass\s/, 'class'], [/\bObject\.(assign|entries|hasOwn)\b|\.includes\(|\.startsWith\(/, 'ES2015+ API']]) {
    assert.doesNotMatch(code, re, what);
  }
  assert.doesNotMatch(READER, /\.cookie\s*=[^=]/, '读端不许写 cookie');
  /* 内联进 <head> 的体积：未压缩也要小（压缩后约 3KB） */
  assert.ok(Buffer.byteLength(code.replace(/\s+/g, ' ')) < 6500, String(Buffer.byteLength(code)));
});

test('共享外壳带上读端 / 图标（2026-11 合站后子站直接用主站源文件；契约夹具只有 tests/fixtures 一份）', () => {
  const files = frameFiles();
  assert.equal(files['ui-cookie-read.js'], READER);
  assert.equal(files['favicon.js'], readFileSync(path.join(REPO, 'space/web/assets/common/js/ui/favicon.js'), 'utf8'));
  assert.equal(files['favicon.svg'], readFileSync(path.join(REPO, 'space/web/static/favicon.svg'), 'utf8'));
  assert.ok(readFileSync(FIXTURE, 'utf8').length > 100, '契约夹具');
});

const cookieOf = (name) => 'sgx-ui=' + fx.cases.find((c) => c.name === name).cookie;

test('旧版自定义色留下的东西首帧清掉：<style id="sgx-accent-roles">、本站缓存 sgx-shell-accent-css、内联 --sgx-seed', () => {
  const s = sandbox({ cookie: cookieOf('湖蓝 lake（深套）'), store: { 'sgx-shell-accent-css': 'oldver|#1f8a70\nOLD' } });
  const st = s.head.appendChild(s.ctx.document.createElement('style'));
  st.id = 'sgx-accent-roles';
  s.html.style.setProperty('--sgx-seed', '#1f8a70');
  s.U.apply(s.html);
  assert.equal(s.ctx.document.getElementById('sgx-accent-roles'), null);
  assert.equal(s.ls.has('sgx-shell-accent-css'), false);
  assert.equal(s.html.style.getPropertyValue('--sgx-seed'), '');
  assert.equal(s.html.getAttribute('data-palette'), 'lake');
  assert.equal(s.html.classList.contains('dark'), true);
});
test('深浅只由调色板决定：不读 prefers-color-scheme、不挂系统监听；paint 换调色板就换深浅和 <meta>', () => {
  const s = sandbox({ cookie: cookieOf('雾霾蓝 dustyblue（浅套）'), dark: true });
  s.U.apply(s.html);
  assert.equal(s.listeners.length, 0, '不挂系统深浅色监听');
  assert.equal(s.html.classList.contains('dark'), false, '系统是深色，浅套照样是浅');
  s.flip(false);
  assert.equal(s.html.classList.contains('dark'), false);
  assert.doesNotMatch(READER.replace(/\/\*[\s\S]*?\*\//g, ''), /prefers-color-scheme|matchMedia/);
  /* paint：带 <meta> 的页面 */
  const metas = { 'color-scheme': makeEl('meta'), 'theme-color': makeEl('meta') };
  s.ctx.document.querySelector = (sel) => metas[/name="([^"]+)"/.exec(sel)[1]] || null;
  assert.equal(s.U.paint('terra', s.html), true);
  assert.equal(s.html.getAttribute('data-palette'), null);
  assert.equal(s.html.classList.contains('dark'), true);
  assert.equal(s.html.getAttribute('data-dark'), '1');
  assert.equal(metas['color-scheme'].getAttribute('content'), 'dark');
  assert.equal(metas['theme-color'].getAttribute('content'), '#161412');
  assert.equal(s.U.paint('glacier', s.html), false);
  assert.equal(s.html.getAttribute('data-palette'), 'glacier');
  assert.equal(s.html.classList.contains('dark'), false);
  assert.equal(metas['color-scheme'].getAttribute('content'), 'light');
  assert.equal(metas['theme-color'].getAttribute('content'), palettes.presets.find((p) => p.id === 'glacier').tokens.background);
});
test('坏 cookie / 没有 DOM 能力也不抛：默认 terra（深套）', () => {
  const s = sandbox({ cookie: 'sgx-ui=%%%' });
  assert.equal(s.U.read(), null);
  assert.equal(s.U.decode(''), null);
  assert.equal(s.U.decode(null), null);
  assert.equal(s.U.read(null), null);
  const a = s.U.apply(s.html);
  assert.deepEqual(plain(a), { dark: true, pal: 'terra', fs: 'standard', rm: false });
});

test('cookie 属性按主机名 / 协议：localhost / http 不带 Domain / Secure；styrigx.com 及子域 https 带（P5-1 跨站 e2e 修法）', async () => {
  const { cookieAttrs } = await import('../../../../space/web/assets/common/js/prefs/prefs-write.js');
  const prod = '; Domain=styrigx.com; Path=/; Max-Age=34560000; SameSite=Lax; Secure';
  assert.equal(cookieAttrs({ hostname: 'styrigx.com', protocol: 'https:' }), prod);
  assert.equal(cookieAttrs({ hostname: 'blog.styrigx.com', protocol: 'https:' }), prod);
  assert.equal(cookieAttrs({ hostname: 'localhost', protocol: 'http:' }), '; Path=/; Max-Age=34560000; SameSite=Lax');
  assert.equal(cookieAttrs({ hostname: '127.0.0.1', protocol: 'http:' }), '; Path=/; Max-Age=34560000; SameSite=Lax');
  assert.equal(cookieAttrs({ hostname: 'evilstyrigx.com', protocol: 'https:' }), '; Path=/; Max-Age=34560000; SameSite=Lax; Secure');
  assert.equal(cookieAttrs(null), '; Path=/; Max-Age=34560000; SameSite=Lax');
});
