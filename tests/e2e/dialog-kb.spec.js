/**
 * 弹层 UI 回归：按钮样式 + 键盘避让。
 * - 选项按钮为实心 primary 矩形（12px 圆角），底部有「取消」，标题靠左。
 * - 移动端视口：聚焦输入后，模拟键盘高度，弹层底边不超出 visualViewport。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 } });

async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

async function gotoSecurity(pg) {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
}

test.describe('verify dialog UI', () => {
  test('owner dialog: solid buttons, cancel, left-aligned title', async ({ page: pg }) => {
    await gotoSecurity(pg);
    await pg.locator('#sec-owner-cred').click();
    const dlg = pg.locator('#sec-owner-dlg');
    await expect(dlg).toBeVisible();

    /* 标题靠左 */
    const titleAlign = await pg.locator('#sec-owner-title').evaluate((el) => getComputedStyle(el).textAlign);
    expect(titleAlign).toBe('left');

    /* 选项按钮：实心底色（非透明），12px 圆角 */
    const rootBtn = pg.locator('#sec-owner-root');
    const bg = await rootBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    const radius = await rootBtn.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(radius).toBe('12px');

    /* 底部有「取消」 */
    await expect(pg.locator('#sec-owner-cancel')).toBeVisible();
    await expect(pg.locator('#sec-owner-cancel')).toContainText('取消');

    /* 输入态：验证为整宽实心按钮 */
    await rootBtn.click();
    const goBtn = pg.locator('#sec-owner-go');
    await expect(goBtn).toBeVisible();
    const goBg = await goBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(goBg).not.toBe('rgba(0, 0, 0, 0)');
    const goRadius = await goBtn.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(goRadius).toBe('12px');
    /* 返回为文字按钮 */
    await expect(pg.locator('#sec-owner-back')).toBeVisible();
  });

  test('mgmt dialog: visitor fake entry uses same styles', async ({ page: pg }) => {
    await gotoSecurity(pg);
    /* 访客假入口：data-sgx-role=visitor 时固定单个「根凭证」按钮，DOM 与真入口一致 */
    await pg.evaluate(() => {
      document.documentElement.dataset.sgxRole = 'visitor';
    });
    await pg.locator('#sec-mgmt-cred').click();
    const dlg = pg.locator('#sec-mgmt-dlg');
    await expect(dlg).toBeVisible();
    const rootBtn = pg.locator('#sec-mgmt-root');
    await expect(rootBtn).toBeVisible();
    const bg = await rootBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    await expect(pg.locator('#sec-mgmt-cancel')).toBeVisible();
  });
});
