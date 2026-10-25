/**
 * 锁屏凭证的门 / 账号登录 E2E（预览站真实后端）。
 *
 * stepup 已删除：锁屏凭证页的reauth 票由 /api/lock-reauth（状态 / 清票）+ 各凭证接口 reauth:true 签发；
 * 账号通行密钥登录走 /api/account challenge + login-passkey。
 * 完整逻辑由 tests/workers/auth-gateway/lock-reauth.test.mjs、account.test.mjs 覆盖。
 *
 * 覆盖：
 * - 无会话 lock-reauth status 被拒（401）；/api/stepup 已不存在
 * - 锁屏通行密钥的 lock-passkey-challenge 不能用于账号登录（403 challenge，用途隔离）
 * - 账号登录 challenge 单次使用，重放被拒（403 challenge）
 *
 * 运行：SGX_TEST_OWNER_KEY=<预览测试 OWNER_KEY> SGX_TEST_BASE=https://<preview> \
 *   SGX_TEST_SUITE=passkey npx playwright test --config=playwright.config.js account-challenge.spec.js
 * 未设 SGX_TEST_OWNER_KEY 时跳过（CI 需 Gray 配置该 secret）。
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.SGX_TEST_BASE || '';
const OWNER_KEY = process.env.SGX_TEST_OWNER_KEY || '';
const HAS_KEY = !!OWNER_KEY;

test.describe('lock reauth / account challenge e2e', () => {
  test.skip(!HAS_KEY || !BASE, '需要 SGX_TEST_BASE 与 SGX_TEST_OWNER_KEY');

  /** @param {import('@playwright/test').Page} page */
  async function addVirtualAuth(page, userVerified) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: false,
        automaticPresenceSimulation: true,
      },
    });
    if (userVerified) {
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
    }
    return { cdp, authenticatorId };
  }

  /**
   * 拿 admin 锁屏会话 cookie：设测试密码 → verify → 从 Set-Cookie 提取。
   * @param {import('@playwright/test').Page} page
   * @param {any} request
   */
  async function adminSessionCookie(page, request) {
    const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));
    const pw = 'e2e-reauth-' + Date.now();
    let r = await request.post(BASE + '/api/lock-password', {
      data: { action: 'set', token, password: pw },
    });
    if ((await r.json()).error === 'exists') {
      r = await request.post(BASE + '/api/lock-password', {
        data: { action: 'change', token, password: pw },
      });
    }
    expect((await r.json()).ok).toBe(true);
    r = await request.post(BASE + '/api/lock-password', {
      data: { action: 'verify', password: pw },
    });
    expect((await r.json()).ok).toBe(true);
    const sc = r.headers()['set-cookie'] || '';
    const m = sc.match(/sgx-lock-session=([^;]+)/);
    expect(m).toBeTruthy();
    /* 清理测试密码 */
    await request.post(BASE + '/api/lock-password', {
      data: { action: 'remove', token },
    });
    return 'sgx-lock-session=' + m[1];
  }

  test('无会话 lock-reauth status → 401', async ({ request }) => {
    const r = await request.post(BASE + '/api/lock-reauth', {
      data: { action: 'status' },
    });
    expect(r.status()).toBe(401);
  });

  test('锁屏 lock-passkey-challenge 不能用于账号登录 login-passkey', async ({ page, request }) => {
    const cookie = await adminSessionCookie(page, request);
    const headers = { Cookie: cookie };
    const chal = await (await request.post(BASE + '/api/lock-passkey', {
      data: { action: 'challenge', type: 'auth' },
      headers,
    })).json();
    if (!chal.ok) test.skip(true, '无已注册锁屏 passkey，跳过');
    const r = await request.post(BASE + '/api/account', {
      data: { action: 'login-passkey', cid: chal.cid, credential: { rawId: 'x' } },
      headers,
    });
    const j = await r.json();
    if (j.error === 'config') test.skip(true, '预览站未配 SGX_ACCOUNT_*，跳过');
    expect(r.status()).toBe(403);
    expect(j.error).toBe('challenge');
  });

  test('账号登录 challenge 单次使用，重放被拒', async ({ page, request }) => {
    const cookie = await adminSessionCookie(page, request);
    const headers = { Cookie: cookie };
    const chal = await (await request.post(BASE + '/api/account', {
      data: { action: 'login-challenge' },
      headers,
    })).json();
    if (!chal.ok) test.skip(true, '无账号通行密钥或未配 SGX_ACCOUNT_*，跳过');
    let r = await request.post(BASE + '/api/account', {
      data: { action: 'login-passkey', cid: chal.cid, credential: { rawId: 'nope' } },
      headers,
    });
    expect(r.status()).toBe(403);
    r = await request.post(BASE + '/api/account', {
      data: { action: 'login-passkey', cid: chal.cid, credential: { rawId: 'nope' } },
      headers,
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).error).toBe('challenge');
  });
});
