/**
 * B2-5 验收：
 * 1. 首页只剩名片、双时钟、天气、数字健康；便签、博客、数字花园、桌面图标、收藏都不渲染
 * 2. 我的文件主页：删掉我的站点、收藏、最近添加；顶部只剩「文章」「书籍」两项（左图标 + 右名字）
 * 3. 书籍列表来自 /api/books，点开在当前标签页去书库阅读器
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

test.use({ viewport: { width: 390, height: 844 } });

async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

test('首页只保留名片、时钟、天气、数字健康', async ({ page }) => {
  await blockExternalRequests(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#home-widgets')).toBeAttached({ timeout: 15000 });
  const ids = await page.locator('#home-widgets > .widget').evaluateAll((els) => els.map((e) => e.id));
  for (const id of ids) expect(['w-profile', 'dual-clock', 'weather', 'w-screen']).toContain(id);
  expect(ids).toContain('w-profile');
  expect(ids).toContain('dual-clock');
  for (const sel of ['#now', '#w-blog', '#w-garden', '#home-apps', '#garden']) {
    await expect(page.locator(sel)).toHaveCount(0);
  }
});

for (const lang of [
  { prefix: '', lang: 'zh', labels: ['文章', '书籍'] },
  { prefix: '/en', lang: 'en', labels: ['Posts', 'Books'] },
]) {
  test(`我的文件主页：只剩文章、书籍两项（${lang.prefix || 'zh'}）`, async ({ page }) => {
    await pinLang(page, lang.lang);
    await blockExternalRequests(page);
    await page.goto(lang.prefix + '/files/', { waitUntil: 'domcontentloaded' });
    const cats = page.locator('[data-home-group="cats"] [data-cat]');
    await expect(cats).toHaveCount(2);
    await expect(cats).toHaveText(lang.labels);
    for (const g of ['sites', 'recent', 'fav']) {
      await expect(page.locator(`[data-home-group="${g}"]`)).toHaveCount(0);
    }
    // 图标在左、名字在右，同一行
    const ic = await cats.first().locator('span').first().boundingBox();
    const tx = await cats.first().locator('span').nth(1).boundingBox();
    expect(tx.x).toBeGreaterThan(ic.x + ic.width - 1);
    expect(Math.abs(tx.y + tx.height / 2 - (ic.y + ic.height / 2))).toBeLessThanOrEqual(2);
    await expect(cats.nth(1)).toHaveAttribute('href', lang.prefix + '/files/?type=book');
  });
}

test('书籍列表：来自 /api/books，当前标签页打开阅读器', async ({ page }) => {
  await pinLang(page, 'zh');
  await blockExternalRequests(page);
  await page.route('**/api/books', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        books: [
          { id: 'a1', title: '第一本', author: '作者甲', format: 'epub', cover_url: '', read_url: 'https://book.styrigx.com/read/?id=a1', added_at: 2000 },
          { id: 'b2', title: '第二本', author: '', format: 'pdf', cover_url: '', read_url: 'https://book.styrigx.com/read/?id=b2', added_at: 1000 },
        ],
      }),
    })
  );
  await page.goto('/files/?type=book', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.subpage-title')).toHaveText('书籍');
  const rows = page.locator('#files-items a');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('第一本');
  await expect(rows.first()).toContainText('作者甲');
  await expect(rows.first()).toHaveAttribute('href', 'https://book.styrigx.com/read/?id=a1');
  await expect(rows.first()).not.toHaveAttribute('target', '_blank');
});

test('文章列表：标题为「文章」，文章链接新标签打开博客', async ({ page }) => {
  await pinLang(page, 'zh');
  await blockExternalRequests(page);
  await page.goto('/files/?type=post', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.subpage-title')).toHaveText('文章');
  const first = page.locator('#files-items a').first();
  if (await first.count()) {
    await expect(first).toHaveAttribute('href', /^https:\/\/blog\.styrigx\.com\//);
    await expect(first).toHaveAttribute('target', '_blank');
  }
});
