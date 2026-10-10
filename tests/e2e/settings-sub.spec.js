/**
 * 2.6.0：设置二级页。真实断言（不 mock 自家逻辑）：
 * - Mobile /settings/ 只留账户卡 + 8 分类入口，无选项组
 * - DeX/PC /settings/ 左右双栏：左分类导航、右详情窗格（复用子页同一套 partial）
 * - 7 个子页可达、有返回键、有对应选项组
 * - 旧 hash 跳转到子页
 * - 设置搜索结果跳子页（含跨页高亮）
 * - 中英双语
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

const CATS = [
  { id: 'display', zh: '显示', en: 'Display' },
  { id: 'theme', zh: '壁纸和主题', en: 'Wallpaper & theme' },
  { id: 'security', zh: '安全与隐私', en: 'Security and privacy' },
  { id: 'manage', zh: '常规管理', en: 'General management' },
  { id: 'apps', zh: '应用', en: 'Apps' },
  { id: 'accessibility', zh: '辅助功能', en: 'Accessibility' },
  { id: 'wellbeing', zh: '数字健康', en: 'Digital wellbeing' },
  { id: 'about', zh: '关于本站', en: 'About' },
];

async function gotoSettings(pg, path) {
  await blockExternalRequests(pg);
  await pg.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
}

/* Mobile（竖屏）：单列分类列表 */
test.use({ viewport: { width: 412, height: 915 } });

test('settings home (mobile): account card + 8 category links, no option groups', async ({ page: pg }) => {
  await gotoSettings(pg, '/settings/');
  // 账户卡（移动端只显示分类列表里的那张）
  await expect(pg.locator('.set-mobile-only .sgx-account-card').first()).toBeVisible();
  // 8 个分类入口
  for (const c of CATS) {
    const link = pg.locator(`.set-mobile-only .set-row[href="/settings/${c.id}/"]`);
    await expect(link, `${c.id} link`).toHaveCount(1);
    await expect(link, `${c.id} title`).toContainText(c.zh);
  }
  // 选项组与双栏导航在移动端不显示（DOM 存在但隐藏）
  for (const gid of ['#sg-display', '#sg-theme', '#sg-manage', '#sg-apps', '#sg-accessibility', '#sg-wellbeing', '#sg-about']) {
    await expect(pg.locator(gid), gid).toBeHidden();
  }
  await expect(pg.locator('#set-cat-nav')).toBeHidden();
  await expect(pg.locator('.set-col-r')).toBeHidden();
});

test.describe('settings home (dex): two-pane', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('left nav switches right pane in place', async ({ page: pg }) => {
    await gotoSettings(pg, '/settings/');
    // 左栏导航可见、8 项
    const nav = pg.locator('#set-cat-nav');
    await expect(nav).toBeVisible();
    await expect(nav.locator('.set-cat')).toHaveCount(8);
    // 移动端列表隐藏
    await expect(pg.locator('.set-mobile-only')).toBeHidden();
    // 默认显示 display 窗格
    await expect(pg.locator('#sg-display')).toBeVisible();
    await expect(pg.locator('#set-right-title')).toContainText('显示');
    // 点主题：右窗格原地切换，不跳转
    await nav.locator('[data-cat="theme"]').click();
    await expect(pg.locator('#sg-theme')).toBeVisible();
    await expect(pg.locator('#sg-display')).toBeHidden();
    await expect(pg.locator('#set-right-title')).toContainText('壁纸和主题');
    expect(new URL(pg.url()).pathname).toBe('/settings/');
    // 点安全与隐私：跳独立页面
    await nav.locator('[data-cat="security"]').click();
    await pg.waitForURL('**/settings/security/', { timeout: 10000 });
  });
});

test('settings home (en): 8 category links', async ({ page: pg }) => {
  await gotoSettings(pg, '/en/settings/');
  for (const c of CATS) {
    const link = pg.locator(`.set-row[href="/en/settings/${c.id}/"]`);
    await expect(link, `${c.id} link`).toHaveCount(1);
    await expect(link, `${c.id} title`).toContainText(c.en);
  }
});

const SUBCHECKS = {
  display: ['#theme-previews', '#row-system', '#seg-font', '#seg-layout'],
  theme: ['#palette-dots'],
  manage: ['#row-lang', '#row-datetime', '#row-weather'],
  apps: ['#row-app-files', '#row-app-store', '#row-app-browser'],
  accessibility: ['#row-motion'],
  wellbeing: ['#well-v-total'],
  about: ['#row-reset'],
};

for (const c of CATS) {
  if (c.id === 'security') continue; // security 子页已有测试覆盖
  test(`subpage /settings/${c.id}/: back button + options`, async ({ page: pg }) => {
    await gotoSettings(pg, `/settings/${c.id}/`);
    await expect(pg.locator('[data-go-back]').first(), 'back button').toBeVisible();
    await expect(pg.locator('.subpage-title').first(), 'title').toContainText(c.zh);
    for (const sel of SUBCHECKS[c.id]) {
      await expect(pg.locator(sel), sel).toHaveCount(1);
    }
    // noindex
    const robots = await pg.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('noindex');
  });
}

test('legacy hash #display redirects to subpage', async ({ page: pg }) => {
  await blockExternalRequests(pg);
  await pg.goto('/settings/#display', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL('**/settings/display/', { timeout: 10000 });
  await expect(pg.locator('#theme-previews')).toBeVisible();
});

test('settings search result navigates to subpage', async ({ page: pg }) => {
  await gotoSettings(pg, '/settings/');
  // 胶囊本身就是输入框，直接输入
  const input = pg.locator('#sgx-cap-input-settings');
  await expect(input).toBeVisible();
  await input.fill('字体大小');
  const item = pg.locator('#sgx-cap-results-settings .setso-item').first();
  await expect(item).toBeVisible({ timeout: 10000 });
  await expect(item).toContainText('字体大小');
  await item.click();
  // 跨页跳转带 #seg-font（高亮命中行），只断言 pathname
  await pg.waitForURL((url) => new URL(url).pathname === '/settings/display/', { timeout: 10000 });
  await expect(pg.locator('#seg-font')).toBeVisible();
});

test('subpage back button returns to settings home', async ({ page: pg }) => {
  await gotoSettings(pg, '/settings/manage/');
  await pg.locator('[data-go-back]').first().click();
  await pg.waitForURL('**/settings/', { timeout: 10000 });
});

test('about page: version rows (2.6.0 spec)', async ({ page: pg }) => {
  await gotoSettings(pg, '/settings/about/');
  const body = pg.locator('#sg-about');
  await expect(body).toContainText('Styrigx UI 8.5');
  await expect(body).toContainText('2.6.0');
  await expect(body).toContainText('Hugo');
  await expect(body).toContainText('Tailwind CSS');
  await expect(body).toContainText('构建时间');
  await expect(body).toContainText('GitHub');
  await expect(body).toContainText('重置所有设置');
});
