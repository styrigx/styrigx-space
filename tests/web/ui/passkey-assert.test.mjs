/**
 * 通行密钥断言（auth/passkey-assert.js getPasskeyAssertion）：
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

const { getPasskeyAssertion } = await import('../../../web/assets/js/auth/passkey-assert.js');

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

/* ---- frontend-js #9：五处断言共用 assertionOptions / assertionToJSON ---- */
const { assertionOptions, assertionToJSON, isPasskeyCancel } = await import('../../../web/assets/js/auth/passkey-assert.js');
const { readFileSync } = await import('node:fs');
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('assertionOptions / assertionToJSON / isPasskeyCancel', () => {
  const o = assertionOptions({ challenge: 'AQID', rpId: 'styrigx.com', allowCredentials: [{ id: 'AAEC', type: 'public-key' }, { id: 'AwQ' }] });
  assert.deepEqual([...new Uint8Array(o.challenge)], [1, 2, 3]);
  assert.equal(o.rpId, 'styrigx.com');
  assert.equal(o.userVerification, 'required');
  assert.deepEqual(o.allowCredentials.map((c) => [[...new Uint8Array(c.id)], c.type]), [[[0, 1, 2], 'public-key'], [[3, 4], 'public-key']]);
  /* 没给 rpId / allowCredentials 为空：都不带（= 当前站点、可发现凭证） */
  const o2 = assertionOptions({ challenge: 'AQID', allowCredentials: [] });
  assert.equal('rpId' in o2, false);
  assert.equal('allowCredentials' in o2, false);
  const B = (s) => new TextEncoder().encode(s).buffer;
  const cred = { id: 'k', rawId: B('raw'), type: 'public-key', response: { authenticatorData: B('ad'), clientDataJSON: B('cd'), signature: B('sg'), userHandle: B('uh') } };
  assert.deepEqual(assertionToJSON(cred), { id: 'k', rawId: 'cmF3', type: 'public-key', response: { authenticatorData: 'YWQ', clientDataJSON: 'Y2Q', signature: 'c2c', userHandle: 'dWg' } });
  cred.response.userHandle = null;
  assert.equal(assertionToJSON(cred).response.userHandle, null);
  assert.equal(isPasskeyCancel({ kind: 'cancelled' }), true);
  assert.equal(isPasskeyCancel({ kind: 'nokey', cause: { name: 'NotAllowedError' } }), true);
  assert.equal(isPasskeyCancel({ kind: 'nokey', cause: { name: 'InvalidStateError' } }), false);
  assert.equal(isPasskeyCancel({ kind: 'timeout' }), false);
  assert.equal(isPasskeyCancel(null), false);
});

test('全站的通行密钥断言都经 getPasskeyAssertion + assertionToJSON：没有别处手写 credentials.get / 断言序列化', () => {
  const files = ['web/assets/js/shell/lock.js', 'web/assets/js/shell/upgrade.js', 'web/assets/js/apps/security-lock.js', 'web/assets/js/auth/account-methods.js'];
  let flows = 0;
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!src.includes('navigator.credentials.get'), f + ' 不直接调 credentials.get');
    assert.ok(!/signature: bufToB64url/.test(src), f + ' 不手写断言序列化');
    flows += (src.match(/getPasskeyAssertion\(assertionOptions\(/g) || []).length;
    assert.ok(src.includes('assertionToJSON(cred)'), f + ' 用 assertionToJSON');
  }
  /* 锁屏解锁、锁屏里的重置、访客升级、锁屏凭证页再验证、账号登录 / 再验证 */
  assert.equal(flows, 5);
});
