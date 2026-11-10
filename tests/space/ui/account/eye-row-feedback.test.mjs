/**
 * 批次 A 验收修复 P2：眼睛图标 + 行反馈（tests/ui）。
 *
 * 眼睛（bindEyeButton，dialog-behavior.js）：
 * - 初始 eye-off（带斜线）+ aria-pressed=false + aria-label=显示密码
 * - 点一次 → eye + 隐藏密码 + aria-pressed=true + 输入框明文 + 焦点仍在输入框
 * - 再点恢复；reset() 回到密文态；文案可由 opts 或 data-eye-show/hide 传入
 * - 旧 function(show) 回调仍兼容
 * 行反馈（tapFeedback / 行状态 helper，同文件）由下一提交补测试。
 *
 * 运行：node --test tests/ui/eye-row-feedback.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsDict } from '../../../fixtures/strings.mjs';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bindEyeButton,
  EYE_SVG,
  EYE_OFF_SVG,
  tapFeedback,
  setRowBusy,
  setRowSelected,
} from '../../../../space/web/assets/js/lib/dialog-behavior.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 最小 fake DOM：只实现 bindEyeButton / 行 helper 用到的表面。 */
function fakeEl() {
  const listeners = {};
  const el = {
    _listeners: listeners,
    innerHTML: '',
    _attrs: {},
    _classes: new Set(),
    type: 'password',
    disabled: false,
    focused: false,
    classList: {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      contains: (c) => el._classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c);
        else if (force) el._classes.add(c);
        else el._classes.delete(c);
      },
    },
    addEventListener: (t, f) => {
      (listeners[t] = listeners[t] || []).push(f);
    },
    setAttribute: (k, v) => { el._attrs[k] = String(v); },
    getAttribute: (k) => (k in el._attrs ? el._attrs[k] : null),
    focus: () => { el.focused = true; },
    click: () => {
      const e = { preventDefault: () => {} };
      (listeners.click || []).slice().forEach((f) => f(e));
    },
  };
  return el;
}

test('眼睛：初始 eye-off + 显示密码 + aria-pressed=false', () => {
  const btn = fakeEl();
  const input = fakeEl();
  bindEyeButton(btn, input, { showLabel: '显示密码', hideLabel: '隐藏密码' });
  assert.ok(btn.innerHTML.includes('<line'), '初始应为 eye-off（带斜线）');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(btn.getAttribute('aria-label'), '显示密码');
  assert.equal(input.type, 'password');
});

test('眼睛：点一次变 eye + 隐藏密码 + 明文 + 焦点在输入框；再点恢复', () => {
  const btn = fakeEl();
  const input = fakeEl();
  bindEyeButton(btn, input, { showLabel: '显示密码', hideLabel: '隐藏密码' });
  btn.click();
  assert.ok(!btn.innerHTML.includes('<line'), '明文态应为 eye（无斜线）');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(btn.getAttribute('aria-label'), '隐藏密码');
  assert.equal(input.type, 'text');
  assert.equal(input.focused, true, '切换不丢焦点');
  btn.click();
  assert.ok(btn.innerHTML.includes('<line'), '再点恢复 eye-off');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(btn.getAttribute('aria-label'), '显示密码');
  assert.equal(input.type, 'password');
});

test('眼睛：reset() 回到密文态', () => {
  const btn = fakeEl();
  const input = fakeEl();
  const reset = bindEyeButton(btn, input, { showLabel: '显示密码', hideLabel: '隐藏密码' });
  btn.click();
  assert.equal(input.type, 'text');
  reset();
  assert.ok(btn.innerHTML.includes('<line'));
  assert.equal(input.type, 'password');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(btn.getAttribute('aria-label'), '显示密码');
});

test('眼睛：文案可由 data-eye-show / data-eye-hide 传入；旧 function 回调仍兼容', () => {
  const btn = fakeEl();
  btn.setAttribute('data-eye-show', 'Show password');
  btn.setAttribute('data-eye-hide', 'Hide password');
  const input = fakeEl();
  const seen = [];
  bindEyeButton(btn, input, (show) => seen.push(show));
  assert.equal(btn.getAttribute('aria-label'), 'Show password');
  btn.click();
  assert.equal(btn.getAttribute('aria-label'), 'Hide password');
  assert.deepEqual(seen, [true]);
});

test('眼睛：EYE_OFF_SVG 带斜线、EYE_SVG 不带；icon.html 有 eye/eye-off 条目且路径一致', () => {
  assert.ok(EYE_OFF_SVG.includes('<line'), 'EYE_OFF_SVG 应含斜线');
  assert.ok(!EYE_SVG.includes('<line'), 'EYE_SVG 不应含斜线');
  const icon = read('space/web/layouts/partials/icon.html');
  assert.ok(icon.includes('eq $name "eye"'), 'icon.html 应有 eye 条目');
  assert.ok(icon.includes('eq $name "eye-off"'), 'icon.html 应有 eye-off 条目');
  assert.ok(icon.includes('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z'), 'icon.html eye 应为现有睁眼路径');
});

test('眼睛：各处不再内联眼睛 SVG、不再 toggle .off；模板文案为显示密码/隐藏密码', () => {
  const spaceDir = 'space/web/assets/js/shell/space';
  const files = ['space/web/assets/js/shell/account/window.js', 'space/web/assets/js/shell/account/cmd/keys.js']
    .concat(readdirSync(join(ROOT, spaceDir)).filter((f) => f.endsWith('.js')).map((f) => spaceDir + '/' + f));
  for (const f of files) {
    const src = read(f);
    assert.ok(!src.includes("classList.toggle('off'"), f + ' 不应再 toggle .off');
    assert.ok(!src.includes('M2 12s3.5-7'), f + ' 不应再内联眼睛 SVG（统一走 bindEyeButton）');
  }
  /* 进站 v3 L1：安全页（security.js / security-lock.js）和锁屏 lock.js、cred-rows.js 都删了，进站凭证在盾牌终端里 */
  for (const f of ['apps/security.js', 'apps/security-lock.js', 'shell/lock.js', 'auth/cred-rows.js']) {
    assert.ok(!existsSync(join(ROOT, 'space/web/assets/js', f)), f + ' 已删');
  }
  /* 语言包化（2026-11-07）：账号页文案表在主站字符串表 js.account */
  const d = jsDict('account');
  assert.deepEqual(d.eyeShow, { en: 'Show password', zh: '显示密码' }, 'account eyeShow 应为显示密码');
  assert.deepEqual(d.eyeHide, { en: 'Hide password', zh: '隐藏密码' }, 'account eyeHide 应为隐藏密码');
  /* 锁屏 sudo styrigx reset 走 /api/lock-reset（paths.js 唯一一处地址）；没有底部弹层 / 验证对话框 */
  assert.ok(read(spaceDir + '/paths.js').includes("reset: '/api/lock-reset'"), 'reset 走 /api/lock-reset');
  for (const f of ['layer.js', 'reset.js', 'session.js']) {
    assert.ok(!/createMethodSheet|createVerifyDialog|mountResetFlow/.test(read(spaceDir + '/' + f)), f + ' 不用底部弹层 / 验证对话框');
  }
  /* P2-3：升级验证层（shell/upgrade.js）已删除 */
  assert.ok(!existsSync(join(ROOT, 'space/web/assets/js/shell/upgrade.js')), 'shell/upgrade.js 已删除');
});

test('行反馈：tapFeedback 有 vibrate 时以 10ms 调用，不支持时不报错', () => {
  const calls = [];
  const vibrate = (ms) => { calls.push(ms); return true; };
  /* Node 20 无 globalThis.navigator（Node 21+ 才有），Node 22 的 navigator 是只读 getter：
     有则在其上定义 vibrate，无则临时挂一个纯对象，事后还原。 */
  const nav = globalThis.navigator;
  if (nav && typeof nav === 'object') {
    Object.defineProperty(nav, 'vibrate', { configurable: true, writable: true, value: vibrate });
    try {
      tapFeedback();
    } finally {
      delete nav.vibrate;
    }
  } else {
    globalThis.navigator = { vibrate };
    try {
      tapFeedback();
    } finally {
      delete globalThis.navigator;
    }
  }
  assert.deepEqual(calls, [10]);
  /* 不支持 vibrate：不报错 */
  tapFeedback();
});

test('行反馈：busy / 选中 helper 按约定 class 增删', () => {
  const row = fakeEl();
  setRowBusy(row, true);
  assert.ok(row.classList.contains('sgx-row-busy'), 'busy 应加 .sgx-row-busy');
  assert.equal(row.disabled, true, 'busy 应禁用行防重复点击');
  setRowBusy(row, false);
  assert.ok(!row.classList.contains('sgx-row-busy'));
  assert.equal(row.disabled, false);
  setRowSelected(row, true);
  assert.ok(row.classList.contains('sgx-row-selected'));
  setRowSelected(row, false);
  assert.ok(!row.classList.contains('sgx-row-selected'));
});
