/**
 * 通行密钥断言（lib/passkey-assert.js getPasskeyAssertion）：
 * AbortSignal 必须放在 navigator.credentials.get 选项的顶层（WebAuthn 只认这里），publicKey 里只带 timeout。
 * 运行：node --test tests/web/ui/passkey-assert.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let seen = null;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { credentials: { get: async (opts) => { seen = opts; return { id: 'cred' }; } } },
});

const { getPasskeyAssertion } = await import('../../../web/assets/js/lib/passkey-assert.js');

test('signal 在顶层、publicKey 里没有 signal；timeout 30000；原选项不被改', async () => {
  const options = { challenge: new Uint8Array([1, 2, 3]), rpId: 'styrigx.com' };
  const cred = await getPasskeyAssertion(options);
  assert.deepEqual(cred, { id: 'cred' });
  assert.ok(seen.signal instanceof AbortSignal, '顶层带 AbortSignal');
  assert.equal(seen.signal.aborted, false);
  assert.equal('signal' in seen.publicKey, false, 'publicKey 里不放 signal');
  assert.equal(seen.publicKey.timeout, 30000);
  assert.equal(seen.publicKey.rpId, 'styrigx.com');
  assert.equal('timeout' in options, false);
});
