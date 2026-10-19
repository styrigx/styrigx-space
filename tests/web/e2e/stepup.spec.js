/**
 * stepup / 账号登录 E2E（预览站真实后端）。
 *
 * 账号体系后：门票据只由近期账号登录换取（/api/stepup enter），原 stepup challenge/verify
 * （站长通行密钥直接开门）已移除；账号通行密钥登录走 /api/account challenge + login-passkey。
 * 完整的账号通行密钥登录（真实 ES256 断言、UV、userHandle、迁移）由
 * tests/workers/auth-gateway/account.test.mjs 覆盖。
 *
 * 覆盖：
 * - 无会话 stepup enter 被拒（401）
 * - 锁屏通行密钥的 pk-challenge 不能用于账号登录（403 challenge，用途隔离）
 * - 账号登录 challenge 单次使用，重放被拒（403 challenge）
 *
 * 运行：SGX_TEST_OWNER_KEY=<预览测试 OWNER_KEY> SGX_TEST_BASE=https://<preview> \
 *   SGX_TEST_SUITE=passkey npx playwright test --config=playwright.config.js stepup.spec.js
 * 未设 SGX_TEST_OWNER_KEY 时跳过（CI 需 Gray 配置该 secret）。
 * 注意：完整流程需要预览站配置 SGX_STEPUP_PRIVATE/SGX_STEPUP_PUBLIC，否则 verify 返回 no-stepup-key。
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.SGX_TEST_BASE || '';
const OWNER_KEY = process.env.SGX_TEST_OWNER_KEY || '';
const HAS_KEY = !!OWNER_KEY;

test.describe('stepup e2e', () => {
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
   * 拿 owner 会话 cookie：设测试密码 → verify → 从 Set-Cookie 提取。
   * @param {import('@playwright/test').Page} page
   * @param {any} request
   */
  async function ownerSessionCookie(page, request) {
    const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));
    const pw = 'e2e-stepup-' + Date.now();
    let r = await request.post(BASE + '/api/owner-password', {
      data: { action: 'set', token, password: pw },
    });
    if ((await r.json()).error === 'exists') {
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'change', token, password: pw },
      });
    }
    expect((await r.json()).ok).toBe(true);
    r = await request.post(BASE + '/api/owner-password', {
      data: { action: 'verify', password: pw },
    });
    expect((await r.json()).ok).toBe(true);
    const sc = r.headers()['set-cookie'] || '';
    const m = sc.match(/sgx-verified=([^;]+)/);
    expect(m).toBeTruthy();
    /* 清理测试密码 */
    await request.post(BASE + '/api/owner-password', {
      data: { action: 'remove', token },
    });
    return 'sgx-verified=' + m[1];
  }

  test('无会话 stepup enter → 401', async ({ request }) => {
    const r = await request.post(BASE + '/api/stepup', {
      data: { action: 'enter' },
    });
    /* middleware L1 未验证的 /api/* 返回 401（/api/stepup 不在白名单） */
    expect(r.status()).toBe(401);
  });

  test('锁屏 pk-challenge 不能用于账号登录 login-passkey', async ({ page, request }) => {
    const cookie = await ownerSessionCookie(page, request);
    const headers = { Cookie: cookie };
    const chal = await (await request.post(BASE + '/api/owner-passkey', {
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
    const cookie = await ownerSessionCookie(page, request);
    const headers = { Cookie: cookie };
    const chal = await (await request.post(BASE + '/api/account', {
      data: { action: 'challenge' },
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
