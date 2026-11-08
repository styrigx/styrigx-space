/**
 * passkey-e2e 预览的组合入口 tests/space/e2e/helpers/preview-worker.js（账号拆分 PR3）：env 按正式绑定拆给网关 / 账号两半，
 * 网关那一半看不到账号钥匙和账号库，只拿到 ACCOUNT / ACCOUNT_VERIFIER 两个进程内的「服务绑定」。
 */
import './_cf-workers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const pw = await import('../../space/e2e/helpers/preview-worker.js');

const FULL = {
  SGX_ENV: 'preview', SGX_SITE: 'space', SGX_RP_ID: 'x.pages.dev', SGX_ORIGIN: 'https://x.pages.dev',
  SGX_LOCK_PRIVATE: 'lp', SGX_LOCK_PUBLIC: 'lu', SGX_LOCK_SPACE_KEY: 'space', SGX_PW_PEPPER: 'pep',
  SGX_ACCOUNT_PRIVATE: 'ap', SGX_ACCOUNT_PUBLIC: 'au', SGX_ACCOUNT_RECOVERY_KEY: 'acct-recovery', SGX_ACCOUNT_PASSWORD_PEPPER: 'acct-pep',
  D1_LOCK_AUTH: { d1: 'lock' }, D1_ACCOUNT: { d1: 'account' }, ASSETS: { fetch() {} },
};

test('preview-worker：网关那一半没有任何账号钥匙 / 账号库，有 ACCOUNT / ACCOUNT_VERIFIER', () => {
  const g = pw.gatewayEnvOf(FULL, { waitUntil() {} });
  for (const k of ['SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC', 'SGX_ACCOUNT_RECOVERY_KEY', 'SGX_ACCOUNT_PASSWORD_PEPPER', 'D1_ACCOUNT']) assert.equal(g[k], undefined, k);
  for (const k of ['SGX_LOCK_PRIVATE', 'SGX_LOCK_PUBLIC', 'SGX_LOCK_SPACE_KEY', 'SGX_PW_PEPPER', 'D1_LOCK_AUTH', 'ASSETS', 'SGX_ENV']) assert.equal(g[k], FULL[k], k);
  assert.equal(typeof g.ACCOUNT.fetch, 'function');
  assert.equal(g.ACCOUNT_VERIFIER.session, undefined, '命名 v2：session() 删了');
  assert.equal(typeof g.ACCOUNT_VERIFIER.authorize, 'function', 'P2-2：网关 api/search.js、api/chat.js 要问 authorize');
});

test('preview-worker：账号那一半只拿账号的绑定，没有锁屏钥匙 / 进站凭证 / 锁屏库 / 网关的 pepper', () => {
  const a = pw.accountEnvOf(FULL);
  for (const k of ['SGX_LOCK_PRIVATE', 'SGX_LOCK_PUBLIC', 'SGX_LOCK_SPACE_KEY', 'SGX_PW_PEPPER', 'D1_LOCK_AUTH']) assert.equal(a[k], undefined, k + '（网关的 pepper 账号不再用）');
  for (const k of ['SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC', 'SGX_ACCOUNT_RECOVERY_KEY', 'SGX_ACCOUNT_PASSWORD_PEPPER', 'D1_ACCOUNT', 'ASSETS']) assert.equal(a[k], FULL[k], k);
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
  const r = await pw.default.fetch(new Request('https://x.pages.dev/api/prefs', { headers: { 'X-Styrigx-Lock-Level': 'password' } }), env, { waitUntil() {} });
  /* 预览 SGX_ENV=preview 时网关不拦 /api/*：剥头后转发，账号 Worker 看不到身份头 → 401（没剥掉就会当成有进站会话进 prefs） */
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
});

test('preview-worker：AI_SERVICE 是桩（P4-1，不调真实 Workers AI）：固定 hits + 固定回答流，账号结论头决定私密来源', async () => {
  const g = pw.gatewayEnvOf(FULL, { waitUntil() {} });
  assert.equal(typeof g.AI_SERVICE.fetch, 'function');
  const ask = (h = {}) => g.AI_SERVICE.fetch(new Request('https://styrigx-ai/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ q: '主题' }) }));
  let r = await ask();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('X-Styrigx-AI-Scope'), 'public');
  const txt = await r.text();
  assert.deepEqual([...txt.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]), ['delta', 'delta', 'done']);
  assert.ok(!txt.includes('/account/'));
  r = await ask({ 'X-Styrigx-Account-Session': '1' });
  assert.equal(r.headers.get('X-Styrigx-AI-Scope'), 'private');
  assert.ok(!(await r.text()).includes('event: hits'));
  assert.equal((await g.AI_SERVICE.fetch(new Request('https://styrigx-ai/healthz'))).status, 200);
  assert.equal((await g.AI_SERVICE.fetch(new Request('https://styrigx-ai/search?q=x'))).status, 404);
});
