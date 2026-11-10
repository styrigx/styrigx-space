/**
 * v6 用户的期限、组与 epoch（workers/account/src/core/users.js）：
 * - expiryFromDate：useradd -e YYYY-MM-DD 按 Linux 语义，该日 00:00 Asia/Shanghai 起失效；不合法日期 → null
 * - 自己改凭据：epoch +1，当前会话续命（快照刷新，admit 仍有效），别的会话作废并删行
 * - root 替人重置：epoch +1，该用户会话全部作废（含别人会话里压着的这一层）
 * - 加组 / 删组 / 改期限：epoch +1、会话全部作废；没变化不动 epoch
 * - 临时用户进不了特权组 / 写组；在这些组里的用户不能设期限；root 不能有期限
 * - 每次变更一个 batch：+1 与作废要么都成要么都不成
 *
 * 运行：node --test tests/workers/account/identity-users.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { users as U, idSession as S, identityEnv, seedBase, seedUser, seedSession, pushRoot, NOW, DAY, all } from './_identity.mjs';

const epoch = (env, uid) => all(env, 'SELECT epoch FROM account_users WHERE uid = ?', uid)[0].epoch;
const sessions = (env, uid) => all(env, 'SELECT id FROM account_sessions WHERE uid = ? ORDER BY id', uid).map((r) => r.id);

test('expiryFromDate：该日 00:00 Asia/Shanghai（UTC 前一天 16:00）；不合法 → null', () => {
  assert.equal(U.expiryFromDate('2026-12-01'), Date.UTC(2026, 10, 30, 16, 0, 0));
  assert.equal(new Date(U.expiryFromDate('2027-01-01')).toISOString(), '2026-12-31T16:00:00.000Z');
  for (const bad of ['', '2026-13-01', '2026-02-30', '2026-2-1', '20261201', null, '2026-12-01T00:00']) assert.equal(U.expiryFromDate(bad), null, String(bad));
  assert.equal(U.SHANGHAI_OFFSET_MS, 8 * 3600000);
});

test('isUserActive', () => {
  assert.equal(U.isUserActive({ uid: 1, name: 'a', avatar: '', expiresAt: 0, epoch: 0, disabled: false }, NOW), true);
  assert.equal(U.isUserActive({ uid: 1, name: 'a', avatar: '', expiresAt: NOW, epoch: 0, disabled: false }, NOW), false);
  assert.equal(U.isUserActive({ uid: 1, name: 'a', avatar: '', expiresAt: 0, epoch: 0, disabled: true }, NOW), false);
  assert.equal(U.isUserActive(null, NOW), false);
});

test('自己改凭据：epoch +1，当前会话续命，其他会话（含它们压着的层）删掉', async () => {
  const env = identityEnv();
  seedBase(env);
  const mine = await seedSession(env, { uid: 1000 });
  const other = await seedSession(env, { uid: 1000 });
  pushRoot(env, other.id);
  const e = await U.credentialsChanged(env, 1000, { sessionId: mine.id });
  assert.equal(e, 1);
  assert.deepEqual(sessions(env, 1000), [mine.id]);
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM account_session_stack')[0].n, 0);
  const a = await S.admitSession(env, mine.token, NOW);
  assert.equal(a.ok, true, '当前会话仍有效');
  assert.equal((await S.admitSession(env, other.token, NOW)).ok, false);
});

test('root 自己在 su 层里改 root 密码：root 层续命，root 别处压着的层作废', async () => {
  const env = identityEnv();
  seedBase(env);
  const mine = await seedSession(env, { uid: 1000 });
  pushRoot(env, mine.id);
  const other = await seedSession(env, { uid: 1000 });
  pushRoot(env, other.id);
  await U.credentialsChanged(env, 0, { sessionId: mine.id });
  assert.equal((await S.admitSession(env, mine.token, NOW)).identity.uid, 0, '本会话 root 层还在');
  assert.equal((await S.admitSession(env, other.token, NOW)).identity.uid, 1000, '别的会话弹回 styrigx');
  assert.equal(epoch(env, 1000), 0, 'styrigx 不受影响');
});

test('root 替别人重置：epoch +1、该用户会话全部作废', async () => {
  const env = identityEnv();
  seedBase(env);
  const a = await seedSession(env, { uid: 1000 });
  const b = await seedSession(env, { uid: 1000 });
  pushRoot(env, b.id);
  assert.equal(await U.credentialsChanged(env, 1000, {}), 1);
  assert.deepEqual(sessions(env, 1000), []);
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM account_session_stack')[0].n, 0);
  assert.equal((await S.admitSession(env, a.token, NOW)).ok, false);
  await assert.rejects(() => U.credentialsChanged(env, 4242, {}), /user-missing/);
});

test('加组 / 删组：变了才 +1 并作废会话；临时用户进不了特权 / 写组', async () => {
  const env = identityEnv();
  seedBase(env);
  seedUser(env, { uid: 1001, name: 'alice', expiresAt: NOW + 7 * DAY });
  const s = await seedSession(env, { uid: 1001 });
  assert.deepEqual(await U.addToGroup(env, 1001, 'listen', NOW), { ok: true, changed: true });
  assert.equal(epoch(env, 1001), 1);
  assert.deepEqual(sessions(env, 1001), [], '组变了 → 会话作废');
  assert.equal((await S.admitSession(env, s.token, NOW)).ok, false);
  assert.deepEqual(await U.addToGroup(env, 1001, 'listen', NOW), { ok: true, changed: false });
  assert.equal(epoch(env, 1001), 1, '没变化不动 epoch');
  for (const g of ['wheel', 'sudoers', 'curio-write', 'daymark-write']) assert.deepEqual(await U.addToGroup(env, 1001, g, NOW), { ok: false, reason: 'temporary' });
  assert.deepEqual(await U.addToGroup(env, 0, 'wheel', NOW), { ok: false, reason: 'root' });
  assert.deepEqual(await U.addToGroup(env, 4242, 'ai', NOW), { ok: false, reason: 'no-user' });
  assert.deepEqual(await U.getGroups(env, 1001), ['listen']);
  assert.deepEqual(await U.removeFromGroup(env, 1001, 'listen'), { ok: true, changed: true });
  assert.equal(epoch(env, 1001), 2);
  assert.deepEqual(await U.removeFromGroup(env, 1001, 'listen'), { ok: true, changed: false });
});

test('改期限：+1 并作废会话；在特权 / 写组里不能设期限；root 不能有期限；坏值拒绝', async () => {
  const env = identityEnv();
  seedBase(env);
  seedUser(env, { uid: 1001, name: 'bob', groups: ['ai'] });
  await seedSession(env, { uid: 1001 });
  const exp = U.expiryFromDate('2026-12-01');
  assert.deepEqual(await U.setUserExpiry(env, 1001, exp), { ok: true, changed: true });
  assert.equal(epoch(env, 1001), 1);
  assert.deepEqual(sessions(env, 1001), []);
  assert.deepEqual(await U.setUserExpiry(env, 1001, exp), { ok: true, changed: false });
  assert.deepEqual(await U.setUserExpiry(env, 1000, exp), { ok: false, reason: 'privileged-groups' });
  assert.deepEqual(await U.setUserExpiry(env, 0, exp), { ok: false, reason: 'root' });
  assert.deepEqual(await U.setUserExpiry(env, 1001, -1), { ok: false, reason: 'bad-expiry' });
  assert.deepEqual(await U.setUserExpiry(env, 1001, 0), { ok: true, changed: true }, '改回永久');
});

test('原子：batch 里任一句失败，epoch 与会话都不变', async () => {
  const env = identityEnv();
  seedBase(env);
  await seedSession(env, { uid: 1000 });
  env.D1_ACCOUNT.raw.exec("CREATE TRIGGER boom BEFORE DELETE ON account_sessions BEGIN SELECT RAISE(ABORT, 'boom'); END");
  await assert.rejects(() => U.credentialsChanged(env, 1000, {}), /boom/);
  assert.equal(epoch(env, 1000), 0);
  assert.equal(sessions(env, 1000).length, 1);
});
