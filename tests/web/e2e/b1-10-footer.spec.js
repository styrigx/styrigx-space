/**
 * B1-10｜页脚（2026-10-22 重写）
 *
 * 用户定：版权「© 年份 Sloan Gray」不再每页显示（Powered by 一行已删），
 * 只留在「设置 › 关于本站」，紧跟卡片下方，不沉到视口底。
 * 覆盖：关于页（中 / 英）有页脚且紧跟卡片；主页、设置、设置子页、聊天、状态没有页脚。360 / 412 两种宽度。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, scrolledTo, expect } = require('./helpers');

const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 412, height: 915 },
];

const NO_FOOTER = ['/', '/settings/', '/settings/display/', '/chat/', '/account/status/', '/en/settings/'];
const ABOUT = ['/settings/about/', '/en/settings/about/'];

for (const vp of VIEWPORTS) {
  for (const path of NO_FOOTER) {
    test(`B1-10 ${vp.width} ${path}：没有版权页脚`, async ({ page }) => {
      await page.setViewportSize(vp);
      await blockExternalRequests(page);
      await freezeTime(page);
      await page.goto(path);
      await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('footer')).toHaveCount(0);
      await expect(page.locator('.sgx-powered')).toHaveCount(0);
    });
  }
  for (const path of ABOUT) {
    test(`B1-10 ${vp.width} ${path}：页脚紧跟卡片、完整可见`, async ({ page }) => {
      await page.setViewportSize(vp);
      await blockExternalRequests(page);
      await freezeTime(page);
      await page.goto(path);
      await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
      const copy = page.locator('footer p').first();
      await expect(copy).toHaveText(/©\s*\d{4}–\d{4} Sloan Gray/);
      await expect(page.locator('footer p')).toHaveCount(1);
      await expect(page.locator('.sgx-powered')).toHaveCount(0);

      await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
      /* 等滚到底真正落地（含 CSS smooth 滚动） */
      await scrolledTo(page);
      const m = await page.evaluate(() => {
        const main = document.querySelector('#sgx-main .widget').getBoundingClientRect();
        const first = document.querySelector('footer p').getBoundingClientRect();
        const last = first;
        return { mainBottom: main.bottom, firstTop: first.top, lastBottom: last.bottom, vh: window.innerHeight };
      });
      expect(m.firstTop).toBeGreaterThanOrEqual(0);
      expect(m.lastBottom, `页脚底 ${m.lastBottom} 视口 ${m.vh}`).toBeLessThanOrEqual(m.vh);
      // 紧跟卡片：© 行离关于卡片底不超过 64px（不再被 flex 推到视口底）
      expect(m.firstTop - m.mainBottom, `间距 ${m.firstTop - m.mainBottom}`).toBeLessThanOrEqual(64);
    });
  }
}
