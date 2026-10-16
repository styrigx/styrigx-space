/**
 * B1-10｜页脚 © 被底部搜索胶囊遮挡
 *
 * 要求：滚到底时页脚完整可见，与胶囊之间至少留 16px。
 * 做法：有底部胶囊的页面给 main 底部加 padding-bottom = 胶囊高度 + 底部安全区 + 16px
 *      （用 CSS 变量 --sgx-bottom-dock-h，胶囊和留白共用）。
 * 验收：滚到底，页脚 bounding box 底部 ≤ 胶囊顶部 - 16。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 412, height: 915 },
];

for (const vp of VIEWPORTS) {
  test(`B1-10 ${vp.width}：滚到底页脚不被胶囊遮挡（≥16px 间隙）`, async ({ page }) => {
    await page.setViewportSize(vp);
    await blockExternalRequests(page);
    await freezeTime(page);

    // 设置页（带底部胶囊）
    await page.goto('/settings/');
    await expect(page.locator('#sgx-cap-settings')).toBeVisible();

    // 滚到底
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);

    // 页脚版权文字（在 main 内 .set-layout 底部）
    const footerBox = await page.locator('main .set-layout p.text-xs').last().boundingBox();
    const capBox = await page.locator('#sgx-cap-settings').boundingBox();

    expect(footerBox).not.toBeNull();
    expect(capBox).not.toBeNull();

    const footerBottom = footerBox.y + footerBox.height;
    const capTop = capBox.y;

    // 页脚底 ≤ 胶囊顶 - 16
    expect(footerBottom).toBeLessThanOrEqual(capTop - 16);
  });
}
