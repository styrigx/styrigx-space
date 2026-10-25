/**
 * baseof.html 头部的偏好预读脚本（渲染前的 IIFE）在 localStorage 抛错时不能整段跳过：
 * 以前读 sgx-palette / sgx-accent 没包 try，站点数据被禁用时直接跳到最外层 catch，
 * 减弱动效、布局偏好、语言跳转、首次进入都不执行。
 * 这里把模板里的那段脚本抠出来（调色板 id 列表换成常量）在 vm 里跑。
 *
 * 运行：node --test tests/web/ui/boot-storage.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const baseof = readFileSync(path.join(REPO, 'web/layouts/_default/baseof.html'), 'utf8');
const start = baseof.indexOf('/* 用户偏好预读：在渲染前应用，避免闪烁 */');
assert.ok(start > 0, '找到预读脚本');
const end = baseof.indexOf('})();', start) + '})();'.length;
const PAL_TPL = /\{\{ \$palIds := slice \}\}[\s\S]*?\{\{ \$palIds \| jsonify \| safeJS \}\}/;
assert.match(baseof.slice(start, end), PAL_TPL);
const SRC = baseof.slice(start, end).replace(PAL_TPL, '["dustyblue","forest","lake"]');
assert.doesNotMatch(SRC, /\{\{/, '没有剩下的模板语法');

function run(storage) {
  const attrs = {};
  const classes = new Set();
  const replaced = [];
  const d = {
    setAttribute: (k, v) => { attrs[k] = String(v); },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    style: { setProperty() {} },
  };
  const ctx = {
    document: { documentElement: d, createElement: () => ({}), head: { appendChild() {} } },
    localStorage: storage,
    sessionStorage: storage,
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    navigator: { language: 'zh-CN' },
    location: { pathname: '/', search: '', hash: '', replace: (u) => replaced.push(u) },
    addEventListener() {},
  };
  vm.runInNewContext(SRC, ctx);
  return { attrs, classes, replaced };
}

const throwing = new Proxy({}, { get: () => () => { throw new DOMException('denied', 'SecurityError'); } });

test('localStorage / sessionStorage 全部抛错：减弱动效、布局、深色仍然写上，不设调色板', () => {
  const { attrs, classes } = run(throwing);
  assert.equal(attrs['data-reduced-motion'], '1', '减弱动效跟系统');
  assert.ok(classes.has('reduced-motion'));
  assert.equal(attrs['data-layout'], 'auto');
  assert.equal(attrs['data-theme-mode'], 'system');
  assert.equal(attrs['data-dark'], '1');
  assert.equal(attrs['data-palette'], undefined);
});

test('存储正常：调色板、布局照旧生效；默认调色板的值被清掉', () => {
  const mk = (seed) => {
    const m = new Map(Object.entries(seed));
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
  };
  let s = mk({ 'sgx-palette': 'forest', 'sgx-layout': 'pc' });
  let r = run(s);
  assert.equal(r.attrs['data-palette'], 'forest');
  assert.equal(r.attrs['data-layout'], 'dex');
  s = mk({ 'sgx-palette': 'xlake' });
  r = run(s);
  assert.equal(r.attrs['data-palette'], 'lake', '旧撞色 x<id> 迁到 <id>');
  assert.equal(s.m.get('sgx-palette'), 'lake');
  s = mk({ 'sgx-palette': 'dustyblue' });
  r = run(s);
  assert.equal(r.attrs['data-palette'], undefined);
  assert.equal(s.m.has('sgx-palette'), false);
});
