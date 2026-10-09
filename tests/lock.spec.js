/**
 * Hark：锁屏专用测试（与视觉回归/Lighthouse 分离）。
 * - 未解锁时锁屏覆盖内容（无法交互）
 * - ?lock=1 强制触发锁屏
 * - Turnstile 验证卡行为
 * - 锁屏基准截图
 *
 * 注意：这些测试需要锁屏启用的构建（生产构建）；CI 的 visual/Lighthouse
 * 用 SGX_TEST_NO_LOCK=1 的构建，两者分离。
 */
const { test, expect } = require('@playwright/test');

test.describe('lock screen', () => {
  test('?lock=1 forces lock screen on any page', async ({ page }) => {
    await page.goto('/?lock=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const lock = page.locator('#sgx-lock');
    await expect(lock).toBeVisible();
    /* 锁屏覆盖内容：主内容不可见/不可点 */
    const main = page.locator('main, #app-grid').first();
    if (await main.count()) {
      /* 锁屏是全屏覆盖，main 应被遮挡 */
      const box = await lock.boundingBox();
      expect(box.width).toBeGreaterThan(300);
    }
  });

  test('lock screen baseline screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await page.goto('/?lock=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page).toHaveScreenshot('lock-screen.png', { animations: 'disabled' });
  });

  test('avatar click opens verify dialog (local fallback)', async ({ page }) => {
    /* localhost → 直接解锁（无 Turnstile），验证兜底路径 */
    await page.goto('/?lock=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.click('#sgx-lock-avatar');
    await page.waitForTimeout(1000);
    /* 本地应直接解锁，锁屏消失 */
    const lock = page.locator('#sgx-lock');
    await expect(lock).toBeHidden({ timeout: 5000 });
    /* session 标记已写 */
    const shown = await page.evaluate(() => {
      try { return sessionStorage.getItem('sgx-lock-shown'); } catch (e) { return null; }
    });
    expect(shown).toBe('1');
  });

  test('password link opens password dialog', async ({ page }) => {
    await page.goto('/?lock=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const pwlink = page.locator('#sgx-lock-pwlink');
    await expect(pwlink).toBeVisible();
    await pwlink.click();
    await page.waitForTimeout(600);
    const dlg = page.locator('.sgx-verify-dlg');
    await expect(dlg).toBeVisible();
    /* 密码框存在 */
    await expect(page.locator('#sgx-pw-input')).toBeVisible();
  });

  test('wrong password shows error (no password set)', async ({ page }) => {
    await page.goto('/?lock=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.click('#sgx-lock-pwlink');
    await page.waitForTimeout(600);
    await page.fill('#sgx-pw-input', 'wrongpassword123');
    await page.click('#sgx-pw-go');
    await page.waitForTimeout(1500);
    /* 未设置密码 → 应提示（not-set 或 wrong，取决于后端） */
    const err = page.locator('#sgx-pw-err');
    await expect(err).toBeVisible();
  });
});
