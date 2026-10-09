/**
 * 通行密钥 E2E（Hark 方案）：Playwright CDP WebAuthn 虚拟认证器。
 * 在预览站跑完整流程：注册 → 列表出现 → 锁屏通行密钥解锁 → 删除。
 * 另含服务端测试：伪造 sgx-verified=1 访问首页，必须仍然是锁屏。
 *
 * 运行：SGX_TEST_OWNER_KEY=<预览测试 OWNER_KEY> SGX_TEST_BASE=https://<preview> \
 *   npx playwright test --config=playwright.config.js passkey.spec.js
 * 未设 SGX_TEST_OWNER_KEY 时跳过（CI 需 Gray 配置该 secret）。
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.SGX_TEST_BASE || '';
const OWNER_KEY = process.env.SGX_TEST_OWNER_KEY || '';
const HAS_KEY = !!OWNER_KEY;

test.describe('passkey e2e (virtual authenticator)', () => {
  test.skip(!HAS_KEY || !BASE, '需要 SGX_TEST_BASE 与 SGX_TEST_OWNER_KEY');

  /** @param {import('@playwright/test').Page} page */
  async function addVirtualAuth(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    return { cdp, authenticatorId };
  }

  /** @param {import('@playwright/test').Page} page */
  async function gateWithKey(page) {
    await page.goto(BASE + '/settings/security/lock/');
    /* 验证身份弹层 */
    const dlg = page.locator('#lockgate-dlg');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await page.click('#lockgate-key');
    await page.fill('#lockgate-input', OWNER_KEY);
    await page.click('#lockgate-go');
    /* 进入管理区 */
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
  }

  test('注册 → 列表 → 删除', async ({ page }) => {
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      await gateWithKey(page);
      /* 注册 */
      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem').first()).toBeVisible({ timeout: 20000 });
      const count1 = await page.locator('.lockmgr-pkitem').count();
      expect(count1).toBeGreaterThan(0);
      /* 重命名 */
      const nameInput = page.locator('.lockmgr-pkitem input[type="text"]').first();
      await nameInput.fill('E2E-Test');
      await nameInput.blur();
      await expect(page.locator('.sgx-toast.show')).toContainText(/已重命名|Renamed/, { timeout: 10000 });
      /* 删除（两步确认） */
      const delBtn = page.locator('.lockmgr-pkdel').first();
      await delBtn.click();
      await delBtn.click();
      await expect(page.locator('.sgx-toast.show')).toContainText(/已删除|Deleted/, { timeout: 10000 });
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });

  test('锁屏通行密钥解锁', async ({ page, context }) => {
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      /* 先注册一个 */
      await gateWithKey(page);
      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem').first()).toBeVisible({ timeout: 20000 });
      /* 回到锁屏（强制） */
      await page.goto(BASE + '/?lock=1');
      const lock = page.locator('#sgx-lock');
      await expect(lock).toBeVisible({ timeout: 15000 });
      const pkbtn = page.locator('#sgx-lock-pkbtn');
      await expect(pkbtn).toBeVisible();
      await pkbtn.click();
      /* 解锁：锁屏消失 */
      await expect(lock).toBeHidden({ timeout: 20000 });
      const shown = await page.evaluate(() => {
        try { return sessionStorage.getItem('sgx-lock-shown'); } catch (e) { return null; }
      });
      expect(shown).toBe('1');
      /* 清理：删掉测试密钥 */
      await gateWithKey(page);
      const delBtn = page.locator('.lockmgr-pkdel').first();
      if (await delBtn.count()) {
        await delBtn.click();
        await delBtn.click();
      }
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });

  test('伪造 sgx-verified=1 仍是锁屏', async ({ page, context }) => {
    /* Hark：未签名的 cookie 不得绕过锁屏 */
    await context.addCookies([
      { name: 'sgx-verified', value: '1', domain: new URL(BASE).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    ]);
    await page.goto(BASE + '/?lock=1');
    const lock = page.locator('#sgx-lock');
    await expect(lock).toBeVisible({ timeout: 15000 });
  });
});
