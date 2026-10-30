/**
 * 凭证域配置（_kernel/realms.js）钉死测试：账号拆分 PR3 起网关只有锁屏一个域，线上格式一个字都不能变。
 *
 * 覆盖：
 * - REALM_LOCK 的 cookie 名 / 属性 / 有效期 / 钥匙名 / D1 绑定钉死；锁屏根密钥并入 REALM_LOCK（rootKey = SGX_ADMIN_KEY、rootIssues = 两张锁屏短票）
 * - 账号域 REALM_ACCOUNT、根域 REALM_ROOT、BY_ACCOUNT、账号三张票从网关删掉（它们只在账号 Worker）
 * - 三张锁屏票总表；LockResetTicket 的 by = root / password / passkey（方案第 7 节）
 * - 每个钥匙名都在 src/secrets.js 的 SECRET_NAMES 与 wrangler.toml 的 Secrets Store 绑定里；网关只剩 4 个（方案 10.1）
 * - realmCookie / realmClearCookie 拼出的 Set-Cookie 与原手拼字符串相同；rpConfigMissing 仍是 503 config
 * - 密码：锁屏读 D1 password 表 realm='lock' 那一行；库里遗留的 realm='account' 行网关读不到
 *
 * 运行：node --test tests/workers/auth-gateway/realms.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as R from '../../../workers/auth-gateway/functions/_kernel/realms.js';
import { SECRET_NAMES } from '../../../workers/auth-gateway/src/secrets.js';
import { withAuthD1 } from '../_harness.mjs';

const { REALMS, REALM_LOCK, LOCK_EPOCH, realmPrivateKey, realmPublicKey, realmCookie, realmClearCookie, rpConfig, rpConfigMissing } = R;
const REPO = new URL('../../../', import.meta.url).pathname;

test('realms：REALM_LOCK 线上格式逐字相同；锁屏根密钥 rootKey = SGX_ADMIN_KEY（方案 6.2）', () => {
  assert.equal(REALM_LOCK.id, 'lock');
  assert.equal(REALM_LOCK.keyName, 'LockKey');
  assert.equal(REALM_LOCK.cookie, 'sgx-lock-session');
  assert.equal(REALM_LOCK.cookieAttrs, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax');
  assert.equal(REALM_LOCK.maxAge, 43200);
  assert.equal(REALM_LOCK.privateKey, 'SGX_LOCK_PRIVATE');
  assert.equal(REALM_LOCK.publicKey, 'SGX_LOCK_PUBLIC');
  assert.equal(REALM_LOCK.pepper, 'SGX_PW_PEPPER', 'pepper 与账号 Worker 共用（Sloan 2026-10-30 定，不拆）');
  assert.equal(REALM_LOCK.rootKey, 'SGX_ADMIN_KEY');
  assert.deepEqual([...REALM_LOCK.rootIssues], ['LockReauthTicket', 'LockResetTicket']);
  assert.equal(LOCK_EPOCH, 'lock-epoch');
  assert.equal(REALM_LOCK.epoch, 'lock-epoch');
  assert.ok(Object.isFrozen(REALM_LOCK) && Object.isFrozen(REALM_LOCK.rootIssues) && Object.isFrozen(REALM_LOCK.challenge));
});

test('realms：只经 D1_LOCK_AUTH；不再有账号域 / 根域；没有任何 KV 键名 / KV 绑定', () => {
  assert.equal(REALM_LOCK.d1Binding, 'D1_LOCK_AUTH');
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
  const session = await import('../../../workers/auth-gateway/functions/_kernel/lock-session.js');
  assert.equal(session.LOCK_SESSION_COOKIE, 'sgx-lock-session');
  assert.equal(session.LOCK_SESSION_COOKIE_ATTRS, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax');
  assert.equal(session.LOCK_SESSION_MAX_AGE, 43200);
  const T = R.TICKETS;
  const want = {
    LockSessionTicket: ['sgx-lock-session', 43200, ['password', 'passkey', 'tempkey']],
    LockResetTicket: ['sgx-lock-reset', 180, ['root', 'password', 'passkey']],
    LockReauthTicket: ['sgx-lock-reauth', 180, ['password', 'passkey', 'root']],
  };
  assert.deepEqual(Object.keys(T).sort(), Object.keys(want).sort());
  for (const [name, [cookie, maxAge, bys]] of Object.entries(want)) {
    assert.equal(T[name].cookie, cookie, name);
    assert.equal(T[name].privateKey, 'SGX_LOCK_PRIVATE', name);
    assert.equal(T[name].publicKey, 'SGX_LOCK_PUBLIC', name);
    assert.equal(T[name].maxAge, maxAge, name);
    assert.deepEqual([...T[name].bys], bys, name);
    assert.equal(REALMS[T[name].realm].epoch, 'lock-epoch', name);
  }
  assert.ok(T.LockSessionTicket.cookieAttrs.includes('Domain=.styrigx.com') && T.LockSessionTicket.cookieAttrs.includes('SameSite=Lax'));
  for (const n of ['LockResetTicket', 'LockReauthTicket']) assert.equal(T[n].cookieAttrs, 'Path=/; HttpOnly; Secure; SameSite=Strict', n);
  assert.equal(R.ROLE_ADMIN, 'admin');
  assert.equal(R.ROLE_VISITOR, 'visitor');
});

test('realms：网关 Secrets Store 只剩 4 个（SGX_LOCK_PRIVATE / SGX_LOCK_PUBLIC / SGX_ADMIN_KEY / SGX_PW_PEPPER）；账号钥匙、旧 SGX_ROOT_KEY 都不绑', () => {
  assert.deepEqual([...SECRET_NAMES].sort(), ['SGX_ADMIN_KEY', 'SGX_LOCK_PRIVATE', 'SGX_LOCK_PUBLIC', 'SGX_PW_PEPPER']);
  const toml = readFileSync(REPO + 'workers/auth-gateway/wrangler.toml', 'utf8').split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  assert.deepEqual([...toml.matchAll(/^binding = "(SGX_[A-Z_]+)"$/gm)].map((m) => m[1]).sort(), [...SECRET_NAMES].sort());
  for (const n of ['SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC', 'SGX_ACCOUNT_ROOT_KEY', 'SGX_ROOT_KEY', 'SGX_STEPUP_PRIVATE', 'SGX_APP_PRIVATE']) {
    assert.ok(!toml.includes(n), n);
  }
});

test('realms：钥匙名符合 SGX_<PURPOSE>_PRIVATE/PUBLIC，且都在 SECRET_NAMES 与 wrangler.toml 里', () => {
  const toml = readFileSync(REPO + 'workers/auth-gateway/wrangler.toml', 'utf8');
  for (const n of [REALM_LOCK.privateKey, REALM_LOCK.publicKey, REALM_LOCK.rootKey, REALM_LOCK.pepper]) {
    assert.ok(SECRET_NAMES.includes(n), n + ' 应在 src/secrets.js 的 SECRET_NAMES 里');
    assert.ok(toml.includes('binding = "' + n + '"'), n + ' 应在 wrangler.toml 的 Secrets Store 绑定里');
  }
  assert.match(REALM_LOCK.privateKey, /^SGX_[A-Z]+_PRIVATE$/);
  assert.match(REALM_LOCK.publicKey, /^SGX_[A-Z]+_PUBLIC$/);
});

test('realms：realmCookie / realmClearCookie 与原手拼字符串相同', () => {
  assert.equal(realmCookie(REALM_LOCK, 'v2', 3600), 'sgx-lock-session=v2; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600');
  assert.equal(realmCookie(R.TICKETS.LockResetTicket, 'v3'), 'sgx-lock-reset=v3; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=180');
  assert.equal(realmClearCookie(REALM_LOCK), 'sgx-lock-session=; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
});

test('realms：读钥匙缺失一律返回空串（fail closed）', () => {
  assert.equal(realmPrivateKey(undefined, REALM_LOCK), '');
  assert.equal(realmPublicKey({}, REALM_LOCK), '');
  assert.equal(realmPrivateKey({ SGX_LOCK_PRIVATE: 'x' }, REALM_LOCK), 'x');
  assert.equal(realmPublicKey({ SGX_LOCK_PUBLIC: 'y' }, REALM_LOCK), 'y');
});

test('realms：rpConfig 缺变量 → null；rpConfigMissing 仍是 503 config', async () => {
  assert.equal(rpConfig({}), null);
  assert.equal(rpConfig({ SGX_RP_ID: 'styrigx.com' }), null);
  assert.deepEqual(rpConfig({ SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: 'https://styrigx.com' }), { rpId: 'styrigx.com', origin: 'https://styrigx.com' });
  const r = rpConfigMissing();
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, error: 'config', message: 'SGX_RP_ID / SGX_ORIGIN 未配置' });
});

test('password：锁屏读 D1 password 表 realm=lock 那一行；库里遗留的账号行网关读不到（d1-state 只认 lock 域）', async () => {
  const pw = await import('../../../workers/auth-gateway/functions/_kernel/lib/password.js');
  const d1 = await import('../../../workers/auth-gateway/functions/_kernel/d1-state.js');
  assert.equal(pw.getPepper({ SGX_PW_PEPPER: 'pep' }), 'pep');
  assert.equal(pw.getPepper(undefined), '');
  const rec = await pw.makePasswordRecord('lock-secret-1', 'pep');
  assert.equal(rec.peppered, true);
  assert.equal(rec.iterations, 100000);
  const env = withAuthD1({});
  env.D1_LOCK_AUTH.putPassword('account', await pw.makePasswordRecord('account-secret-1', 'pep'));
  assert.deepEqual(await pw.verifyRealmPassword(env, REALM_LOCK, 'pep', 'account-secret-1'), { ok: false, set: false, needsRehash: false }, '账号行不当锁屏密码');
  env.D1_LOCK_AUTH.putPassword('lock', rec);
  assert.deepEqual(await pw.verifyRealmPassword(env, REALM_LOCK, 'pep', 'lock-secret-1'), { ok: true, set: true, needsRehash: false });
  for (const bad of ['account', 'root', { id: 'account', d1Binding: 'D1_LOCK_AUTH' }]) assert.throws(() => d1.realmOf(bad), /bad realm/);
});
