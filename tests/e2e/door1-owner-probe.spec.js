/**
 * #1 站长凭证门进门探针 E2E（定稿 v1.3）。
 *
 * 复现真实顺序：已配 lockkey、已配 ownerkey（设备上没有）→ lockkey 解锁得站长会话
 * → 站长凭证用根凭证验证 → 停在门内页并能列出、删除 ownerkey。
 *
 * 探针必须同时验证「会话 + 门票据」：
 * - 会话有效但票据无效 → 探针失败，留在门内页显示原因（接口、状态码、服务端 reason），
 *   不自动跳转。（修前：探针只验会话，页面进入后门内 API 全部 403，用户被动等待）
 * - 会话 + 票据都有效 → 停在门内页，列出 ownerkey，可删除。
 *
 * 运行：npx playwright test --config=playwright.config.js door1-owner-probe.spec.js
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

test.describe('#1 owner door probe', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
  });

  test('会话有效但票据无效 → 弹验证过期框（不跳转），点按钮才回安全页；门内内容不渲染', async ({ page }) => {
    /* 会话有效 */
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: false, passkey: true });
    /* 票据无效（过期） */
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: false, reason: 'expired' });

    await page.goto('/settings/security/owner/', { waitUntil: 'domcontentloaded' });

    /* A-1：探针发现票据无效 → 验证过期弹框，不自动跳转 */
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 10000 });
    await expect(dlg).toContainText('请返回安全与隐私重新验证');
    await expect(dlg.locator('button.sgx-verify-skip')).toHaveText('返回安全与隐私');
    /* 不点不跳 */
    await expect(page).toHaveURL(/\/settings\/security\/owner\//);

    /* 锁屏遮罩已移除 */
    await expect(page.locator('#sgx-lock')).toHaveCount(0);

    /* 探针未通过 → 门内容器保持隐藏，DOM 里没有门内内容（无删除按钮、无已设置文案） */
    await expect(page.locator('#lockmgr')).toBeHidden();
    await expect(page.locator('#lockmgr-pwdel')).toBeHidden();
    await expect(page.locator('#lockmgr-pwsub')).toBeHidden();

    /* 点按钮才跳转（clearStepupThen → 安全页） */
    await dlg.locator('button.sgx-verify-skip').click();
    await expect(page).toHaveURL(/\/settings\/security\/?$/, { timeout: 10000 });
  });

  test('会话 + 票据都有效 → 停在门内页，列出 ownerkey，可删除', async ({ page }) => {
    /* 会话有效 */
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: false, passkey: true });
    /* 票据有效 */
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });

    const ownerKeys = [
      { credId: 'testcredid01', name: 'Test Owner Key', class: 'owner', createdAt: Date.now() },
    ];
    /* 列出 ownerkey（scope=root） */
    await page.route('**/api/owner-passkey', async (route) => {
      const req = route.request();
      let action = '';
      try {
        const post = req.postDataJSON();
        action = post && post.action;
      } catch (e) {}
      if (action === 'list') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, keys: ownerKeys, scope: 'root' }),
        });
      } else if (action === 'remove') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/settings/security/owner/', { waitUntil: 'domcontentloaded' });

    /* 停在门内页，不跳走 */
    await expect(page).toHaveURL(/\/settings\/security\/owner\//, { timeout: 10000 });
    /* 5 秒后仍在门内页（没有被 needVerify 踢回） */
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/settings\/security\/owner\//);

    /* 列表显示 ownerkey（名字在 input 的 value 里） */
    const keyInput = page.locator('.lockmgr-pkitem input').first();
    await expect(keyInput).toBeVisible({ timeout: 10000 });
    await expect(keyInput).toHaveValue('Test Owner Key');
  });

  test('探针网络失败 → 留在门内页显示「网络连接失败」（不跳转）', async ({ page }) => {
    /* /api/owner-status 直接 abort（模拟网络失败） */
    await page.route('**/api/owner-status', async (route) => {
      await route.abort();
    });

    await page.goto('/settings/security/owner/', { waitUntil: 'domcontentloaded' });

    /* 留在门内页 */
    await expect(page).toHaveURL(/\/settings\/security\/owner\//, { timeout: 10000 });
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/settings\/security\/owner\//);

    /* 失败面板显示网络原因，不是「会话过期」 */
    const panel = page.locator('#sgx-probe-fail');
    await expect(panel).toBeVisible({ timeout: 10000 });
    await expect(panel.filter({ hasText: '网络连接失败' })).toBeVisible();
    await expect(panel.filter({ hasText: '会话过期' })).toHaveCount(0);
  });
});
