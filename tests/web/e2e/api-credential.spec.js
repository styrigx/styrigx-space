/**
 * 前端真请求 e2e（Item 25）：lock-password 的 set/change/remove、
 * lock-passkey 的 register（lock），以及账号体系的 /api/account（账号密码、账号通行密钥）
 * 和 /api/lock-reauth（锁屏凭证的门：状态 / 清票）。
 *
 * - 不 mock fetch：浏览器用真实 fetch 发请求到 cred-e2e-helpers.cjs 启动的
 *   本地测试服务器；
 * - 测试服务器跑的是 functions/api/ 下的真实 handler（onRequestPost），
 *   配内存 KV；断言 KV 中对应键更新、通行密钥 class 正确。
 * - register 的 WebAuthn 仪式由 Node 端合成 attestation（见 helper 注释）。
 *
 * 运行：SGX_TEST_SUITE=credential npx playwright test --config=tests/config/playwright.config.js
 * （CI 的 quality job 单独跑这一组；不需要 hugo 构建，自带测试服务器）
 */
const { test, expect } = require('@playwright/test');
const { startCredentialTestServer } = require('./cred-e2e-helpers.cjs');

const PORT = 8937;

let t; // { kv, env, origin, mintAuth, makeAttestationCredential, close }

/* 按当前 Lock 纪元重签 admin 锁屏会话 + LockReauthTicket，写入浏览器 context。
   set/change/remove/register 会推进 epoch，每次鉴权操作前都重签。 */
async function mintBrowserAuth(context, reauthBy) {
  const { sessionCookie, reauthCookie } = await t.mintAuth(reauthBy);
  await context.addCookies([
    { name: 'sgx-lock-session', value: sessionCookie, domain: 'localhost', path: '/' },
    { name: 'sgx-lock-reauth', value: reauthCookie, domain: 'localhost', path: '/' },
  ]);
}

/* 账号会话 + AccountReauthTicket 写入浏览器 context（按当前 Account 纪元签；和 LockReauthTicket 是两个 cookie，互不覆盖） */
async function mintBrowserAccount(context, by, authAt) {
  const acc = await t.mintAccount(by, authAt);
  const d = await t.mintAccountReauth(by);
  await context.addCookies([
    { name: 'sgx-account-session', value: acc, domain: 'localhost', path: '/' },
    { name: 'sgx-account-reauth', value: d, domain: 'localhost', path: '/' },
  ]);
}

/* AccountResetTicket 写入浏览器 context（RootKey 只签重置票，不签账号会话） */
async function mintBrowserAccountReset(context) {
  const x = await t.mintAccountReset();
  await context.addCookies([{ name: 'sgx-account-reset', value: x, domain: 'localhost', path: '/' }]);
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

  test('lock-password set/change/remove，KV 对应键更新', async ({ page, context }) => {
    const kv = t.kv;
    // set
    await mintBrowserAuth(context, 'password');
    let r = await apiFetch(page, '/api/lock-password',
      { action: 'set', password: 'LockPass-111' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const rec1 = await kv.get('lock-password', 'json');
    expect(rec1 && rec1.hash).toBeTruthy();
    expect(rec1.peppered).toBe(true);
    expect(await kv.get('lock-configured')).toBe('1');

    // change（epoch 已推进，重签票据）
    await mintBrowserAuth(context, 'password');
    r = await apiFetch(page, '/api/lock-password',
      { action: 'change', password: 'LockPass-222' });
    expect(r.json.ok).toBe(true);
    const rec2 = await kv.get('lock-password', 'json');
    expect(rec2.hash).not.toBe(rec1.hash);

    // 新密码能 verify 通过（证明存的是可用 hash）
    r = await apiFetch(page, '/api/lock-password',
      { action: 'verify', password: 'LockPass-222' });
    expect(r.json.ok).toBe(true);

    // remove：账号未配置时不能删最后一把锁屏凭证（A-2：403 last-key，密码还在）
    await mintBrowserAuth(context, 'password');
    r = await apiFetch(page, '/api/lock-password',
      { action: 'remove' });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('last-key');
    expect((await kv.get('lock-password', 'json')).hash).toBe(rec2.hash);
  });

  test('账号密码 set/change（/api/account；KV 仍存 account-password）', async ({ page, context }) => {
    const kv = t.kv;
    await mintBrowserAuth(context, 'root');
    // 第一次设账号密码：没有账号会话，凭根凭证签的 AccountResetTicket
    await mintBrowserAccountReset(context);
    let r = await apiFetch(page, '/api/account', { action: 'password-change', password: 'AccountPass-222' });
    expect(r.json.ok).toBe(true);
    expect(r.json.changed).toBe(false);
    const rec1 = await kv.get('account-password', 'json');
    expect(rec1 && rec1.hash).toBeTruthy();
    expect(await kv.get('account-configured')).toBe('1');
    // 首次配置推进了 lock-epoch：重签 lock 会话；之后用账号会话 + AccountReauthTicket 改密码
    await mintBrowserAuth(context, 'root');
    await context.clearCookies({ name: 'sgx-account-reset' });
    await mintBrowserAccount(context, 'password');
    r = await apiFetch(page, '/api/account', { action: 'password-change', password: 'AccountPass-333' });
    expect(r.json.ok).toBe(true);
    expect(r.json.changed).toBe(true);
    const rec2 = await kv.get('account-password', 'json');
    expect(rec2.hash).not.toBe(rec1.hash);
    expect(await kv.get('account-epoch')).toBe('1');
    // 新密码能登录账号
    r = await apiFetch(page, '/api/account', { action: 'login-password', password: 'AccountPass-333' });
    expect(r.json.ok).toBe(true);
    // 锁屏凭证的门：AccountReauthTicket不能开锁屏的门（去掉上面签的 LockReauthTicket 后 status valid=false）
    await context.clearCookies({ name: 'sgx-lock-reauth' });
    r = await apiFetch(page, '/api/lock-reauth', { action: 'status' });
    expect(r.json.ok).toBe(true);
    expect(r.json.valid).toBe(false);
  });

  test('通行密钥 register，KV 中 class 正确（lock：门内 lock-passkey / owner：账号页 /api/account）', async ({ page, context }) => {
    const kv = t.kv;
    for (const pkClass of ['lock', 'account']) {
      await mintBrowserAuth(context, 'password');
      if (pkClass === 'account') await mintBrowserAccount(context, 'password');
      const api = pkClass === 'account' ? '/api/account' : '/api/lock-passkey';
      // 1）真请求拿 challenge
      const ch = await apiFetch(page, api, pkClass === 'account'
        ? { action: 'passkey-register-challenge' }
        : { action: 'challenge', type: 'register' });
      expect(ch.json.ok).toBe(true);
      expect(ch.json.cid).toBeTruthy();
      expect(ch.json.challenge).toBeTruthy();

      // 2）Node 端合成 attestation（UV=1），真请求提交 register
      const credential = await t.makeAttestationCredential(ch.json.challenge, 'localhost', t.origin);
      const reg = await apiFetch(page, api,
        { action: pkClass === 'account' ? 'passkey-register' : 'register', cid: ch.json.cid, credential, name: 'e2e-' + pkClass });
      expect(reg.json.ok).toBe(true);
      expect(reg.json.credId).toBeTruthy();

      // 3）断言 KV：记录和索引落在对应域的键下（lock-passkey:* / account-passkey:*），不再写 class 字段
      const prefix = pkClass === 'account' ? 'account-passkey' : 'lock-passkey';
      const idx = await kv.get(prefix + '-index', 'json');
      expect(idx).toContain(reg.json.credId);
      const stored = await kv.get(prefix + ':' + String(reg.json.credId).slice(0, 12), 'json');
      expect(stored).toBeTruthy();
      expect(stored.class).toBeUndefined();
    }
    // 账号页只列账号类；锁屏接口只列锁屏类（账号类只在账号页管理）。
    // 第一次注册账号通行密钥推进了 lock-epoch：先按新纪元重签锁屏会话和账号会话
    await mintBrowserAuth(context, 'password');
    await mintBrowserAccount(context, 'password');
    const listAcc = await apiFetch(page, '/api/account', { action: 'passkey-list' });
    expect(listAcc.json.ok, JSON.stringify(listAcc.json)).toBe(true);
    expect(listAcc.json.keys.map((k) => k.name)).toEqual(['e2e-account']);
    await mintBrowserAuth(context, 'password');
    const listDoor = await apiFetch(page, '/api/lock-passkey', { action: 'list' });
    expect(listDoor.json.ok, JSON.stringify(listDoor.json)).toBe(true);
    expect(listDoor.json.keys.map((k) => k.name)).toEqual(['e2e-lock']);
  });
});
