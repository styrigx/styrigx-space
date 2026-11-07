/**
 * 2026-10-24 JS 共享拆分（js.Batch + esbuild splitting）结构测试（node --test）。
 *
 * 覆盖：
 * - entries/entry-*.js 全部登记进 baseof 的批量构建列表；各页模板 sgx-entry 指向的入口都在列表里
 * - P4-3 PR-4b：主站只剩一个顶级页「旷野」（/）：入口 entry-space.js（静态挂首页小组件 + 旷野页模块）、子页 entry-space-sub.js；
 *   原顶栏两栏入口 entry-tab-* / lazy-*、页内切换 shell/inpage-tabs.js、左右滑切栏 shell/tab-swipe.js 都删了
 * - /chat/ 页 P4-2b 已删（entry-chat.js、apps/chat.js 都不在）
 * - baseof：modulepreload、data-sgx-js 签名、入口加载失败只自动刷新一次（sgx-js-retry）；core 成功后清标记
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(join(root, p), 'utf8');
const base = rd('space/web/layouts/_default/baseof.html');
const ENTRY_DIR = 'space/web/assets/js/entries';

function batchList() {
  const m = base.match(/partialCached "sgx-js-batch\.html" \(dict "defines" \$featDefines "entries" \(slice ([^)]*)\)\)/);
  assert.ok(m, 'baseof 用 partialCached 调 sgx-js-batch.html 并给出入口列表');
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

test('所有 entry-*.js 都在批量构建列表里；列表里的入口文件都存在', () => {
  const list = batchList();
  const files = readdirSync(join(root, ENTRY_DIR)).filter((f) => /^entry-.*\.js$/.test(f)).map((f) => f.replace(/\.js$/, ''));
  for (const f of files) assert.ok(list.includes(f), `${f} 没登记进 baseof 的 js.Batch 列表`);
  for (const e of list) assert.ok(existsSync(join(root, ENTRY_DIR, e + '.js')), `列表里的 ${e}.js 不存在`);
  assert.ok(!existsSync(join(root, ENTRY_DIR, 'entry-tabs.js')), '三栏共用的 entry-tabs.js 已拆成 entry-tab-*.js');
});

test('各页模板 sgx-entry 指向的入口都在列表里', () => {
  const list = batchList();
  const walk = (d) => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + '/' + e.name) : e.name.endsWith('.html') ? [d + '/' + e.name] : []));
  let n = 0;
  for (const f of walk('space/web/layouts')) {
    for (const m of rd(f).matchAll(/\.Scratch\.Set "sgx-entry" "([^"]+)\.js"/g)) {
      n++;
      assert.ok(list.includes(m[1]), `${f}: ${m[1]} 不在批量构建列表里`);
    }
  }
  assert.ok(n >= 12, '模板里应有各页入口');
  assert.ok(rd('space/web/layouts/index.html').includes('"sgx-entry" "entry-space.js"'));
  assert.ok(rd('space/web/layouts/_default/sub.html').includes('"sgx-entry" "entry-space-sub.js"'));
  assert.ok(rd('space/web/layouts/_default/status.html').includes('"sgx-entry" "entry-space-status.js"'));
  assert.ok(!existsSync(join(root, 'space/web/layouts/_default/chat.html')), 'P4-2b：/chat/ 页已删');
  for (const f of ['settings.html', 'settings-sub.html', 'settings-status.html']) assert.ok(!existsSync(join(root, 'space/web/layouts/_default', f)), `PR-4b：${f} 已改名 / 删除`);
});

test('旷野入口：entry-space.js 静态挂首页小组件和旷野页模块，没有页内切换；聊天不再是页面', () => {
  for (const f of ['entry-tab-home.js', 'entry-tab-settings.js', 'entry-tab-chat.js', 'lazy-home.js', 'lazy-settings.js', 'lazy-chat.js', 'entry-chat.js', 'entry-settings.js', 'entry-settings-status.js']) {
    assert.ok(!existsSync(join(root, ENTRY_DIR, f)), `${f} 已删`);
  }
  for (const f of ['inpage-tabs.js', 'tab-swipe.js']) assert.ok(!existsSync(join(root, 'space/web/assets/js/shell', f)), `shell/${f} 已删（主站只一页）`);
  assert.ok(!existsSync(join(root, 'space/web/assets/js/apps/chat.js')), 'P4-2b：apps/chat.js 已删');
  assert.ok(!existsSync(join(root, 'space/web/assets/js/apps/settings.js')), 'apps/settings.js 已改名 apps/space.js');
  const src = rd(`${ENTRY_DIR}/entry-space.js`);
  assert.ok(src.includes("import { mountHome } from '../apps/index.js'"), '静态 import 首页小组件');
  assert.ok(src.includes("import { mountSpace } from '../apps/space.js'"), '静态 import 旷野页模块');
  assert.ok(!/registerTab|inpage-tabs|import\(/.test(src), '没有页内切换 / 按需取');
  assert.ok(src.indexOf('mountSpace();') < src.indexOf('initCore();'), '先挂页面模块再 initCore');
  const sub = rd(`${ENTRY_DIR}/entry-space-sub.js`);
  assert.ok(sub.includes("import { mountSpace } from '../apps/space.js'") && !sub.includes('mountHome'), '子页只挂旷野页模块');
  const core = rd('space/web/assets/js/shell/core.js');
  assert.ok(!/tab-swipe|inpage-tabs|sgx-tab-(leave|enter)/.test(core), 'core 不再接页内切换 / 左右滑');
});

test('baseof：modulepreload + 构建签名 + 入口加载失败只自动刷新一次', () => {
  assert.ok(base.includes('<link rel="modulepreload" href="{{ . }}">'), '入口静态依赖的 chunk 输出 modulepreload');
  assert.ok(/<script type="module" src="\{\{ \$js\.src \}\}" data-sgx-js="\{\{ index \$sgxJs "_sig" \}\}"><\/script>/.test(base), '入口带构建签名');
  const m = base.match(/<script>addEventListener\('error',function\(e\)\{[^<]*<\/script>/);
  assert.ok(m, '入口前有内联 error 兜底');
  assert.ok(m[0].includes("'sgx-js-retry'") && m[0].includes('location.reload()') && m[0].includes("hasAttribute('data-sgx-js')"), '只管入口脚本，同一地址只刷新一次');
  assert.ok(m[0].indexOf('sessionStorage.getItem(k)===p') < m[0].indexOf('location.reload()'), '先查标记再刷新');
  /* 首帧脚本（主题 / 语言 / 布局）仍是 <head> 里的同步内联脚本 */
  const head = base.slice(0, base.indexOf('</head>'));
  assert.ok(head.includes("localStorage.getItem('sgx-theme-mode')"), '主题预读仍在 head 内联');
  assert.ok(!/<script[^>]*type="module"/.test(head), 'head 里不放 module 脚本');
  const part = rd('space/web/layouts/partials/sgx-js-batch.html');
  assert.ok(part.includes('js.Batch "js/sgx"') && part.includes('| fingerprint'), 'js.Batch 构建，入口 fingerprint（/js/* 是 immutable 缓存）');
});

test('core.js：入口加载成功清掉自动重试标记', () => {
  const core = rd('space/web/assets/js/shell/core.js');
  assert.ok(core.includes("sessionStorage.getItem('sgx-js-retry') === location.pathname"), 'core 初始化成功清标记');
});

test('锁屏按需加载（frontend-js #6）：core 只带守卫，界面和鉴权模块不进每页的 core；P2-3 起没有升级层', () => {
  const core = rd('space/web/assets/js/shell/core.js');
  assert.ok(core.includes("import { initLock } from './lock-guard.js';"), 'core 从 lock-guard.js 取 initLock');
  assert.ok(!/from '\.\/(lock|upgrade)\.js'/.test(core), 'core 不静态 import 锁屏界面');
  assert.ok(!/initUpgrade/.test(core), '升级层入口已删');
  const guard = rd('space/web/assets/js/shell/lock-guard.js');
  const staticImports = [...guard.matchAll(/^import [^\n]* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(staticImports, ['../lib/diag-jumptrace.js', '../lib/lock-state.js', '../lib/i18n.js'], '守卫只静态依赖 lib/diag-jumptrace.js、lib/lock-state.js、lib/i18n.js（字符串表读取，无依赖，语言包化 2026-11-07）');
  assert.ok(guard.includes("import('./lock.js')") && !guard.includes("import('./upgrade.js')"), '界面按需 import()；没有升级层');
  /* fail closed：先同步盖遮罩再 import，加载失败遮罩不撤 */
  const open = guard.slice(guard.indexOf('function openLockScreen()'));
  assert.ok(open.indexOf('showLockCover()') < open.indexOf("import('./lock.js')"), '先盖遮罩再加载');
  assert.ok(/\.catch\(function \(\) \{\s*if \(!lockReleased\) lockLoadFailed\(cover\);\s*\}\)/.test(open), '加载失败只换成重新加载按钮');
  const fail = guard.slice(guard.indexOf('function lockLoadFailed('), guard.indexOf('function openLockScreen()'));
  assert.ok(!/remove\(|hidden = true|display ?= ?'none'/.test(fail), '加载失败不撤遮罩');
  /* initLock 不再直接画锁屏 */
  const init = guard.slice(guard.indexOf('export function initLock()'), guard.indexOf('function showLockCover()'));
  assert.ok(!init.includes('showLockScreen'), 'initLock 不直接调锁屏界面');
  const lock = rd('space/web/assets/js/shell/lock.js');
  assert.ok(lock.includes('export function showLockScreen()') && lock.includes("getElementById('sgx-lock-cover')"), '锁屏画上后撤掉遮罩');
  assert.ok(!existsSync(join(root, 'space/web/assets/js/shell/upgrade.js')) && !guard.includes('initUpgrade'), 'P2-3：升级层整个删除');
});

test('锁屏按需加载 × 页面自带的门（2026-10-26 回归）：门内页撤锁屏走 releaseLockScreen，晚到的锁屏界面不再画上', () => {
  const guard = rd('space/web/assets/js/shell/lock-guard.js');
  const rel = guard.slice(guard.indexOf('export function releaseLockScreen()'));
  assert.ok(rel.includes('lockReleased = true'), '释放是粘性的');
  assert.ok(rel.includes("getElementById('sgx-lock')") && rel.includes("getElementById('sgx-lock-cover')"), '已画的锁屏和守卫遮罩都撤');
  const open = guard.slice(guard.indexOf('function openLockScreen()'), guard.indexOf('export function releaseLockScreen()'));
  assert.ok(/^\s*if \(lockReleased\) return;/m.test(open), '释放后不再盖遮罩');
  assert.ok(/\.then\(function \(m\) \{[\s\S]*?if \(lockReleased\) return;[\s\S]*?m\.showLockScreen\(\);/.test(open), 'import 回来时已释放就不画锁屏');
  /* 门内页不再自己删 #sgx-lock（只删 DOM 会被随后按需画上的锁屏盖住） */
  for (const f of ['space/web/assets/js/apps/security-lock.js', 'space/web/assets/js/apps/app-gate.js']) {
    const src = rd(f);
    assert.ok(src.includes("import { releaseLockScreen } from '../shell/lock-guard.js';"), f + ' 经 releaseLockScreen');
    assert.ok(!src.includes("getElementById('sgx-lock')"), f + ' 不再手删 #sgx-lock');
  }
});
