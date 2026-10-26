/**
 * 通行密钥索引（_kernel/passkey-store.js）在 KV 出错 / 最终一致时不丢钥匙（gateway 审计 #12）：
 * - 读索引出错：getPasskeys 这次返回 []（fail closed），但绝不用 kv.list 的结果覆盖现有索引
 * - kv.list 还没看到刚注册的那把（最终一致）也不会让它从索引里掉出去
 * - 索引确实不存在：按前缀补建；补建时某把读失败就不写残缺索引
 * - savePasskey 遇到索引不存在：先补建再加，不会只剩新的这一把
 *
 * 运行：node --test tests/workers/auth-gateway/passkey-index.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPasskeys, savePasskey, passkeyKey, PASSKEY_LOCK, PASSKEY_ACCOUNT } from '../../../workers/auth-gateway/functions/_kernel/passkey-store.js';
import { makeKV } from '../_harness.mjs';

const IDX = { [PASSKEY_LOCK]: 'lock-passkey-index', [PASSKEY_ACCOUNT]: 'account-passkey-index' };
const rec = (credId) => JSON.stringify({ name: 'k', credId, publicKey: 'pk', signCount: 0 });

for (const domain of [PASSKEY_LOCK, PASSKEY_ACCOUNT]) {
  const A = domain + 'credAAAAAAAAAAAAAAAA';
  const B = domain + 'credBBBBBBBBBBBBBBBB';

  test(domain + '：读索引出错 → 这次返回 []，索引原样不动；恢复后两把都在', async () => {
    const kv = makeKV({ [IDX[domain]]: JSON.stringify([A, B]), [passkeyKey(domain, A)]: rec(A), [passkeyKey(domain, B)]: rec(B) });
    kv.listHides.add(passkeyKey(domain, B)); /* B 刚注册，list 还看不到 */
    kv.failGet = (k) => k === IDX[domain];
    assert.deepEqual(await getPasskeys(kv, domain), []);
    assert.deepEqual(kv.puts, [], '不写索引');
    assert.deepEqual(JSON.parse(kv.m.get(IDX[domain])), [A, B]);
    kv.failGet = () => false;
    assert.deepEqual((await getPasskeys(kv, domain)).map((k) => k.credId), [A, B]);
  });

  test(domain + '：索引不存在 → 按前缀补建并写回', async () => {
    const kv = makeKV({ [passkeyKey(domain, A)]: rec(A), [passkeyKey(domain, B)]: rec(B) });
    assert.deepEqual((await getPasskeys(kv, domain)).map((k) => k.credId).sort(), [A, B].sort());
    assert.deepEqual(JSON.parse(kv.m.get(IDX[domain])).sort(), [A, B].sort());
  });

  test(domain + '：补建时某把读失败 → 不写残缺索引', async () => {
    const kv = makeKV({ [passkeyKey(domain, A)]: rec(A), [passkeyKey(domain, B)]: rec(B) });
    kv.failGet = (k) => k === passkeyKey(domain, B);
    assert.deepEqual(await getPasskeys(kv, domain), []);
    assert.equal(kv.m.has(IDX[domain]), false, '索引不写');
  });

  test(domain + '：savePasskey 遇到索引不存在 → 先补建再加，旧的那把不会被挤掉', async () => {
    const kv = makeKV({ [passkeyKey(domain, A)]: rec(A) });
    await savePasskey(kv, domain, { credId: B, publicKey: 'pk', name: 'new' });
    assert.deepEqual(JSON.parse(kv.m.get(IDX[domain])).sort(), [A, B].sort());
  });

  test(domain + '：savePasskey 时读索引出错 → 记录照存，索引不被覆盖', async () => {
    const kv = makeKV({ [IDX[domain]]: JSON.stringify([A]), [passkeyKey(domain, A)]: rec(A) });
    kv.failGet = (k) => k === IDX[domain];
    await savePasskey(kv, domain, { credId: B, publicKey: 'pk', name: 'new' });
    assert.ok(kv.m.has(passkeyKey(domain, B)), '记录写了');
    assert.deepEqual(JSON.parse(kv.m.get(IDX[domain])), [A], '索引没被重建覆盖');
  });

  test(domain + '：索引存在时 savePasskey 只追加（更新 signCount 不写索引）', async () => {
    const kv = makeKV({ [IDX[domain]]: JSON.stringify([A]), [passkeyKey(domain, A)]: rec(A) });
    await savePasskey(kv, domain, { credId: A, publicKey: 'pk', signCount: 5 });
    assert.deepEqual(kv.puts, [passkeyKey(domain, A)]);
    await savePasskey(kv, domain, { credId: B, publicKey: 'pk' });
    assert.deepEqual(JSON.parse(kv.m.get(IDX[domain])), [A, B]);
  });
}
