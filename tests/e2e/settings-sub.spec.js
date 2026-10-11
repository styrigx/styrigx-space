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

/* 2.8.0：2.7.0 起语言跟随浏览器（Playwright 默认 en-US），不钉住会导致
   中文断言被跳转到 /en/ 后失败。按测试意图显式钉住 sgx-lang；
   跟随行为本身由 lang-follow.spec.js 单独覆盖。 */
async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

/* Mobile（竖屏）：单列分类列表 */
test.use({ viewport: { width: 412, height: 915 } });

test('settings home (mobile): account card + 8 category links, no option groups', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/');
  // 账户卡（移动端只显示分类列表里的那张）
  await expect(pg.locator('.set-mobile-only .sgx-account-card').first()).toBeVisible();
  // 8 个分类入口（2.8.0：分类列表移出 .set-mobile-only，改由 .set-main 内 aria-label="分类" 的 section 承载）
  const catList = pg.locator('.set-main section[aria-label="分类"]');
  for (const c of CATS) {
    const link = catList.locator(`.set-row[href="/settings/${c.id}/"]`);
    await expect(link, `${c.id} link`).toHaveCount(1);
    await expect(link, `${c.id} title`).toContainText(c.zh);
    await expect(link, `${c.id} visible`).toBeVisible();
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
    await pinLang(pg, 'zh');
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
  await pinLang(pg, 'en');
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
  /* manage：测试构建（SGX_TEST_NO_WEATHER=1，见 deploy.yml）编译期禁用天气组件，
     #row-weather 只在生产构建输出，见 layouts/partials/feature.html */
  manage: ['#row-lang', '#row-datetime'],
  apps: ['#row-app-files', '#row-app-store', '#row-app-browser'],
  accessibility: ['#row-motion'],
  wellbeing: ['#well-v-total'],
  about: ['#row-reset'],
};

for (const c of CATS) {
  if (c.id === 'security') continue; // security 子页已有测试覆盖
  test(`subpage /settings/${c.id}/: back button + options`, async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, `/settings/${c.id}/`);
    await expect(pg.locator('[data-go-back]').first(), 'back button').toBeVisible();
    await expect(pg.locator('.subpage-title').first(), 'title').toContainText(c.zh);
    for (const sel of SUBCHECKS[c.id]) {
      await expect(pg.locator(sel), sel).toHaveCount(1);
    }
    if (c.id === 'manage') {
      // 测试构建禁用天气：天气行必须不存在（生产构建才有，见上）
      await expect(pg.locator('#row-weather'), '#row-weather absent in test build').toHaveCount(0);
    }
    // noindex
    const robots = await pg.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('noindex');
  });
}

test('legacy hash #display redirects to subpage', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/settings/#display', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL('**/settings/display/', { timeout: 10000 });
  await expect(pg.locator('#theme-previews')).toBeVisible();
});

test('settings search result navigates to subpage', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
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
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/manage/');
  await pg.locator('[data-go-back]').first().click();
  await pg.waitForURL('**/settings/', { timeout: 10000 });
});

test('about page: version rows (2.6.0 spec)', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/about/');
  /* 2.8.0：版本号从 data/version.yaml（唯一来源）读取，不再硬编码，
     版本推进时测试自动跟随 */
  const fs = require('fs');
  const path = require('path');
  const vy = fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'version.yaml'), 'utf8');
  const ui = (vy.match(/^ui:\s*"([^"]+)"/m) || [])[1];
  const sgx = (vy.match(/^sgx:\s*"([^"]+)"/m) || [])[1];
  const body = pg.locator('#sg-about');
  await expect(body).toContainText(`Styrigx UI ${ui}`);
  await expect(body).toContainText(`SGX ${sgx}`);
  await expect(body).toContainText('Hugo');
  await expect(body).toContainText('Tailwind CSS');
  await expect(body).toContainText('构建时间');
  await expect(body).toContainText('GitHub');
  await expect(body).toContainText('重置所有设置');
});

/* 解锁方式入口迁移：从账户卡移到「安全与隐私」第一行 */
test.describe('unlock methods entry relocation', () => {
  test('settings home has no orphan #sgx-unlock-link', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, '/settings/');
    await expect(pg.locator('#sgx-unlock-link')).toHaveCount(0);
    /* 切英文再查一遍：后加的 init script 会覆盖前一个的 sgx-lang */
    await pinLang(pg, 'en');
    await gotoSettings(pg, '/en/settings/');
    await expect(pg.locator('#sgx-unlock-link')).toHaveCount(0);
  });

  test('security page: unlock methods first row, click goes to lock page', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
    const row = pg.locator('#sec-unlock-methods');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('解锁方式');
    await expect(row).toContainText('密码、通行密钥');
    await expect(row).toHaveAttribute('href', '/settings/security/lock/');
    /* 初始隐藏；模拟服务端会话有效（sgx:session ok）后显示 */
    await expect(row).toBeHidden();
    await pg.evaluate(() => window.dispatchEvent(new CustomEvent('sgx:session', { detail: { ok: true } })));
    await expect(row).toBeVisible();
    await row.click();
    await pg.waitForURL('**/settings/security/lock/', { timeout: 10000 });
  });

  test('security page (en): unlock methods row', async ({ page: pg }) => {
    await pinLang(pg, 'en');
    await blockExternalRequests(pg);
    await pg.goto('/en/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
    const row = pg.locator('#sec-unlock-methods');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Unlock methods');
    await expect(row).toContainText('Password, passkeys');
    await expect(row).toHaveAttribute('href', '/en/settings/security/lock/');
  });
});
