/**
 * 恢复密钥（core/recovery-key.js；POST /api/account/reset { action:'recovery-key', key }）：
 * - 正确 → reset 票（by = recovery-key，3 分钟），不签 session、不动纪元；审计 reset-recovery-key ok=1
 * - 只认 SGX_ACCOUNT_RECOVERY_KEY：旧 SGX_ACCOUNT_ROOT_KEY、进站凭证的值都不认
 * - 错 / 空 / 只有空白 → 401 auth（计数、审计 ok=0、对齐 200 毫秒）；两边去空白后比对
 * - 单 IP 5 次锁 15 分钟（锁定中码对也 429）；全局只减速不封锁；kind = recovery-key
 * - 配置 / D1 出错 fail closed；成功但审计写不进去 → 503，不签票
 *
 * 运行：node --test tests/workers/account/recovery-key.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { keys, makeEnv, post, accSession, pickCookie, setCookies, auditEvents, epochOf, all, one, RECOVERY_KEY, recoveryKey } from './_fixtures.mjs';

before(keys);
const rk = (env, key, ck, o) => post(env, 'reset', { action: 'recovery-key', key }, ck, o);

test('正确的恢复密钥 → reset 票（by=recovery-key，3 分钟、主站 Strict）；不签 session、不推纪元；审计 reset-recovery-key', async () => {
  const env = makeEnv();
  const r = await rk(env, RECOVERY_KEY);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(setCookies(r).map((c) => c.split('=')[0]), ['sgx-account-reset']);
  assert.match(setCookies(r)[0], /Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=180$/);
  assert.match(pickCookie(r, 'sgx-account-reset'), /^recovery-key\.0\./);
  assert.equal(epochOf(env, 'session'), 0);
  assert.equal(epochOf(env, 'reset'), 0);
  assert.deepEqual(auditEvents(env), ['reset-recovery-key']);
});

test('已有 session 也不动它（不重签、不清除）', async () => {
  const env = makeEnv();
  const r = await rk(env, RECOVERY_KEY, { 'sgx-account-session': await accSession() });
  assert.equal(pickCookie(r, 'sgx-account-session'), null);
});

test('只认 SGX_ACCOUNT_RECOVERY_KEY：旧名 SGX_ACCOUNT_ROOT_KEY 里的值、进站凭证的值都不认', async () => {
  const env = makeEnv({ SGX_ACCOUNT_ROOT_KEY: 'old-root-value', SGX_ROOT_KEY: 'space-key', SGX_SPACE_RECOVERY_KEY: 'space-key-2' });
  for (const k of ['old-root-value', 'space-key', 'space-key-2']) assert.equal((await rk(env, k)).status, 401, k);
  const noKey = makeEnv({ SGX_ACCOUNT_RECOVERY_KEY: '', SGX_ACCOUNT_ROOT_KEY: RECOVERY_KEY });
  const r = await rk(noKey, RECOVERY_KEY);
  assert.equal(r.status, 500, '只绑了旧名 = 没配置');
  assert.equal((await r.json()).error, 'config');
});

test('错的 → 401 auth（计入 kind=recovery-key 单 IP + 全局）；审计 ok=0；返回前对齐到 200 毫秒', async () => {
  const env = makeEnv();
  const t0 = Date.now();
  const r = await rk(env, 'wrong-key');
  assert.ok(Date.now() - t0 >= recoveryKey.MIN_DELAY_MS - 5);
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { ok: false, error: 'auth' });
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.deepEqual(all(env, 'SELECT kind, bucket FROM account_attempt_limit ORDER BY bucket').map((x) => x.kind + ':' + x.bucket), ['recovery-key:*', 'recovery-key:10.9.9.9']);
  assert.deepEqual(auditEvents(env), ['reset-recovery-key:fail']);
});

test('缺 key / 空串 / 只有空白 → 401 auth（也计数）；两边去空白后比对：带空格换行的正确密钥照样通过', async () => {
  const env = makeEnv({ SGX_ACCOUNT_RECOVERY_KEY: 'abcd efgh\nijkl' });
  for (const k of [undefined, '', '   \n ']) assert.equal((await rk(env, k)).status, 401, JSON.stringify(k));
  assert.equal(one(env, "SELECT count FROM account_attempt_limit WHERE bucket = '10.9.9.9'").count, 3);
  assert.equal((await rk(env, ' abcdefgh ijkl\r\n')).status, 200);
  assert.equal(recoveryKey.normalizeRecoveryKey(' a b\tc\n'), 'abc');
});

test('单 IP 连错 5 次 → 锁 15 分钟：锁定中正确密钥也 429 cooldown（照写审计）；别的 IP 不受影响；IPv6 同一 /64 共用', async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) await rk(env, 'bad-' + i);
  const r = await rk(env, RECOVERY_KEY);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'cooldown');
  assert.equal(auditEvents(env).at(-1), 'reset-recovery-key:fail');
  assert.equal((await rk(env, RECOVERY_KEY, {}, { identity: { ip: '10.2.2.2' } })).status, 200);
  const env6 = makeEnv();
  for (let i = 0; i < 5; i++) await rk(env6, 'bad', {}, { identity: { ip: '2001:db8:1:2::' + (i + 1) } });
  assert.equal((await rk(env6, RECOVERY_KEY, {}, { identity: { ip: '2001:db8:1:2::ff' } })).status, 429);
  /* 到期后放行，成功清掉本 IP 计数 */
  env.D1_ACCOUNT.raw.prepare("UPDATE account_attempt_limit SET locked_until = 1 WHERE bucket = '10.9.9.9'").run();
  assert.equal((await rk(env, RECOVERY_KEY)).status, 200);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM account_attempt_limit WHERE bucket = '10.9.9.9'").n, 0);
});

test('全局只减速不封锁：每小时真比对失败满 20 次后 recoveryKeyLimit 给 3 秒减速，不 limited', async () => {
  const env = makeEnv();
  env.D1_ACCOUNT.raw.prepare("INSERT INTO account_attempt_limit (kind, bucket, count, window_start, expires_at) VALUES ('recovery-key', '*', 20, ?, ?)").run(Date.now(), Date.now() + 3600000);
  assert.deepEqual(await recoveryKey.recoveryKeyLimit(env, '10.3.3.3'), { limited: false, delayMs: recoveryKey.RECOVERY_KEY_GLOBAL_DELAY_MS });
});

test('配置：缺恢复密钥 → 500 config；缺签名钥匙 → 503 config（先于比对，不计数、不写审计）', async () => {
  let env = makeEnv({ SGX_ACCOUNT_RECOVERY_KEY: '' });
  assert.equal((await rk(env, RECOVERY_KEY)).status, 500);
  env = makeEnv({ SGX_ACCOUNT_PRIVATE: '' });
  const r = await rk(env, RECOVERY_KEY);
  assert.equal(r.status, 503);
  assert.equal(all(env, 'SELECT * FROM account_attempt_limit').length, 0);
  assert.deepEqual(auditEvents(env), []);
});

test('限速 D1 读出错 → 503 server（不比对）；成功但审计写不进去 → 503 server，不签票（fail closed）', async () => {
  const env = makeEnv();
  env.D1_ACCOUNT.raw.exec('DROP TABLE account_attempt_limit; CREATE VIEW account_attempt_limit AS SELECT 1 AS broken');
  assert.equal((await rk(env, RECOVERY_KEY)).status, 503);
  const env2 = makeEnv();
  env2.D1_ACCOUNT.raw.exec('DROP TABLE account_audit; CREATE VIEW account_audit AS SELECT 1 AS broken');
  const r = await rk(env2, RECOVERY_KEY);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Set-Cookie'), null);
});

test('要进站会话（没有 → 401 session，不计数、不写审计）', async () => {
  const env = makeEnv();
  const r = await rk(env, RECOVERY_KEY, {}, { identity: { session: '' } });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'session');
  assert.deepEqual(auditEvents(env), []);
});
