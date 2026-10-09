/**
 * 2.4.0 E：视觉回归测试。
 * 3 视口 × 中英 × 深浅色 × 主要页面（/、/files/、/store/、/browser/、/settings/）
 * + F 的两张基准（弹层打开、引擎菜单打开）。
 * 首次运行：npx playwright test --update-snapshots 生成基准；
 * 后续运行自动对比，不一致即失败。
 */
const { test, expect } = require('@playwright/test');

const VIEWPORTS = {
  mobile: { width: 412, height: 915 },
  landscape: { width: 915, height: 412 },
  desktop: { width: 1920, height: 1080 },
};
const PAGES = ['/', '/files/', '/store/', '/browser/', '/settings/'];
const LANGS = [
  { prefix: '', name: 'zh' },
  { prefix: '/en', name: 'en' },
];
const THEMES = [
  { name: 'light', setup: null },
  { name: 'dark', setup: 'dark' },
];

/** 所有组合：视口 × 语言 × 主题 × 页面 */
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      for (const page of PAGES) {
        const name = `${vpName}-${lang.name}-${theme.name}${page.replace(/\//g, '_')}`;
        test(name, async ({ page: pg }) => {
          await pg.setViewportSize(vp);
          /* 预置主题 + 冻结时间 + 禁用锁屏，避免动态内容导致截图不稳定 */
          await pg.addInitScript((t) => {
            if (t === 'dark') {
              try { localStorage.setItem('sgx-theme-mode', 'dark'); } catch (e) {}
            }
            try { sessionStorage.setItem('sgx-lock-shown', '1'); } catch (e) {}
            /* 冻结时间：2026-10-09 12:00:00 */
            const frozen = new Date('2026-10-09T12:00:00+08:00').getTime();
            const RealDate = Date;
            // @ts-ignore
            window.Date = class extends RealDate {
              constructor(...args) {
                if (args.length === 0) super(frozen);
                else super(...args);
              }
              static now() { return frozen; }
            };
          }, theme.setup);
          await pg.goto(lang.prefix + page, { waitUntil: 'networkidle' });
          await pg.waitForTimeout(1500);
          /* 关掉动画，保证截图稳定 */
          await pg.emulateMedia({ reducedMotion: 'reduce' });
          await expect(pg).toHaveScreenshot(`${name}.png`, {
            fullPage: false,
            animations: 'disabled',
            /* 遮罩动态区域：时钟、天气 */
            mask: [pg.locator('#dual-clock'), pg.locator('#weather')],
          });
        });
      }
    }
  }
}

/* F 基准 1：弹层打开（设置页日期时间弹层） */
test('baseline-sheet-open', async ({ page: pg }) => {
  await pg.setViewportSize(VIEWPORTS.mobile);
  await pg.addInitScript(() => {
    try { sessionStorage.setItem('sgx-lock-shown', '1'); } catch (e) {}
  });
  await pg.goto('/settings/', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1000);
  await pg.click('#row-datetime');
  await pg.waitForTimeout(800);
  await pg.emulateMedia({ reducedMotion: 'reduce' });
  await expect(pg).toHaveScreenshot('baseline-sheet-open.png', { animations: 'disabled' });
});

/* F 基准 2：引擎菜单打开（浏览器页搜索引擎菜单） */
test('baseline-engine-menu', async ({ page: pg }) => {
  await pg.setViewportSize(VIEWPORTS.mobile);
  await pg.addInitScript(() => {
    try { sessionStorage.setItem('sgx-lock-shown', '1'); } catch (e) {}
  });
  await pg.goto('/browser/', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1000);
  const btn = pg.locator('[data-engine-btn]').first();
  if (await btn.count()) {
    await btn.click();
    await pg.waitForTimeout(800);
  }
  await pg.emulateMedia({ reducedMotion: 'reduce' });
  await expect(pg).toHaveScreenshot('baseline-engine-menu.png', { animations: 'disabled' });
});
