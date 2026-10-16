/**
 * B1-2 upgrade.js 通行密钥错误决策单测（node --test）。
 *
 * 测试 upgradePasskeyErrorText(e, isEn) 的 5 种 kind：
 * - timeout、nokey-InvalidState、failed：返回文案（翻译后的文字，不是 key 名）
 * - cancelled、nokey-NotAllowedError：返回 null（不弹错）
 *
 * 注意：passkeyErrorText 内部经 loadI18n 读 document.documentElement.lang，
 * 因此每个用例内先把桩的 lang 设为对应语言。
 *
 * 运行：node --test tests/ui/upgrade-passkey.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const I18N_JSON = JSON.stringify({
  pkCancelled: { zh: '已取消', en: 'Cancelled' },
  pkTimeout: { zh: '超时，请重试', en: 'Timed out, please retry' },
  pkNoKey: { zh: '这台设备上没有这把钥匙', en: 'No matching key on this device' },
  pkFailed: { zh: '通行密钥验证失败', en: 'Passkey verification failed' },
});

// 测试桩：在模块加载前装好；每个用例内切换 lang
globalThis.document = {
  documentElement: { lang: 'zh' },
  getElementById: (id) => (id === 'sgx-i18n-core' ? { textContent: I18N_JSON } : null),
};

const { upgradePasskeyErrorText } = await import('../../assets/js/shell/upgrade.js');

function setLang(lang) {
  globalThis.document.documentElement.lang = lang;
}

// ---- 中文 ----
test('upgrade: timeout 返回翻译后的中文文案（不是 key 名）', () => {
  setLang('zh');
  const msg = upgradePasskeyErrorText({ kind: 'timeout' }, false);
  assert.equal(msg, '超时，请重试');
  assert.ok(!/^pk[A-Z]/.test(msg), '不应返回 key 名');
});

test('upgrade: cancelled 返回 null（不弹错）', () => {
  setLang('zh');
  assert.equal(upgradePasskeyErrorText({ kind: 'cancelled' }, false), null);
});

test('upgrade: nokey-NotAllowedError 返回 null（不弹错）', () => {
  setLang('zh');
  const e = { kind: 'nokey', cause: { name: 'NotAllowedError' } };
  assert.equal(upgradePasskeyErrorText(e, false), null);
});

test('upgrade: nokey-InvalidStateError 返回通用报错（与 46fe723 前一致）', () => {
  setLang('zh');
  const e = { kind: 'nokey', cause: { name: 'InvalidStateError' } };
  assert.equal(upgradePasskeyErrorText(e, false), '验证失败');
});

test('upgrade: failed 返回翻译后的中文文案（不是 key 名）', () => {
  setLang('zh');
  const msg = upgradePasskeyErrorText({ kind: 'failed' }, false);
  assert.equal(msg, '通行密钥验证失败');
  assert.ok(!/^pk[A-Z]/.test(msg), '不应返回 key 名');
});

// ---- 英文 ----
test('upgrade: timeout 返回翻译后的英文文案', () => {
  setLang('en');
  const msg = upgradePasskeyErrorText({ kind: 'timeout' }, true);
  assert.equal(msg, 'Timed out, please retry');
});

test('upgrade: cancelled 英文返回 null（不弹错）', () => {
  setLang('en');
  assert.equal(upgradePasskeyErrorText({ kind: 'cancelled' }, true), null);
});

test('upgrade: nokey-NotAllowedError 英文返回 null（不弹错）', () => {
  setLang('en');
  const e = { kind: 'nokey', cause: { name: 'NotAllowedError' } };
  assert.equal(upgradePasskeyErrorText(e, true), null);
});

test('upgrade: nokey-InvalidStateError 英文返回通用报错', () => {
  setLang('en');
  const e = { kind: 'nokey', cause: { name: 'InvalidStateError' } };
  assert.equal(upgradePasskeyErrorText(e, true), 'Verification failed');
});

test('upgrade: failed 返回翻译后的英文文案', () => {
  setLang('en');
  const msg = upgradePasskeyErrorText({ kind: 'failed' }, true);
  assert.equal(msg, 'Passkey verification failed');
});
