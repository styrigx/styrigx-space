/**
 * 凭证域配置（_kernel/realms.js）钉死测试：重构只换了取值位置，线上格式一个字都不能变。
 *
 * 覆盖：
 * - 各凭证域的 cookie 名 / 属性 / 有效期与重构前字面量逐字相同；每个域的 D1 绑定名（d1Binding）钉死，没有任何 KV 键名 / KV 绑定
 * - 旧导出名（SESSION_COOKIE…）仍等于原值
 * - 签名钥匙只剩账号、锁屏两套：stepup / app 凭证域及其钥匙名全部删除
 * - 每个钥匙名都按 SGX_<PURPOSE>_PRIVATE/PUBLIC 规范，且都在 src/secrets.js 的
 *   SECRET_NAMES 与 wrangler.toml 的 Secrets Store 绑定里（少一个 → 线上读不到 → fail closed）
 * - realmCookie / realmClearCookie 拼出的 Set-Cookie 与原手拼字符串相同
 * - rpConfigMissing 仍是 503 config
 * - 密码哈希搬到 _kernel/password.js 后：lock / account 各读 D1 password 表自己那一行
 * - 账号体系：REALM_ACCOUNT（sgx-account、SGX_ACCOUNT_*）与 lock 会话完全分开
 *
 * 运行：node --test tests/workers/auth-gateway/realms.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  REALMS,
  REALM_LOCK,
  REALM_ACCOUNT,
  REALM_ROOT,
  LOCK_EPOCH,
  ACCOUNT_EPOCH,
  realmPrivateKey,
  realmPublicKey,
  realmCookie,
  realmClearCookie,
  rpConfig,
  rpConfigMissing,
} from '../../../workers/auth-gateway/functions/_kernel/realms.js';
import { SECRET_NAMES } from '../../../workers/auth-gateway/src/secrets.js';
import { withAuthD1 } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;

test('realms：线上格式与重构前字面量逐字相同', () => {
  assert.equal(REALM_LOCK.cookie, 'sgx-lock-session');
  assert.equal(REALM_LOCK.cookieAttrs, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax');
  assert.equal(REALM_LOCK.maxAge, 43200);
  assert.equal(REALM_LOCK.privateKey, 'SGX_LOCK_PRIVATE');
  assert.equal(REALM_LOCK.publicKey, 'SGX_LOCK_PUBLIC');

  assert.equal(REALM_ACCOUNT.storeClass, undefined, '通行密钥记录不再有 class');
  assert.equal(REALM_ACCOUNT.pepper, 'SGX_PW_PEPPER');
  assert.equal(REALM_ACCOUNT.cookie, 'sgx-account-session');
  assert.equal(REALM_ACCOUNT.cookieAttrs, 'Path=/; HttpOnly; Secure; SameSite=Strict');
  assert.equal(REALM_ACCOUNT.maxAge, 34560000); /* 400 天：不点退出一直登录 */
  assert.equal(REALM_ACCOUNT.recent, undefined); /* 「管理凭证」近期登录窗口已随 stepup 删除 */
  assert.equal(REALM_ACCOUNT.privateKey, 'SGX_ACCOUNT_PRIVATE');
  assert.equal(REALM_ACCOUNT.publicKey, 'SGX_ACCOUNT_PUBLIC');
  assert.notEqual(REALM_ACCOUNT.cookie, REALM_LOCK.cookie);
  assert.equal(REALM_LOCK.pepper, 'SGX_PW_PEPPER');
  assert.equal(REALM_ROOT.secret, 'SGX_ROOT_KEY');
  assert.equal(LOCK_EPOCH, 'lock-epoch');
  assert.equal(ACCOUNT_EPOCH, 'account-epoch');
});

test('realms：每个凭证域只经自己的 D1 绑定（D1_<域>_AUTH，同一个库）；不再有任何 KV 键名 / KV 绑定', () => {
  assert.equal(REALM_LOCK.d1Binding, 'D1_LOCK_AUTH');
  assert.equal(REALM_ACCOUNT.d1Binding, 'D1_ACCOUNT_AUTH');
  assert.equal(REALM_ROOT.d1Binding, 'D1_ROOT_AUTH');
  assert.deepEqual(Object.values(REALMS).map((r) => r.d1Binding).sort(), ['D1_ACCOUNT_AUTH', 'D1_LOCK_AUTH', 'D1_ROOT_AUTH'], '三个域三个名字，互不共用');
  assert.equal(REALM_LOCK.epoch, 'lock-epoch');
  assert.equal(REALM_ACCOUNT.epoch, 'account-epoch');
  /* challenge 表的 purpose 与有效期 */
  assert.deepEqual({ ...REALM_LOCK.challenge }, { register: 'register', auth: 'auth', reset: 'reset', ttl: 300 });
  assert.deepEqual({ ...REALM_ACCOUNT.challenge }, { login: 'login', register: 'register', ttl: 300 });
  /* 运行时不再有 KV：没有 kv / legacyKv 键名表，也没有 kvBinding（防止有人又往 KV 写） */
  for (const r of Object.values(REALMS)) {
    for (const k of ['kv', 'legacyKv', 'kvBinding']) assert.equal(r[k], undefined, r.id + '.' + k);
    assert.ok(!JSON.stringify(r).includes('KV_'), r.id + ' 不应引用任何 KV 绑定');
  }
});

test('realms：六张票总表（cookie / 钥匙 / 时长 / 属性 / by / 纪元归哪个域），session 文件导出同一份值', async () => {
  const R = await import('../../../workers/auth-gateway/functions/_kernel/realms.js');
  const session = await import('../../../workers/auth-gateway/functions/_kernel/lock-session.js');
  assert.equal(session.LOCK_SESSION_COOKIE, 'sgx-lock-session');
  assert.equal(session.LOCK_SESSION_COOKIE_ATTRS, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax');
  assert.equal(session.LOCK_SESSION_MAX_AGE, 43200);
  const T = R.TICKETS;
  const want = {
    LockSessionTicket: ['sgx-lock-session', 'SGX_LOCK_PRIVATE', 43200, ['password', 'passkey', 'tempkey'], 'lock-epoch'],
    LockResetTicket: ['sgx-lock-reset', 'SGX_LOCK_PRIVATE', 180, ['root', 'account'], 'lock-epoch'],
    LockReauthTicket: ['sgx-lock-reauth', 'SGX_LOCK_PRIVATE', 180, ['password', 'passkey', 'root'], 'lock-epoch'],
    AccountSessionTicket: ['sgx-account-session', 'SGX_ACCOUNT_PRIVATE', 34560000, ['password', 'passkey'], 'account-epoch'],
    AccountResetTicket: ['sgx-account-reset', 'SGX_ACCOUNT_PRIVATE', 180, ['root'], 'account-epoch'],
    AccountReauthTicket: ['sgx-account-reauth', 'SGX_ACCOUNT_PRIVATE', 180, ['password', 'passkey', 'root'], 'account-epoch'],
  };
  assert.deepEqual(Object.keys(T).sort(), Object.keys(want).sort());
  for (const [name, [cookie, priv, maxAge, bys, epoch]] of Object.entries(want)) {
    assert.equal(T[name].cookie, cookie, name);
    assert.equal(T[name].privateKey, priv, name);
    assert.equal(T[name].publicKey, priv.replace('PRIVATE', 'PUBLIC'), name);
    assert.equal(T[name].maxAge, maxAge, name);
    assert.deepEqual([...T[name].bys], bys, name);
    assert.equal(R.REALMS[T[name].realm].epoch, epoch, name);
  }
  assert.ok(T.LockSessionTicket.cookieAttrs.includes('Domain=.styrigx.com') && T.LockSessionTicket.cookieAttrs.includes('SameSite=Lax'));
  assert.ok(!T.AccountSessionTicket.cookieAttrs.includes('Domain=') && T.AccountSessionTicket.cookieAttrs.includes('SameSite=Strict'));
  for (const n of ['LockResetTicket', 'LockReauthTicket', 'AccountResetTicket', 'AccountReauthTicket']) {
    assert.equal(T[n].cookieAttrs, 'Path=/; HttpOnly; Secure; SameSite=Strict', n);
  }
  assert.equal(R.ROLE_ADMIN, 'admin');
  assert.equal(R.ROLE_VISITOR, 'visitor');
  assert.deepEqual([...R.REALM_ROOT.issues].sort(), ['AccountReauthTicket', 'AccountResetTicket', 'LockReauthTicket', 'LockResetTicket']);
});

test('realms：签名钥匙只剩账号、锁屏两套（stepup / app 全删）', () => {
  assert.deepEqual(Object.keys(REALMS).sort(), ['account', 'lock', 'root']);
  for (const n of ['SGX_STEPUP_PRIVATE', 'SGX_STEPUP_PUBLIC', 'SGX_APP_PRIVATE', 'SGX_APP_PUBLIC']) {
    assert.ok(!SECRET_NAMES.includes(n), n + ' 不应再在 SECRET_NAMES 里');
  }
  const toml = readFileSync(REPO + 'workers/auth-gateway/wrangler.toml', 'utf8');
  assert.ok(!/SGX_STEPUP_|SGX_APP_/.test(toml), 'wrangler.toml 不应再绑定 SGX_STEPUP_* / SGX_APP_*');
  assert.ok(!toml.includes('app-verify'), 'wrangler.toml 不应再登记 /app-verify/');
  const pagesToml = readFileSync(REPO + 'web/wrangler.toml', 'utf8');
  assert.ok(!/SGX_STEPUP_|SGX_APP_/.test(pagesToml), 'web/wrangler.toml（Pages 预览）也不应再有 SGX_STEPUP_* / SGX_APP_*');
});

test('realms：钥匙名符合 SGX_<PURPOSE>_PRIVATE/PUBLIC，且都在 SECRET_NAMES 与 wrangler.toml 里', () => {
  const toml = readFileSync(REPO + 'workers/auth-gateway/wrangler.toml', 'utf8');
  for (const realm of Object.values(REALMS)) {
    const names = [realm.privateKey, realm.publicKey, realm.secret, realm.pepper].filter(Boolean);
    for (const n of names) {
      assert.ok(SECRET_NAMES.includes(n), realm.id + ': ' + n + ' 应在 src/secrets.js 的 SECRET_NAMES 里');
      assert.ok(toml.includes('binding = "' + n + '"'), realm.id + ': ' + n + ' 应在 wrangler.toml 的 Secrets Store 绑定里');
    }
    if (realm.privateKey) assert.match(realm.privateKey, /^SGX_[A-Z]+_PRIVATE$/);
    if (realm.publicKey) assert.match(realm.publicKey, /^SGX_[A-Z]+_PUBLIC$/);
    if (realm.privateKey && realm.publicKey) {
      assert.equal(realm.privateKey.replace(/_PRIVATE$/, ''), realm.publicKey.replace(/_PUBLIC$/, ''), realm.id + ': 公私钥 PURPOSE 应一致');
    }
  }
});

test('realms：realmCookie / realmClearCookie 与原手拼字符串相同', () => {
  assert.equal(
    realmCookie(REALM_LOCK, 'v2', 3600),
    'sgx-lock-session=v2; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600'
  );
  assert.equal(
    realmCookie(REALM_ACCOUNT, 'v3'),
    'sgx-account-session=v3; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000'
  );
  assert.equal(
    realmClearCookie(REALM_LOCK),
    'sgx-lock-session=; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  );
});

test('realms：读钥匙缺失一律返回空串（fail closed）', () => {
  assert.equal(realmPrivateKey(undefined, REALM_LOCK), '');
  assert.equal(realmPublicKey({}, REALM_ACCOUNT), '');
  assert.equal(realmPrivateKey({ SGX_ACCOUNT_PRIVATE: 'x' }, REALM_ACCOUNT), 'x');
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

test('password：lock / account 各读自己的记录（D1 password 表按域一行）', async () => {
  const pw = await import('../../../workers/auth-gateway/functions/_kernel/password.js');
  assert.equal(pw.getPepper({ SGX_PW_PEPPER: 'pep' }), 'pep');
  assert.equal(pw.getPepper(undefined), '');
  const rec = await pw.makePasswordRecord('account-secret-1', 'pep');
  assert.equal(rec.peppered, true);
  assert.equal(rec.iterations, 100000);
  const env = withAuthD1({});
  env.D1_ACCOUNT_AUTH.putPassword('account', rec);
  assert.deepEqual(await pw.verifyRealmPassword(env, REALM_ACCOUNT, 'pep', 'account-secret-1'), { ok: true, set: true, needsRehash: false });
  assert.deepEqual(await pw.verifyRealmPassword(env, REALM_ACCOUNT, 'pep', 'wrong-pass'), { ok: false, set: true, needsRehash: false });
  /* lock 读自己那一行：未设置 */
  assert.deepEqual(await pw.verifyRealmPassword(env, REALM_LOCK, 'pep', 'account-secret-1'), { ok: false, set: false, needsRehash: false });
  assert.deepEqual(env.D1_LOCK_AUTH.rows('password').map((r) => r.realm), ['account']);
});
