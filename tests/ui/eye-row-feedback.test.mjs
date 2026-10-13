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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bindEyeButton,
  EYE_SVG,
  EYE_OFF_SVG,
} from '../../assets/js/lib/dialog-behavior.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
  const icon = read('layouts/partials/icon.html');
  assert.ok(icon.includes('eq $name "eye"'), 'icon.html 应有 eye 条目');
  assert.ok(icon.includes('eq $name "eye-off"'), 'icon.html 应有 eye-off 条目');
  assert.ok(icon.includes('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z'), 'icon.html eye 应为现有睁眼路径');
});

test('眼睛：各处不再内联眼睛 SVG、不再 toggle .off；模板文案为显示密码/隐藏密码', () => {
  for (const f of [
    'assets/js/apps/door.js',
    'assets/js/apps/security-lock.js',
    'assets/js/apps/security.js',
    'assets/js/shell/lock.js',
    'assets/js/shell/upgrade.js',
  ]) {
    const src = read(f);
    assert.ok(!src.includes("classList.toggle('off'"), f + ' 不应再 toggle .off');
    assert.ok(!src.includes('M2 12s3.5-7'), f + ' 不应再内联眼睛 SVG（统一走 bindEyeButton）');
  }
  assert.ok(!read('assets/js/apps/security.js').includes('const EYE ='), 'security.js 的 EYE 常量应删除');
  for (const t of ['layouts/_default/security-owner.html', 'layouts/_default/security-lock.html']) {
    const src = read(t);
    assert.ok(src.includes('"eyeShow" (dict "zh" "显示密码" "en" "Show password")'), t + ' eyeShow 应为显示密码');
    assert.ok(src.includes('"eyeHide" (dict "zh" "隐藏密码" "en" "Hide password")'), t + ' eyeHide 应为隐藏密码');
  }
  /* 补眼睛按钮的三个位置都在 */
  assert.ok(read('assets/js/shell/lock.js').includes('sgx-reset-root-eye'), '重置 step1 应有眼睛按钮');
  assert.ok(read('assets/js/shell/lock.js').includes('sgx-reset-pw-eye'), '重置 step2 应有眼睛按钮');
  assert.ok(read('assets/js/shell/upgrade.js').includes('sgx-upgrade-eye'), '访客升级弹层应有眼睛按钮');
});
