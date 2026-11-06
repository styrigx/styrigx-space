/**
 * 顶栏长度统一（P4-3 再修，Gray 2026-11-06 立规⑥：顶栏一会长一会短是设计问题）——主站这一侧。测试构建（锁屏禁用）。
 * 同一视口下旷野页、旷野子页（安全 / 风格）、账号页的顶栏胶囊左右边距一样，等于公式（页边距 m、最宽 DeX 1440 / Mobile 640，见 topbar-spec.spec.js 1280×800 那组）；
 * 整页打开、切布局偏好，边距都不变（PR-4b 主页与设置合成旷野，页内切栏已删）。
 * 四站整树（博客 / 奇趣 / 日刻 / 锁屏）在 tests/curio/e2e/topbar-length.spec.js 量；四站布局规则一致的单测在 tests/space/ui/shell/topbar-length.test.mjs。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, animationsDone, expect } = require('../helpers/helpers');

const PAGES = ['/', '/security/', '/theme/', '/account/', '/en/', '/en/security/'];
const VIEWPORTS = [[412, 915], [1280, 800], [1920, 1080], [982, 2104]];

/** 主站 __layoutMode() 的规则 → 期望的左右边距 */
function expected(w, h, pref = 'auto') {
  const m = w < 600 ? 16 : Math.min(48, Math.max(16, 5.333 + 0.022222 * w));
  const big = w >= 840 && h >= 500;
  const mode = pref === 'mobile' ? 'mobile' : pref === 'dex' ? (big ? 'dex' : 'mobile') : big && w > h ? 'dex' : 'mobile';
  const width = Math.min(w - 2 * m, mode === 'dex' ? 1440 : 640);
  return { mode, inset: (w - width) / 2 };
}

async function setup(page) {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await page.route('**/api/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' }));
}

async function open(page, p) {
  await page.goto(p, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await animationsDone(page);
}

/** 胶囊左右边距（右边距按视口宽算） */
const insets = (page) => page.evaluate(() => {
  const r = document.querySelector('.sgx-topbar').getBoundingClientRect();
  return { left: r.left, right: window.innerWidth - r.right };
});

function check(b, want, label) {
  expect(Math.abs(b.left - want.inset), `${label} 左边距 ${b.left}，应为 ${want.inset}`).toBeLessThanOrEqual(1);
  expect(Math.abs(b.right - want.inset), `${label} 右边距 ${b.right}，应为 ${want.inset}`).toBeLessThanOrEqual(1);
}

for (const [w, h] of VIEWPORTS) {
  test(`${w}×${h}：主站各页顶栏胶囊左右边距一样，等于公式；data-sgx-layout = 布局模式`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await setup(page);
    const want = expected(w, h);
    const seen = new Set();
    for (const p of PAGES) {
      await open(page, p);
      await expect(page.locator('html'), p).toHaveAttribute('data-sgx-layout', want.mode);
      await expect(page.locator('html'), p).toHaveClass(new RegExp('\\blayout-' + want.mode + '\\b'));
      const b = await insets(page);
      check(b, want, `${w}×${h} ${p}`);
      seen.add(`${b.left.toFixed(2)}|${b.right.toFixed(2)}`);
    }
    expect(seen.size, `各页边距 ${[...seen].join(' / ')}`).toBe(1);
  });
}

test('切布局偏好（快捷设置 / 设置页写 sgx-layout 后 __applyLayout）：data-sgx-layout 跟着变，顶栏长度和整页打开一样', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setup(page);
  await open(page, '/security/');
  check(await insets(page), expected(1280, 800), 'auto');
  for (const pref of ['mobile', 'dex', 'auto']) {
    await page.evaluate((v) => { localStorage.setItem('sgx-layout', v); /** @type {any} */ (window).__applyLayout(); }, pref);
    await animationsDone(page);
    const want = expected(1280, 800, pref);
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', want.mode);
    check(await insets(page), want, `偏好 ${pref}（当页切）`);
    await open(page, '/');
    check(await insets(page), want, `偏好 ${pref}（整页打开）`);
    await open(page, '/security/');
  }
});
