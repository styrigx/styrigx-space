/* B1-1｜立即锁定误触防护验收测试
 *
 * 验收标准（任务书）：
 * 1. 取消后同一位置再点不触发
 * 2. 上下滑动（touchmove）后抬手不触发
 * 3. 确认后才发 /api/lock
 * 4. 锁定过程中主页 DOM 不出现（无 --:-- 时钟节点）
 * 5. Space 键不触发（只认 Enter）
 */
import { test, expect } from '@playwright/test';

const SECURITY_URL = '/settings/security/';

/* 拦截 /api/lock，记录是否被调用 */
async function trackLockApi(page) {
  let called = false;
  await page.route('**/api/lock', async (route) => {
    called = true;
    await route.fulfill({ status: 200, body: '{}' });
  });
  return () => called;
}

/* 进入安全页并等待加载 */
async function gotoSecurity(page) {
  await page.goto(SECURITY_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sec-locknow')).toBeVisible({ timeout: 15000 });
}

test.describe('B1-1 立即锁定', () => {
  test('点立即锁定先弹确认层（标题/说明/取消/锁定）', async ({ page }) => {
    await gotoSecurity(page);
    await page.locator('#sec-locknow').click();
    const dlg = page.locator('#sec-locknow-confirm');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('立即锁定？');
    await expect(dlg).toContainText('当前设备会回到锁屏');
    await expect(dlg.locator('[data-act="cancel"]')).toContainText('取消');
    await expect(dlg.locator('[data-act="ok"]')).toContainText('锁定');
  });

  test('取消后 400ms 内同位置再点不触发（防误触）', async ({ page }) => {
    const wasCalled = await trackLockApi(page);
    await gotoSecurity(page);
    const btn = page.locator('#sec-locknow');
    await btn.click();
    const dlg = page.locator('#sec-locknow-confirm');
    await expect(dlg).toBeVisible();
    /* 点取消 */
    await dlg.locator('[data-act="cancel"]').click();
    await expect(dlg).toBeHidden();
    /* 400ms 内在同一位置再点，不应再弹确认层 */
    const box = await btn.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(100);
    await expect(page.locator('#sec-locknow-confirm')).toBeHidden();
    expect(wasCalled()).toBe(false);
  });

  test('点背景关闭确认层', async ({ page }) => {
    await gotoSecurity(page);
    await page.locator('#sec-locknow').click();
    const dlg = page.locator('#sec-locknow-confirm');
    await expect(dlg).toBeVisible();
    /* 点 dialog 背景（dialog 元素本身，非卡片）关闭 */
    await page.mouse.click(10, 10);
    await expect(dlg).toBeHidden();
  });

  test('确认后才发 /api/lock', async ({ page }) => {
    const wasCalled = await trackLockApi(page);
    await gotoSecurity(page);
    /* 只点开确认层，不点锁定 */
    await page.locator('#sec-locknow').click();
    await expect(page.locator('#sec-locknow-confirm')).toBeVisible();
    await page.waitForTimeout(500);
    expect(wasCalled()).toBe(false);
    /* 点锁定后才发 */
    await page.locator('#sec-locknow-confirm [data-act="ok"]').click();
    await page.waitForTimeout(500);
    expect(wasCalled()).toBe(true);
  });

  test('Space 键不触发，只认 Enter', async ({ page }) => {
    await gotoSecurity(page);
    const btn = page.locator('#sec-locknow');
    await btn.focus();
    /* Space 不应弹确认层 */
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    await expect(page.locator('#sec-locknow-confirm')).toBeHidden();
    /* Enter 应该弹确认层 */
    await page.keyboard.press('Enter');
    await expect(page.locator('#sec-locknow-confirm')).toBeVisible();
  });

  test('锁定过程中不出现 --:-- 时钟（用 location.replace）', async ({ page }) => {
    await trackLockApi(page);
    await gotoSecurity(page);
    await page.locator('#sec-locknow').click();
    await page.locator('#sec-locknow-confirm [data-act="ok"]').click();
    /* location.replace 到 /?lock=1，中间不应渲染主页（含 --:-- 时钟） */
    await page.waitForURL('**/?lock=1', { timeout: 10000 });
    /* 主页时钟节点不应出现 */
    await expect(page.locator('text=--:--')).toHaveCount(0);
  });
});
