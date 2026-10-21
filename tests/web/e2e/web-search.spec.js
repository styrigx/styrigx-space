/**
 * 全网搜索页（/search/，2026-10-20 由浏览器搜索 /browser/search/ 改名搬来）：做法与设置搜索一致。
 * 顶栏长条左端搜索图标（#sgx-tb-search，v5 收进长条）打开它；旧地址 /browser/search/、/browser/?q=、/browser/#focus 都转到这里。
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

test('主页点长条左端搜索图标 → 全网搜索页并聚焦；长条页名「全网搜索」', async ({ page }) => {
  await go(page, '/');
  await expect(page.locator('.sgx-tb-pill > #sgx-tb-search')).toHaveCount(1);
  await expect(page.locator('#sgx-tb-search')).toHaveAttribute('aria-label', '搜索');
  await page.locator('#sgx-tb-search').click();
  await expect(page).toHaveURL(/\/search\/$/);
  await expect(page.locator('#sgx-cap-input-brwsearch')).toBeFocused({ timeout: 5000 });
  await expect(page.locator('.sgx-tb-title')).toHaveText('全网搜索');
  await expect(page).toHaveTitle(/^全网搜索 \| Styrigx$/);
});

test('英文页长条页名 Web search；主页搜索图标 aria-label Search、链到英文搜索页', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {}
  });
  await blockExternalRequests(page);
  await page.goto('/en/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sgx-tb-search')).toHaveAttribute('aria-label', 'Search');
  await expect(page.locator('#sgx-tb-search')).toHaveAttribute('href', '/en/search/');
  await page.goto('/en/search/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-tb-title')).toHaveText('Web search');
});

test('输入出站内建议和引擎搜索行；ⓧ 清空后回到最近搜索', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-browser-history', JSON.stringify(['hello'])); } catch (e) {}
  });
  await go(page, '/search/');
  await expect(page.locator('#brws-page .setso-chip')).toHaveText(['hello']);
  const input = page.locator('#sgx-cap-input-brwsearch');
  /* 2026-10-21 主站书签下线：站内索引只剩文章和 App（设置） */
  await input.fill('设置');
  await expect(page.locator('#brws-page [data-brws-u]').first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#brws-page [data-brws-engine]')).toContainText('设置');
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

test('没有大标题：内容从顶栏下方 16px 开始，不用滚动', async ({ page }) => {
  await go(page, '/search/');
  await page.waitForTimeout(300);
  const g = await page.evaluate(() => {
    const bar = document.querySelector('.sgx-tb-pill');
    const main = document.querySelector('.setso-layout .set-main');
    return {
      barBottom: bar.getBoundingClientRect().bottom,
      mainTop: main.getBoundingClientRect().top,
      bigTitles: document.querySelectorAll('.subpage-title, [data-subpage-head]').length,
      scrollY: window.scrollY,
    };
  });
  expect(g.bigTitles).toBe(0);
  expect(g.scrollY).toBe(0);
  expect(Math.abs(g.mainTop - (g.barBottom + 16))).toBeLessThanOrEqual(2);
});

test('在全网搜索页点长条搜索图标：不跳转，只聚焦底部输入框', async ({ page }) => {
  await go(page, '/search/');
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__sgxNoReload = 1; document.activeElement && document.activeElement.blur(); });
  await expect(page.locator('#sgx-cap-input-brwsearch')).not.toBeFocused();
  await page.locator('#sgx-tb-search').click();
  await expect(page.locator('#sgx-cap-input-brwsearch')).toBeFocused({ timeout: 5000 });
  expect(await page.evaluate(() => window.__sgxNoReload)).toBe(1);
  expect(new URL(page.url()).pathname).toBe('/search/');
});

test('胶囊右端是 × 关闭（没有 ⋮）；顶栏也没有 ⋮（搜索引擎 / 清除浏览记录在 安全与隐私）', async ({ page }) => {
  await go(page, '/search/');
  await expect(page.locator('#sgx-cap-brwsearch [data-cap-more]')).toHaveCount(0);
  await expect(page.locator('#sgx-cap-brwsearch [data-cap-close]')).toBeVisible();
  await expect(page.locator('.sgx-tb-more')).toHaveCount(0);
  await expect(page.locator('#brws-more')).toHaveCount(0);
});

test('点 × 关闭：回到进来的那一页', async ({ page }) => {
  await go(page, '/settings/');
  /* 站内跳转（带 referrer），和点顶栏长条一样 */
  await page.evaluate(() => { location.href = '/search/'; });
  await page.waitForURL(/\/search\/$/);
  await expect(page.locator('#sgx-cap-input-brwsearch')).toBeFocused({ timeout: 5000 });
  await page.locator('#sgx-cap-brwsearch [data-cap-close]').click();
  await expect(page).toHaveURL(/\/settings\/$/, { timeout: 10000 });
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
