/**
 * 全网搜索页（/search/，2026-10-20 由浏览器搜索 /browser/search/ 改名搬来）：做法与设置搜索一致。
 * 顶栏长条左端搜索图标（#sgx-tb-search，v5 收进长条）打开它；旧地址 /browser/search/、/browser/?q=、/browser/#focus 都转到这里。
 * 2026-10-21 v7 底栏：长条药丸（放大镜 · 「搜索或输入网址」· 有输入才出现的 ⓧ 清空）+ 旁边单独的 × 关闭圆（同高同材质）；语音搜索整个删掉。
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

test('药丸里的 ⓧ 清空只在有输入时出现（在输入框右边、药丸里面）', async ({ page }) => {
  await go(page, '/search/');
  const clear = page.locator('#sgx-cap-brwsearch .sgx-cap-pill [data-cap-clear]');
  await expect(clear).toBeHidden();
  await page.locator('#sgx-cap-input-brwsearch').fill('abc');
  await expect(clear).toBeVisible();
  const m = await page.evaluate(() => {
    const r = (q) => document.querySelector(q).getBoundingClientRect();
    return { x: r('#sgx-cap-brwsearch [data-cap-clear]'), i: r('#sgx-cap-input-brwsearch'), p: r('#sgx-cap-brwsearch .sgx-cap-pill') };
  });
  expect(m.x.left).toBeGreaterThanOrEqual(m.i.right - 1);
  expect(m.x.right).toBeLessThanOrEqual(m.p.right);
  await page.locator('#sgx-cap-input-brwsearch').fill('');
  await expect(clear).toBeHidden();
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

test('底栏：长条药丸 + 单独的 × 关闭圆（同高、同材质、在药丸右边 8px）；没有 ⋮、没有麦克风', async ({ page }) => {
  await go(page, '/search/');
  await page.waitForTimeout(400);
  await expect(page.locator('#sgx-cap-brwsearch [data-cap-more]')).toHaveCount(0);
  await expect(page.locator('#sgx-cap-brwsearch [data-cap-close]')).toBeVisible();
  /* 语音搜索删了：哪儿都没有麦克风 / 语音弹窗 */
  await expect(page.locator('[data-mic], .sgx-cap-mic, .sgx-vs-dlg')).toHaveCount(0);
  expect(await page.evaluate(() => typeof (window.SGX || {}).voiceSheet)).toBe('undefined');
  const pill = page.locator('#sgx-cap-brwsearch .sgx-cap-pill');
  const close = page.locator('#sgx-cap-brwsearch .sgx-cap-close');
  await expect(pill.locator('input#sgx-cap-input-brwsearch')).toHaveAttribute('placeholder', '搜索或输入网址');
  await expect(pill.locator('[data-cap-close]')).toHaveCount(0);
  const m = await page.evaluate(() => {
    const r = (q) => document.querySelector(q).getBoundingClientRect();
    const cs = (q) => getComputedStyle(document.querySelector(q));
    const p = cs('#sgx-cap-brwsearch .sgx-cap-pill'), c = cs('#sgx-cap-brwsearch .sgx-cap-close');
    return { p: r('#sgx-cap-brwsearch .sgx-cap-pill'), c: r('#sgx-cap-brwsearch .sgx-cap-close'),
      mat: [p.backgroundColor === c.backgroundColor, p.borderTopColor === c.borderTopColor, p.boxShadow === c.boxShadow], crad: c.borderTopLeftRadius, vw: innerWidth };
  });
  expect(Math.abs(m.p.height - m.c.height)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(m.c.width - m.c.height)).toBeLessThanOrEqual(0.5);
  expect(m.crad).toBe('999px');
  expect(m.mat).toEqual([true, true, true]);
  expect(Math.abs(m.p.top - m.c.top)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(m.c.left - m.p.right - 8)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.p.left - 16)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.vw - m.c.right - 16)).toBeLessThanOrEqual(1);
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
