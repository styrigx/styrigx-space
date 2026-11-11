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
  SGX_ACCOUNT_PRIVATE: 'ap', SGX_ACCOUNT_PUBLIC: 'au', SGX_ACCOUNT_PASSWORD_PEPPER: 'acct-pep',
  D1_SPACE: { d1: 'space' }, D1_ACCOUNT: { d1: 'account' }, ASSETS: { fetch() {} },
};

test('preview-worker：网关那一半没有任何账号钥匙 / 账号库，有 ACCOUNT / ACCOUNT_VERIFIER', () => {
  const g = pw.gatewayEnvOf(FULL, { waitUntil() {} });
  for (const k of ['SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC', 'SGX_ACCOUNT_PASSWORD_PEPPER', 'D1_ACCOUNT']) assert.equal(g[k], undefined, k);
  for (const k of ['D1_SPACE', 'ASSETS', 'SGX_ENV']) assert.equal(g[k], FULL[k], k);
  assert.equal(typeof g.ACCOUNT.fetch, 'function');
  assert.equal(g.ACCOUNT_VERIFIER.session, undefined, '命名 v2：session() 删了');
  assert.equal(g.ACCOUNT_VERIFIER.authorize, undefined, 'v6 P4：authorize() 删了');
  assert.equal(typeof g.ACCOUNT_VERIFIER.admit, 'function', '同正式 AccountVerifier：admit / auditRoot');
  assert.equal(typeof g.ACCOUNT_VERIFIER.auditRoot, 'function');
});

test('preview-worker：账号那一半只拿账号的绑定，没有网关的库；v6 P4 起 SGX_SPACE_* 与两把旧恢复钥匙、账号签名钥匙对都不在 env 键表里', () => {
  const a = pw.accountEnvOf({ ...FULL, SGX_SPACE_PRIVATE: 'x', SGX_ACCOUNT_RECOVERY_KEY: 'y' });
  for (const k of ['SGX_SPACE_PRIVATE', 'SGX_ACCOUNT_RECOVERY_KEY', 'D1_SPACE', 'SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC']) assert.equal(a[k], undefined, k);
  for (const k of ['SGX_ACCOUNT_PASSWORD_PEPPER', 'D1_ACCOUNT', 'ASSETS']) assert.equal(a[k], FULL[k], k);
  assert.deepEqual(pw.ACCOUNT_ENV_KEYS.filter((k) => /SGX_SPACE_|RECOVERY_KEY|SGX_ACCOUNT_PRIVATE|SGX_ACCOUNT_PUBLIC/.test(k)), []);
});

test('preview-worker：ACCOUNT.fetch 只认 v6 会话；没有的 /api/* → 401，响应带 X-SGX-Runtime: account', async () => {
  const g = pw.gatewayEnvOf(FULL, { waitUntil() {} });
  const r = await g.ACCOUNT.fetch(new Request('https://x.pages.dev/api/prefs'));
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
});

test('preview-worker：默认导出是 { fetch }，只交给网关（伪造的 x-styrigx-* 先被网关剥掉）', async () => {
  assert.equal(typeof pw.default.fetch, 'function');
  const env = Object.assign({}, FULL, { SGX_ENV: 'preview' });
  const r = await pw.default.fetch(new Request('https://x.pages.dev/api/prefs', { headers: { 'X-Styrigx-Space-Level': 'password' } }), env, { waitUntil() {} });
  /* 网关剥掉外来 x-styrigx-* 头后转发；账号 Worker 只认 v6 会话 → 401 */
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
