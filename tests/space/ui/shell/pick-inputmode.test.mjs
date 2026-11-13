/**
 * 选择的键盘（Gray 2026-11-11 三星实机视频）：[y/N] 原来也设 inputmode=numeric，手机弹数字键盘打不出 y，只能回车 = 默认 N；
 * Samsung Pass 还在这一行弹「账号和密码」自动填充。现在：
 * - 全是数字的选项（[1] [2] …）→ numeric；有字母的（[y/N]、名字）→ text
 * - S9（#392 不够，Gray 三星实机：空命令行也弹）：隐藏用户名只在秘密输入时插进表单，命令 / 选择 / 命名时表单里根本没有它；输入框本身秘密模式的 autocomplete 不变
 * 运行：node --test tests/space/ui/shell/pick-inputmode.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickInputMode } from '../../../../space/web/assets/common/js/frame/term/view/pick.js';
import { createInputLine } from '../../../../space/web/assets/common/js/frame/term/view/input-line.js';

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
    insertBefore(c) { this.childNodes.unshift(c); c.parent = this; return c; },
    remove() { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((x) => x !== this); this.parent = null; },
    removeChild() {},
    querySelectorAll() { return []; },
    classList: { toggle() {} },
    focus() {},
  };
}
function mkLine() {
  const doc = { activeElement: null, createElement: () => fakeEl() };
  const dom = { root: fakeEl(), log: fakeEl(), form: fakeEl(), input: fakeEl(), ps: fakeEl(), hint: fakeEl(), live: fakeEl() };
  dom.input.ownerDocument = doc;
  const C = createInputLine({ dom, p: 'sgx-at', t: (k) => k, ps: () => '$', onCmd() {}, pickFocus: false, pmDefault: 'SpacePassword' });
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

test('隐藏用户名（S9）：只在秘密输入时在表单里（autocomplete=username、带值）；命令 / 选择 / 命名时不在 DOM 里；输入框秘密模式不变', () => {
  const { C, dom } = mkLine();
  const pmu = () => dom.form.childNodes.find((n) => n.getAttribute && n.getAttribute('data-term-pmu') !== null) || null;
  C.setMode('cmd');
  assert.equal(pmu(), null, '空命令行：没有用户名字段');
  assert.equal(dom.input.getAttribute('autocomplete'), 'off');
  C.pick({ y() {}, n() {} }, 'n');
  assert.equal(pmu(), null, '[y/N]：没有用户名字段');
  C.ask('pw', () => {});
  assert.equal(pmu().getAttribute('autocomplete'), 'username');
  assert.equal(pmu().value, 'SpacePassword');
  assert.equal(dom.input.getAttribute('autocomplete'), 'current-password');
  assert.equal(dom.input.type, 'password');
  C.ask('newpw', () => {});
  assert.equal(dom.form.childNodes.filter((n) => n.getAttribute && n.getAttribute('data-term-pmu') !== null).length, 1, '换秘密模式不重复插');
  assert.equal(dom.input.getAttribute('autocomplete'), 'new-password');
  C.ask('pkname', () => {});
  assert.equal(pmu(), null);
  assert.equal(dom.input.getAttribute('autocomplete'), 'off');
  C.toCmd();
  assert.equal(pmu(), null);
});

test('秘密模式表里没有临时钥匙时代的 temp 了（S9）', async () => {
  const { SECRET_MODES } = await import('../../../../space/web/assets/common/js/frame/term/view/input-line.js');
  assert.deepEqual([...SECRET_MODES], ['pw', 'rkey', 'newpw', 'newpw2']);
});
