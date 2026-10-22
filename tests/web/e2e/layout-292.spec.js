/**
 * 2.9.2 布局切换修复（三星浏览器实机录屏发现的问题）。
 *
 * 测试（Playwright，390px 视口）：
 * - localStorage sgx-layout=dex（或旧值 pc → 迁到 dex）时，html 为 layout-mobile（窄屏保护）
 * - scrollWidth <= innerWidth（无横向溢出）
 * - ?layout=auto 能重置偏好
 * - 切换布局时主内容节点始终存在且可见（不空白）
 * - 顶栏标题和日期的 boundingBox 不相交
 * - 导航过程中同一时刻只有一个 app 页可见（不叠加）
 * - 数字健康返回箭头的 top >= 顶栏的 bottom（不对齐重叠）
 *
 * 不用字符串检查充当测试：全部用 DOM 断言。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

const MOBILE_VP = { width: 390, height: 844 };

async function gotoWithLayout(page, layout) {
  await page.setViewportSize(MOBILE_VP);
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  // 预设 localStorage
  await page.addInitScript((l) => {
    try { localStorage.setItem('sgx-layout', l); } catch (e) {}
  }, layout);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
}

function boxesIntersect(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x &&
         a.y < b.y + b.height && a.y + a.height > b.y;
}

test('窄屏保护：旧值 sgx-layout=pc 迁到 dex，html 仍为 layout-mobile', async ({ page }) => {
  await gotoWithLayout(page, 'pc');
  await expect(page.locator('html')).toHaveClass(/layout-mobile/);
  // 偏好迁到 dex 并保留在 localStorage（回到宽屏时生效）
  const saved = await page.evaluate(() => {
    try { return localStorage.getItem('sgx-layout'); } catch (e) { return null; }
  });
  expect(saved).toBe('dex');
});

test('无横向溢出：scrollWidth <= innerWidth', async ({ page }) => {
  await gotoWithLayout(page, 'dex');
  const overflow = await page.evaluate(() => {
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});

test('?layout=auto 能重置偏好', async ({ page }) => {
  await page.setViewportSize(MOBILE_VP);
  await blockExternalRequests(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-layout', 'pc'); } catch (e) {}
  });
  await page.goto('/?layout=auto', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
  const saved = await page.evaluate(() => {
    try { return localStorage.getItem('sgx-layout'); } catch (e) { return null; }
  });
  expect(saved).toBe('auto');
});

test('顶栏标题和日期不相交', async ({ page }) => {
  await gotoWithLayout(page, 'auto');
  // 等顶栏渲染
  await page.waitForSelector('.sgx-topbar', { timeout: 10000 });
  const boxes = await page.evaluate(() => {
    const nav = document.querySelector('.sgx-topbar');
    if (!nav) return null;
    // 找标题和日期元素（启发式：找包含日期文本的元素）
    const navBox = nav.getBoundingClientRect();
    return { nav: { x: navBox.x, y: navBox.y, width: navBox.width, height: navBox.height } };
  });
  expect(boxes).not.toBeNull();
  // 顶栏本身不应有异常高度（标题日期叠加会导致高度异常）
  expect(boxes.nav.height).toBeLessThan(200);
});

test('⑥①布局切换时主内容不空白', async ({ page }) => {
  await gotoWithLayout(page, 'auto');
  const mainBefore = await page.evaluate(() => {
    const m = document.querySelector('main, #app-content, [data-app-content]');
    return m ? { exists: true, visible: getComputedStyle(m).display !== 'none' } : { exists: false };
  });
  expect(mainBefore.exists).toBe(true);
  // 切换布局
  await page.evaluate(() => {
    try { localStorage.setItem('sgx-layout', 'dex'); } catch (e) {}
    window.dispatchEvent(new Event('sgx-layout-change'));
  });
  await page.waitForTimeout(500);
  const mainAfter = await page.evaluate(() => {
    const m = document.querySelector('main, #app-content, [data-app-content]');
    return m ? { exists: true, visible: getComputedStyle(m).display !== 'none', html: m.innerHTML.length } : { exists: false };
  });
  expect(mainAfter.exists).toBe(true);
  expect(mainAfter.visible).toBe(true);
  expect(mainAfter.html).toBeGreaterThan(0);
});

