/**
 * v6 新会话判定（workers/account/src/core/identity-session.js admitSession / admitRequest）：
 * - 一次 D1 查询（会话 + 栈 + 用户 + 组 + epoch JOIN），只读：不写任何行
 * - 库里只存令牌的 SHA-256；令牌格式不对不查库
 * - 栈底：过期 / 用户禁用 / 用户到期 / epoch 不等 → 拒绝；栈底是 root 只允许救援会话
 * - root 层：有效 → 当前身份 root（via 栈底）；过期 / epoch 不等 / root 禁用 → 弹回栈底（不写库）
 * - 救援：栈底 root、rescue 标志、没有中间层、不续期
 * - 组：只回认识的组，排序去重
 * - 时长常量（Gray 定稿）与续期节流：剩余不到一半才续、每会话每天至多一次；救援永不续
 * - 读库出错 fail closed
 *
 * 运行：node --test tests/workers/account/identity-session.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idSession as S, identityEnv, seedBase, seedUser, seedSession, pushRoot, token, NOW, DAY, reqWithToken, all } from './_identity.mjs';

const writes = (env) => env.D1_ACCOUNT.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i.test(s));

test('时长与节流常量（Gray 2026-11-11 定稿）', () => {
  assert.equal(S.SESSION_COOKIE, 'sgx-session');
  assert.equal(S.SESSION_TTL_MS.user, 30 * DAY);
  assert.equal(S.SESSION_TTL_MS.rootLayer, 3600000);
  assert.equal(S.SESSION_TTL_MS.rescue, 900000);
  assert.equal(S.ROOT_IDLE_MS, 900000);
  assert.equal(S.RENEW_BELOW_MS, 15 * DAY);
  assert.equal(S.RENEW_MIN_INTERVAL_MS, DAY);
});

test('shouldRenew：剩余不到一半才续；距上次续期（或签发）不满一天不续；救援 / 已过期不续', () => {
  const s = (left, last) => ({ rescue: false, expiresAt: NOW + left, renewedAt: last, createdAt: 0 });
  assert.equal(S.shouldRenew(s(20 * DAY, 0), NOW), false, '剩 20 天');
  assert.equal(S.shouldRenew(s(15 * DAY, 0), NOW), false, '正好一半');
  assert.equal(S.shouldRenew(s(15 * DAY - 1, 0), NOW), true, '不到一半');
  assert.equal(S.shouldRenew(s(10 * DAY, NOW - DAY + 1), NOW), false, '一天内续过');
  assert.equal(S.shouldRenew(s(10 * DAY, NOW - DAY), NOW), true);
  assert.equal(S.shouldRenew({ rescue: false, expiresAt: NOW + DAY, renewedAt: 0, createdAt: NOW - 1000 }, NOW), false, '刚签发不续');
  assert.equal(S.shouldRenew({ rescue: true, expiresAt: NOW + 1000, renewedAt: 0, createdAt: 0 }, NOW), false);
  assert.equal(S.shouldRenew(s(-1, 0), NOW), false);
});

test('sessionIdOf：SHA-256 十六进制；格式不对 → null（不查库）', async () => {
  const t = token();
  const id = await S.sessionIdOf(t);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.notEqual(id, t);
  for (const bad of ['', 'short', 'x'.repeat(44), 'a'.repeat(42) + '!', null, 42]) assert.equal(await S.sessionIdOf(bad), null);
  const env = identityEnv();
  assert.deepEqual(await S.admitSession(env, 'nope', NOW), { ok: false, reason: 'no-session' });
  assert.equal(env.D1_ACCOUNT.statements.length, 0);
});

test('styrigx 会话：一次查询、不写库；身份 = styrigx + 默认组', async () => {
  const env = identityEnv();
  seedBase(env);
  const { token: t, id } = await seedSession(env, { uid: 1000 });
  env.D1_ACCOUNT.statements.length = 0;
  const a = await S.admitSession(env, t, NOW);
  assert.equal(a.ok, true);
  assert.equal(a.sessionId, id);
  assert.deepEqual(a.identity, { uid: 1000, name: 'styrigx', groups: ['ai', 'curio-write', 'daymark-write', 'listen', 'status', 'sudoers', 'wheel'], rescue: false });
  assert.equal(a.via, null);
  assert.equal(a.renew, false);
  assert.equal(env.D1_ACCOUNT.statements.length, 1, '一次 D1 查询');
  assert.equal(env.D1_ACCOUNT.statements[0], S.ADMIT_SQL);
  assert.deepEqual(writes(env), []);
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM account_sessions WHERE id = ?', t)[0].n, 0, '库里不存令牌原文');
});

test('栈底无效：没这行 / 过期 / 用户禁用 / 用户到期 / epoch 不等 / 用户不在', async () => {
  const env = identityEnv();
  seedBase(env);
  seedUser(env, { uid: 1001, name: 'off', disabled: true });
  seedUser(env, { uid: 1002, name: 'gone', expiresAt: NOW - 1 });
  seedUser(env, { uid: 1003, name: 'bumped', epoch: 3 });
  const cases = [
    [{ uid: 1000, expiresAt: NOW }, 'expired'],
    [{ uid: 1001 }, 'user'],
    [{ uid: 1002 }, 'user'],
    [{ uid: 1003, epoch: 2 }, 'epoch'],
    [{ uid: 4242 }, 'no-session'],
  ];
  for (const [s, reason] of cases) {
    const { token: t } = await seedSession(env, s);
    assert.deepEqual(await S.admitSession(env, t, NOW), { ok: false, reason }, JSON.stringify(s));
  }
  assert.deepEqual(await S.admitSession(env, token(), NOW), { ok: false, reason: 'no-session' });
  seedUser(env, { uid: 1004, name: 'later', expiresAt: NOW + DAY });
  const { token: t2 } = await seedSession(env, { uid: 1004 });
  assert.equal((await S.admitSession(env, t2, NOW)).ok, true, '还没到期的临时用户有效');
});

test('root 代码级不能做栈底（非救援）；救援会话必须是 root', async () => {
  const env = identityEnv();
  seedBase(env);
  const { token: a } = await seedSession(env, { uid: 0 });
  assert.deepEqual(await S.admitSession(env, a, NOW), { ok: false, reason: 'root-bottom' });
  const { token: b } = await seedSession(env, { uid: 1000, rescue: true });
  assert.deepEqual(await S.admitSession(env, b, NOW), { ok: false, reason: 'root-bottom' });
});

test('su root 层：有效 → root（via styrigx）；过期 / epoch 不等 / root 禁用 / 压的不是 root → 弹回 styrigx，不写库', async () => {
  const env = identityEnv();
  seedBase(env);
  const s1 = await seedSession(env, { uid: 1000 });
  pushRoot(env, s1.id, { expiresAt: NOW + 1800000 });
  env.D1_ACCOUNT.statements.length = 0;
  const a = await S.admitSession(env, s1.token, NOW);
  assert.deepEqual(a.identity, { uid: 0, name: 'root', groups: [], rescue: false });
  assert.deepEqual(a.via, { uid: 1000, name: 'styrigx' });
  assert.equal(a.layerExpiresAt, NOW + 1800000);
  assert.equal(env.D1_ACCOUNT.statements.length, 1);

  const s2 = await seedSession(env, { uid: 1000 });
  pushRoot(env, s2.id, { expiresAt: NOW });
  const s3 = await seedSession(env, { uid: 1000 });
  pushRoot(env, s3.id, { epoch: 5 });
  const s4 = await seedSession(env, { uid: 1000 });
  pushRoot(env, s4.id, { uid: 1000 });
  for (const s of [s2, s3, s4]) {
    const r = await S.admitSession(env, s.token, NOW);
    assert.equal(r.ok, true);
    assert.equal(r.identity.uid, 1000, '弹回栈底');
    assert.equal(r.via, null);
  }
  env.D1_ACCOUNT.raw.exec('UPDATE account_users SET disabled = 1 WHERE uid = 0');
  assert.equal((await S.admitSession(env, s1.token, NOW)).identity.uid, 1000, 'root 禁用 → 弹回');
  assert.deepEqual(writes(env), []);
});

test('救援会话：root、rescue、没有 via、不续期', async () => {
  const env = identityEnv();
  seedBase(env);
  const { token: t } = await seedSession(env, { uid: 0, rescue: true, createdAt: NOW - 60000, expiresAt: NOW + 840000 });
  const a = await S.admitSession(env, t, NOW);
  assert.deepEqual(a.identity, { uid: 0, name: 'root', groups: [], rescue: true });
  assert.equal(a.via, null);
  assert.equal(a.renew, false);
});

test('renew 标志：剩余不到一半且一天内没续过才是 true（admit 本身不写）', async () => {
  const env = identityEnv();
  seedBase(env);
  const fresh = await seedSession(env, { uid: 1000, createdAt: NOW - DAY, expiresAt: NOW + 29 * DAY });
  const old = await seedSession(env, { uid: 1000, createdAt: NOW - 20 * DAY, expiresAt: NOW + 10 * DAY });
  const justRenewed = await seedSession(env, { uid: 1000, createdAt: NOW - 20 * DAY, expiresAt: NOW + 10 * DAY, renewedAt: NOW - 3600000 });
  assert.equal((await S.admitSession(env, fresh.token, NOW)).renew, false);
  assert.equal((await S.admitSession(env, old.token, NOW)).renew, true);
  assert.equal((await S.admitSession(env, justRenewed.token, NOW)).renew, false);
  assert.deepEqual(writes(env), []);
});

test('组：只回认识的组（库里混进的未知组丢掉），排序', async () => {
  const env = identityEnv();
  seedUser(env, { uid: 1001, name: 'alice', groups: ['status', 'listen', 'admin'] });
  const { token: t } = await seedSession(env, { uid: 1001 });
  assert.deepEqual((await S.admitSession(env, t, NOW)).identity.groups, ['listen', 'status']);
});

test('admitRequest：从 Cookie 取 sgx-session；没有 → no-cookie（不查库）；读库出错 → error（fail closed）', async () => {
  const env = identityEnv();
  seedBase(env);
  const { token: t } = await seedSession(env, { uid: 1000 });
  assert.equal((await S.admitRequest(env, reqWithToken(t), NOW)).identity.uid, 1000);
  env.D1_ACCOUNT.statements.length = 0;
  assert.deepEqual(await S.admitRequest(env, reqWithToken(''), NOW), { ok: false, reason: 'no-cookie' });
  assert.equal(env.D1_ACCOUNT.statements.length, 0);
  const broken = { D1_ACCOUNT: { prepare() { throw new Error('boom'); } } };
  assert.deepEqual(await S.admitSession(broken, t, NOW), { ok: false, reason: 'error' });
  assert.deepEqual(await S.admitSession({}, t, NOW), { ok: false, reason: 'error' });
});
