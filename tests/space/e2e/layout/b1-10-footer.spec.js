/**
 * B1-10｜页脚（2026-11 UI 重设计 PR-1 重写：tmux 页脚，四站同一个 partials/sgx-footer.html）
 *
 * 取代 2026-10-22 起「版权只在关于本站显示」：现在每页底部都有一个 tmux 页脚 footer.sgx-foot：
 *   第一行 状态栏 = 会话 space · 窗口 0:home 1:blog …（当前窗口带 *）· 右边 状态 / 语言 / CST 时钟；
 *   第二行 © 年份 Sloan Gray · styrigx · rss · github · x · 联系。
 * 手机布局（360 / 412）只显示当前窗口、不显示语言；Powered by 一行仍然没有。页脚在正文之后、页面不横向滚动。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, scrolledTo, expect } = require('../helpers/helpers');

const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 412, height: 915 },
];

/* P4-3 PR-4c：英文无前缀、中文 /zh/。当前窗口同 NAVIGATE 当前项：主页 = 0:home，旷野页 /wild/ 和风格页 = 4:wild，安全 / 账号页没有当前项
   （对齐 PR-B：原 /status/ /about/ 并进 /wild/） */
const PAGES = [['/', 'home'], ['/theme/', 'wild'], ['/security/', null], ['/wild/', 'wild'], ['/zh/', 'home'], ['/zh/theme/', 'wild'], ['/zh/wild/', 'wild']];

for (const vp of VIEWPORTS) {
  for (const [path, win] of PAGES) {
    test(`B1-10 ${vp.width} ${path}：只有一个 tmux 页脚（© 行、当前窗口 ${win || '无'}），手机布局只显示当前窗口、不显示语言`, async ({ page }) => {
      await page.setViewportSize(vp);
      await blockExternalRequests(page);
      await freezeTime(page);
      await page.goto(path);
      await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('footer')).toHaveCount(1);
      await expect(page.locator('footer.sgx-foot')).toHaveCount(1);
      await expect(page.locator('.sgx-powered')).toHaveCount(0);
      await expect(page.locator('.sgx-foot-2')).toContainText(/©\s*\d{4}\s+Sloan Gray/);
      await expect(page.locator('.sgx-foot-ses')).toHaveText('space');
      /* 当前窗口（带 *）显示，其他窗口在手机布局藏起来 */
      const cur = page.locator('.sgx-foot-win a[aria-current="page"]');
      await expect(cur).toHaveCount(win ? 1 : 0);
      if (win) {
        await expect(cur).toHaveAttribute('data-win', win);
        await expect(cur).toBeVisible();
      }
      await expect(page.locator('.sgx-foot-win a:not([aria-current="page"])').first()).toBeHidden();
      await expect(page.locator('.sgx-foot-lang')).toBeHidden();
      await expect(page.locator('.sgx-foot-st')).toContainText('–/6');

      await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
      await scrolledTo(page);
      const m = await page.evaluate(() => {
        const f = document.querySelector('footer.sgx-foot').getBoundingClientRect();
        const main = document.querySelector('#sgx-main');
        return {
          top: f.top, bottom: f.bottom, left: f.left, right: f.right, vh: window.innerHeight, vw: window.innerWidth,
          mainBottom: main ? main.getBoundingClientRect().bottom : null,
          sw: document.scrollingElement.scrollWidth,
        };
      });
      expect(m.sw, '页面不横向滚动').toBeLessThanOrEqual(vp.width);
      /* 通栏：左右贴视口 */
      expect(Math.abs(m.left), `页脚左 ${m.left}`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.right - m.vw), `页脚右 ${m.right}`).toBeLessThanOrEqual(1);
      /* 滚到底完整可见，且在正文之后 */
      expect(m.top).toBeGreaterThanOrEqual(0);
      expect(m.bottom, `页脚底 ${m.bottom} 视口 ${m.vh}`).toBeLessThanOrEqual(m.vh + 1);
      if (m.mainBottom !== null) expect(m.top, `页脚顶 ${m.top} 正文底 ${m.mainBottom}`).toBeGreaterThanOrEqual(m.mainBottom - 1);
    });
  }
}

test('B1-10 1280 桌面布局：页脚显示全部窗口（当前带 *）和语言 zh · en；内容宽同顶栏', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.goto('/zh/');
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  const wins = page.locator('.sgx-foot-win a');
  expect(await wins.count()).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < await wins.count(); i++) await expect(wins.nth(i)).toBeVisible();
  await expect(page.locator('.sgx-foot-win a[aria-current="page"]')).toHaveAttribute('data-win', 'home');
  await expect(page.locator('.sgx-foot-lang')).toBeVisible();
  await expect(page.locator('.sgx-foot-lang [aria-current="true"]')).toHaveText('zh');
  await expect(page.locator('.sgx-foot-lang a[hreflang="en"]')).toHaveCount(1);
  const m = await page.evaluate(() => {
    const pad = (sel) => { const e = document.querySelector(sel); const cs = getComputedStyle(e); return [parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight)]; };
    return { foot: pad('footer.sgx-foot'), bar: pad('.sgx-topbar') };
  });
  expect(Math.abs(m.foot[0] - m.bar[0]), `页脚左内边距 ${m.foot[0]} 顶栏 ${m.bar[0]}`).toBeLessThanOrEqual(1);
  expect(Math.abs(m.foot[1] - m.bar[1]), `页脚右内边距 ${m.foot[1]} 顶栏 ${m.bar[1]}`).toBeLessThanOrEqual(1);
});
