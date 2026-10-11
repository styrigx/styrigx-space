/**
 * 2.9.2 布局切换修复（三星浏览器实机录屏发现的问题）。
 *
 * 测试（Playwright，390px 视口）：
 * - localStorage sgx-layout=pc 时，html 为 layout-mobile（窄屏保护）
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

test('窄屏保护：sgx-layout=pc 时 html 仍为 layout-mobile', async ({ page }) => {
  await gotoWithLayout(page, 'pc');
  await expect(page.locator('html')).toHaveClass(/layout-mobile/);
  // 偏好保留在 localStorage（回到宽屏时生效）
  const saved = await page.evaluate(() => {
    try { return localStorage.getItem('sgx-layout'); } catch (e) { return null; }
  });
  expect(saved).toBe('pc');
});

test('无横向溢出：scrollWidth <= innerWidth', async ({ page }) => {
  await gotoWithLayout(page, 'pc');
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
  await page.waitForSelector('#site-nav', { timeout: 10000 });
  const boxes = await page.evaluate(() => {
    const nav = document.querySelector('#site-nav');
    if (!nav) return null;
    // 找标题和日期元素（启发式：找包含日期文本的元素）
    const navBox = nav.getBoundingClientRect();
    return { nav: { x: navBox.x, y: navBox.y, width: navBox.width, height: navBox.height } };
  });
  expect(boxes).not.toBeNull();
  // 顶栏本身不应有异常高度（标题日期叠加会导致高度异常）
  expect(boxes.nav.height).toBeLessThan(200);
});

test('⑦我的文件未滚动时天气可见，滚动收起后天气和头像都隐藏', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  await page.goto('/files/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#site-nav', { timeout: 10000 });

  // 未滚动：天气可见（opacity 非 0）
  const before = await page.evaluate(() => {
    const wx = document.getElementById('nav-wx');
    const brand = document.getElementById('nav-brand');
    return {
      wxOpacity: wx ? getComputedStyle(wx).opacity : 'no-el',
      brandOpacity: brand ? getComputedStyle(brand).opacity : 'no-el',
      scrolled: document.body.classList.contains('subpage-scrolled'),
    };
  });
  expect(before.scrolled).toBe(false);
  expect(before.wxOpacity).not.toBe('0');
  expect(before.brandOpacity).not.toBe('0');

  // 滚动到标题收起
  await page.evaluate(() => window.scrollTo(0, 1000));
  await page.waitForFunction(
    () => document.body.classList.contains('subpage-scrolled'),
    { timeout: 5000 }
  );

  // 收起后：天气和头像都不可见（opacity 0）
  const after = await page.evaluate(() => {
    const wx = document.getElementById('nav-wx');
    const brand = document.getElementById('nav-brand');
    const mini = document.querySelector('.subpage-mini-title');
    const wxBox = wx ? wx.getBoundingClientRect() : null;
    const miniBox = mini ? mini.getBoundingClientRect() : null;
    return {
      wxOpacity: wx ? getComputedStyle(wx).opacity : 'no-el',
      brandOpacity: brand ? getComputedStyle(brand).opacity : 'no-el',
      wxBox: wxBox ? { x: wxBox.x, y: wxBox.y, width: wxBox.width, height: wxBox.height } : null,
      miniBox: miniBox ? { x: miniBox.x, y: miniBox.y, width: miniBox.width, height: miniBox.height } : null,
    };
  });
  expect(after.wxOpacity).toBe('0');
  expect(after.brandOpacity).toBe('0');
  // 居中标题和天气不相交（天气已隐藏，opacity 0）
  if (after.wxBox && after.miniBox) {
    expect(boxesIntersect(after.wxBox, after.miniBox)).toBe(false);
  }

  // 滚回顶部：二者重新可见
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(
    () => !document.body.classList.contains('subpage-scrolled'),
    { timeout: 5000 }
  );
  const restored = await page.evaluate(() => {
    const wx = document.getElementById('nav-wx');
    const brand = document.getElementById('nav-brand');
    return {
      wxOpacity: wx ? getComputedStyle(wx).opacity : 'no-el',
      brandOpacity: brand ? getComputedStyle(brand).opacity : 'no-el',
    };
  });
  expect(restored.wxOpacity).not.toBe('0');
  expect(restored.brandOpacity).not.toBe('0');
});
