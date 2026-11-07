/**
 * 顶栏长度 + 页名胶囊（P4-3 PR-4b，Gray 2026-11-07 定稿）——主站这一侧。测试构建（锁屏禁用）。
 * 布局只有手机 phone / 桌面 desktop：手动选了就照办；自动 = navigator.userAgentData.mobile（没有就看 UA），
 * 算出桌面但视口 < 720 CSS px → 手机；UA 报手机但浏览器在用桌面版网站的虚拟视口（布局视口 > 屏幕宽 × 1.25）→ 桌面。
 * 顶栏宽：手机布局 min(100% − 32, 640)；桌面布局按 <html data-sgx-device> 分档——手机设备 min(720, 100% − 48)，
 * 电脑 / 平板 min(clamp(720, 60vw, 960), 100% − 48)（2026-11-07 Gray：桌面顶栏固定居中、不接近铺满），居中。
 * 页名胶囊只做一件事：显示当前页名字；手机布局不显示，桌面布局按整条顶栏居中。
 * 无头 Chromium 的 userAgentData.mobile 是 false，所以手机用例用 UA + userAgentData 桩模拟。
 * 四站整树在 tests/curio/e2e/topbar-length.spec.js 量；四站规则一致的单测在 tests/space/ui/shell/topbar-length.test.mjs。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, animationsDone, expect } = require('../helpers/helpers');

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
/* 语言偏好固定 zh，直接走中文 /zh/…（P4-3 PR-4c：英文在根路径、无前缀），英文页名见 topbar-spec */
const PAGES = [['/zh/', '旷野'], ['/zh/security/', '安全'], ['/zh/theme/', '风格'], ['/zh/account/', null]];

/**
 * 新开一个上下文：mobile = 手机 UA + userAgentData.mobile = true；pref = localStorage sgx-layout
 * @param {import('@playwright/test').Browser} browser
 */
async function ctxPage(browser, w, h, mobile, pref) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, userAgent: mobile ? PHONE_UA : undefined, isMobile: false });
  await ctx.addInitScript((m) => {
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ mobile: m, platform: m ? 'Android' : 'Linux', brands: [] }), configurable: true });
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  }, mobile);
  if (pref) await ctx.addInitScript((p) => { try { localStorage.setItem('sgx-layout', p); } catch (e) {} }, pref);
  const page = await ctx.newPage();
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.route('**/api/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' }));
  return { ctx, page };
}

async function open(page, p) {
  await page.goto(p, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await animationsDone(page);
}

const measure = (page) => page.evaluate(() => {
  const bar = document.querySelector('.sgx-topbar').getBoundingClientRect();
  const t = document.querySelector('.sgx-tb-title');
  const tr = t ? t.getBoundingClientRect() : null;
  const root = document.documentElement;
  return {
    layout: root.getAttribute('data-sgx-layout'),
    width: bar.width, left: bar.left, right: window.innerWidth - bar.right, center: bar.left + bar.width / 2,
    title: t ? t.textContent : null, titleShown: !!tr && tr.width > 0 && getComputedStyle(t).display !== 'none',
    titleCenter: tr ? tr.left + tr.width / 2 : 0,
    noHScroll: root.scrollWidth <= root.clientWidth,
  };
});

/* [宽, 高, 手机 UA, 布局偏好, 期望布局, 期望顶栏宽] */
const CASES = [
  [412, 915, true, null, 'phone', 380],
  [915, 412, true, null, 'phone', 640],
  [760, 360, true, null, 'phone', 640],
  [360, 800, true, null, 'phone', 328],
  [384, 800, true, null, 'phone', 352],
  [1024, 768, false, null, 'desktop', 720],
  [1280, 800, false, null, 'desktop', 768],
  [1920, 1080, false, null, 'desktop', 960],
  [700, 900, false, null, 'phone', 640],
  [980, 2104, true, 'desktop', 'desktop', 720], // 手机上手动选桌面：手机设备档 min(720, 980 − 48)
];

for (const [w, h, mobile, pref, mode, width] of CASES) {
  test(`${w}×${h} ${mobile ? '手机 UA' : '桌面 UA'}${pref ? ' 手动' + pref : ' 自动'}：布局 ${mode}、顶栏宽 ${width}、居中、不横向滚；页名胶囊${mode === 'desktop' ? '居中显示页名' : '不显示'}`, async ({ browser }) => {
    const { ctx, page } = await ctxPage(browser, w, h, mobile, pref);
    for (const [p, name] of PAGES) {
      await open(page, p);
      const m = await measure(page);
      expect(m.layout, p).toBe(mode);
      expect(Math.abs(m.width - width), `${p} 顶栏宽 ${m.width}，应为 ${width}`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.left - m.right), `${p} 左右边距 ${m.left} / ${m.right}`).toBeLessThanOrEqual(1);
      expect(m.noHScroll, `${p} 横向不滚`).toBe(true);
      if (mode === 'phone') {
        expect(m.titleShown, `${p} 手机布局不显示页名胶囊`).toBe(false);
      } else {
        expect(m.titleShown, `${p} 桌面布局显示页名胶囊`).toBe(true);
        if (name) expect(m.title, p).toBe(name);
        expect(Math.abs(m.titleCenter - m.center), `${p} 页名胶囊中心 ${m.titleCenter}，顶栏中心 ${m.center}`).toBeLessThanOrEqual(2);
      }
    }
    await ctx.close();
  });
}

test('手机上手动选「桌面」：跨页保持（同源 localStorage），切回「自动」又是手机', async ({ browser }) => {
  const { ctx, page } = await ctxPage(browser, 412, 915, true, null);
  await open(page, '/zh/theme/');
  expect((await measure(page)).layout).toBe('phone');
  await page.evaluate(() => { localStorage.setItem('sgx-layout', 'desktop'); /** @type {any} */ (window).__applyLayout(); });
  await animationsDone(page);
  expect((await measure(page)).layout).toBe('desktop');
  for (const p of ['/zh/', '/zh/security/', '/zh/account/']) {
    await open(page, p);
    const m = await measure(page);
    expect(m.layout, p).toBe('desktop');
    expect(Math.abs(m.width - 364), `${p} 桌面布局 412 宽（手机设备）：min(720, 412 − 48) = 364`).toBeLessThanOrEqual(1);
    expect(m.noHScroll, p).toBe(true);
  }
  await page.evaluate(() => { localStorage.setItem('sgx-layout', 'auto'); /** @type {any} */ (window).__applyLayout(); });
  await animationsDone(page);
  expect((await measure(page)).layout).toBe('phone');
  await ctx.close();
});

test('桌面窗口拖窄到 720 以下（自动）：不刷新就落到手机布局，拖回来又是桌面（matchMedia 重算）', async ({ browser }) => {
  const { ctx, page } = await ctxPage(browser, 1280, 800, false, null);
  await open(page, '/zh/');
  expect((await measure(page)).layout).toBe('desktop');
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'phone');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'desktop');
  await ctx.close();
});

/* 手机开「桌面版网站」（2026-11-07 Gray 录屏：S23 Ultra 三星浏览器，视口约 980、屏幕 384 CSS px 宽）。
   UA 报桌面 → 桌面；UA 还报手机（切换后没重载 / 某次跳转没带上桌面 UA）也按虚拟视口认桌面——录屏里奇趣停在手机布局就是这条。
   设备档 = 手机（粗指针 + 屏幕短边 < 600）→ 顶栏 min(720, 100% − 48) = 720。 */
const SAM_DESK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/130.0.0.0 Safari/537.36';
for (const uadMobile of [false, true]) {
  test(`手机桌面版网站 980 宽（屏幕 384，userAgentData.mobile=${uadMobile}）：桌面布局、设备 phone、顶栏 720 居中`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 980, height: 2104 }, screen: { width: 384, height: 824 }, isMobile: true, hasTouch: true,
      userAgent: uadMobile ? PHONE_UA : SAM_DESK_UA });
    await ctx.addInitScript((m) => {
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ mobile: m, platform: m ? 'Android' : 'Linux', brands: [] }), configurable: true });
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    }, uadMobile);
    const page = await ctx.newPage();
    await blockExternalRequests(page);
    await freezeTime(page);
    await page.route('**/api/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' }));
    for (const [p] of PAGES) {
      await open(page, p);
      const m = await measure(page);
      expect(m.layout, p).toBe('desktop');
      expect(await page.locator('html').getAttribute('data-sgx-device'), p).toBe('phone');
      expect(Math.abs(m.width - 720), `${p} 顶栏宽 ${m.width}，应为 720`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.left - m.right), p).toBeLessThanOrEqual(1);
      expect(m.titleShown, p).toBe(true);
    }
    await ctx.close();
  });
}

test('电脑 UA：data-sgx-device = desktop；1280 → 768（60vw）、1920 → 960（封顶）', async ({ browser }) => {
  for (const [w, h, want] of [[1280, 800, 768], [1920, 1080, 960]]) {
    const { ctx, page } = await ctxPage(browser, w, h, false, null);
    await open(page, '/');
    const m = await measure(page);
    expect(m.layout).toBe('desktop');
    expect(await page.locator('html').getAttribute('data-sgx-device')).toBe('desktop');
    expect(Math.abs(m.width - want), `${w} 顶栏宽 ${m.width}，应为 ${want}`).toBeLessThanOrEqual(2);
    await ctx.close();
  }
});
