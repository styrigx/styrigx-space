/**
 * 两扇门验证弹层 E2E（静态构建 + API mock，无需真实后端）。
 *
 * 覆盖（第七节验收）：
 * - 取消系统验证后弹层仍在，不提示错误
 * - 密码错误显示行内提示（不用 toast）
 * - 成功后直接进门内页面（不留在入口页）
 *
 * 运行：npx playwright test --config=playwright.config.js door-verify.spec.js
 * （默认 suite，走静态 public/ 构建；/api/* 用 page.route mock）
 *
 * Hark：等具体元素，不用 waitForTimeout/networkidle。
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

/** @param {import('@playwright/test').Page} page */
async function mockJson(page, pattern, status, body) {
  await page.route(pattern, async (route) => {
    await route.fulfill({
      status: status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

test.describe('door verify dialog', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    /* 语言钉住中文：2.7.0 起语言跟随系统，Playwright 默认 en-US 会跳 /en/，
       中文断言会失败（与 visual.spec.js 同一做法）。 */
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    /* 站长凭证已配置（密码+通行密钥）：管理凭证弹层显示两个行 */
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sec-mgmt-cred')).toBeVisible({ timeout: 15000 });
  });

  test('取消系统验证后弹层仍在，不提示错误', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, {
      ok: true, challenge: 'dGVzdC1jaGFsbGVuZ2U', cid: 'c1', rpId: 'localhost', allowCredentials: [],
    });
    await page.click('#sec-mgmt-cred');
    const dlg = page.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();
    /* 桩掉系统验证：直接拒绝 NotAllowedError（模拟用户取消） */
    await page.evaluate(() => {
      try {
        navigator.credentials.get = function () {
          return Promise.reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
        };
      } catch (e) {}
    });
    await page.locator('.sgx-door-row').filter({ hasText: '站长通行密钥' }).click();
    /* 等加载圈消失（流程结束），弹层仍在且无行内错误 */
    await expect(page.locator('.sgx-door-spin')).toHaveCount(0, { timeout: 8000 });
    await expect(dlg).toBeVisible();
    await expect(page.locator('.sgx-door-err:not([hidden])')).toHaveCount(0);
  });

  test('密码错误显示行内提示，弹层不关闭', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 401, { ok: false, error: 'auth' });
    await page.click('#sec-mgmt-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '站长密码' }).click();
    await page.locator('.sgx-door-expand input').fill('wrong-password');
    await page.locator('.sgx-door-actions .primary').click();
    await expect(page.locator('.sgx-door-err:not([hidden])').filter({ hasText: '密码不正确' }))
      .toBeVisible({ timeout: 8000 });
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
  });

  test('密码验证成功后直接进锁屏门内页', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, { ok: true });
    await page.click('#sec-mgmt-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '站长密码' }).click();
    await page.locator('.sgx-door-expand input').fill('correct-password');
    await page.locator('.sgx-door-actions .primary').click();
    await page.waitForURL('**/settings/security/lock/**', { timeout: 10000 });
  });

  test('根凭证验证成功后直接进站长凭证门内页', async ({ page }) => {
    await mockJson(page, '**/api/root-auth', 200, { ok: true });
    await mockJson(page, '**/api/root-session', 200, { ok: true });
    await page.click('#sec-owner-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await expect(page.locator('.sgx-door-row').filter({ hasText: '根凭证' })).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand textarea').fill('test-root-key');
    await page.locator('.sgx-door-actions .primary').click();
    await page.waitForURL('**/settings/security/owner/**', { timeout: 10000 });
  });

  test('点遮罩等同取消', async ({ page }) => {
    await page.click('#sec-mgmt-cred');
    const dlg = page.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();
    /* 点 dialog 元素本身（遮罩区域） */
    await page.evaluate(() => {
      const d = document.getElementById('sec-verify-dlg');
      d.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(dlg).toBeHidden({ timeout: 5000 });
  });
});
