/**
 * 账号通行密钥改名 AccountKey：前端 signalCurrentUserDetails（apps/account-common.js）。
 * - 支持时只发一次，用 list 返回的当前账号 handle，name=AccountKey、displayName=Sloan Gray、rpId=当前域名
 * - 不支持 / 没有 handle → 不发，不报错；API 抛错 / reject 也吞掉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = /** @type {any} */ ({ hostname: 'styrigx.com' });
globalThis.window = /** @type {any} */ (globalThis);
const mod = await import('../../../web/assets/js/apps/account-common.js');

test('signalAccountName：不支持 signalCurrentUserDetails → 不发', () => {
  mod._resetSignalForTest();
  globalThis.PublicKeyCredential = /** @type {any} */ (function () {});
  assert.equal(mod.signalAccountName({ userHandle: 'h1' }), false);
  delete globalThis.PublicKeyCredential;
  assert.equal(mod.signalAccountName({ userHandle: 'h1' }), false);
});

test('signalAccountName：支持时用当前 handle 发一次；没有 handle 不发', () => {
  mod._resetSignalForTest();
  const calls = [];
  globalThis.PublicKeyCredential = /** @type {any} */ ({ signalCurrentUserDetails: (o) => { calls.push(o); return Promise.resolve(); } });
  assert.equal(mod.signalAccountName({ userHandle: '' }), false);
  assert.equal(mod.signalAccountName({ userHandle: 'acct-h', userName: 'AccountKey', displayName: 'Sloan Gray' }), true);
  assert.equal(mod.signalAccountName({ userHandle: 'acct-h' }), false, '每页只发一次');
  assert.deepEqual(calls, [{ rpId: 'styrigx.com', userId: 'acct-h', name: 'AccountKey', displayName: 'Sloan Gray' }]);
  /* 服务端没给 userName 时退回常量 AccountKey */
  mod._resetSignalForTest();
  mod.signalAccountName({ userHandle: 'x' });
  assert.equal(calls[1].name, 'AccountKey');
  delete globalThis.PublicKeyCredential;
});

test('signalAccountName：API 抛错 / reject 都吞掉', async () => {
  mod._resetSignalForTest();
  globalThis.PublicKeyCredential = /** @type {any} */ ({ signalCurrentUserDetails: () => { throw new Error('boom'); } });
  assert.equal(mod.signalAccountName({ userHandle: 'h' }), false);
  mod._resetSignalForTest();
  globalThis.PublicKeyCredential = /** @type {any} */ ({ signalCurrentUserDetails: () => Promise.reject(new Error('nope')) });
  assert.equal(mod.signalAccountName({ userHandle: 'h' }), true);
  await new Promise((r) => setTimeout(r, 0));
  delete globalThis.PublicKeyCredential;
});
