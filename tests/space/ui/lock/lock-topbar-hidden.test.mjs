/**
 * 锁屏界面开着时不画页面顶栏（2026-11-09 Gray 报：三星浏览器刷新 / 切语言时锁屏上闪一下顶栏）：
 * - v5 S3 整站放开：访客页面（<html data-sgx-lock-session="locked">）顶栏照常，规则只看锁屏界面本身（<body class="sgx-entry">）
 * - input.css 把 #site-nav 藏掉（visibility: hidden），并去掉顶栏的 view-transition-name；
 *   规则在所有 @layer 之外（要压过同样不分层的 .sgx-topbar { view-transition-name }），也不在共享外壳段里（锁屏只在主站）
 * - v5 S5 起没有锁屏界面；v6 P4 起开机动画（shell/space/unlock.js）也删了
 * 运行：node --test tests/space/ui/lock/lock-topbar-hidden.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const css = readFileSync(path.join(REPO, 'space/web/assets/common/css/input.css'), 'utf8');

const HIDE = 'body.sgx-entry #site-nav { visibility: hidden; }';
const NO_VT = 'body.sgx-entry #site-nav .sgx-topbar { view-transition-name: none; }';

/** 去掉注释后，位置 i 之前的花括号深度（0 = 不在任何 @layer / @media 里） */
function depthAt(i) {
  const before = css.slice(0, i).replace(/\/\*[\s\S]*?\*\//g, '');
  let d = 0;
  for (const ch of before) { if (ch === '{') d++; else if (ch === '}') d--; }
  return d;
}

test('input.css：锁屏界面开着时藏页面顶栏 + 去掉顶栏 view-transition-name', () => {
  for (const rule of [HIDE, NO_VT]) {
    const i = css.indexOf(rule);
    assert.ok(i > 0, '缺规则：' + rule);
    assert.equal(css.indexOf(rule, i + 1), -1, '规则只写一次：' + rule);
    assert.equal(depthAt(i), 0, '规则要在所有 @layer / @media 之外：' + rule);
  }
});

test('input.css：规则不在共享外壳段里（锁屏只在主站，不进 shell.css）', () => {
  const re = /\/\* @shell:begin ([\w-]+)[\s\S]*?\/\* @shell:end \1 \*\//g;
  let m;
  while ((m = re.exec(css))) {
    assert.ok(!m[0].includes('body.sgx-entry #site-nav'), '共享外壳段 ' + m[1] + ' 不应出现锁屏藏顶栏的规则');
  }
});

test('input.css：访客页面（locked 标记）不再藏顶栏，也不藏锁屏层自己的 .sgx-entry-tb', () => {
  assert.doesNotMatch(css, /data-sgx-lock-session="[a-z-]+"[^{]*#site-nav/);
  assert.doesNotMatch(css, /sgx-entry-off/);
  assert.doesNotMatch(css, /body\.sgx-entry[^{]*\.sgx-entry-tb/);
});

/* v6 P4：开机动画（shell/space/unlock.js，旧进站成功后的那一段）随旧进站会话删了，没有地方再加 body.sgx-entry；上面的 CSS 规则留着不碍事 */
