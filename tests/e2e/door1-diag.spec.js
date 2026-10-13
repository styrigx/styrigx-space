/**
 * #1 诊断手段 E2E（静态构建 + API mock，无需真实后端）。
 *
 * 覆盖：
 * - <html data-sgx-build> 构建标记存在（CI 测试构建为 "dev"，生产构建为短 SHA）
 * - 安全与隐私页底部 + 门内页显示小字构建标记
 * - 门内页跳转留痕：sessionStorage 有记录时安全页显示一次，刷新后消失
 *
 * 运行：npx playwright test --config=playwright.config.js door1-diag.spec.js
 * （默认 suite，走静态 public/ 构建；/api/* 用 page.route mock）
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

test.describe('#1 诊断：构建标记与跳转留痕', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    /* 语言钉住中文 */
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
  });

  test('<html> 有 data-sgx-build 构建标记', async ({ page }) => {
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    const sha = await page.getAttribute('html', 'data-sgx-build');
    expect(sha).toMatch(/^([0-9a-f]{7}|dev)$/);
  });

  test('安全与隐私页底部显示小字构建标记', async ({ page }) => {
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    const tag = page.locator('[data-testid="sgx-build-tag"]');
    await expect(tag).toBeVisible({ timeout: 15000 });
    await expect(tag).toHaveText(/^(构建|build) ([0-9a-f]{7}|dev)$/);
  });

  test('门内页（站长凭证）显示小字构建标记', async ({ page }) => {
    await page.goto('/settings/security/owner/', { waitUntil: 'domcontentloaded' });
    /* 探针无 mock 会失败留页，构建标记仍在 DOM 中 */
    const tag = page.locator('[data-testid="sgx-build-tag"]');
    await expect(tag).toHaveCount(1, { timeout: 15000 });
  });

  test('门内页跳转留痕：安全页显示一次，刷新后消失', async ({ page }) => {
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sec-mgmt-cred')).toBeVisible({ timeout: 15000 });
    /* 模拟门内页跳转前写入留痕 */
    await page.evaluate(() => {
      try {
        sessionStorage.setItem('sgx-last-jump', JSON.stringify({ who: 'probe-fail-back', reason: 'expired', at: Date.now() }));
      } catch (e) {}
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const note = page.locator('#sgx-jump-note');
    await expect(note).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#sgx-jump-note-text')).toHaveText(/上次门内跳转：probe-fail-back（expired）/);
    /* 取即清除：再刷新不再显示 */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-jump-note')).toBeHidden({ timeout: 15000 });
  });

  test('无跳转记录时不显示留痕条', async ({ page }) => {
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sec-mgmt-cred')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#sgx-jump-note')).toBeHidden();
  });
});
