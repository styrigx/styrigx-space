/**
 * 2.4.0 E：视觉回归测试。
 * 5 视口 × 中英 × 深浅色 × 主要页面（/、/files/、/store/、/browser/、/settings/）
 * + F 的两张基准（弹层打开、引擎菜单打开）。
 * 首次运行：npx playwright test --update-snapshots 生成基准；
 * 后续运行自动对比，不一致即失败。
 *
 * Hark：goto 用 domcontentloaded + 等具体元素，不用 networkidle
 * （CI 里外部请求会让 networkidle 永远等不到）；删掉全部 waitForTimeout。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

const VIEWPORTS = {
  mobile: { width: 412, height: 915 },
  landscape: { width: 915, height: 412 },
  tabletPortrait: { width: 800, height: 1280 },
  tabletLandscape: { width: 1280, height: 800 },
  desktop: { width: 1920, height: 1080 },
};
/* 安全与隐私：新页面加入视觉回归（先只报告，基线未生成前不阻塞） */
const PAGES = ['/', '/files/', '/store/', '/browser/', '/settings/', '/settings/security/', '/settings/security/lock/'];
const LANGS = [
  { prefix: '', name: 'zh' },
  { prefix: '/en', name: 'en' },
];
const THEMES = [
  { name: 'light', setup: null },
  { name: 'dark', setup: 'dark' },
];

/* 页面主容器：等它出现即认为页面主体已渲染 */
const MAIN = 'main, #app-grid';

/** 等页面就绪：主容器可见 + 字体加载完成 */
async function waitPageReady(pg) {
  await expect(pg.locator(MAIN).first()).toBeVisible({ timeout: 15000 });
  await pg.evaluate(() => document.fonts.ready);
}

/** 所有组合：视口 × 语言 × 主题 × 页面 */
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      for (const page of PAGES) {
        const name = `${vpName}-${lang.name}-${theme.name}${page.replace(/\//g, '_')}`;
        test(name, async ({ page: pg }) => {
          await pg.setViewportSize(vp);
          await blockExternalRequests(pg);
          /* 关掉动画，保证截图稳定（goto 之前设置，context 级生效） */
          await pg.emulateMedia({ reducedMotion: 'reduce' });
          /* 预置主题 + 冻结时间，避免动态内容导致截图不稳定
             （锁屏由构建期 SGX_TEST_NO_LOCK=1 禁用，见 deploy.yml） */
          await pg.addInitScript((t) => {
            if (t === 'dark') {
              try { localStorage.setItem('sgx-theme-mode', 'dark'); } catch (e) {}
            }
          }, theme.setup);
          await freezeTime(pg);
          await pg.goto(lang.prefix + page, { waitUntil: 'domcontentloaded' });
          await waitPageReady(pg);
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

/* F 基准 1：弹层打开（2.6.0 起日期时间行在 /settings/manage/ 子页） */
test('baseline-sheet-open', async ({ page: pg }) => {
  await pg.setViewportSize(VIEWPORTS.mobile);
  await blockExternalRequests(pg);
  await pg.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(pg);
  await pg.goto('/settings/manage/', { waitUntil: 'domcontentloaded' });
  await waitPageReady(pg);
  /* 2.8.0：等目标行就绪（可能在折叠区下方） */
  await pg.locator('#row-datetime').waitFor({ state: 'visible', timeout: 15000 });
  await pg.locator('#row-datetime').scrollIntoViewIfNeeded();
  await pg.click('#row-datetime');
  /* 等原生 dialog 弹层打开 */
  await expect(pg.locator('dialog[open]').first()).toBeVisible({ timeout: 10000 });
  await expect(pg).toHaveScreenshot('baseline-sheet-open.png', { animations: 'disabled' });
});

/* F 基准 2：引擎菜单打开（浏览器页搜索引擎菜单） */
test('baseline-engine-menu', async ({ page: pg }) => {
  await pg.setViewportSize(VIEWPORTS.mobile);
  await blockExternalRequests(pg);
  await pg.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(pg);
  await pg.goto('/browser/', { waitUntil: 'domcontentloaded' });
  await waitPageReady(pg);
  const btn = pg.locator('#brw-engine-btn');
  if (await btn.count()) {
    await btn.click();
    /* 等引擎菜单弹出（popover 菜单容器） */
    await expect(pg.locator('#brw-eng-menu').first()).toBeVisible({ timeout: 10000 });
  }
  await expect(pg).toHaveScreenshot('baseline-engine-menu.png', { animations: 'disabled' });
});
