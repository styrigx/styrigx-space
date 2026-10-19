/**
 * 凭证域配置（_kernel/realms.js）钉死测试：重构只换了取值位置，线上格式一个字都不能变。
 *
 * 覆盖：
 * - 各凭证域的 cookie 名 / 属性 / 有效期、KV 键名与重构前字面量逐字相同
 * - 旧导出名（SESSION_COOKIE、STEPUP_COOKIE、APP_COOKIE_ATTRS…）仍等于原值
 * - 每个钥匙名都按 SGX_<PURPOSE>_PRIVATE/PUBLIC 规范，且都在 src/secrets.js 的
 *   SECRET_NAMES 与 wrangler.toml 的 Secrets Store 绑定里（少一个 → 线上读不到 → fail closed）
 * - realmCookie / realmClearCookie 拼出的 Set-Cookie 与原手拼字符串相同
 * - rpConfigMissing 仍是 503 config
 * - 密码哈希搬到 _kernel/password.js 后：lock / owner 各读自己的 KV 键，旧导出仍可用
 *
 * 运行：node --test tests/workers/auth-gateway/realms.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  REALMS,
  REALM_LOCK,
  REALM_STEPUP,
  REALM_APP,
  REALM_OWNER,
  REALM_ROOT,
  SESSION_EPOCH_KEY,
  realmPrivateKey,
  realmPublicKey,
  realmCookie,
  realmClearCookie,
  rpConfig,
  rpConfigMissing,
} from '../../../workers/auth-gateway/functions/_kernel/realms.js';
import { SECRET_NAMES } from '../../../workers/auth-gateway/src/secrets.js';

const REPO = new URL('../../../', import.meta.url).pathname;

function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get: async (k, fmt) => {
      const v = m.has(k) ? m.get(k) : null;
      if (v === null) return null;
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    _map: m,
  };
}

test('realms：线上格式与重构前字面量逐字相同', () => {
  assert.equal(REALM_LOCK.cookie, 'sgx-verified');
  assert.equal(REALM_LOCK.cookieAttrs, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax');
  assert.equal(REALM_LOCK.maxAge, 43200);
  assert.equal(REALM_LOCK.kv.password, 'lock-pw');
  assert.equal(REALM_LOCK.privateKey, 'SGX_LOCK_PRIVATE');
  assert.equal(REALM_LOCK.publicKey, 'SGX_LOCK_PUBLIC');

  assert.equal(REALM_STEPUP.cookie, 'sgx-stepup');
  assert.equal(REALM_STEPUP.cookieAttrs, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict');
  assert.equal(REALM_STEPUP.maxAge, 180);
  assert.equal(REALM_STEPUP.kv.challengePrefix, 'stepup-challenge:');
  assert.equal(REALM_STEPUP.kv.challengeTtl, 300);
  assert.equal(REALM_STEPUP.kv.lockresetChallengePrefix, 'lockreset-challenge:');
  assert.equal(REALM_STEPUP.privateKey, 'SGX_STEPUP_PRIVATE');
  assert.equal(REALM_STEPUP.publicKey, 'SGX_STEPUP_PUBLIC');

  assert.equal(REALM_APP.cookie, 'sgx-app');
  assert.equal(REALM_APP.cookieAttrs, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax');
  assert.equal(REALM_APP.maxAge, 600);
  assert.equal(REALM_APP.kv.epochPrefix, 'app-epoch:');
  assert.equal(REALM_APP.privateKey, 'SGX_APP_PRIVATE');
  assert.equal(REALM_APP.publicKey, 'SGX_APP_PUBLIC');

  assert.equal(REALM_OWNER.kv.password, 'owner-pw');
  assert.equal(REALM_OWNER.kv.passkeyPrefix, 'owner-passkey:');
  assert.equal(REALM_OWNER.kv.challengePrefix, 'pk-challenge:');
  assert.equal(REALM_OWNER.pepper, 'SGX_PW_PEPPER');
  assert.equal(REALM_LOCK.pepper, 'SGX_PW_PEPPER');

  assert.equal(REALM_ROOT.secret, 'SGX_ROOT_KEY');
  assert.equal(SESSION_EPOCH_KEY, 'session-epoch');
});

test('realms：旧导出名仍等于原值（调用方不变）', async () => {
  const session = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
  assert.equal(session.SESSION_COOKIE, 'sgx-verified');
  assert.equal(session.COOKIE_ATTRS, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax');
  assert.equal(session.SESSION_MAX_AGE, 43200);
  const stepup = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  assert.equal(stepup.STEPUP_COOKIE, 'sgx-stepup');
  assert.equal(stepup.STEPUP_MAX_AGE, 180);
  assert.equal(stepup.STEPUP_COOKIE_ATTRS, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict');
  const app = await import('../../../workers/auth-gateway/functions/api/app-token.js');
  assert.equal(app.APP_COOKIE, 'sgx-app');
  assert.equal(app.APP_TOKEN_MAX_AGE, 600);
  assert.equal(app.APP_COOKIE_ATTRS, 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600');
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
    realmCookie(REALM_STEPUP, 'v1'),
    'sgx-stepup=v1; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=180'
  );
  assert.equal(
    realmCookie(REALM_LOCK, 'v2', 3600),
    'sgx-verified=v2; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600'
  );
  assert.equal(
    realmClearCookie(REALM_STEPUP),
    'sgx-stepup=; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  );
  assert.equal(
    realmClearCookie(REALM_APP),
    'sgx-app=; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  );
  assert.equal(
    realmClearCookie(REALM_LOCK),
    'sgx-verified=; Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  );
});

test('realms：读钥匙缺失一律返回空串（fail closed）', () => {
  assert.equal(realmPrivateKey(undefined, REALM_LOCK), '');
  assert.equal(realmPublicKey({}, REALM_STEPUP), '');
  assert.equal(realmPrivateKey({ SGX_APP_PRIVATE: 'x' }, REALM_APP), 'x');
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

test('password：lock / owner 各读自己的 KV 键；旧导出（owner-password.js）仍可用', async () => {
  const pw = await import('../../../workers/auth-gateway/functions/_kernel/password.js');
  const legacy = await import('../../../workers/auth-gateway/functions/api/owner-password.js');
  assert.equal(legacy.getPepper, pw.getPepper);
  assert.equal(legacy.makePasswordRecord, pw.makePasswordRecord);
  assert.equal(pw.getPepper({ SGX_PW_PEPPER: 'pep' }), 'pep');
  assert.equal(pw.getPepper(undefined), '');
  const rec = await pw.makePasswordRecord('owner-secret-1', 'pep');
  assert.equal(rec.peppered, true);
  assert.equal(rec.iterations, 100000);
  const kv = makeKV({ 'owner-pw': JSON.stringify(rec) });
  assert.deepEqual(await pw.verifyRealmPassword(kv, REALM_OWNER, 'pep', 'owner-secret-1'), { ok: true, set: true, needsRehash: false });
  assert.deepEqual(await pw.verifyRealmPassword(kv, REALM_OWNER, 'pep', 'wrong-pass'), { ok: false, set: true, needsRehash: false });
  /* lock 读 lock-pw：未设置 */
  assert.deepEqual(await pw.verifyRealmPassword(kv, REALM_LOCK, 'pep', 'owner-secret-1'), { ok: false, set: false, needsRehash: false });
  assert.deepEqual(await legacy.verifyOwnerPassword(kv, 'pep', 'owner-secret-1'), { ok: true, set: true, needsRehash: false });
});
