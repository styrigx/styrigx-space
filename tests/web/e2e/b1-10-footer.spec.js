/**
 * B1-10｜页脚 © 被底部搜索胶囊遮挡（验收重写）
 *
 * 要求：带底部搜索胶囊的页面，滚到底时页脚（© 行 + Powered by 行）完整可见，
 *      页脚最后一行的底边 ≤ 胶囊顶边 - 16px。
 * 旧版选的是 main .set-layout 里的 p.text-xs，根本不是真正的页脚（页脚是 baseof 里的 <footer>），
 * 所以那两条“通过”等于没测。这里直接量 <footer> 里的两行文字。
 * 覆盖：设置主页、设置子页，360 / 412 两种宽度。
 * 2026-10-20：设置搜索删除，设置页不再有底部搜索胶囊：改为断言没有胶囊、滚到底页脚完整在视口内（cap: null）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 412, height: 915 },
];

const PAGES = [
  { path: '/settings/', cap: null },
  { path: '/settings/display/', cap: null },
];

for (const vp of VIEWPORTS) {
  for (const p of PAGES) {
    test(`B1-10 ${vp.width} ${p.path}：滚到底页脚完整可见${p.cap ? '，距胶囊 ≥16px' : '（没有底部胶囊）'}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await blockExternalRequests(page);
      await freezeTime(page);
      await page.goto(p.path);

      if (p.cap) await expect(page.locator(p.cap)).toBeVisible({ timeout: 15000 });
      else {
        await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('.sgx-cap')).toHaveCount(0);
      }
      const copy = page.locator('footer p').first();
      const powered = page.locator('footer .sgx-powered');
      await expect(copy).toHaveText(/©\s*\d{4}–\d{4} Sloan Gray/);
      await expect(powered).toHaveCount(1);

      // 滚到底，等布局稳定（两次读数一致）
      await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
      await expect.poll(async () => {
        const a = await page.evaluate(() => window.scrollY);
        await page.waitForTimeout(150);
        const b = await page.evaluate(() => window.scrollY);
        return a === b;
      }).toBe(true);
      await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));

      const m = await page.evaluate(([capSel]) => {
        const c = capSel ? document.querySelector(capSel).getBoundingClientRect() : { top: window.innerHeight + 16 };
        const ps = document.querySelectorAll('footer p');
        const first = ps[0].getBoundingClientRect();
        const last = document.querySelector('footer .sgx-powered').getBoundingClientRect();
        return { capTop: c.top, firstTop: first.top, lastBottom: last.bottom, vh: window.innerHeight };
      }, [p.cap]);

      // 两行都在视口里
      expect(m.firstTop, `© 行顶 ${m.firstTop}`).toBeGreaterThanOrEqual(0);
      expect(m.lastBottom, `页脚底 ${m.lastBottom} 视口 ${m.vh}`).toBeLessThanOrEqual(m.vh);
      // 页脚底 ≤ 胶囊顶 - 16
      expect(m.lastBottom, `页脚底 ${m.lastBottom}，胶囊顶 ${m.capTop}`).toBeLessThanOrEqual(m.capTop - 16);
    });
  }
}
