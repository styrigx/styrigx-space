/**
 * 前端真请求 e2e（Item 25）：owner-password 的 set/change/remove
 *（kind=lock/owner）与 owner-passkey 的 register。
 *
 * - 不 mock fetch：浏览器用真实 fetch 发请求到 cred-e2e-helpers.cjs 启动的
 *   本地测试服务器；
 * - 测试服务器跑的是 functions/api/ 下的真实 handler（onRequestPost），
 *   配内存 KV；断言 KV 中对应键更新、通行密钥 class 正确。
 * - register 的 WebAuthn 仪式由 Node 端合成 attestation（见 helper 注释）。
 *
 * 运行：npx playwright test --config=playwright.config.js api-credential.spec.js
 * （默认 testMatch 已包含本文件；不需要 hugo 构建，自带测试服务器）
 */
const { test, expect } = require('@playwright/test');
const { startCredentialTestServer } = require('./cred-e2e-helpers.cjs');

const PORT = 8937;

let t; // { kv, env, origin, mintAuth, makeAttestationCredential, close }

/* 按当前 KV session-epoch 重签会话 + stepup 票据，写入浏览器 context。
   set/change/remove/register 会推进 epoch，每次鉴权操作前都重签。 */
async function mintBrowserAuth(context, stepupBy, stepupScope) {
  const { sessionCookie, stepupCookie } = await t.mintAuth(stepupBy, stepupScope);
  await context.addCookies([
    { name: 'sgx-verified', value: sessionCookie, domain: 'localhost', path: '/' },
    { name: 'sgx-stepup', value: stepupCookie, domain: 'localhost', path: '/' },
  ]);
}

/* 浏览器真实 fetch（不经 page.route mock） */
async function apiFetch(page, apiPath, body) {
  return page.evaluate(async ({ apiPath, body }) => {
    const r = await fetch(apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    return { status: r.status, json: await r.json() };
  }, { apiPath, body });
}

test.describe('credential APIs 真请求 e2e', () => {
  test.beforeAll(async () => {
    t = await startCredentialTestServer(PORT);
  });
  test.afterAll(async () => {
    if (t) await t.close();
  });

  test.beforeEach(async ({ page }) => {
    // 同源空页面：fetch 能带上 Origin 与 cookie
    await page.goto(t.origin + '/');
  });

  test('owner-password set/change/remove（kind=lock），KV 对应键更新', async ({ page, context }) => {
    const kv = t.kv;
    // set
    await mintBrowserAuth(context, 'owner', 'keys');
    let r = await apiFetch(page, '/api/owner-password',
      { action: 'set', kind: 'lock', password: 'LockPass-111' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const rec1 = await kv.get('lock-pw', 'json');
    expect(rec1 && rec1.hash).toBeTruthy();
    expect(rec1.peppered).toBe(true);
    expect(await kv.get('layer:lock')).toBe('1');

    // change（epoch 已推进，重签票据）
    await mintBrowserAuth(context, 'owner', 'keys');
    r = await apiFetch(page, '/api/owner-password',
      { action: 'change', kind: 'lock', password: 'LockPass-222' });
    expect(r.json.ok).toBe(true);
    const rec2 = await kv.get('lock-pw', 'json');
    expect(rec2.hash).not.toBe(rec1.hash);

    // 新密码能 verify 通过（证明存的是可用 hash）
    r = await apiFetch(page, '/api/owner-password',
      { action: 'verify', password: 'LockPass-222' });
    expect(r.json.ok).toBe(true);

    // remove
    await mintBrowserAuth(context, 'owner', 'keys');
    r = await apiFetch(page, '/api/owner-password',
      { action: 'remove', kind: 'lock' });
    expect(r.json.ok).toBe(true);
    expect(await kv.get('lock-pw', 'json')).toBeNull();
    expect(await kv.get('layer:lock')).toBeNull();
  });

  test('owner-password set/change/remove（kind=owner），KV 对应键更新', async ({ page, context }) => {
    const kv = t.kv;
    // set（站长密码走入口 1：stepup by=root scope=root）
    await mintBrowserAuth(context, 'root', 'root');
    let r = await apiFetch(page, '/api/owner-password',
      { action: 'set', kind: 'owner', password: 'OwnerPass-222' });
    expect(r.json.ok).toBe(true);
    const rec1 = await kv.get('owner-pw', 'json');
    expect(rec1 && rec1.hash).toBeTruthy();
    expect(await kv.get('layer:owner')).toBe('1');

    // change
    await mintBrowserAuth(context, 'root', 'root');
    r = await apiFetch(page, '/api/owner-password',
      { action: 'change', kind: 'owner', password: 'OwnerPass-333' });
    expect(r.json.ok).toBe(true);
    const rec2 = await kv.get('owner-pw', 'json');
    expect(rec2.hash).not.toBe(rec1.hash);

    // remove（无其他站长凭证时清掉层标记）
    await mintBrowserAuth(context, 'root', 'root');
    r = await apiFetch(page, '/api/owner-password',
      { action: 'remove', kind: 'owner' });
    expect(r.json.ok).toBe(true);
    expect(await kv.get('owner-pw', 'json')).toBeNull();
    expect(await kv.get('layer:owner')).toBeNull();
  });

  test('owner-passkey register，KV 中 class 正确（lock / owner）', async ({ page, context }) => {
    const kv = t.kv;
    for (const [pkClass, stepupBy, stepupScope] of [
      ['lock', 'owner', 'keys'],   // 锁屏类：入口 2
      ['owner', 'root', 'root'],   // 站长类：入口 1
    ]) {
      await mintBrowserAuth(context, stepupBy, stepupScope);
      // 1）真请求拿 challenge
      const ch = await apiFetch(page, '/api/owner-passkey',
        { action: 'challenge', type: 'register', pkClass });
      expect(ch.json.ok).toBe(true);
      expect(ch.json.cid).toBeTruthy();
      expect(ch.json.challenge).toBeTruthy();

      // 2）Node 端合成 attestation（UV=1），真请求提交 register
      const credential = await t.makeAttestationCredential(ch.json.challenge, 'localhost', t.origin);
      const reg = await apiFetch(page, '/api/owner-passkey',
        { action: 'register', cid: ch.json.cid, credential, name: 'e2e-' + pkClass });
      expect(reg.json.ok).toBe(true);
      expect(reg.json.credId).toBeTruthy();

      // 3）断言 KV：索引含该 credId，且记录的 class 与请求一致
      const idx = await kv.get('owner-passkey-index', 'json');
      expect(idx).toContain(reg.json.credId);
      const stored = await kv.get('owner-passkey:' + String(reg.json.credId).slice(0, 12), 'json');
      expect(stored.class).toBe(pkClass);
    }
  });
});
