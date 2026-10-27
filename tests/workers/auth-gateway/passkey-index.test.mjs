/**
 * 通行密钥存储（_kernel/passkey-store.js → d1-state.js）不丢钥匙、不复活钥匙（gateway 审计 #12；2026-10-27 搬到 D1）。
 *
 * 以前的 KV 索引是「读-改-写」：60 秒内连续注册两把，第二次读到旧索引就把第一把挤出去（不自愈）；删除同理。
 * 现在每把一行 D1（强一致），没有索引可丢。这里核对：
 * - 连续 / 并发注册、删除：谁也不挤掉谁
 * - 上线前 KV 里的钥匙由 scripts/migrate-kv-to-d1.mjs 部署前导入（按索引保序，索引不存在按前缀）；运行时不读 KV、没有回落：
 *   删光了不会从 KV 读回来，env 里放一个碰一下就抛错的 KV 也照常工作
 * - 更新（signCount / 改名）不会把刚删掉的钥匙写回来
 *
 * 运行：node --test tests/workers/auth-gateway/passkey-index.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPasskeys, getPasskey, hasPasskey, savePasskey, updatePasskey, deletePasskey, PASSKEY_LOCK, PASSKEY_ACCOUNT,
} from '../../../workers/auth-gateway/functions/_kernel/passkey-store.js';
import { makeKV, makeAuthD1, authD1For, forbiddenKV } from '../_harness.mjs';

const IDX = { [PASSKEY_LOCK]: 'lock-passkey-index', [PASSKEY_ACCOUNT]: 'account-passkey-index' };
const PREFIX = { [PASSKEY_LOCK]: 'lock-passkey:', [PASSKEY_ACCOUNT]: 'account-passkey:' };
const kvKey = (domain, credId) => PREFIX[domain] + credId.slice(0, 12);
const rec = (credId) => JSON.stringify({ name: 'k', credId, publicKey: 'pk', signCount: 0 });

/** 网关 env：三个 D1 绑定同一个库（同线上），没有 KV */
function noKvEnv(db) {
  const d = db || makeAuthD1();
  return { D1_LOCK_AUTH: d, D1_ACCOUNT_AUTH: d, D1_ROOT_AUTH: d };
}
const ids = (list) => list.map((k) => k.credId);

for (const domain of [PASSKEY_LOCK, PASSKEY_ACCOUNT]) {
  const other = domain === PASSKEY_LOCK ? PASSKEY_ACCOUNT : PASSKEY_LOCK;
  const A = domain + 'credAAAAAAAAAAAAAAAA';
  const B = domain + 'credBBBBBBBBBBBBBBBB';
  const C = domain + 'credCCCCCCCCCCCCCCCC';

  test(domain + '：连续注册两把、并发再注册一把 → 三把都在（以前的索引读-改-写会挤掉先注册的那把）', async () => {
    const env = noKvEnv();
    await savePasskey(env, domain, { credId: A, publicKey: 'pk', name: 'phone' });
    await savePasskey(env, domain, { credId: B, publicKey: 'pk', name: 'laptop' });
    await Promise.all([savePasskey(env, domain, { credId: C, publicKey: 'pk' }), getPasskeys(env, domain)]);
    assert.deepEqual(ids(await getPasskeys(env, domain)), [A, B, C], '按注册顺序');
    assert.equal(await hasPasskey(env, domain), true);
    assert.deepEqual(await getPasskeys(env, other), [], '另一个域看不到');
  });

  test(domain + '：删一把不影响别的；同 credId 再注册是覆盖不是多一把', async () => {
    const env = noKvEnv();
    for (const id of [A, B, C]) await savePasskey(env, domain, { credId: id, publicKey: 'pk' });
    await Promise.all([deletePasskey(env, domain, B), savePasskey(env, domain, { credId: A, publicKey: 'pk2', name: 'renamed' })]);
    const list = await getPasskeys(env, domain);
    assert.deepEqual(ids(list), [A, C]);
    assert.equal(list[0].name, 'renamed');
    assert.equal(list[0].publicKey, 'pk2');
    assert.equal(await getPasskey(env, domain, B), null);
    assert.equal(await deletePasskey(env, domain, B), null, '再删一次：本来就没有');
  });

  test(domain + '：更新（signCount / 改名）只改还在的那条，刚删掉的不会被写回来', async () => {
    const env = noKvEnv();
    await savePasskey(env, domain, { credId: A, publicKey: 'pk' });
    const got = await getPasskey(env, domain, A);
    await deletePasskey(env, domain, A); /* 解锁验证期间被删 */
    got.signCount = 9;
    assert.equal(await updatePasskey(env, domain, got), false);
    assert.equal(await getPasskey(env, domain, A), null);
    await savePasskey(env, domain, { credId: B, publicKey: 'pk' });
    const b = await getPasskey(env, domain, B);
    b.signCount = 4;
    assert.equal(await updatePasskey(env, domain, b), true);
    assert.equal((await getPasskey(env, domain, B)).signCount, 4);
  });

  test(domain + '：上线前 KV 里的钥匙（导入脚本按索引导进 D1，保序）：之后只认 D1，删光了不会从 KV 读回来', async () => {
    const kv = makeKV({ [IDX[domain]]: JSON.stringify([B, A]), [kvKey(domain, A)]: rec(A), [kvKey(domain, B)]: rec(B) });
    const db = authD1For(kv); /* = 部署前跑过 scripts/migrate-kv-to-d1.mjs */
    const env = noKvEnv(db);
    assert.deepEqual(ids(await getPasskeys(env, domain)), [B, A], '按 KV 索引的顺序');
    assert.deepEqual(await getPasskeys(env, other), [], '另一个域看不到');
    await deletePasskey(env, domain, A);
    await deletePasskey(env, domain, B);
    assert.deepEqual(await getPasskeys(env, domain), [], '删光了不会从 KV 读回来');
    assert.equal(await hasPasskey(env, domain), false);
    assert.ok(kv.m.has(kvKey(domain, A)), 'KV 旧数据原样保留（不删生产数据）');
    assert.deepEqual(kv.puts, [], 'KV 只读不写');
    assert.equal(kv._calls.get + kv._calls.list, 0, '网关代码一次都没读 KV（导入只发生在测试替身里）');
  });

  test(domain + '：上线前 KV 索引不存在 → 导入脚本按前缀补查', async () => {
    const kv = makeKV({ [kvKey(domain, A)]: rec(A), [kvKey(domain, B)]: rec(B) });
    const env = noKvEnv(authD1For(kv));
    assert.deepEqual(ids(await getPasskeys(env, domain)).sort(), [A, B].sort());
  });

  test(domain + '：没有 KV 回落——env 里的 KV 碰一下就抛错，注册 / 列出 / 删除照常；D1 里没有就是没有', async () => {
    const touched = [];
    const db = makeAuthD1();
    const env = { ...noKvEnv(db), KV_LOCK_DOOR: forbiddenKV('KV_LOCK_DOOR', touched), KV_ACCOUNT_LOGIN: forbiddenKV('KV_ACCOUNT_LOGIN', touched) };
    assert.deepEqual(await getPasskeys(env, domain), []);
    assert.equal(await hasPasskey(env, domain), false);
    await savePasskey(env, domain, { credId: A, publicKey: 'pk' });
    assert.deepEqual(ids(await getPasskeys(env, domain)), [A]);
    await deletePasskey(env, domain, A);
    assert.equal(await getPasskey(env, domain, A), null);
    assert.deepEqual(touched, []);
    assert.deepEqual(db.rows('kv_migration'), [], '运行时不写导入标记');
  });
}

test('D1 读不到（绑定缺失 / 查询出错）：getPasskeys / getPasskey 当没有，hasPasskey / savePasskey / deletePasskey 抛错', async () => {
  const noD1 = {};
  assert.deepEqual(await getPasskeys(noD1, PASSKEY_LOCK), []);
  assert.equal(await getPasskey(noD1, PASSKEY_LOCK, 'x'), null);
  await assert.rejects(hasPasskey(noD1, PASSKEY_LOCK));
  await assert.rejects(savePasskey(noD1, PASSKEY_LOCK, { credId: 'x', publicKey: 'pk' }));
  const db = makeAuthD1();
  db.failOn = (sql) => /passkey/.test(sql);
  const env = noKvEnv(db);
  assert.deepEqual(await getPasskeys(env, PASSKEY_ACCOUNT), []);
  await assert.rejects(deletePasskey(env, PASSKEY_ACCOUNT, 'x'));
});
