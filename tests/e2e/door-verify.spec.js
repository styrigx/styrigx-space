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
    await page.locator('.sgx-door-expand input[type="password"]').fill('wrong-password');
    await page.locator('.sgx-door-actions .primary').click();
    await expect(page.locator('.sgx-door-err:not([hidden])').filter({ hasText: '密码不正确' }))
      .toBeVisible({ timeout: 8000 });
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
  });

  test('密码验证成功后先到管理凭证索引页（批次 A 收尾 D1）', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, { ok: true });
    await page.click('#sec-mgmt-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '站长密码' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('correct-password');
    await page.locator('.sgx-door-actions .primary').click();
    await page.waitForURL('**/settings/security/mgmt/', { timeout: 10000 });
  });

  test('根凭证验证成功后直接进站长凭证门内页', async ({ page }) => {
    await mockJson(page, '**/api/root-auth', 200, { ok: true });
    /* #1 诊断：根凭证成功后先预检 stepup 票据，valid 才进门。
       测试环境静态构建无 data-sgx-role，显式置 owner 走有会话路径。 */
    await page.evaluate(() => { document.documentElement.dataset.sgxRole = 'owner'; });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/root-session', 200, { ok: true });
    await page.click('#sec-owner-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await expect(page.locator('.sgx-door-row').filter({ hasText: '根凭证' })).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('test-root-key');
    await page.locator('.sgx-door-actions .primary').click();
    await page.waitForURL('**/settings/security/owner/**', { timeout: 10000 });
  });

  test('根凭证成功但 stepup 预检失败时弹层不关闭并显示原因', async ({ page }) => {
    await mockJson(page, '**/api/root-auth', 200, { ok: true });
    /* 有会话路径才做 stepup 预检：测试环境显式置 owner */
    await page.evaluate(() => { document.documentElement.dataset.sgxRole = 'owner'; });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: false, reason: 'expired' });
    await page.click('#sec-owner-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('test-root-key');
    await page.locator('.sgx-door-actions .primary').click();
    /* 弹层不关闭，行内错误显示接口、状态码、reason */
    const err = page.locator('.sgx-door-err:not([hidden])');
    await expect(err.filter({ hasText: '预检未通过' })).toBeVisible({ timeout: 8000 });
    await expect(err.filter({ hasText: 'POST /api/stepup' })).toBeVisible();
    await expect(err.filter({ hasText: 'expired' })).toBeVisible();
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    /* 未跳转，仍在安全页 */
    expect(page.url()).toContain('/settings/security/');
    expect(page.url()).not.toContain('/settings/security/owner/');
  });

  test('无会话时根凭证走换会话路径，不调 stepup 预检', async ({ page }) => {
    /* 未配锁引导场景：无 owner 会话（测试环境 data-sgx-role 缺席即无会话）。
       生产 middleware 对无会话的 /api/* 直接 401，预检必失败，
       因此无会话路径不得调 /api/stepup，先走 /api/root-session 换会话。 */
    await mockJson(page, '**/api/root-auth', 200, { ok: true });
    let stepupCalls = 0;
    await page.route('**/api/stepup', async (route) => {
      stepupCalls++;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false }),
      });
    });
    await mockJson(page, '**/api/root-session', 200, { ok: true });
    await page.click('#sec-owner-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('test-root-key');
    await page.locator('.sgx-door-actions .primary').click();
    /* 换会话成功后直接进门，不应被预检拦住 */
    await page.waitForURL('**/settings/security/owner/**', { timeout: 10000 });
    expect(stepupCalls).toBe(0);
  });

  test('点遮罩不关闭弹层，只有 × 或取消关闭（批次 A 收尾 A1/A3）', async ({ page }) => {
    await page.click('#sec-mgmt-cred');
    const dlg = page.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();
    /* 点 dialog 元素本身（遮罩区域）→ 弹层保留 */
    await page.evaluate(() => {
      const d = document.getElementById('sec-verify-dlg');
      d.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(dlg).toBeVisible({ timeout: 5000 });
    /* 点 × 关闭 */
    await page.locator('#sec-verify-close').click();
    await expect(dlg).toBeHidden({ timeout: 5000 });
  });

  test('密码输错一次后改对再点验证能成功（bindSubmitButton 去重修复）', async ({ page }) => {
    /* bindSubmitButton 回归：第一次提交失败后，按钮必须还能再次提交。
       旧实现 fired 标志永不重置，第二次点击完全没反应。 */
    let stepupCalls = 0;
    await page.route('**/api/stepup', async (route) => {
      stepupCalls++;
      if (stepupCalls === 1) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'auth' }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      }
    });
    await page.click('#sec-mgmt-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '站长密码' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('wrong-password');
    await page.locator('.sgx-door-actions .primary').click();
    await expect(page.locator('.sgx-door-err:not([hidden])').filter({ hasText: '密码不正确' }))
      .toBeVisible({ timeout: 8000 });
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    /* 改对后再次点击验证，必须再次提交并成功进门 */
    await page.locator('.sgx-door-expand input[type="password"]').fill('correct-password');
    await page.locator('.sgx-door-actions .primary').click();
    await page.waitForURL('**/settings/security/mgmt/', { timeout: 10000 });
    expect(stepupCalls).toBe(2);
  });

  test('键盘按下验证只提交一次（批次 A 收尾：pointerup + click 去重）', async ({ page }) => {
    let authCalls = 0;
    await page.route('**/api/root-auth', async (route) => {
      authCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.evaluate(() => { document.documentElement.dataset.sgxRole = 'owner'; });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/root-session', 200, { ok: true });
    await page.click('#sec-owner-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('test-root-key');
    /* 聚焦验证按钮，按 Enter → 只提交一次（click 兜底，pointerup 未触发时不重复） */
    await page.locator('.sgx-door-actions .primary').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/settings/security/owner/**', { timeout: 10000 });
    expect(authCalls).toBe(1);
  });
});
