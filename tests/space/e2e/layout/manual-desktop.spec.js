/**
 * 手动桌面 + 手机屏（2026-11-07 Gray 真机：X 应用内浏览器没有「桌面版网站」开关，快捷面板选「桌面」只有顶栏出了页名胶囊，正文还是手机版）。
 * 共享外壳 layout-mode.js：偏好 = 桌面且屏幕短边 < 600 时 viewport 改成 width=980（同三星 / Chrome 桌面版网站的布局视口），
 * 首帧就是桌面宽、整页缩小显示；快捷面板里切进 / 切出「桌面」原地改 viewport（不重载、不白闪），没生效才整页重载（重载前把页面底色交给下一页首帧）。自动 / 手机偏好、电脑不动。
 * 首帧底色（同一个文件 __sgxFirstPaint）：color-scheme / theme-color 跟本站深浅色，<head> 最前面一条最低层的 html 底色——
 * 样式表没到时就是本站底色（不是浏览器白底），样式表到了照常按调色板。
 * 应用内浏览器（Android WebView）认不认 meta 宽度取决于宿主 App，这里只能验 Chromium 手机模式。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const ORIG = 'width=device-width, initial-scale=1';

async function go(page, { pref, palette, path = '/zh/' } = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript((o) => {
    try {
      localStorage.setItem('sgx-lang', 'zh');
      if (o.pref && !sessionStorage.getItem('sgx-e2e-set')) { localStorage.setItem('sgx-layout', o.pref); sessionStorage.setItem('sgx-e2e-set', '1'); }
      if (o.palette) localStorage.setItem('sgx-palette', o.palette);
    } catch (e) {}
  }, { pref, palette });
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

  test('NAVIGATE 面板切「桌面」：原地改成 980 宽、不整页重载（不白闪），面板还开着；切回「自动」原地还原 viewport', async ({ page }) => {
    await go(page);
    await page.evaluate(() => { /** @type {any} */ (window).__sgxNoReload = 1; });
    let loads = 0;
    page.on('load', () => { loads++; });
    /* 顶栏 v3（2026-11 PR-1）：布局分段在 NAVIGATE（>_）面板里 */
    await page.locator('.sgx-tb-grid').click();
    await expect(page.locator('#sgx-nav')).toBeVisible();
    await page.locator('#sgx-nav [data-qp-seg="layout"] [data-v="desktop"]').click();
    await expect.poll(async () => (await state(page)).layout).toBe('desktop');
    const s = await state(page);
    expect(s.meta).toBe('width=980');
    expect(s.w).toBeGreaterThanOrEqual(980);
    expect(s.scale).toBeLessThan(0.5);
    expect(await page.evaluate(() => localStorage.getItem('sgx-layout'))).toBe('desktop');
    /* 同一个文档（没重载）：标记还在，面板还开着、选中「桌面」 */
    expect(await page.evaluate(() => /** @type {any} */ (window).__sgxNoReload)).toBe(1);
    await expect(page.locator('#sgx-nav')).toBeVisible();
    await expect(page.locator('#sgx-nav [data-qp-seg="layout"] [data-v="desktop"]')).toHaveAttribute('aria-pressed', 'true');
    /* 切回自动：同样原地，viewport 还原、手机布局 */
    await page.$eval('#sgx-nav [data-qp-seg="layout"] [data-v="auto"]', (b) => /** @type {HTMLElement} */ (b).click());
    await expect.poll(async () => (await state(page)).meta).toBe(ORIG);
    await expect.poll(async () => (await state(page)).layout).toBe('phone');
    expect(await state(page)).toEqual({ meta: ORIG, w: 412, layout: 'phone', scale: 1 });
    expect(await page.evaluate(() => /** @type {any} */ (window).__sgxNoReload)).toBe(1);
    expect(loads).toBe(0);
  });

  test('重载兜底不白闪：sessionStorage sgx-fp-bg 里是重载前的页面底色，样式表没到时首帧就用它，用一次就删', async ({ page }) => {
    await go(page);
    await page.route(/\/css\/main\.[0-9a-f]+\.css$/, (r) => r.abort());
    await page.evaluate(() => sessionStorage.setItem('sgx-fp-bg', 'rgb(240, 246, 252)'));
    await page.reload({ waitUntil: 'load' });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(240, 246, 252)');
    expect(await page.evaluate(() => sessionStorage.getItem('sgx-fp-bg'))).toBeNull();
    /* 不是 rgb() 的值不认（不往样式里拼任意字符串） */
    await page.evaluate(() => sessionStorage.setItem('sgx-fp-bg', 'red}html{color:red'));
    await page.reload({ waitUntil: 'load' });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(22, 20, 18)'); /* 调色板 v4：默认访客 = terra（深套），首帧底 #161412 */
  });

  test('首帧底色（调色板 v4）：深套 lake、系统浅色，样式表没到 → color-scheme / theme-color 是这套的深色，html 底色 = 这套 bg-1（不是白底）', async ({ page }) => {
    await page.route(/\/css\/main\.[0-9a-f]+\.css$/, (r) => r.abort());
    await go(page, { palette: 'lake' });
    expect(await page.evaluate(() => document.querySelector('meta[name="color-scheme"]').getAttribute('content'))).toBe('dark');
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => m.getAttribute('content')))).toEqual(['#01172b']);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(1, 23, 43)'); /* lake bg-1 #01172b */
    expect(await page.evaluate(() => document.head.firstElementChild && document.head.firstElementChild.id)).toBe('sgx-first-paint');
  });

  test('首帧底色：默认 terra（深套），系统浅色也不白底', async ({ page }) => {
    await page.route(/\/css\/main\.[0-9a-f]+\.css$/, (r) => r.abort());
    await go(page);
    expect(await page.evaluate(() => document.querySelector('meta[name="color-scheme"]').getAttribute('content'))).toBe('dark');
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => m.getAttribute('content')))).toEqual(['#161412']);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(22, 20, 18)'); /* terra 深色 #161412，同 theme-color */
    expect(await page.evaluate(() => document.head.firstElementChild && document.head.firstElementChild.id)).toBe('sgx-first-paint');
  });

  test('首帧底色只是最低层的兜底：样式表到了以后照常按调色板（换了调色板 = 那套的 bg-1，不是默认色）', async ({ page }) => {
    await go(page, { palette: 'lake' });
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'lake');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(1, 23, 43)'); /* lake bg-1 #01172b（v4 起湖蓝是深套） */
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
