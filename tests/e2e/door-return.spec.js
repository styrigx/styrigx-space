/**
 * v1.1 C5：门内页返回目标 E2E（静态构建 + API mock，无需真实后端）。
 *
 * 覆盖（C1/C2）：
 * - 站长凭证门返回 → /settings/security/（C1，从哪里进门回哪里）
 * - 管理凭证索引页返回 → /settings/security/（C2，清票后跳）
 * - 锁屏子页返回 → /settings/security/mgmt/（C2）
 * - 应用子页返回 → /settings/security/mgmt/（C2）
 * - Book 子页返回 → /settings/security/apps/（C2，保持）
 *
 * 运行：npx playwright test --config=playwright.config.js door-return.spec.js
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

test.describe('v1.1 C5：门内页返回目标', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    /* 门内页探针通过：状态接口 + stepup status */
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
  });

  test('C1：站长凭证门返回 → /settings/security/', async ({ page }) => {
    await page.goto('/settings/security/owner/', { waitUntil: 'domcontentloaded' });
    /* 等管理区加载（探针通过） */
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    /* 点返回键（door.js 捕获监听 → clearStepupThen → 安全页） */
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/$/, { timeout: 10000 });
  });

  test('C2：管理凭证索引页返回 → /settings/security/', async ({ page }) => {
    await page.goto('/settings/security/mgmt/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mgmt-lock-sub')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/$/, { timeout: 10000 });
  });

  test('C2：锁屏子页返回 → /settings/security/mgmt/', async ({ page }) => {
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/mgmt\/$/, { timeout: 10000 });
  });

  test('C2：应用子页返回 → /settings/security/mgmt/', async ({ page }) => {
    await page.goto('/settings/security/apps/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#appmgr')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/mgmt\/$/, { timeout: 10000 });
  });

  test('C2：Book 子页返回 → /settings/security/apps/（保持）', async ({ page }) => {
    await page.goto('/settings/security/apps/book/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#bookmgr')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/apps\/$/, { timeout: 10000 });
  });
});

test.describe('v1.1 C2b：popstate 清票不误清', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
  });

  /* 直接派发 popstate 事件，验证目标判定逻辑（不依赖浏览器返回导航的时序）。
     目标在门内（mgmt/lock/apps/book）→ 不清票；目标在门外（安全页）→ 清票。 */
  test('C2b：popstate 目标在门内不清理，目标在门外才清', async ({ page }) => {
    let clearCount = 0;
    await page.route('**/api/stepup', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'clear') clearCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, valid: true }),
      });
    });

    await page.goto('/settings/security/mgmt/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mgmt-lock-sub')).toBeVisible({ timeout: 15000 });
    const clearBefore = clearCount;

    /* 目标在门内：锁屏子页 → 不清 */
    await page.evaluate(() => {
      const e = new PopStateEvent('popstate', { state: { url: 'https://styrigx.com/settings/security/lock/' } });
      window.dispatchEvent(e);
    });
    /* 等 handler 跑完（fetch 发出需一小会），再断言未清 */
    await page.waitForFunction(() => new Promise((resolve) => setTimeout(resolve, 500)), null, { timeout: 5000 });
    assertClearNotCalled(clearCount, clearBefore, 'popstate 目标为锁屏子页不应清票');

    /* 目标在门内：应用子页 → 不清 */
    await page.evaluate(() => {
      const e = new PopStateEvent('popstate', { state: { url: 'https://styrigx.com/settings/security/apps/' } });
      window.dispatchEvent(e);
    });
    await page.waitForFunction(() => new Promise((resolve) => setTimeout(resolve, 500)), null, { timeout: 5000 });
    assertClearNotCalled(clearCount, clearBefore, 'popstate 目标为应用子页不应清票');

    /* 目标在门内：Book 子页 → 不清 */
    await page.evaluate(() => {
      const e = new PopStateEvent('popstate', { state: { url: 'https://styrigx.com/settings/security/apps/book/' } });
      window.dispatchEvent(e);
    });
    await page.waitForFunction(() => new Promise((resolve) => setTimeout(resolve, 500)), null, { timeout: 5000 });
    assertClearNotCalled(clearCount, clearBefore, 'popstate 目标为 Book 子页不应清票');

    /* 目标在门内：索引页自身 → 不清 */
    await page.evaluate(() => {
      const e = new PopStateEvent('popstate', { state: { url: 'https://styrigx.com/settings/security/mgmt/' } });
      window.dispatchEvent(e);
    });
    await page.waitForFunction(() => new Promise((resolve) => setTimeout(resolve, 500)), null, { timeout: 5000 });
    assertClearNotCalled(clearCount, clearBefore, 'popstate 目标为索引页自身不应清票');

    /* 目标在门外：安全页 → 清 */
    await page.evaluate(() => {
      const e = new PopStateEvent('popstate', { state: { url: 'https://styrigx.com/settings/security/' } });
      window.dispatchEvent(e);
    });
    await expect.poll(async () => clearCount, { timeout: 2000 }).toBeGreaterThan(clearBefore);
  });

  test('C2b：索引页 → 锁屏子页 → 按钮返回 → 回索引页，不清票', async ({ page }) => {
    let clearCount = 0;
    await page.route('**/api/stepup', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'clear') clearCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, valid: true }),
      });
    });

    await page.goto('/settings/security/mgmt/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mgmt-lock-sub')).toBeVisible({ timeout: 15000 });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    const clearBefore = clearCount;

    /* 按钮返回 → 回索引页（整页跳转，门内页非 SPA） */
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/mgmt\/$/, { timeout: 10000 });
    await expect(page.locator('#mgmt-lock-sub')).toBeVisible({ timeout: 15000 });

    assertClearNotCalled(clearCount, clearBefore, '从锁屏按钮返回索引页不应清票');
  });
});

/** popstate 误清断言：clear 调用次数不应增加 */
function assertClearNotCalled(after, before, msg) {
  if (after > before) {
    throw new Error(msg + '（before=' + before + ', after=' + after + '）');
  }
}
