/**
 * 浏览器搜索独立页（/browser/search/）：取代浏览器页的磨砂弹出层，做法与设置搜索一致。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

test.use({ viewport: { width: 390, height: 844 } });

async function go(page, path) {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
}

test('点浏览器页地址栏 → 跳搜索页并聚焦；页面上没有旧弹出层', async ({ page }) => {
  await go(page, '/browser/');
  await expect(page.locator('#brw-overlay')).toHaveCount(0);
  await page.locator('#brw-addrbar').click();
  await expect(page).toHaveURL(/\/browser\/search\/$/);
  await expect(page.locator('#sgx-cap-input-brwsearch')).toBeFocused({ timeout: 5000 });
});

test('输入出站内建议和引擎搜索行；ⓧ 清空后回到最近搜索', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-browser-history', JSON.stringify(['hello'])); } catch (e) {}
  });
  await go(page, '/browser/search/');
  await expect(page.locator('#brws-page .setso-chip')).toHaveText(['hello']);
  const input = page.locator('#sgx-cap-input-brwsearch');
  await input.fill('github');
  await expect(page.locator('#brws-page [data-brws-u]').first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#brws-page [data-brws-engine]')).toContainText('github');
  await page.locator('#sgx-cap-brwsearch [data-cap-clear]').click();
  await expect(input).toHaveValue('');
  await expect(page.locator('#brws-page .setso-chip')).toHaveText(['hello']);
});

test('旧入口 /browser/?q= 和 /browser/#focus 转到搜索页', async ({ page }) => {
  await go(page, '/browser/?q=abc');
  await expect(page).toHaveURL(/\/browser\/search\/\?q=abc$/, { timeout: 10000 });
  await expect(page.locator('#sgx-cap-input-brwsearch')).toHaveValue('abc');
  await page.goto('/browser/#focus', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/browser\/search\/$/, { timeout: 10000 });
});

test('进页内容置顶（和设置搜索一致）：大标题滚到顶栏下沿之上，内容紧贴顶栏下方', async ({ page }) => {
  await go(page, '/browser/search/');
  await page.waitForTimeout(300);
  const g = await page.evaluate(() => {
    const bar = document.querySelector('.sgx-topbar');
    const heads = Array.from(document.querySelectorAll('[data-subpage-head]'));
    const head = heads.find((h) => h.getClientRects().length) || heads[0];
    const title = head.querySelector('.subpage-title');
    const main = document.querySelector('.setso-layout .set-main');
    return {
      barBottom: bar.getBoundingClientRect().bottom,
      titleBottom: title.getBoundingClientRect().bottom,
      mainTop: main.getBoundingClientRect().top,
    };
  });
  expect(g.titleBottom).toBeLessThanOrEqual(g.barBottom);
  expect(Math.abs(g.mainTop - (g.barBottom + 16))).toBeLessThanOrEqual(2);
});

test('胶囊右端是 × 关闭（没有 ⋮）；搜索引擎 / 清除最近搜索在顶栏 ⋮ 里', async ({ page }) => {
  await go(page, '/browser/search/');
  await expect(page.locator('#sgx-cap-brwsearch [data-cap-more]')).toHaveCount(0);
  await expect(page.locator('#sgx-cap-brwsearch [data-cap-close]')).toBeVisible();
  await page.locator('.sgx-tb-pill #brws-more').click();
  await expect(page.getByText('搜索引擎', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('清除最近搜索', { exact: true })).toBeVisible();
});

test('点 × 关闭：回到进来的那一页', async ({ page }) => {
  await go(page, '/browser/');
  await page.locator('#brw-addrbar').click();
  await expect(page).toHaveURL(/\/browser\/search\/$/);
  await expect(page.locator('#sgx-cap-input-brwsearch')).toBeFocused({ timeout: 5000 });
  await page.locator('#sgx-cap-brwsearch [data-cap-close]').click();
  await expect(page).toHaveURL(/\/browser\/$/, { timeout: 10000 });
});
