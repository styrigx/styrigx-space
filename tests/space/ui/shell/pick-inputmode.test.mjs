/**
 * 选择的键盘（Gray 2026-11-11 三星实机视频）：[y/N] 原来也设 inputmode=numeric，手机弹数字键盘打不出 y，只能回车 = 默认 N；
 * Samsung Pass 还在这一行弹「账号和密码」自动填充。现在：
 * - 全是数字的选项（[1] [2] …）→ numeric；有字母的（[y/N]、名字）→ text
 * - 非秘密输入（命令 / 选择 / 命名）时隐藏用户名 autocomplete=off，秘密输入时才是 username；输入框本身秘密模式的 autocomplete 不变
 * 运行：node --test tests/space/ui/shell/pick-inputmode.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickInputMode } from '../../../../space/web/assets/js/shell/term/view/pick.js';
import { createInputLine } from '../../../../space/web/assets/js/shell/term/view/input-line.js';

test('pickInputMode：全数字 = numeric，有字母 / 空 = text', () => {
  assert.equal(pickInputMode(['1', '2']), 'numeric');
  assert.equal(pickInputMode(['0', '10']), 'numeric');
  assert.equal(pickInputMode(['y', 'n']), 'text');
  assert.equal(pickInputMode(['1', 'n']), 'text');
  assert.equal(pickInputMode([]), 'text');
});

/** 够 createInputLine 用的最小假 DOM */
function fakeEl() {
  const attrs = new Map();
  return {
    attrs, hidden: false, value: '', type: 'text', readOnly: false, disabled: false, innerHTML: '', textContent: '',
    childNodes: [], firstChild: null,
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    addEventListener() {},
    appendChild(c) { this.childNodes.push(c); return c; },
    removeChild() {},
    querySelectorAll() { return []; },
    classList: { toggle() {} },
    focus() {},
  };
}
function mkLine() {
  const doc = { activeElement: null, createElement: () => fakeEl() };
  const dom = { root: fakeEl(), log: fakeEl(), form: fakeEl(), input: fakeEl(), ps: fakeEl(), pmu: fakeEl(), hint: fakeEl(), live: fakeEl() };
  dom.input.ownerDocument = doc;
  const C = createInputLine({ dom, p: 'sgx-at', t: (k) => k, ps: () => '$', onCmd() {}, pickFocus: false });
  return { C, dom };
}

test('C.pick：[y/N] 用文字键盘，数字选项用数字键盘；x.inputmode 仍可覆盖', () => {
  const { C, dom } = mkLine();
  C.pick({ y() {}, n() {} }, 'n', { ps: '[y/N]' });
  assert.equal(dom.input.getAttribute('inputmode'), 'text');
  assert.equal(dom.input.getAttribute('autocomplete'), 'off');
  C.toCmd();
  C.pick({ 1() {}, 2() {} }, '1');
  assert.equal(dom.input.getAttribute('inputmode'), 'numeric');
  C.toCmd();
  assert.equal(dom.input.getAttribute('inputmode'), 'text');
  C.pick({ 1() {} }, '1', { inputmode: 'text' });
  assert.equal(dom.input.getAttribute('inputmode'), 'text');
});

test('隐藏用户名：命令 / 选择时 autocomplete=off（不招 Samsung Pass），秘密输入时 username；输入框秘密模式不变', () => {
  const { C, dom } = mkLine();
  C.setMode('cmd');
  assert.equal(dom.pmu.getAttribute('autocomplete'), 'off');
  C.pick({ y() {}, n() {} }, 'n');
  assert.equal(dom.pmu.getAttribute('autocomplete'), 'off');
  C.ask('pw', () => {});
  assert.equal(dom.pmu.getAttribute('autocomplete'), 'username');
  assert.equal(dom.input.getAttribute('autocomplete'), 'current-password');
  assert.equal(dom.input.type, 'password');
  C.ask('newpw', () => {});
  assert.equal(dom.pmu.getAttribute('autocomplete'), 'username');
  assert.equal(dom.input.getAttribute('autocomplete'), 'new-password');
  C.ask('pkname', () => {});
  assert.equal(dom.pmu.getAttribute('autocomplete'), 'off');
  assert.equal(dom.input.getAttribute('autocomplete'), 'off');
});
