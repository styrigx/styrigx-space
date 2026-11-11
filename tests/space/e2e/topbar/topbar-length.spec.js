/**
 * 顶栏长度（P4-3 PR-4b 布局判定；2026-11 UI 重设计 PR-1 顶栏 v3）——主站这一侧。测试构建（锁屏禁用）。
 * 布局只有手机 phone / 桌面 desktop：手动选了就照办；自动 = navigator.userAgentData.mobile（没有就看 UA），
 * 算出桌面但视口 < 720 CSS px → 手机；UA 报手机但浏览器在用桌面版网站的虚拟视口（布局视口 > 屏幕宽 × 1.25）→ 桌面。
 * 顶栏 v3：任何布局 / 设备都是贴顶通栏（宽 = 视口宽），内容收进居中的 --sgx-content-w（1080）：
 * 左右内边距 pad = max(页边距, (宽 − 1080) / 2)，内容宽 = 宽 − 2 × pad（字标左缘 = pad − 4 内缩、图标组右缘 = 宽 − pad）。
 * 顶栏不显示页名（标记留着）。无头 Chromium 的 userAgentData.mobile 是 false，所以手机用例用 UA + userAgentData 桩模拟。
 * 四站整树在 tests/curio/e2e/topbar-length.spec.js 量；四站规则一致的单测在 tests/space/ui/shell/topbar-length.test.mjs。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, animationsDone, expect } = require('../helpers/helpers');

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
/* 语言偏好固定 zh，直接走中文 /zh/…（P4-3 PR-4c：英文在根路径、无前缀），英文页名见 topbar-spec */
const PAGES = [['/zh/', '主页'], ['/zh/status/', '状态'], ['/404.html', null]]; /* 对齐 PR-B：根页叫「主页」，状态页 /zh/status/（2026-11-12 旷野删除）；2026-11-08 /zh/account/ 删除；进站 v3 L1 安全页 / 临时钥匙页删除，短页换 404 */

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

const pageM = (w) => (w < 600 ? 12 /* 对齐 PR-B：手机页边距 12 */ : Math.min(48, Math.max(16, 5.333 + 0.022222 * w)));
/** 顶栏内容宽 = 宽 − 2 × max(页边距, (宽 − 1080) / 2) */
const contentW = (w) => w - 2 * Math.max(pageM(w), (w - 1080) / 2);

const measure = (page) => page.evaluate(() => {
  const bar = document.querySelector('.sgx-topbar').getBoundingClientRect();
  const logo = document.querySelector('.sgx-tb-logo').getBoundingClientRect();
  const acts = document.querySelector('.sgx-tb-acts').getBoundingClientRect();
  const t = document.querySelector('.sgx-tb-title');
  const tr = t ? t.getBoundingClientRect() : null;
  const root = document.documentElement;
  const cl = logo.left + 4;
  return {
    layout: root.getAttribute('data-sgx-layout'),
    bar: bar.width, barLeft: bar.left, vw: window.innerWidth,
    width: acts.right - cl, left: cl, right: window.innerWidth - acts.right,
    title: t ? t.textContent : null, titleShown: !!tr && tr.width > 0 && getComputedStyle(t).display !== 'none',
    noHScroll: root.scrollWidth <= root.clientWidth,
  };
});

/** 通栏 + 内容宽 + 居中 + 不横向滚 + 不显示页名 */
function checkBar(m, w, p) {
  expect(Math.abs(m.barLeft) + Math.abs(m.bar - m.vw), `${p} 顶栏通栏 ${m.barLeft} / ${m.bar}`).toBeLessThanOrEqual(1);
  expect(Math.abs(m.width - contentW(w)), `${p} 顶栏内容宽 ${m.width}，应为 ${contentW(w)}`).toBeLessThanOrEqual(1);
  expect(Math.abs(m.left - m.right), `${p} 左右边距 ${m.left} / ${m.right}`).toBeLessThanOrEqual(1);
  expect(m.noHScroll, `${p} 横向不滚`).toBe(true);
  expect(m.titleShown, `${p} 顶栏不显示页名`).toBe(false);
}

/* [宽, 高, 手机 UA, 布局偏好, 期望布局] */
const CASES = [
  [412, 915, true, null, 'phone'],
  [915, 412, true, null, 'phone'],
  [760, 360, true, null, 'phone'],
  [360, 800, true, null, 'phone'],
  [384, 800, true, null, 'phone'],
  [1024, 768, false, null, 'desktop'],
  [1280, 800, false, null, 'desktop'],
  [1920, 1080, false, null, 'desktop'],
  [700, 900, false, null, 'phone'],
  [980, 2104, true, 'desktop', 'desktop'], // 手机上手动选桌面
];

for (const [w, h, mobile, pref, mode] of CASES) {
  test(`${w}×${h} ${mobile ? '手机 UA' : '桌面 UA'}${pref ? ' 手动' + pref : ' 自动'}：布局 ${mode}、顶栏通栏、内容宽 ${Math.round(contentW(w))} 居中、不横向滚；不显示页名`, async ({ browser }) => {
    const { ctx, page } = await ctxPage(browser, w, h, mobile, pref);
    for (const [p, name] of PAGES) {
      await open(page, p);
      const m = await measure(page);
      expect(m.layout, p).toBe(mode);
      checkBar(m, w, p);
      if (name) expect(m.title, `${p} 页名标记`).toBe(name);
    }
    await ctx.close();
  });
}

test('手机上手动选「桌面」：跨页保持（同源 localStorage），切回「自动」又是手机', async ({ browser }) => {
  const { ctx, page } = await ctxPage(browser, 412, 915, true, null);
  await open(page, '/zh/status/');
  expect((await measure(page)).layout).toBe('phone');
  await page.evaluate(() => { localStorage.setItem('sgx-layout', 'desktop'); /** @type {any} */ (window).__applyLayout(); });
  await animationsDone(page);
  expect((await measure(page)).layout).toBe('desktop');
  for (const p of ['/zh/', '/404.html']) { /* 进站 v3 L1：安全页 / 临时钥匙页已删 */
    await open(page, p);
    const m = await measure(page);
    expect(m.layout, p).toBe('desktop');
    checkBar(m, 412, p);
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
   设备档 = 手机（粗指针 + 屏幕短边 < 600）；顶栏 v3 通栏，内容宽按 980 算。 */
const SAM_DESK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/130.0.0.0 Safari/537.36';
for (const uadMobile of [false, true]) {
  test(`手机桌面版网站 980 宽（屏幕 384，userAgentData.mobile=${uadMobile}）：桌面布局、设备 phone、顶栏通栏、内容居中`, async ({ browser }) => {
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
      checkBar(m, 980, p);
    }
    await ctx.close();
  });
}

test('电脑 UA：data-sgx-device = desktop；1280 → 内容宽 1280 − 2 × 页边距、1920 → 1080（封顶）', async ({ browser }) => {
  for (const [w, h, want] of [[1280, 800, contentW(1280)], [1920, 1080, 1080]]) {
    const { ctx, page } = await ctxPage(browser, w, h, false, null);
    await open(page, '/');
    const m = await measure(page);
    expect(m.layout).toBe('desktop');
    expect(await page.locator('html').getAttribute('data-sgx-device')).toBe('desktop');
    expect(Math.abs(m.width - want), `${w} 顶栏内容宽 ${m.width}，应为 ${want}`).toBeLessThanOrEqual(2);
    checkBar(m, w, '/');
    await ctx.close();
  }
});
