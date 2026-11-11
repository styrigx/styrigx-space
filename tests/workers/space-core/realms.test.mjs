/**
 * 凭证域配置（src/core/realms.js）钉死测试。v6 P4（定稿 v5.2 §十三）起进站签发删除：
 * 三张锁屏票、签名钥匙对 SGX_SPACE_PRIVATE / PUBLIC、旧恢复钥匙 SGX_SPACE_RECOVERY_KEY、旧 pepper SGX_SPACE_PASSWORD_PEPPER、
 * 进站 cookie sgx-space-session、锁屏凭证（解锁密码 / 锁屏通行密钥）都从网关删掉；剩下的只有 realm='lock' 行标签和它的 D1 绑定。
 *
 * 运行：node --test tests/workers/space-core/realms.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import * as R from '../../../workers/space-core/src/core/realms.js';

const { REALMS, REALM_LOCK } = R;
const REPO = new URL('../../../', import.meta.url).pathname;

test('realms：只剩 REALM_LOCK = { id: lock, d1Binding: D1_SPACE }；冻结', () => {
  assert.deepEqual(Object.keys(R).sort(), ['REALMS', 'REALM_LOCK']);
  assert.deepEqual({ ...REALM_LOCK }, { id: 'lock', d1Binding: 'D1_SPACE' });
  assert.deepEqual(Object.keys(REALMS), ['lock']);
  assert.ok(Object.isFrozen(REALM_LOCK) && Object.isFrozen(REALMS));
  assert.ok(!JSON.stringify(REALM_LOCK).includes('KV_'));
  assert.ok(!JSON.stringify(REALM_LOCK).includes('ACCOUNT'));
});

test('realms：进站签发删除——没有票、cookie、钥匙名、pepper；相关模块文件都删了', () => {
  for (const k of ['TICKETS', 'LOCK_EPOCH', 'BY_LINK', 'realmCookie', 'realmClearCookie', 'realmPrivateKey', 'realmPublicKey', 'rpConfig', 'rpConfigMissing',
    'KEY_SPACE_PASSWORD', 'KEY_SPACE_PASSKEY', 'KEY_SPACE_RECOVERY_KEY', 'LOCK_SESSION_COOKIE', 'LOCK_REAUTH_TICKET', 'LOCK_RESET_TICKET']) {
    assert.equal(k in R, false, k);
  }
  for (const f of ['secrets.js', 'core/lock-session.js', 'core/tickets.js', 'core/password.js', 'core/passkey-verify.js', 'core/passkey-store.js', 'core/space-check.js',
    'core/share-links.js', 'core/share-open.js', 'api/space-auth.js', 'api/share.js', 'api/lock-password.js', 'api/lock-passkey.js', 'api/lock-reset.js', 'api/lock-reauth.js']) {
    assert.equal(existsSync(REPO + 'workers/space-core/src/' + f), false, f);
  }
});

test('realms：wrangler.toml 不绑任何 SGX_* 私密值（SGX_SPACE_* 四个随进站签发删除）；账号钥匙、旧 SGX_ROOT_KEY、旧 SGX_LOCK_* 都不绑', () => {
  const toml = readFileSync(REPO + 'workers/space-core/wrangler.toml', 'utf8').split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  assert.deepEqual([...toml.matchAll(/^binding = "(SGX_[A-Z_]+)"$/gm)].map((m) => m[1]), []);
  for (const n of ['SGX_SPACE_', 'SGX_ACCOUNT_', 'SGX_ROOT_KEY', 'SGX_STEPUP_PRIVATE', 'SGX_APP_PRIVATE', 'SGX_LOCK_', 'SGX_PW_PEPPER']) {
    assert.ok(!toml.includes(n), n);
  }
});
