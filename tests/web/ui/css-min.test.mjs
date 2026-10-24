/**
 * scripts/lib/css-min.cjs（build-css --minify 压缩自定义分层 CSS，2026-10-24 PR3）：
 * input.css 压缩前后，每条规则（含所在 @layer / @media / 嵌套链）的选择器、每条声明的属性 / 值 / !important、
 * 每个 @ 规则的参数，按 token 看完全一致、顺序一致；注释全部去掉；压缩结果再压一次不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const postcss = require('postcss');
const { minifyCss, squash, squashSelector } = require('../../../scripts/lib/css-min.cjs');
const SRC = readFileSync(new URL('../../../web/assets/css/input.css', import.meta.url), 'utf8');

/** 规整成「看 token」的形式：空白收成一个、逗号两边不留空格（引号外） */
const tok = (s) => squashSelector(String(s));

function flatten(css) {
  const out = [];
  const path = (n) => {
    const a = [];
    for (let p = n.parent; p && p.type !== 'root'; p = p.parent) a.unshift(p.type === 'atrule' ? '@' + p.name + ' ' + tok(p.params) : tok(p.selector));
    return a.join(' / ');
  };
  postcss.parse(css).walk((n) => {
    if (n.type === 'rule') out.push(['rule', path(n), tok(n.selector)]);
    else if (n.type === 'atrule') out.push(['at', path(n), n.name, tok(n.params)]);
    else if (n.type === 'decl') out.push(['decl', path(n), n.prop, squash(n.value), !!n.important]);
  });
  return out;
}

test('input.css 压缩前后：规则、选择器、声明、@ 规则逐条一致', () => {
  const min = minifyCss(SRC);
  const a = flatten(SRC);
  const b = flatten(min);
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i++) assert.deepEqual(b[i], a[i], 'node #' + i);
  assert.ok(a.length > 5000);
});

test('注释全部去掉，体积明显变小；再压一次结果不变', () => {
  const min = minifyCss(SRC);
  let comments = 0;
  postcss.parse(min).walkComments(() => comments++);
  assert.equal(comments, 0);
  assert.ok(min.length < SRC.length * 0.8, min.length + ' vs ' + SRC.length);
  assert.equal(minifyCss(min), min);
});

test('squash：引号里的空白和逗号不动；引号外收成一个空格', () => {
  assert.equal(squash('  a \n\t b  '), 'a b');
  assert.equal(squash('"a  , b"   x'), '"a  , b" x');
  assert.equal(squash("'it\\'s  ok'  y"), "'it\\'s  ok' y");
  assert.equal(squashSelector('.a ,\n  .b[data-x="1, 2"] >  .c'), '.a,.b[data-x="1, 2"] > .c');
  assert.equal(squashSelector(':is(.a, .b)'), ':is(.a,.b)');
});

test('压缩器保留 !important、空的自定义属性和 @layer 声明语句', () => {
  const out = minifyCss('@layer a, b;\n/* x */\n.a {\n  color: red !important;\n  --e: ;\n}\n@media (min-width: 1px) and (hover: hover) {\n  .b { margin: 0  auto; }\n}\n');
  assert.equal(out, '@layer a, b;.a{color:red!important;--e: }@media (min-width: 1px) and (hover: hover){.b{margin:0 auto}}\n');
});
