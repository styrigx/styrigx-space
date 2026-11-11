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
  assert.ok(n >= 2, '模板里应有各页入口（2026-11-08 云同步子页删除后 11 个；同日账号整页 6 个删除后 5 个；进站 v3 L1 安全页 3 个删除后 2 个）');
  for (const f of ['security.html', 'security-lock.html', 'security-tempkeys.html']) assert.ok(!existsSync(join(root, 'space/web/layouts/_default', f)), `进站 v3 L1：${f} 已删（盾牌下拉）`);
  for (const f of ['entry-security.js', 'entry-security-lock.js', 'entry-security-tempkeys.js']) assert.ok(!existsSync(join(root, ENTRY_DIR, f)), `进站 v3 L1：${f} 已删`);
  assert.ok(rd('space/web/layouts/index.html').includes('"sgx-entry" "entry-space.js"'));
  assert.ok(!existsSync(join(root, 'space/web/layouts/_default/sub.html')), '对齐 PR-C：风格页 /theme/ 退役，sub.html 删除');
  assert.ok(!existsSync(join(root, ENTRY_DIR, 'entry-space-sub.js')), '对齐 PR-C：entry-space-sub.js 随风格页删除');
  assert.ok(rd('space/web/layouts/_default/status.html').includes('"sgx-entry" "entry-space-status.js"'), '2026-11-12：状态页 /status/ 一个入口');
  assert.ok(!existsSync(join(root, 'space/web/layouts/_default/wild.html')), '2026-11-12：旷野页删除，状态单独成页');
  assert.ok(!existsSync(join(root, ENTRY_DIR, 'entry-space-wild.js')), '2026-11-12：entry-space-wild.js 改名 entry-space-status.js');
  assert.ok(!existsSync(join(root, 'space/web/layouts/_default/chat.html')), 'P4-2b：/chat/ 页已删');
  for (const f of ['settings.html', 'settings-sub.html', 'settings-status.html']) assert.ok(!existsSync(join(root, 'space/web/layouts/_default', f)), `PR-4b：${f} 已改名 / 删除`);
});

test('主站入口：entry-space.js 静态挂首页小组件和页面模块，entry-space-status.js 挂状态页，没有页内切换；聊天不再是页面', () => {
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
  const sub = rd(`${ENTRY_DIR}/entry-space-status.js`);
  assert.ok(sub.includes("import { mountSpace } from '../apps/space.js'") && !sub.includes('mountHome'), '状态页只挂页面模块');
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
  assert.ok(head.includes("localStorage.getItem('sgx-palette')"), '调色板（深浅）预读仍在 head 内联');
  assert.ok(!/<script[^>]*type="module"/.test(head), 'head 里不放 module 脚本');
  const part = rd('space/web/layouts/partials/sgx-js-batch.html');
  assert.ok(part.includes('js.Batch "js/sgx"') && part.includes('| fingerprint'), 'js.Batch 构建，入口 fingerprint（/js/* 是 immutable 缓存）');
});

test('core.js：入口加载成功清掉自动重试标记', () => {
  const core = rd('space/web/assets/js/shell/core.js');
  assert.ok(core.includes("sessionStorage.getItem('sgx-js-retry') === location.pathname"), 'core 初始化成功清标记');
});

test('守卫在 core 里（frontend-js #6）：只带守卫，钥匙层 / 鉴权模块不进每页的 core；v5 S5 起没有锁屏界面（进站在终端里）', () => {
  const core = rd('space/web/assets/js/shell/core.js');
  assert.ok(core.includes("import { initLock } from './space/guard.js';"), 'core 从 space/guard.js 取 initLock');
  assert.ok(!/from '\.\/(lock|upgrade|lock-guard)\.js'/.test(core) && !/from '\.\/space\/(entry|layer)\.js'/.test(core), 'core 不静态 import 钥匙层');
  assert.ok(!/initUpgrade/.test(core), '升级层入口已删');
  for (const f of ['shell/lock.js', 'shell/lock-guard.js', 'lib/lock-state.js', 'shell/space/entry.js', 'shell/space/shield.js', 'shell/space/tempkeys.js']) assert.ok(!existsSync(join(root, 'space/web/assets/js', f)), f + ' 已删');
  const guard = rd('space/web/assets/js/shell/space/guard.js');
  const staticImports = [...guard.matchAll(/^import [^\n]* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(staticImports, ['../../lib/diag-jumptrace.js'], '守卫只静态依赖 diag-jumptrace（v6 P4 起 state / paths 随钥匙层删了）');
  assert.ok(!/from '\.\/(api|entry|session|reset|shield|layer)\.js'/.test(guard), '守卫不带 api / 通行密钥代码');
  assert.ok(!/\bimport\(/.test(guard.replace(/\/\*[\s\S]*?\*\//g, '')), '守卫不再按需加载锁屏界面');
  assert.ok(!guard.includes('sgx-entry-cover') && !guard.includes('showEntryCover'), '没有全页遮罩');
  assert.ok(!existsSync(join(root, 'space/web/assets/js/shell/upgrade.js')) && !guard.includes('initUpgrade'), 'P2-3：升级层整个删除');
});

test('进站 v3 L1：自带门的页面（安全页 / app-gate）删了，守卫不再需要 releaseLockScreen', () => {
  for (const f of ['apps/security-lock.js', 'apps/app-gate.js', 'apps/security.js']) assert.ok(!existsSync(join(root, 'space/web/assets/js', f)), f + ' 已删');
  const walk = (d) => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + '/' + e.name) : e.name.endsWith('.js') ? [d + '/' + e.name] : []));
  for (const f of walk('space/web/assets/js')) assert.ok(!rd(f).includes('releaseLockScreen'), f + ' 不再引用 releaseLockScreen');
});
