/**
 * 2026-10-24 JS 共享拆分（js.Batch + esbuild splitting）结构测试（node --test）。
 *
 * 覆盖：
 * - entries/entry-*.js 全部登记进 baseof 的批量构建列表；各页模板 sgx-entry 指向的入口都在列表里
 * - 顶栏三栏各一个入口：当前栏静态 mount，另两栏 load: import('./lazy-*.js')，三个入口 keep / top 参数一致
 * - lazy-*.js 存在并导出对应挂载函数
 * - baseof：modulepreload、data-sgx-js 签名、入口加载失败只自动刷新一次（sgx-js-retry）
 * - inpage-tabs.js：用构建签名比对取回来的页面；模块取不到整页导航（同一地址只一次）；core 成功后清标记
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const rd = (p) => readFileSync(join(root, p), 'utf8');
const base = rd('web/layouts/_default/baseof.html');
const ENTRY_DIR = 'web/assets/js/entries';

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
  for (const f of walk('web/layouts')) {
    for (const m of rd(f).matchAll(/\.Scratch\.Set "sgx-entry" "([^"]+)\.js"/g)) {
      n++;
      assert.ok(list.includes(m[1]), `${f}: ${m[1]} 不在批量构建列表里`);
    }
  }
  assert.ok(n >= 12, '模板里应有各页入口');
  assert.ok(rd('web/layouts/index.html').includes('"sgx-entry" "entry-tab-home.js"'));
  assert.ok(rd('web/layouts/_default/chat.html').includes('"sgx-entry" "entry-tab-chat.js"'));
  assert.ok(rd('web/layouts/_default/settings.html').includes('"sgx-entry" "entry-tab-settings.js"'));
});

test('三栏入口：当前栏静态挂、另两栏 import(lazy-*.js)，keep / top 一致', () => {
  const TABS = { home: ['index.js', 'mountHome'], chat: ['chat.js', 'mountChat'], settings: ['settings.js', 'mountSettings'] };
  /** @type {Record<string, string>} */
  const flags = {};
  for (const cur of Object.keys(TABS)) {
    const src = rd(`${ENTRY_DIR}/entry-tab-${cur}.js`);
    assert.ok(src.includes(`import { ${TABS[cur][1]} } from '../apps/${TABS[cur][0]}'`), `${cur}: 静态 import 自己那一栏`);
    for (const id of Object.keys(TABS)) {
      const m = src.match(new RegExp(`registerTab\\('${id}', \\{ (keep: (?:true|false)(?:, top: true)?), (mount|load): ([^\\n]*)\\}\\);`));
      assert.ok(m, `${cur}: 应登记 ${id}`);
      if (flags[id]) assert.equal(m[1], flags[id], `${id} 的 keep / top 三个入口必须一致`);
      flags[id] = m[1];
      if (id === cur) assert.equal(m[2], 'mount', `${cur}: 当前栏用 mount`);
      else {
        assert.equal(m[2], 'load', `${cur}: ${id} 用 load 按需取`);
        assert.ok(m[3].includes(`import('./lazy-${id}.js')`), `${cur}: ${id} import lazy-${id}.js`);
        assert.ok(!src.includes(`from '../apps/${TABS[id][0]}'`), `${cur}: 不能静态带上 ${id} 的模块`);
      }
    }
    assert.ok(src.indexOf('initInpageTabs();') < src.indexOf('initCore();'), `${cur}: 先挂当前栏再 initCore`);
  }
  for (const id of Object.keys(TABS)) {
    const lz = rd(`${ENTRY_DIR}/lazy-${id}.js`);
    assert.ok(lz.includes(`export { ${TABS[id][1]} } from '../apps/${TABS[id][0]}'`), `lazy-${id}.js 导出挂载函数`);
    assert.ok(lz.includes("import '../shell/core.js';"), `lazy-${id}.js 引 core（共享代码合成一个 chunk）`);
  }
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
  const part = rd('web/layouts/partials/sgx-js-batch.html');
  assert.ok(part.includes('js.Batch "js/sgx"') && part.includes('| fingerprint'), 'js.Batch 构建，入口 fingerprint（/js/* 是 immutable 缓存）');
});

test('inpage-tabs.js / core.js：构建签名比对、模块失败整页导航、成功清标记', () => {
  const tabs = rd('web/assets/js/shell/inpage-tabs.js');
  assert.ok(tabs.includes("script[type=\"module\"][data-sgx-js]"), '用 data-sgx-js 判断同一次构建');
  assert.ok(!tabs.includes('/js/entries/'), '不再按入口地址判断（三栏入口不同）');
  assert.ok(tabs.includes("const RETRY_KEY = 'sgx-js-retry'"));
  assert.ok(/if \(p\.modFailed\) return hardNav\(p\.href, push\);/.test(tabs), '预取失败过：点标签直接整页导航');
  assert.ok(/Promise\.all\(\[load\(p\), loadMod\(p\)\]\)/.test(tabs), '切栏等 HTML 和模块都到');
  assert.ok(/sessionStorage\.getItem\(RETRY_KEY\) === path\) return false;/.test(tabs), '同一地址只自动一次');
  const core = rd('web/assets/js/shell/core.js');
  assert.ok(core.includes("sessionStorage.getItem('sgx-js-retry') === location.pathname"), 'core 初始化成功清标记');
});
