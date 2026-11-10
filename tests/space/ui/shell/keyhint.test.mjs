/**
 * 终端窗口底部的按键提示行（Gray 2026-11-09 细节 1，space/web/assets/js/shell/term/view/keyhint.js）+ 一行输出式的加载提示（细节 3，站内终端 cat daymark/today）。
 * 运行：node --test tests/space/ui/shell/keyhint.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { KH_EN, khKeyFor } from '../../../../space/web/assets/js/shell/term/view/keyhint.js';
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
  /* 终端统一 T1：terminal.js / ai-panel.js 不再抄英文底，和 keyhint.js 同用 shell/term/core/strings.js 的 KH_EN */
  for (const f of ['terminal.js', 'ai-panel.js']) {
    const src = read('space/web/assets/js/shell/' + f);
    assert.match(src, /^import \{ KH_EN, shellSection(, flatStrings)? \} from '\.\/term\/core\/strings\.js';$/m, f + ' 用公共件');
    assert.doesNotMatch(src, /cmdHome: '|ai: 'enter send/, f + ' 不再抄英文底');
  }
});

test('每个终端窗口都有提示行（v5 S5：锁屏 / 盾牌 / 账号的终端并进全站终端）：主页终端 / 终端窗口 / AI 窗口', () => {
  for (const f of ['space/entry.js', 'space/shield.js']) assert.ok(!existsSync(path.join(REPO, 'space/web/assets/js/shell', f)), f + ' 删了');
  assert.doesNotMatch(read('space/web/assets/js/shell/account/window.js'), /data-at-kh/, '账号窗口不再自带终端');
  assert.match(read('space/web/layouts/index.html'), /<p class="sgx-kh sgx-term-kh" data-term-kh hidden><\/p>/);
  const tb = read('space/web/layouts/partials/shell-topbar.html');
  assert.match(tb, /<p class="sgx-kh sgx-term-kh" data-term-kh hidden><\/p>\n  <\/div>\n<\/dialog>/);
  assert.match(tb, /<p class="sgx-kh sgx-ai-kh" data-ai-kh hidden><\/p>\n    <p class="sgx-ai-foot">/);
  /* 出口：终端窗口的「‹ 返回」= esc 同一条路（先退出当前命令 / reset 层），最外层关窗口 */
  const tj = read('space/web/assets/js/shell/terminal.js');
  assert.match(tj, /onBack: function \(\) \{ C\.refocus = true; if \(!C\.interrupt\(\) && o\.onBack\) o\.onBack\(\); \}/);
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
  const { pickKeyOf } = await import('../../../../space/web/assets/js/shell/term/view/pick.js');
  assert.equal(pickKeyOf('', ['1', '2'], '1'), '1');
  assert.equal(pickKeyOf('2', ['1', '2'], '1'), '2');
  assert.equal(pickKeyOf(' [2] ', ['1', '2'], '1'), '2');
  assert.equal(pickKeyOf('9', ['1', '2'], '1'), '');
  assert.equal(pickKeyOf('', ['1', '2'], ''), '');
  /* 终端统一 T2：锁屏 / 盾牌 / 账号下拉同一个输入行（shell/term/view/input-line.js），属性名按 attr 取（data-term-pick / data-at-pick） */
  const il = read('space/web/assets/js/shell/term/view/input-line.js');
  assert.match(il, /if \(C\.mode === 'pick'\) paintPick\(d\.log, PICK, input\.value, Object\.keys\(picks\), pickDefault\);/);
  assert.match(il, /const PICK = 'data-' \+ attr \+ '-pick';/);
  assert.match(read('space/web/assets/js/shell/space/term.js'), /return createInputLine\(o\);/);
  assert.match(read('space/web/assets/js/shell/account/window.js'), /attr: 'at',/);
});

test('锁屏底部 ~/styrigx · zh · en 是舞台里自己的一行（不再 absolute 压在终端最后一行上）', () => {
  const css = read('space/web/assets/css/input.css');
  const m = /\n  \.sgx-entry-tail \{([^}]*)\}/.exec(css);
  assert.ok(m, '.sgx-entry-tail');
  assert.doesNotMatch(m[1], /position: absolute/);
  assert.match(m[1], /margin: auto 0 0; padding: 16px 0 calc\(env\(safe-area-inset-bottom, 0px\) \+ 10px\);/);
});
