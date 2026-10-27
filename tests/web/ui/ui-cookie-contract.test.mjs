/**
 * sgx-ui cookie 契约（2026-10-22）：主站写端 lib/ui-cookie.js ↔ 子站读端 lib/ui-cookie-read.js（共享外壳原样分发）。
 * 夹具 tests/fixtures/ui-cookie-contract.json 由 scripts/gen-ui-cookie-contract.mjs 跑真写端生成；
 * 这里断言：夹具没过期、每个 cookie 经读端 read / resolve / apply 得到夹具里的期望、写端字段表 = 读端字段表、
 * 读端是 ES5 经典脚本且从不写 cookie。（过去主站改了 sgx-verified 格式、子站死循环——契约不许悄悄漂移。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { renderContract, FIXTURE } from '../../../scripts/gen-ui-cookie-contract.mjs';
import { renderAll, READER_SRC } from '../../../scripts/gen-shell.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const READER = readFileSync(READER_SRC, 'utf8');
const WRITER = readFileSync(path.join(REPO, 'web/assets/js/lib/ui-cookie.js'), 'utf8');
const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const palettes = JSON.parse(readFileSync(path.join(REPO, 'web/shared/shell/palettes.json'), 'utf8'));

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
const plain = (o) => JSON.parse(JSON.stringify(o));

test('夹具没过期：写端真实产出 = tests/fixtures/ui-cookie-contract.json（改了写端要重跑 gen-ui-cookie-contract.mjs）', async () => {
  assert.equal(await renderContract(), readFileSync(FIXTURE, 'utf8'));
});

test('夹具覆盖：默认 dustyblue 亮 / 暗、跟随系统、lake、旧撞色 xforest 迁移、自定义色、旧 v1 / v2、旧种子、未知版本、乱码', () => {
  const names = fx.cases.map((c) => c.name).join('|');
  for (const k of ['默认 dustyblue 亮色', '默认 dustyblue 深色', '跟随系统', '湖蓝 lake', '旧撞色 xforest', '自定义主题色', '旧 v1', '旧 v2', '旧 cookie：撞色 xforest \\+ 旧种子', '未知版本', '乱码']) assert.match(names, new RegExp(k), k);
  assert.ok(fx.cases.filter((c) => c.source === 'writer').length >= 8);
});

test('语言 lang：写端只写明确选的 zh / en，跟随系统写 \'\'；读端只认小写 zh / en，版本不认识整份不认', () => {
  const s = sandbox();
  const byLocal = (v) => fx.cases.find((c) => c.source === 'writer' && c.local['sgx-lang'] === v);
  assert.equal(s.U.decode(byLocal('en').cookie).lang, 'en');
  assert.equal(s.U.decode(byLocal('zh').cookie).lang, 'zh');
  assert.equal(s.U.decode(byLocal('system').cookie).lang, '');
  for (const c of fx.cases.filter((x) => x.source === 'writer' && !('sgx-lang' in x.local))) assert.equal(s.U.decode(c.cookie).lang, '', c.name);
  assert.equal(s.U.read('sgx-ui=' + s.U.encode({ v: 2, lang: 'en-US' })).lang, '');
  assert.equal(s.U.read('sgx-ui=' + s.U.encode({ v: 2, lang: 'EN' })).lang, '');
  assert.equal(s.U.read('sgx-ui=' + s.U.encode({ v: 3, lang: 'en' })), null);
});

for (const c of fx.cases) {
  test(`契约：${c.name}`, () => {
    for (const sys of ['light', 'dark']) {
      const s = sandbox({ cookie: 'sgx-lock-session=x; sgx-ui=' + c.cookie + '; other=1', dark: sys === 'dark' });
      assert.deepEqual(plain(s.U.read()), c.read, 'read');
      assert.deepEqual(plain(s.U.read('sgx-ui=' + c.cookie)), c.read, 'read(串)');
      assert.deepEqual(plain(s.U.resolve(s.U.read(), sys === 'dark')), c[sys].resolve, sys + ' resolve');
      const a = s.U.apply(s.html, { onMiss() {} });
      assert.deepEqual(plain(a), c[sys].resolve, sys + ' apply 返回');
      assert.deepEqual(rootState(s.html), c[sys].root, sys + ' <html>');
      assert.equal(s.cookieWrites, 0, '读端不许写 cookie');
    }
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

test('写端和读端共用一份常量 / 编解码（import ui-cookie-read.js，不再自己 atob / 写死版本号）', () => {
  assert.match(WRITER, /import '\.\/ui-cookie-read\.js';/);
  assert.match(WRITER, /v: U\.V,/);
  assert.match(WRITER, /U\.encode\(payload\)/);
  assert.match(WRITER, /U\.decode\(v\)/);
  assert.doesNotMatch(WRITER, /atob|btoa|v: 2/);
  const s = sandbox();
  assert.equal(s.U.V, 2);
  assert.ok(s.U.VERSIONS.includes(s.U.V));
  assert.equal(s.U.NAME, 'sgx-ui');
});

test('读端预设表 / 引擎版本 = 共享外壳 palettes.json（gen-shell 生成段）', () => {
  const s = sandbox();
  assert.deepEqual(plain(s.U.PRESETS), Object.fromEntries(palettes.presets.map((p) => [p.id, p.seed])));
  assert.equal(s.U.SCHEME_VER, palettes.schemeVersion);
  assert.equal(s.U.DEFAULT_PAL, palettes.default);
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

test('共享外壳原样带上读端 / 夹具 / 图标', () => {
  const files = renderAll();
  assert.equal(files['ui-cookie-read.js'], READER);
  assert.equal(files['ui-cookie-contract.json'], readFileSync(FIXTURE, 'utf8'));
  assert.equal(files['favicon.js'], readFileSync(path.join(REPO, 'web/assets/js/shell/favicon.js'), 'utf8'));
  assert.equal(files['favicon.svg'], readFileSync(path.join(REPO, 'web/static/favicon.svg'), 'utf8'));
  const m = JSON.parse(files['manifest.json']);
  for (const k of ['ui-cookie-read.js', 'ui-cookie-contract.json', 'favicon.js', 'favicon.svg']) assert.ok(m.files[k], k);
  assert.match(files['README.md'], /SgxUI\.apply\(document\.documentElement/);
});

const cookieOf = (name) => 'sgx-ui=' + fx.cases.find((c) => c.name === name).cookie;

test('自定义色：有缓存首帧插 <style id="sgx-accent-roles">；没缓存回调 onMiss；给了引擎就同步算并写缓存', () => {
  const name = '自定义主题色（默认色板上）';
  const s1 = sandbox({ cookie: cookieOf(name) });
  let missed = '';
  s1.U.apply(s1.html, { onMiss: (seed) => { missed = seed; } });
  assert.equal(missed, '#1f8a70');
  assert.equal(s1.ctx.document.getElementById('sgx-accent-roles'), null, '没缓存：先按预设渲染');
  assert.equal(s1.html.style.getPropertyValue('--sgx-seed'), '#1f8a70');
  assert.equal(s1.U.setRoles('#1f8a70', ':root{--sgx-primary:#1f8a70}'), true);
  assert.equal(s1.ls.get('sgx-shell-accent-css'), palettes.schemeVersion + '|#1f8a70\n:root{--sgx-primary:#1f8a70}');

  const s2 = sandbox({ cookie: cookieOf(name), store: { 'sgx-shell-accent-css': palettes.schemeVersion + '|#1f8a70\nCSS' } });
  s2.U.apply(s2.html, { onMiss: () => assert.fail('有缓存不该回调') });
  assert.equal(s2.ctx.document.getElementById('sgx-accent-roles').textContent, 'CSS');

  const s3 = sandbox({ cookie: cookieOf(name), store: { 'sgx-shell-accent-css': 'oldver|#1f8a70\nOLD' } });
  s3.U.apply(s3.html, { rolesCss: (seed) => 'NEW ' + seed });
  assert.equal(s3.ctx.document.getElementById('sgx-accent-roles').textContent, 'NEW #1f8a70', '引擎版本变了缓存作废');
  assert.equal(s3.ls.get('sgx-shell-accent-css'), palettes.schemeVersion + '|#1f8a70\nNEW #1f8a70');

  /* 主站换回预设：再 apply 一次，--sgx-seed 和 <style> 都撤掉 */
  s2.setCookie(cookieOf('旧撞色 xforest → forest（深色）'));
  s2.U.apply(s2.html);
  assert.equal(s2.ctx.document.getElementById('sgx-accent-roles'), null);
  assert.equal(s2.html.style.getPropertyValue('--sgx-seed'), '');
  assert.equal(s2.html.getAttribute('data-palette'), 'forest');
  /* PR-G 前的旧 cookie（pal = x<id>，accent = 旧种子）：迁到 <id>，按预设渲染，不当自定义色 */
  s2.setCookie(cookieOf('旧 cookie：撞色 xforest + 旧种子 → forest 预设（不当自定义色）'));
  s2.U.apply(s2.html);
  assert.equal(s2.html.getAttribute('data-palette'), 'forest');
  assert.equal(s2.html.style.getPropertyValue('--sgx-seed'), '');
});

test('跟随系统：系统深浅色一变就重落；cookie 指定了 light / dark 时不动；只挂一次监听', () => {
  const s = sandbox({ cookie: cookieOf('跟随系统（空 localStorage）'), dark: false });
  s.U.apply(s.html);
  s.U.apply(s.html);
  assert.equal(s.listeners.length, 1);
  assert.equal(s.html.classList.contains('dark'), false);
  s.flip(true);
  assert.equal(s.html.classList.contains('dark'), true);
  assert.equal(s.html.getAttribute('data-dark'), '1');
  assert.equal(s.html.getAttribute('data-theme-mode'), 'system');
  s.setCookie(cookieOf('默认 dustyblue 亮色'));
  s.flip(true);
  assert.equal(s.html.classList.contains('dark'), false);
  const n = sandbox();
  n.U.apply(n.html, { watch: false });
  assert.equal(n.listeners.length, 0);
});

test('坏 cookie / 没有 DOM 能力也不抛：默认 dustyblue + 跟随系统', () => {
  const s = sandbox({ cookie: 'sgx-ui=%%%' });
  assert.equal(s.U.read(), null);
  assert.equal(s.U.decode(''), null);
  assert.equal(s.U.decode(null), null);
  assert.equal(s.U.read(null), null);
  const a = s.U.apply(s.html);
  assert.deepEqual(plain(a), { mode: 'system', dark: false, pal: 'dustyblue', fs: 'standard', rm: false, seed: '' });
});
