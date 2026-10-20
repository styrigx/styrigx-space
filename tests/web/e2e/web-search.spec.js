/**
 * 全网搜索页（/search/，2026-10-20 由浏览器搜索 /browser/search/ 改名搬来）：做法与设置搜索一致。
 * 主页顶栏搜索按钮打开它；旧地址 /browser/search/、/browser/?q=、/browser/#focus 都转到这里。
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

test('主页顶栏搜索 → 全网搜索页并聚焦；标题「全网搜索」', async ({ page }) => {
  await go(page, '/');
  await page.locator('.sgx-tb-psearch').click();
  await expect(page).toHaveURL(/\/search\/$/);
  await expect(page.locator('#sgx-cap-input-brwsearch')).toBeFocused({ timeout: 5000 });
  await expect(page.locator('h1.subpage-title')).toHaveText('全网搜索');
  await expect(page).toHaveTitle(/^全网搜索 \| Styrigx$/);
});

test('英文页标题 Web search；主页搜索按钮 aria-label = Web search', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {}
  });
  await blockExternalRequests(page);
  await page.goto('/en/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-tb-psearch')).toHaveAttribute('aria-label', 'Web search');
  await expect(page.locator('.sgx-tb-psearch')).toHaveAttribute('href', '/en/search/');
  await page.goto('/en/search/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1.subpage-title')).toHaveText('Web search');
});

test('输入出站内建议和引擎搜索行；ⓧ 清空后回到最近搜索', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-browser-history', JSON.stringify(['hello'])); } catch (e) {}
  });
  await go(page, '/search/');
  await expect(page.locator('#brws-page .setso-chip')).toHaveText(['hello']);
  const input = page.locator('#sgx-cap-input-brwsearch');
  await input.fill('github');
  await expect(page.locator('#brws-page [data-brws-u]').first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#brws-page [data-brws-engine]')).toContainText('github');
  await page.locator('#sgx-cap-brwsearch [data-cap-clear]').click();
  await expect(input).toHaveValue('');
  await expect(page.locator('#brws-page .setso-chip')).toHaveText(['hello']);
});

test('旧入口 /browser/search/?q=、/browser/?q= 和 /browser/#focus 转到全网搜索页', async ({ page }) => {
  await go(page, '/browser/search/?q=xyz');
  await expect(page).toHaveURL(/\/search\/\?q=xyz$/, { timeout: 10000 });
  expect(new URL(page.url()).pathname).toBe('/search/');
  await expect(page.locator('#sgx-cap-input-brwsearch')).toHaveValue('xyz');
  await page.goto('/browser/?q=abc', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/search\/\?q=abc$/, { timeout: 10000 });
  expect(new URL(page.url()).pathname).toBe('/search/');
  await expect(page.locator('#sgx-cap-input-brwsearch')).toHaveValue('abc');
  await page.goto('/browser/#focus', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/search\/$/, { timeout: 10000 });
  expect(new URL(page.url()).pathname).toBe('/search/');
});

test('进页内容置顶（和设置搜索一致）：大标题滚到顶栏下沿之上，内容紧贴顶栏下方', async ({ page }) => {
  await go(page, '/search/');
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

test('胶囊右端是 × 关闭（没有 ⋮）；顶栏也没有 ⋮（搜索引擎 / 清除浏览记录在 安全与隐私）', async ({ page }) => {
  await go(page, '/search/');
  await expect(page.locator('#sgx-cap-brwsearch [data-cap-more]')).toHaveCount(0);
  await expect(page.locator('#sgx-cap-brwsearch [data-cap-close]')).toBeVisible();
  await expect(page.locator('.sgx-tb-more')).toHaveCount(0);
  await expect(page.locator('#brws-more')).toHaveCount(0);
});

test('点 × 关闭：回到进来的那一页', async ({ page }) => {
  await go(page, '/bookmarks/');
  /* 站内跳转（带 referrer），和点主页搜索按钮一样 */
  await page.evaluate(() => { location.href = '/search/'; });
  await page.waitForURL(/\/search\/$/);
  await expect(page.locator('#sgx-cap-input-brwsearch')).toBeFocused({ timeout: 5000 });
  await page.locator('#sgx-cap-brwsearch [data-cap-close]').click();
  await expect(page).toHaveURL(/\/bookmarks\/$/, { timeout: 10000 });
});

test('直接打开再点 × 关闭：回主页', async ({ page }) => {
  await go(page, '/search/');
  await page.locator('#sgx-cap-brwsearch [data-cap-close]').click();
  await expect(page).toHaveURL(/localhost:\d+\/$/, { timeout: 10000 });
});

test('搜索时用 安全与隐私 里选的引擎', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-search-engine', 'bing'); } catch (e) {}
  });
  await go(page, '/search/');
  await page.locator('#sgx-cap-input-brwsearch').fill('kitten');
  await expect(page.locator('#brws-page [data-brws-engine]')).toContainText('用 Bing 搜索');
});
