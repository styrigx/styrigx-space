/**
 * 终端窗口底部的按键提示行（Gray 2026-11-09 细节 1，space/web/assets/js/shell/keyhint.js）+ 一行输出式的加载提示（细节 3，站内终端 cat daymark/today）。
 * 运行：node --test tests/space/ui/shell/keyhint.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { KH_EN, khKeyFor } from '../../../../space/web/assets/js/shell/keyhint.js';
import { createShell } from '../../../../space/web/assets/js/shell/terminal.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');

test('状态 → 提示键：命令行由宿主给；选择 / 秘密 / 起名 / 能中断的等待各一句；不能中断的等待和进站完成不显示', () => {
  assert.equal(khKeyFor('cmd', 'cmdEntry'), 'cmdEntry');
  assert.equal(khKeyFor('cmd', 'cmdLayer'), 'cmdLayer');
  assert.equal(khKeyFor('pick', 'cmd'), 'pick');
  for (const m of ['pw', 'temp', 'rkey', 'newpw', 'newpw2']) assert.equal(khKeyFor(m, 'cmd'), 'secret', m);
  assert.equal(khKeyFor('pkname', 'cmd'), 'name');
  assert.equal(khKeyFor('busy', 'cmd', true), 'busy');
  assert.equal(khKeyFor('busy', 'cmd', false), '');
  assert.equal(khKeyFor('done', 'cmd'), '');
});

test('文案：外壳字符串表 en / zh 都有 kh 节，键和英文底一一对应；英文表 = 英文底；触屏出口是「‹ 返回」', () => {
  const en = yaml.load(read('space/web/data/sgx-shell-i18n/en.yaml')).kh;
  const zh = yaml.load(read('space/web/data/sgx-shell-i18n/zh.yaml')).kh;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(KH_EN).sort());
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(KH_EN).sort());
  for (const k of Object.keys(KH_EN)) assert.equal(en[k], KH_EN[k], 'en.' + k);
  assert.equal(zh.back, '‹ 返回');
  assert.equal(zh.pick, '[n] 选择 · enter 默认项 · esc 返回 · ^C 退出');
  /* terminal.js / ai-panel.js 不 import，各抄了用到的几句英文底：要和 KH_EN 一致 */
  const term = read('space/web/assets/js/shell/terminal.js');
  for (const k of ['cmdHome', 'cmdDrawer', 'back', 'backAria']) assert.ok(term.includes(k + ": '" + KH_EN[k] + "'"), 'terminal.js ' + k);
  assert.ok(read('space/web/assets/js/shell/ai-panel.js').includes("ai: '" + KH_EN.ai + "'"), 'ai-panel.js ai');
});

test('每个终端窗口都有提示行：锁屏 / 盾牌 / 账号下拉 / 主页终端 / 抽屉 / AI 窗口', () => {
  assert.match(read('space/web/assets/js/shell/space/entry.js'), /<p class="sgx-kh sgx-entry-kh" id="sgx-entry-kh" hidden><\/p>/);
  assert.match(read('space/web/assets/js/shell/space/shield.js'), /<p class="sgx-kh sgx-at-kh" data-sh-kh hidden><\/p>/);
  assert.match(read('space/web/assets/js/shell/account/term.js'), /<p class="sgx-kh sgx-at-kh" data-at-kh hidden><\/p>/);
  assert.match(read('space/web/layouts/index.html'), /<p class="sgx-kh sgx-term-kh" data-term-kh hidden><\/p>/);
  const tb = read('space/web/layouts/partials/shell-topbar.html');
  assert.match(tb, /<p class="sgx-kh sgx-term-kh" data-term-kh hidden><\/p>\n  <\/div>\n<\/dialog>/);
  assert.match(tb, /<p class="sgx-kh sgx-ai-kh" data-ai-kh hidden><\/p>\n    <p class="sgx-ai-foot">/);
  /* 出口：盾牌 / 账号下拉的「‹ 返回」= esc 同一条路，最外层关下拉 */
  assert.match(read('space/web/assets/js/shell/space/shield.js'), /onBack: function \(\) \{ if \(!escBack\(\)\) o\.ms\.close\(\); \}/);
  assert.match(read('space/web/assets/js/shell/account/term.js'), /if \(!escBack\(\)\) o\.ms\.close\(\);/);
});

test('站内终端 cat daymark/today：返回的 Promise 带 pending = daymark（视图先打「› fetching daymark…」）', async () => {
  const sh = createShell({ storage: null, act: { cd: () => null, sudo: () => ({}), theme: () => {}, lock: () => {}, ask: () => {}, today: () => Promise.resolve({ text: 'x', by: '' }), daymarkHref: () => '/daymark/' } });
  const r = sh.exec('cat daymark/today');
  assert.equal(typeof r.then, 'function');
  assert.equal(r.pending, 'daymark');
  assert.equal(sh.str.fetching, 'fetching {x}…');
  await r;
});

test('选择的高亮跟着输入走（Gray 2026-11-09 手机截图：打了 2 还亮着 [1]）：空 = 默认项、打了哪项亮哪项、不是选项都不亮；锁屏 / 盾牌 / 账号都接 input 事件', async () => {
  const { pickKeyOf } = await import('../../../../space/web/assets/js/shell/term-pick.js');
  assert.equal(pickKeyOf('', ['1', '2'], '1'), '1');
  assert.equal(pickKeyOf('2', ['1', '2'], '1'), '2');
  assert.equal(pickKeyOf(' [2] ', ['1', '2'], '1'), '2');
  assert.equal(pickKeyOf('9', ['1', '2'], '1'), '');
  assert.equal(pickKeyOf('', ['1', '2'], ''), '');
  assert.match(read('space/web/assets/js/shell/space/term.js'), /if \(C\.mode === 'pick'\) paintPick\(d\.log, 'data-term-pick', input\.value, Object\.keys\(picks\), pickDefault\);/);
  assert.match(read('space/web/assets/js/shell/account/term.js'), /if \(C\.mode === 'pick'\) paintPick\(logEl, 'data-at-pick', input\.value, Object\.keys\(picks\), pickDefault\);/);
});

test('锁屏底部 ~/styrigx · zh · en 是舞台里自己的一行（不再 absolute 压在终端最后一行上）', () => {
  const css = read('space/web/assets/css/input.css');
  const m = /\n  \.sgx-entry-tail \{([^}]*)\}/.exec(css);
  assert.ok(m, '.sgx-entry-tail');
  assert.doesNotMatch(m[1], /position: absolute/);
  assert.match(m[1], /margin: auto 0 0; padding: 16px 0 calc\(env\(safe-area-inset-bottom, 0px\) \+ 10px\);/);
});
