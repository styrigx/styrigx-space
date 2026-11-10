/**
 * v5 S1：进站会话 by=link（分享链接）取代 by=tempkey（workers/space-core/src/core/lock-session.js、core/share-links.js、core/link-keys.js）。
 * - 票格式：by=link ⇔ linkId 合法非空（isLinkId，独立于 isId）；by=password / passkey ⇔ linkId 为空；by=tempkey 一律不认（签不出、旧票 bad-format）
 * - 验票：by=link 每次查 share_link 这一行（作废 / 到期 / 不在 → link-revoked；没绑 D1 → d1-error）；epoch 照常
 * - reissueLockSessionWithEpoch 不给 by=link 重签（纪元推进就该让它失效）
 * 端到端（生成 / 点开 / 作废 / rm --all / 权限 / 清理）在 share.test.mjs；reauth / 退出所有设备的拒绝在 lock-reauth.test.mjs。
 * 运行：node --test tests/workers/space-core/link-session.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';
import { testLockSession, TEST_LINK_ID } from './_tickets.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const LS = await import(REPO + 'workers/space-core/src/core/lock-session.js');
const links = await import(REPO + 'workers/space-core/src/core/share-links.js');
const { ed25519Sign } = await import(REPO + 'workers/space-core/src/lib/crypto.js');
const realms = await import(REPO + 'workers/space-core/src/core/realms.js');

const LOCK = await genKeyPair();
const env = (db) => ({ D1_SPACE: db === undefined ? makeAuthD1() : db, SGX_SPACE_PRIVATE: LOCK.priv, SGX_SPACE_PUBLIC: LOCK.pub });
const req = (v) => new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-space-session=' + v } });

test('签票：by=link 要合法 linkId；password / passkey 不能带 id；by=tempkey 签不出', async () => {
  const exp = Date.now() + 3600e3;
  const v = await LS.signLockSessionTicket(LOCK.priv, { by: 'link', epoch: 0, exp, linkId: TEST_LINK_ID });
  assert.equal(v.split('.')[3], TEST_LINK_ID);
  await assert.rejects(LS.signLockSessionTicket(LOCK.priv, { by: 'link', epoch: 0, exp, linkId: '' }));
  await assert.rejects(LS.signLockSessionTicket(LOCK.priv, { by: 'link', epoch: 0, exp, linkId: 'short' }));
  await assert.rejects(LS.signLockSessionTicket(LOCK.priv, { by: 'password', epoch: 0, exp, linkId: TEST_LINK_ID }));
  await assert.rejects(LS.signLockSessionTicket(LOCK.priv, { by: 'tempkey', epoch: 0, exp, linkId: TEST_LINK_ID }));
  await assert.rejects(LS.signLockSessionTicket(LOCK.priv, /** @type {any} */ ({ by: 'tempkey', epoch: 0, exp, tempkeyId: TEST_LINK_ID })));
  assert.equal(realms.BY_LINK, 'link');
  assert.deepEqual([...realms.TICKETS.LockSessionTicket.bys], ['password', 'passkey', 'link']);
  /* issueLockSession：by=link 必须带 maxAge */
  const h = new Headers();
  assert.deepEqual(await LS.issueLockSession(env(), h, { by: 'link', linkId: TEST_LINK_ID }), { status: 500, body: { ok: false, error: 'invalid-by' } });
  assert.deepEqual(await LS.issueLockSession(env(), h, { by: 'tempkey', maxAge: 60, linkId: TEST_LINK_ID }), { status: 500, body: { ok: false, error: 'invalid-by' } });
  assert.equal(h.getSetCookie().length, 0);
});

test('v5 S1 前的 by=tempkey 旧票（签名正确、纪元对、没过期）：bad-format，等于没进门', async () => {
  const payload = 'tempkey.0.' + (Date.now() + 3600e3) + '.tktesttesttest01';
  const sig = await ed25519Sign(LOCK.priv, 'sgx-space-session|' + payload);
  assert.equal(LS.parseLockSessionTicket(payload + '.' + sig), null);
  const r = await LS.verifyLockSession(req(payload + '.' + sig), env());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-format');
  assert.deepEqual(await LS.checkLockSession('sgx-space-session=' + payload + '.' + sig, env()), { ok: false, reason: 'bad-format' });
});

test('验票：有效链接 → ok（by=link、linkId）；作废 / 到期 / 行不在 → link-revoked；没绑 D1 / 读出错 → d1-error；纪元推进 → epoch-low', async () => {
  const db = makeAuthD1();
  const e = env(db);
  const v = await testLockSession(LOCK.priv, 0, 'link');
  let r = await LS.verifyLockSession(req(v), e);
  assert.deepEqual([r.ok, r.by, r.linkId], [true, 'link', TEST_LINK_ID]);
  const put = (id, exp, rev) => db.raw.prepare("INSERT INTO share_link (id, code, name, target, session_sec, created_at, expires_at, revoked_at) VALUES (?, ?, '', '/', 3600, ?, ?, ?)")
    .run(id, id + 'xxxxxx', Date.now(), exp, rev);
  put('lkrevokedrevoked', Date.now() + 3600e3, Date.now());
  put('lkexpiredexpired', Date.now() - 1, null);
  for (const id of ['lkrevokedrevoked', 'lkexpiredexpired', 'lknotherenothere']) {
    r = await LS.verifyLockSession(req(await testLockSession(LOCK.priv, 0, 'link', { linkId: id })), e);
    assert.deepEqual([r.ok, r.reason], [false, 'link-revoked'], id);
  }
  r = await LS.verifyLockSession(req(v), env(null));
  assert.deepEqual([r.ok, r.reason], [false, 'd1-error'], '没绑 D1 不放行');
  const broken = makeAuthD1();
  broken.failOn = (sql) => /FROM share_link/.test(sql);
  r = await LS.verifyLockSession(req(v), env(broken));
  assert.deepEqual([r.ok, r.reason], [false, 'd1-error'], '读出错 fail closed');
  /* 只读 share_link 一次、按主键，不缓存：同一请求两次验两次读 */
  const n0 = db.calls.filter((q) => /FROM share_link/.test(q)).length;
  await LS.verifyLockSession(req(v), e);
  await LS.verifyLockSession(req(v), e);
  assert.equal(db.calls.filter((q) => /FROM share_link/.test(q)).length - n0, 2);
  /* 锁屏密码进门的票不碰 share_link */
  const n1 = db.calls.filter((q) => /share_link/.test(q)).length;
  assert.equal((await LS.verifyLockSession(req(await testLockSession(LOCK.priv, 0, 'password')), e)).ok, true);
  assert.equal(db.calls.filter((q) => /share_link/.test(q)).length, n1);
  /* 纪元推进 */
  await LS.bumpLockEpoch(e);
  r = await LS.verifyLockSession(req(v), e);
  assert.deepEqual([r.ok, r.reason], [false, 'epoch-low']);
});

test('reissueLockSessionWithEpoch：by=link 不重签；password 照常重签（linkId 为空）', async () => {
  const exp = Date.now() + 3600e3;
  let h = new Headers();
  await LS.reissueLockSessionWithEpoch(env(), h, { ok: true, by: 'link', exp, linkId: TEST_LINK_ID }, 5);
  assert.equal(h.getSetCookie().length, 0);
  h = new Headers();
  await LS.reissueLockSessionWithEpoch(env(), h, { ok: true, by: 'password', exp, linkId: '' }, 5);
  const c = h.getSetCookie()[0];
  assert.match(c, /^sgx-space-session=password\.5\.\d+\.\./);
});

test('isLinkId：16 位 base64url；独立于 isId（各自的正则）', () => {
  assert.ok(links.isLinkId(TEST_LINK_ID));
  assert.ok(links.isLinkId(links.newId()));
  for (const bad of ['', 'A'.repeat(15), 'A'.repeat(17), 'AAAAAAAA.AAAAAAA', undefined, 16]) assert.equal(links.isLinkId(bad), false, String(bad));
  assert.notEqual(links.isLinkId, links.isId);
});
