/**
 * passkey-e2e 预览的组合入口 tests/web/e2e/preview-worker.js（账号拆分 PR3）：env 按正式绑定拆给网关 / 账号两半，
 * 网关那一半看不到账号钥匙和账号库，只拿到 ACCOUNT / ACCOUNT_VERIFIER 两个进程内的「服务绑定」。
 */
import './_cf-workers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const pw = await import('../../web/e2e/preview-worker.js');

const FULL = {
  SGX_ENV: 'preview', SGX_SITE: 'space', SGX_RP_ID: 'x.pages.dev', SGX_ORIGIN: 'https://x.pages.dev',
  SGX_LOCK_PRIVATE: 'lp', SGX_LOCK_PUBLIC: 'lu', SGX_ADMIN_KEY: 'admin', SGX_PW_PEPPER: 'pep',
  SGX_ACCOUNT_PRIVATE: 'ap', SGX_ACCOUNT_PUBLIC: 'au', SGX_ACCOUNT_ROOT_KEY: 'acct-root',
  D1_LOCK_AUTH: { d1: 'lock' }, D1_ACCOUNT_AUTH: { d1: 'account' }, ASSETS: { fetch() {} },
};

test('preview-worker：网关那一半没有任何账号钥匙 / 账号库，有 ACCOUNT / ACCOUNT_VERIFIER', () => {
  const g = pw.gatewayEnvOf(FULL, { waitUntil() {} });
  for (const k of ['SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC', 'SGX_ACCOUNT_ROOT_KEY', 'D1_ACCOUNT_AUTH']) assert.equal(g[k], undefined, k);
  for (const k of ['SGX_LOCK_PRIVATE', 'SGX_LOCK_PUBLIC', 'SGX_ADMIN_KEY', 'SGX_PW_PEPPER', 'D1_LOCK_AUTH', 'ASSETS', 'SGX_ENV']) assert.equal(g[k], FULL[k], k);
  assert.equal(typeof g.ACCOUNT.fetch, 'function');
  assert.equal(typeof g.ACCOUNT_VERIFIER.accountSession, 'function');
});

test('preview-worker：账号那一半只拿账号的绑定，没有锁屏钥匙 / 锁屏根密钥 / 锁屏库', () => {
  const a = pw.accountEnvOf(FULL);
  for (const k of ['SGX_LOCK_PRIVATE', 'SGX_LOCK_PUBLIC', 'SGX_ADMIN_KEY', 'D1_LOCK_AUTH']) assert.equal(a[k], undefined, k);
  for (const k of ['SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC', 'SGX_ACCOUNT_ROOT_KEY', 'SGX_PW_PEPPER', 'D1_ACCOUNT_AUTH', 'ASSETS']) assert.equal(a[k], FULL[k], k);
});

test('preview-worker：ACCOUNT.fetch 只认网关写的身份头；没有身份头的 /api/* → 401，响应带 X-SGX-Runtime: account', async () => {
  const g = pw.gatewayEnvOf(FULL, { waitUntil() {} });
  const r = await g.ACCOUNT.fetch(new Request('https://x.pages.dev/api/prefs'));
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
});

test('preview-worker：默认导出是 { fetch }，只交给网关（伪造的 x-styrigx-* 先被网关剥掉）', async () => {
  assert.equal(typeof pw.default.fetch, 'function');
  const env = Object.assign({}, FULL, { SGX_ENV: 'preview' });
  const r = await pw.default.fetch(new Request('https://x.pages.dev/api/prefs', { headers: { 'X-Styrigx-Lock-Role': 'admin' } }), env, { waitUntil() {} });
  /* 预览 SGX_ENV=preview 时网关不拦 /api/*：剥头后转发，账号 Worker 看不到身份头 → 401（没剥掉就会以 admin 身份进 prefs） */
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
});
