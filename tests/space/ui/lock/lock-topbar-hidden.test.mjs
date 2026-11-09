/**
 * 锁屏态不画页面顶栏（2026-11-09 Gray 报：三星浏览器刷新 / 切语言时锁屏上闪一下顶栏）：
 * - 网关在 HTML 字符串里直接写 <html data-sgx-lock-session="locked">（首帧前就在，不是 JS 后补）
 * - input.css 用这个属性把 #site-nav 藏掉（visibility: hidden），并去掉顶栏的 view-transition-name；
 *   规则在所有 @layer 之外（要压过同样不分层的 .sgx-topbar { view-transition-name }），也不在共享外壳段里（子站不带会话标记）
 * - 只管 locked：valid / lock-reset 页面顶栏照常
 * - 原地开锁时 entry.js 给 <html> 加 .sgx-entry-off 把顶栏放回
 * 运行：node --test tests/space/ui/lock/lock-topbar-hidden.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const css = readFileSync(path.join(REPO, 'space/web/assets/css/input.css'), 'utf8');
const entryJs = readFileSync(path.join(REPO, 'space/web/assets/js/shell/space/entry.js'), 'utf8');

const HIDE = 'html[data-sgx-lock-session="locked"]:not(.sgx-entry-off) #site-nav { visibility: hidden; }';
const NO_VT = 'html[data-sgx-lock-session="locked"]:not(.sgx-entry-off) #site-nav .sgx-topbar { view-transition-name: none; }';

/** 去掉注释后，位置 i 之前的花括号深度（0 = 不在任何 @layer / @media 里） */
function depthAt(i) {
  const before = css.slice(0, i).replace(/\/\*[\s\S]*?\*\//g, '');
  let d = 0;
  for (const ch of before) { if (ch === '{') d++; else if (ch === '}') d--; }
  return d;
}

test('input.css：锁屏态藏页面顶栏 + 去掉顶栏 view-transition-name', () => {
  for (const rule of [HIDE, NO_VT]) {
    const i = css.indexOf(rule);
    assert.ok(i > 0, '缺规则：' + rule);
    assert.equal(css.indexOf(rule, i + 1), -1, '规则只写一次：' + rule);
    assert.equal(depthAt(i), 0, '规则要在所有 @layer / @media 之外：' + rule);
  }
});

test('input.css：规则不在共享外壳段里（子站页面不带会话标记，不进 shell.css）', () => {
  const re = /\/\* @shell:begin ([\w-]+)[\s\S]*?\/\* @shell:end \1 \*\//g;
  let m;
  while ((m = re.exec(css))) {
    assert.ok(!m[0].includes('data-sgx-lock-session'), '共享外壳段 ' + m[1] + ' 不应出现会话标记选择器');
  }
});

test('input.css：只管 locked（valid / lock-reset 顶栏照常），也不藏锁屏层自己的 .sgx-entry-tb', () => {
  assert.doesNotMatch(css, /data-sgx-lock-session="(?:valid|lock-reset)"[^{]*#site-nav/);
  assert.doesNotMatch(css, /data-sgx-lock-session="locked"[^{]*\.sgx-entry-tb/);
});

test('网关：locked 标记写在下发的 HTML 里（首帧前就在，不靠 JS）', async () => {
  const { injectSessionState } = await import(REPO + '/workers/space-core/src/gate.js');
  const page = '<!DOCTYPE html><html lang="zh"><head></head><body><header id="site-nav"><div class="sgx-topbar"></div></header></body></html>';
  const res = new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const html = await (await injectSessionState(res, 'locked')).text();
  assert.match(html, /^<!DOCTYPE html><html data-sgx-lock-session="locked" lang="zh">/);
});

test('entry.js：原地开锁时给 <html> 加 .sgx-entry-off 放回顶栏', () => {
  const i = entryJs.indexOf('function doUnlockAnimation()');
  assert.ok(i > 0, '缺 doUnlockAnimation');
  const body = entryJs.slice(i, entryJs.indexOf('\n  }\n', i));
  assert.match(body, /document\.documentElement\.classList\.add\('sgx-entry-off'\)/);
});
