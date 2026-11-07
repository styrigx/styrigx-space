/**
 * 手动桌面 + 手机屏（2026-11-07 Gray 真机：X 应用内浏览器没有「桌面版网站」开关，快捷面板选「桌面」只有顶栏出了页名胶囊，正文还是手机版）。
 * 共享外壳 layout-mode.js：偏好 = 桌面且屏幕短边 < 600 时 viewport 改成 width=980（同三星 / Chrome 桌面版网站的布局视口），
 * 首帧就是桌面宽、整页缩小显示；快捷面板里切进 / 切出「桌面」先关面板再整页重载。自动 / 手机偏好、电脑不动。
 * 首帧底色（同一个文件 __sgxFirstPaint）：color-scheme / theme-color 跟本站深浅色，<head> 最前面一条最低层的 html 底色——
 * 样式表没到时就是本站底色（不是浏览器白底），样式表到了照常按调色板。
 * 应用内浏览器（Android WebView）认不认 meta 宽度取决于宿主 App，这里只能验 Chromium 手机模式。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const ORIG = 'width=device-width, initial-scale=1';

async function go(page, { pref, theme, palette, path = '/zh/' } = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript((o) => {
    try {
      localStorage.setItem('sgx-lang', 'zh');
      if (o.pref && !sessionStorage.getItem('sgx-e2e-set')) { localStorage.setItem('sgx-layout', o.pref); sessionStorage.setItem('sgx-e2e-set', '1'); }
      if (o.theme) localStorage.setItem('sgx-theme-mode', o.theme);
      if (o.palette) localStorage.setItem('sgx-palette', o.palette);
    } catch (e) {}
  }, { pref, theme, palette });
  await page.goto(path, { waitUntil: 'load' });
}
const state = (page) => page.evaluate(() => ({
  meta: document.querySelector('meta[name="viewport"]').getAttribute('content'),
  w: innerWidth,
  layout: document.documentElement.getAttribute('data-sgx-layout'),
  scale: Math.round(visualViewport.scale * 100) / 100,
}));

test.describe('手机（412 宽，手机 UA）', () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA, colorScheme: 'light' });

  test('偏好 = 桌面：首帧 viewport 就是 980 宽，桌面布局、整页缩小显示', async ({ page }) => {
    await go(page, { pref: 'desktop' });
    const s = await state(page);
    expect(s.meta).toBe('width=980');
    expect(s.w).toBeGreaterThanOrEqual(980);
    expect(s.layout).toBe('desktop');
    expect(s.scale).toBeLessThan(0.5);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('data-sgx-vp', ORIG);
  });

  test('自动 / 手机偏好：viewport 不动（412 宽、手机布局）', async ({ page }) => {
    for (const pref of [null, 'phone']) {
      await go(page, { pref });
      expect(await state(page)).toEqual({ meta: ORIG, w: 412, layout: 'phone', scale: 1 });
    }
  });

  test('快捷面板切「桌面」：关面板、整页重载成 980 宽；切回「自动」还原 viewport', async ({ page }) => {
    await go(page);
    await page.locator('.sgx-tb-quick').click();
    await expect(page.locator('#sgx-qp')).toBeVisible();
    const histLen = await page.evaluate(() => history.length);
    await Promise.all([page.waitForEvent('load'), page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="desktop"]').click()]);
    await expect.poll(async () => (await state(page)).meta).toBe('width=980');
    expect((await state(page)).layout).toBe('desktop');
    expect(await page.evaluate(() => localStorage.getItem('sgx-layout'))).toBe('desktop');
    await expect(page.locator('#sgx-qp')).toBeHidden();
    /* 关面板时退掉了历史哨兵：重载后不在哨兵那一条上（返回键不多一步） */
    expect(await page.evaluate(() => history.state && history.state.sgxQp)).toBeFalsy();
    expect(await page.evaluate(() => history.length)).toBe(histLen);
    /* 切回自动：同样重载，viewport 还原 */
    await page.$eval('.sgx-tb-quick', (b) => /** @type {HTMLElement} */ (b).click());
    await expect(page.locator('#sgx-qp')).toBeVisible();
    await Promise.all([page.waitForEvent('load'), page.$eval('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]', (b) => /** @type {HTMLElement} */ (b).click())]);
    await expect.poll(async () => (await state(page)).meta).toBe(ORIG);
    expect((await state(page)).layout).toBe('phone');
  });

  test('首帧底色：本站深色、系统浅色，样式表没到 → color-scheme / theme-color 是深色，html 底色是深色（不是白底）', async ({ page }) => {
    await page.route(/\/css\/main\.[0-9a-f]+\.css$/, (r) => r.abort());
    await go(page, { theme: 'dark' });
    expect(await page.evaluate(() => document.querySelector('meta[name="color-scheme"]').getAttribute('content'))).toBe('dark');
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => m.getAttribute('content')))).toEqual(['#10151a', '#10151a']);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(10, 14, 16)');
    expect(await page.evaluate(() => document.head.firstElementChild && document.head.firstElementChild.id)).toBe('sgx-first-paint');
  });

  test('首帧底色只是最低层的兜底：样式表到了以后照常按调色板（换了调色板 = 那套的 bg-1，不是默认色）', async ({ page }) => {
    await go(page, { palette: 'lake' });
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'lake');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(240, 246, 252)');
  });
});

test.describe('电脑（1280 宽，桌面 UA）', () => {
  test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  test('偏好 = 桌面：viewport 不动', async ({ page }) => {
    await go(page, { pref: 'desktop' });
    const s = await state(page);
    expect(s.meta).toBe(ORIG);
    expect(s.w).toBe(1280);
    expect(s.layout).toBe('desktop');
  });
});
