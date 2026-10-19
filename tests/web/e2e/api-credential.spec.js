/**
 * 前端真请求 e2e（Item 25）：owner-password 的 set/change/remove（kind=lock）、
 * owner-passkey 的 register（lock），以及账号体系的 /api/account（账号密码、账号通行密钥）
 * 和 /api/stepup enter（近期账号登录换门票据）。
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

/* 账号会话写入浏览器 context（按当前 account-epoch 签） */
async function mintBrowserAccount(context, by, authAt) {
  const acc = await t.mintAccount(by, authAt);
  await context.addCookies([{ name: 'sgx-account', value: acc, domain: 'localhost', path: '/' }]);
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
    await mintBrowserAuth(context, 'account', 'keys');
    let r = await apiFetch(page, '/api/owner-password',
      { action: 'set', kind: 'lock', password: 'LockPass-111' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const rec1 = await kv.get('lock-pw', 'json');
    expect(rec1 && rec1.hash).toBeTruthy();
    expect(rec1.peppered).toBe(true);
    expect(await kv.get('layer:lock')).toBe('1');

    // change（epoch 已推进，重签票据）
    await mintBrowserAuth(context, 'account', 'keys');
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
    await mintBrowserAuth(context, 'account', 'keys');
    r = await apiFetch(page, '/api/owner-password',
      { action: 'remove', kind: 'lock' });
    expect(r.json.ok).toBe(true);
    expect(await kv.get('lock-pw', 'json')).toBeNull();
    expect(await kv.get('layer:lock')).toBeNull();
  });

  test('账号密码 set/change（/api/account；迁移：仍存 owner-pw），kind=owner 已不可用', async ({ page, context }) => {
    const kv = t.kv;
    await mintBrowserAuth(context, 'root', 'root');
    let r = await apiFetch(page, '/api/owner-password', { action: 'set', kind: 'owner', password: 'OwnerPass-222' });
    expect(r.status).toBe(400);
    // 根凭证登录的账号会话：设置账号密码
    await mintBrowserAccount(context, 'root');
    r = await apiFetch(page, '/api/account', { action: 'password', password: 'OwnerPass-222' });
    expect(r.json.ok).toBe(true);
    expect(r.json.changed).toBe(false);
    const rec1 = await kv.get('owner-pw', 'json');
    expect(rec1 && rec1.hash).toBeTruthy();
    expect(await kv.get('layer:owner')).toBe('1');
    // 首次配置推进了 session-epoch：重签 lock 会话；账号会话由响应 Set-Cookie 维持
    await mintBrowserAuth(context, 'root', 'root');
    r = await apiFetch(page, '/api/account', { action: 'password', password: 'OwnerPass-333' });
    expect(r.json.ok).toBe(true);
    expect(r.json.changed).toBe(true);
    const rec2 = await kv.get('owner-pw', 'json');
    expect(rec2.hash).not.toBe(rec1.hash);
    expect(await kv.get('account-epoch')).toBe('1');
    // 新密码能登录账号
    r = await apiFetch(page, '/api/account', { action: 'login-password', password: 'OwnerPass-333' });
    expect(r.json.ok).toBe(true);
    // 登录后进门：by=account, scope=keys
    r = await apiFetch(page, '/api/stepup', { action: 'enter' });
    expect(r.json.ok).toBe(true);
    r = await apiFetch(page, '/api/stepup', { action: 'status' });
    expect(r.json.valid).toBe(true);
  });

  test('通行密钥 register，KV 中 class 正确（lock：门内 owner-passkey / owner：账号页 /api/account）', async ({ page, context }) => {
    const kv = t.kv;
    for (const pkClass of ['lock', 'owner']) {
      await mintBrowserAuth(context, 'account', 'keys');
      await mintBrowserAccount(context, 'password');
      const api = pkClass === 'owner' ? '/api/account' : '/api/owner-passkey';
      // 1）真请求拿 challenge
      const ch = await apiFetch(page, api, pkClass === 'owner'
        ? { action: 'register-challenge' }
        : { action: 'challenge', type: 'register', pkClass });
      expect(ch.json.ok).toBe(true);
      expect(ch.json.cid).toBeTruthy();
      expect(ch.json.challenge).toBeTruthy();

      // 2）Node 端合成 attestation（UV=1），真请求提交 register
      const credential = await t.makeAttestationCredential(ch.json.challenge, 'localhost', t.origin);
      const reg = await apiFetch(page, api,
        { action: 'register', cid: ch.json.cid, credential, name: 'e2e-' + pkClass });
      expect(reg.json.ok).toBe(true);
      expect(reg.json.credId).toBeTruthy();

      // 3）断言 KV：索引含该 credId，且记录的 class 与请求一致
      const idx = await kv.get('owner-passkey-index', 'json');
      expect(idx).toContain(reg.json.credId);
      const stored = await kv.get('owner-passkey:' + String(reg.json.credId).slice(0, 12), 'json');
      expect(stored.class).toBe(pkClass);
    }
    // 账号页只列账号类；门票据不能列账号类（只在账号页管理）
    const listAcc = await apiFetch(page, '/api/account', { action: 'list' });
    expect(listAcc.json.keys.map((k) => k.name)).toEqual(['e2e-owner']);
    const listDoor = await apiFetch(page, '/api/owner-passkey', { action: 'list', pkClass: 'owner' });
    expect(listDoor.status).toBe(403);
  });
});
