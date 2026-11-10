/**
 * 凭证域配置（src/core/realms.js）钉死测试：账号拆分 PR3 起网关只有锁屏一个域，线上格式一个字都不能变。
 *
 * 覆盖：
 * - REALM_LOCK 的 cookie 名 / 属性 / 有效期 / 钥匙名 / D1 绑定钉死；进站凭证并入 REALM_LOCK（spaceKey = SGX_SPACE_RECOVERY_KEY、spaceIssues = 两张锁屏短票）
 * - 账号域 REALM_ACCOUNT、根域 REALM_ROOT、BY_ACCOUNT、账号三张票从网关删掉（它们只在账号 Worker）
 * - 三张锁屏票总表；LockResetTicket 的 by = root / password / passkey（方案第 7 节）
 * - 每个钥匙名都在 src/secrets.js 的 SECRET_NAMES 与 wrangler.toml 的 Secrets Store 绑定里；网关只剩 4 个（方案 10.1）
 * - realmCookie / realmClearCookie 拼出的 Set-Cookie 与原手拼字符串相同；rpConfigMissing 仍是 503 config
 * - 密码：锁屏读 D1 password 表 realm='lock' 那一行；库里遗留的 realm='account' 行网关读不到
 *
 * 运行：node --test tests/workers/space-core/realms.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as R from '../../../workers/space-core/src/core/realms.js';
import { SECRET_NAMES } from '../../../workers/space-core/src/secrets.js';
import { withAuthD1 } from '../_harness.mjs';

const { REALMS, REALM_LOCK, LOCK_EPOCH, realmPrivateKey, realmPublicKey, realmCookie, realmClearCookie, rpConfig, rpConfigMissing } = R;
const REPO = new URL('../../../', import.meta.url).pathname;

test('realms：REALM_LOCK 线上格式逐字相同；进站凭证 spaceKey = SGX_SPACE_RECOVERY_KEY（方案 6.2）', () => {
  assert.equal(REALM_LOCK.id, 'lock');
  assert.equal(REALM_LOCK.keyName, 'SpacePasskey', '进站 v3 Q6：WebAuthn user.name（已注册的通行密钥照旧显示 LockKey）');
  assert.equal(REALM_LOCK.cookie, 'sgx-space-session');
  assert.equal(REALM_LOCK.cookieAttrs, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax');
  assert.equal(REALM_LOCK.maxAge, 43200);
  assert.equal(REALM_LOCK.privateKey, 'SGX_SPACE_PRIVATE');
  assert.equal(REALM_LOCK.publicKey, 'SGX_SPACE_PUBLIC');
  assert.equal(REALM_LOCK.pepper, 'SGX_SPACE_PASSWORD_PEPPER', '解锁密码 pepper（进站 v3 L2：新值，和账号的分开）');
  assert.equal(REALM_LOCK.tempkeyPepper, undefined, 'v5 S1：临时钥匙删除，REALM_LOCK 不再指向临时钥匙 pepper（绑定留到收尾 PR）');
  assert.equal(R.BY_LINK, 'link');
  assert.equal(R.BY_TEMPKEY, undefined, 'v5 S1：by=tempkey 删除');
  assert.deepEqual([R.KEY_SPACE_PASSWORD, R.KEY_SPACE_PASSKEY, R.KEY_SPACE_RECOVERY_KEY], ['SpacePassword', 'SpacePasskey', 'SpaceRecoveryKey']);
  assert.equal(R.KEY_LOCK, undefined);
  assert.equal(R.KEY_SPACE, undefined);
  assert.equal(REALM_LOCK.spaceKey, 'SGX_SPACE_RECOVERY_KEY');
  assert.deepEqual([...REALM_LOCK.spaceIssues], ['LockReauthTicket', 'LockResetTicket']);
  assert.equal(LOCK_EPOCH, 'lock-epoch');
  assert.equal(REALM_LOCK.epoch, 'lock-epoch');
  assert.ok(Object.isFrozen(REALM_LOCK) && Object.isFrozen(REALM_LOCK.spaceIssues) && Object.isFrozen(REALM_LOCK.challenge));
});

test('realms：只经 D1_SPACE；不再有账号域 / 根域；没有任何 KV 键名 / KV 绑定', () => {
  assert.equal(REALM_LOCK.d1Binding, 'D1_SPACE');
  assert.deepEqual(Object.keys(REALMS), ['lock']);
  assert.deepEqual({ ...REALM_LOCK.challenge }, { register: 'register', auth: 'auth', reset: 'reset', ttl: 300 });
  for (const k of ['kv', 'legacyKv', 'kvBinding']) assert.equal(REALM_LOCK[k], undefined, k);
  assert.ok(!JSON.stringify(REALM_LOCK).includes('KV_'));
  for (const k of ['REALM_ACCOUNT', 'REALM_ROOT', 'BY_ACCOUNT', 'KEY_ACCOUNT', 'ACCOUNT_EPOCH', 'ACCOUNT_SESSION_COOKIE', 'ACCOUNT_RESET_COOKIE',
    'ACCOUNT_REAUTH_COOKIE', 'ACCOUNT_SESSION_TICKET', 'ACCOUNT_RESET_TICKET', 'ACCOUNT_REAUTH_TICKET']) {
    assert.equal(k in R, false, k + ' 只在账号 Worker');
  }
  assert.ok(!JSON.stringify(REALM_LOCK).includes('ACCOUNT'));
});

test('realms：三张锁屏票总表（cookie / 钥匙 / 时长 / 属性 / by / 纪元），session 文件导出同一份值', async () => {
  const session = await import('../../../workers/space-core/src/core/lock-session.js');
  assert.equal(session.LOCK_SESSION_COOKIE, 'sgx-space-session');
  assert.equal(session.LOCK_SESSION_COOKIE_ATTRS, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax');
  assert.equal(session.LOCK_SESSION_MAX_AGE, 43200);
  const T = R.TICKETS;
  const want = {
    LockSessionTicket: ['sgx-space-session', 43200, ['password', 'passkey', 'link']],
    LockResetTicket: ['sgx-space-reset', 180, ['space', 'password', 'passkey']],
    LockReauthTicket: ['sgx-space-reauth', 180, ['password', 'passkey', 'space']],
  };
  assert.deepEqual(Object.keys(T).sort(), Object.keys(want).sort());
  for (const [name, [cookie, maxAge, bys]] of Object.entries(want)) {
    assert.equal(T[name].cookie, cookie, name);
    assert.equal(T[name].privateKey, 'SGX_SPACE_PRIVATE', name);
    assert.equal(T[name].publicKey, 'SGX_SPACE_PUBLIC', name);
    assert.equal(T[name].maxAge, maxAge, name);
    assert.deepEqual([...T[name].bys], bys, name);
    assert.equal(REALMS[T[name].realm].epoch, 'lock-epoch', name);
  }
  assert.ok(T.LockSessionTicket.cookieAttrs.includes('Domain=.styrigx.com') && T.LockSessionTicket.cookieAttrs.includes('SameSite=Lax'));
  for (const n of ['LockResetTicket', 'LockReauthTicket']) assert.equal(T[n].cookieAttrs, 'Path=/; HttpOnly; Secure; SameSite=Strict', n);
  assert.deepEqual(Object.keys(R).filter((k) => k.startsWith('ROLE_')), [], '进门二值：没有等级常量');
});

test('realms：Secrets Store 5 个 SGX_SPACE_*（进站 v3 Q18：PRIVATE / PUBLIC / RECOVERY_KEY / PASSWORD_PEPPER / TEMPKEY_PEPPER）；账号钥匙、旧 SGX_ROOT_KEY、旧 SGX_LOCK_* 都不绑', () => {
  assert.deepEqual([...SECRET_NAMES].sort(), ['SGX_SPACE_PASSWORD_PEPPER', 'SGX_SPACE_PRIVATE', 'SGX_SPACE_PUBLIC', 'SGX_SPACE_RECOVERY_KEY', 'SGX_SPACE_TEMPKEY_PEPPER']);
  const toml = readFileSync(REPO + 'workers/space-core/wrangler.toml', 'utf8').split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  assert.deepEqual([...toml.matchAll(/^binding = "(SGX_[A-Z_]+)"$/gm)].map((m) => m[1]).sort(), [...SECRET_NAMES].sort());
  for (const n of ['SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC', 'SGX_ACCOUNT_ROOT_KEY', 'SGX_ROOT_KEY', 'SGX_STEPUP_PRIVATE', 'SGX_APP_PRIVATE', 'SGX_LOCK_', 'SGX_PW_PEPPER']) {
    assert.ok(!toml.includes(n), n);
  }
});

test('realms：钥匙名符合 SGX_<PURPOSE>_PRIVATE/PUBLIC，且都在 SECRET_NAMES 与 wrangler.toml 里', () => {
  const toml = readFileSync(REPO + 'workers/space-core/wrangler.toml', 'utf8');
  for (const n of [REALM_LOCK.privateKey, REALM_LOCK.publicKey, REALM_LOCK.spaceKey, REALM_LOCK.pepper]) {
    assert.ok(SECRET_NAMES.includes(n), n + ' 应在 src/secrets.js 的 SECRET_NAMES 里');
    assert.ok(toml.includes('binding = "' + n + '"'), n + ' 应在 wrangler.toml 的 Secrets Store 绑定里');
  }
  assert.match(REALM_LOCK.privateKey, /^SGX_[A-Z]+_PRIVATE$/);
  assert.match(REALM_LOCK.publicKey, /^SGX_[A-Z]+_PUBLIC$/);
});

test('realms：realmCookie / realmClearCookie 与原手拼字符串相同', () => {
  assert.equal(realmCookie(REALM_LOCK, 'v2', 3600), 'sgx-space-session=v2; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600');
  assert.equal(realmCookie(R.TICKETS.LockResetTicket, 'v3'), 'sgx-space-reset=v3; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=180');
  assert.equal(realmClearCookie(REALM_LOCK), 'sgx-space-session=; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
});

test('realms：读钥匙缺失一律返回空串（fail closed）', () => {
  assert.equal(realmPrivateKey(undefined, REALM_LOCK), '');
  assert.equal(realmPublicKey({}, REALM_LOCK), '');
  assert.equal(realmPrivateKey({ SGX_SPACE_PRIVATE: 'x' }, REALM_LOCK), 'x');
  assert.equal(realmPublicKey({ SGX_SPACE_PUBLIC: 'y' }, REALM_LOCK), 'y');
});

test('realms：rpConfig 缺变量 → null；rpConfigMissing 仍是 503 config', async () => {
  assert.equal(rpConfig({}), null);
  assert.equal(rpConfig({ SGX_RP_ID: 'styrigx.com' }), null);
  assert.deepEqual(rpConfig({ SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: 'https://styrigx.com' }), { rpId: 'styrigx.com', origin: 'https://styrigx.com' });
  const r = rpConfigMissing();
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, error: 'config', message: 'SGX_RP_ID / SGX_ORIGIN not configured' });
});

test('password：锁屏读 D1 password 表 realm=lock 那一行；库里遗留的账号行网关读不到（d1-state 只认 lock 域）', async () => {
  const pw = await import('../../../workers/space-core/src/core/password.js');
  const d1 = await import('../../../workers/space-core/src/core/d1-state.js');
  assert.equal(pw.getPepper({ SGX_SPACE_PASSWORD_PEPPER: 'pep', SGX_SPACE_TEMPKEY_PEPPER: 'pep' }), 'pep');
  assert.equal(pw.getPepper(undefined), '');
  const rec = await pw.makePasswordRecord('lock-secret-1', 'pep');
  assert.equal(rec.peppered, true);
  assert.equal(rec.iterations, 100000);
  const env = withAuthD1({});
  env.D1_SPACE.putPassword('account', await pw.makePasswordRecord('account-secret-1', 'pep'));
  assert.deepEqual(await pw.verifyRealmPassword(env, REALM_LOCK, 'pep', 'account-secret-1'), { ok: false, set: false, needsRehash: false }, '账号行不当锁屏密码');
  env.D1_SPACE.putPassword('lock', rec);
  assert.deepEqual(await pw.verifyRealmPassword(env, REALM_LOCK, 'pep', 'lock-secret-1'), { ok: true, set: true, needsRehash: false });
  for (const bad of ['account', 'root', { id: 'account', d1Binding: 'D1_SPACE' }]) assert.throws(() => d1.realmOf(bad), /bad realm/);
});
