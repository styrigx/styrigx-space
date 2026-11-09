/**
 * B1-12 守护测试（只加测试，不改功能）。
 *
 * 覆盖（任务书 B1-12）：
 * - 页面切换过程中：顶栏、大标题、← 同一时刻都只有 1 个。
 * - （锁屏凭证页「添加通行密钥」那两条随进站 v3 L1 删除：安全页 /security/lock/ 已删，盾牌加通行密钥见 topbar/shield.spec.js；
 *   密码自动填充那条 2026-11-08 随账号终端搬到 account/session.spec.js）
 *
 * 运行：npx playwright test --config=playwright.config.js b1-12-guard.spec.js
 * （默认 suite，走静态 public/ 构建；/api/* 用 page.route mock）
 *
 * Hark：等具体元素，不用 waitForTimeout/networkidle。
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('../helpers/helpers');

test.describe('B1-12 守护：页面切换唯一性', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
  });

  test('顶栏、大标题同一时刻都只有 1 个，没有 ←', async ({ page }) => {
    /* 旷野页（/）长条里是标签（P4-3 PR-4b 起只剩「旷野」一个），没有页名；所以用子页 */
    const pages = ['/wild/']; /* 对齐 PR-B：原 /about/ 并进 /wild/；对齐 PR-C：风格页 /theme/ 退役；进站 v3 L1：/security/ 已删 */
    for (const url of pages) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      /* 等页面稳定：顶栏可见 */
      await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });

      /* 顶栏只有 1 个 */
      await expect(page.locator('#site-nav')).toHaveCount(1);
      /* 2026-10-20 通版顶栏：没有大标题区；页名只在顶栏长条里，只有 1 个 */
      await expect(page.locator('.subpage-title, [data-subpage-head]')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-title')).toHaveCount(1);
      /* 2026-10-20：顶栏 ‹ 返回已删除（用浏览器 / 系统返回），一个都没有 */
      await expect(page.locator('[data-go-back]')).toHaveCount(0);
    }
  });
});
