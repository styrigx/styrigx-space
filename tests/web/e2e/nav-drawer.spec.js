/**
 * 2026-10-20 导航改版验收：
 * - 顶栏全站同一套：左圆九宫格、中间长条（居中标题）、右圆头像；没有 ‹ 返回、没有 ⋮。
 * - 九宫格 → Gmail 式左侧导航抽屉：主页 / 书签 / 书库 / 博客，分隔线下只有 设置；每项有描边图标，
 *   当前页是药丸高亮；没有 我的文件 / 帮助与反馈；点遮罩 / Esc / 系统返回关闭。
 * - /browser/ 拆成 书签 /bookmarks/（只有书签：分类筛选条 + 分组）+ 全网搜索 /search/。
 * - 搜索引擎 / 清除浏览记录搬到 设置 › 安全与隐私 › 隐私。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 } });

async function go(page, path, lang = 'zh') {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
}

const drawer = (page) => page.locator('#sgx-drawer');

async function openDrawer(page) {
  await page.locator('.sgx-tb-nav').click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page)).toHaveClass(/\bis-open\b/);
}

test.describe('顶栏：全站同一套，没有 ‹ 和 ⋮', () => {
  const PAGES = ['/', '/bookmarks/', '/search/', '/settings/', '/settings/display/', '/settings/security/', '/settings/account/', '/settings/search/'];
  for (const path of PAGES) {
    test(`${path}：九宫格 + 长条 + 头像，没有返回圆和 ⋮`, async ({ page }) => {
      await go(page, path);
      await expect(page.locator('.sgx-tb-back')).toHaveCount(0);
      await expect(page.locator('[data-go-back]')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-more')).toHaveCount(0);
      await expect(page.locator('[data-tb-more]')).toHaveCount(0);
      await expect(page.locator('.sgx-topbar > .sgx-tb-nav')).toHaveCount(1);
      await expect(page.locator('.sgx-topbar > .sgx-tb-pill')).toHaveCount(1);
      await expect(page.locator('.sgx-topbar > .sgx-tb-me')).toHaveCount(1);
      /* PR② 预留位：快捷面板圆现在不渲染 */
      await expect(page.locator('.sgx-tb-quick')).toHaveCount(0);
    });
  }

  test('子页长条里只有居中标题', async ({ page }) => {
    await go(page, '/settings/display/');
    await expect(page.locator('.sgx-tb-pill a, .sgx-tb-pill button')).toHaveCount(1); /* 只有 #nav-brand */
    const pill = await page.locator('.sgx-tb-pill').boundingBox();
    const tx = await page.locator('.sgx-tb-text').boundingBox();
    expect(Math.abs(tx.x + tx.width / 2 - (pill.x + pill.width / 2))).toBeLessThanOrEqual(1);
  });
});

test.describe('导航抽屉', () => {
  test('打开：主页 / 书签 / 书库 / 博客，分隔线下只有 设置；每项有图标；没有 我的文件 / 帮助', async ({ page }) => {
    await go(page, '/settings/display/');
    await expect(page.locator('.sgx-tb-nav')).toHaveAttribute('aria-expanded', 'false');
    await openDrawer(page);
    await expect(page.locator('.sgx-tb-nav')).toHaveAttribute('aria-expanded', 'true');
    const lists = drawer(page).locator('.sgx-drawer-list');
    await expect(lists).toHaveCount(2);
    await expect(lists.nth(0).locator('.sgx-drawer-label')).toHaveText(['主页', '书签', '书库', '博客']);
    await expect(lists.nth(1).locator('.sgx-drawer-label')).toHaveText(['设置']);
    await expect(drawer(page).locator('hr.sgx-drawer-div')).toHaveCount(1);
    const items = drawer(page).locator('.sgx-drawer-item');
    await expect(items).toHaveCount(5);
    for (let i = 0; i < 5; i++) await expect(items.nth(i).locator('.sgx-drawer-ic svg')).toHaveCount(1);
    await expect(drawer(page)).not.toContainText('我的文件');
    await expect(drawer(page)).not.toContainText('帮助');
    await expect(drawer(page).locator('a[href*="/files/"]')).toHaveCount(0);
    /* 链接 */
    await expect(items.nth(0)).toHaveAttribute('href', '/');
    await expect(items.nth(1)).toHaveAttribute('href', '/bookmarks/');
    await expect(items.nth(2)).toHaveAttribute('href', 'https://book.styrigx.com/');
    await expect(items.nth(3)).toHaveAttribute('href', 'https://blog.styrigx.com/');
    await expect(items.nth(4)).toHaveAttribute('href', '/settings/');
    /* 设置子页：设置高亮（药丸 = 主色容器底色） */
    await expect(drawer(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(items.nth(4)).toHaveAttribute('aria-current', 'page');
    const bg = await items.nth(4).evaluate((el) => getComputedStyle(el).backgroundColor);
    const bg0 = await items.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe(bg0);
    /* 抽屉贴左边 */
    const sheet = await drawer(page).locator('.sgx-drawer-sheet').boundingBox();
    expect(Math.abs(sheet.x)).toBeLessThanOrEqual(1);
  });

  test('当前页高亮：主页 → 主页，书签页 → 书签', async ({ page }) => {
    await go(page, '/');
    await openDrawer(page);
    await expect(drawer(page).locator('[aria-current="page"] .sgx-drawer-label')).toHaveText('主页');
    await page.goto('/bookmarks/', { waitUntil: 'domcontentloaded' });
    await openDrawer(page);
    await expect(drawer(page).locator('[aria-current="page"] .sgx-drawer-label')).toHaveText('书签');
  });

  test('英文：Home / Bookmarks / Library / Blog + Settings', async ({ page }) => {
    await go(page, '/en/', 'en');
    await openDrawer(page);
    await expect(drawer(page).locator('.sgx-drawer-label')).toHaveText(['Home', 'Bookmarks', 'Library', 'Blog', 'Settings']);
    await expect(drawer(page).locator('.sgx-drawer-item').nth(1)).toHaveAttribute('href', '/en/bookmarks/');
    await expect(drawer(page).locator('.sgx-drawer-item').nth(4)).toHaveAttribute('href', '/en/settings/');
  });

  test('点遮罩关闭', async ({ page }) => {
    await go(page, '/settings/');
    await openDrawer(page);
    await page.mouse.click(400, 500);
    await expect(drawer(page)).toBeHidden();
    await expect(page).toHaveURL(/\/settings\/$/);
    await expect(page.locator('.sgx-tb-nav')).toHaveAttribute('aria-expanded', 'false');
  });

  test('Esc 关闭（桌面）', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await go(page, '/settings/');
    await openDrawer(page);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toBeHidden();
    await expect(page).toHaveURL(/\/settings\/$/);
  });

  test('系统返回只关抽屉，停在本页；再返回才离开', async ({ page }) => {
    await go(page, '/');
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openDrawer(page);
    await page.goBack();
    await expect(drawer(page)).toBeHidden();
    await expect(page).toHaveURL(/\/settings\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });

  test('点项跳转，且不在历史里多留一步', async ({ page }) => {
    await go(page, '/');
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openDrawer(page);
    await drawer(page).locator('.sgx-drawer-item', { hasText: '书签' }).click();
    await expect(page).toHaveURL(/\/bookmarks\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/$/);
    await expect(drawer(page)).toBeHidden();
  });

  test('点当前页那一项只关闭', async ({ page }) => {
    await go(page, '/settings/');
    await openDrawer(page);
    await drawer(page).locator('.sgx-drawer-item', { hasText: '设置' }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(page).toHaveURL(/\/settings\/$/);
  });
});

test.describe('书签页', () => {
  test('/browser/ 跳到 /bookmarks/（中英）', async ({ page }) => {
    await go(page, '/browser/');
    await expect(page).toHaveURL(/\/bookmarks\/$/);
    expect(new URL(page.url()).pathname).toBe('/bookmarks/');
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await page.goto('/en/browser/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/en\/bookmarks\/$/);
  });

  test('只有书签：分类筛选条 + 分组；没有快捷访问、地址栏胶囊、⋮', async ({ page }) => {
    await go(page, '/bookmarks/');
    await expect(page.locator('h1.subpage-title')).toHaveText('书签');
    await expect(page.locator('[data-brw-cat="all"]')).toBeVisible();
    expect(await page.locator('[data-brw-catgroup]').count()).toBeGreaterThan(0);
    await expect(page.locator('.brw-qa-grid, .brw-qa')).toHaveCount(0);
    await expect(page.getByText('快捷访问')).toHaveCount(0);
    await expect(page.locator('#brw-addrbar')).toHaveCount(0);
    await expect(page.locator('#brw-more')).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveClass(/addrbar-/);
    /* 筛选：点第一个分类只剩一组 */
    await page.locator('[data-brw-cat="brwcat-0"]').click();
    await expect(page.locator('[data-brw-catgroup]:visible')).toHaveCount(1);
  });

  test('旧的地址栏位置键会被清掉', async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('x')) { sessionStorage.setItem('x', '1'); localStorage.setItem('sgx-addrbar-pos', 'top'); } } catch (e) {} });
    await go(page, '/bookmarks/');
    expect(await page.evaluate(() => localStorage.getItem('sgx-addrbar-pos'))).toBeNull();
  });
});

test.describe('安全与隐私 › 隐私：搜索引擎 / 清除浏览记录', () => {
  test('搜索引擎行显示当前引擎，点开选 Bing → sgx-search-engine = bing', async ({ page }) => {
    await go(page, '/settings/security/');
    const row = page.locator('#sec-engine');
    await expect(row).toContainText('搜索引擎');
    await expect(page.locator('#sec-engine-val')).toHaveText('Google');
    const sheet = page.locator('#sheet-body');
    await expect(async () => {
      await row.click();
      await expect(sheet.getByText('Bing', { exact: true })).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15000 });
    await sheet.getByText('Bing', { exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem('sgx-search-engine'))).toBe('bing');
    await expect(page.locator('#sec-engine-val')).toHaveText('Bing');
    /* 选回 Google：默认值不存 */
    await expect(async () => {
      await row.click();
      await expect(sheet.getByText('Google', { exact: true })).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15000 });
    await sheet.getByText('Google', { exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem('sgx-search-engine'))).toBeNull();
  });

  test('引擎行在隐私分组里', async ({ page }) => {
    await go(page, '/settings/security/');
    const inPrivacy = await page.evaluate(() => {
      const row = document.getElementById('sec-engine');
      const sec = row && row.closest('section');
      const h = sec && sec.previousElementSibling;
      return h ? h.textContent.trim() : '';
    });
    expect(inPrivacy).toBe('隐私');
    await expect(page.locator('#sec-clearhist')).toContainText('清除浏览记录');
  });

  test('清除浏览记录：确认后清空 sgx-browser-history', async ({ page }) => {
    await page.addInitScript(() => {
      try { if (!localStorage.getItem('sgx-browser-history')) localStorage.setItem('sgx-browser-history', JSON.stringify(['a', 'b'])); } catch (e) {}
    });
    await go(page, '/settings/security/');
    const sheet = page.locator('#sheet-body');
    await expect(async () => {
      await page.locator('#sec-clearhist').click();
      await expect(sheet.getByText('清除', { exact: true })).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15000 });
    await sheet.getByText('清除', { exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem('sgx-browser-history'))).toBe('[]');
  });
});
