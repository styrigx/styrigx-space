/**
 * 2.6.0：设置二级页。真实断言（不 mock 自家逻辑）：
 * - Mobile /settings/ 只留账户卡 + 8 分类入口，无选项组（B2-2 新增 Good Lock，B2-4 删除应用）
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
  { id: 'theme', zh: '风格', en: 'Style' },
  { id: 'security', zh: '安全与隐私', en: 'Security and privacy' },
  { id: 'manage', zh: '常规管理', en: 'General management' },
  { id: 'goodlock', zh: 'Good Lock', en: 'Good Lock' },
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
  for (const gid of ['#sg-display', '#sg-theme', '#sg-manage', '#sg-goodlock', '#sg-accessibility', '#sg-wellbeing', '#sg-about']) {
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
    // 左栏导航可见、9 项
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
    await expect(pg.locator('#set-right-title')).toContainText('风格');
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
  manage: ['#row-lang', '#row-datetime', '#row-reset'],
  goodlock: ['#mod-wellbeing', '#mod-parallax', '#mod-clockstyle', '#mod-sound', '#mod-keys', '#mod-edgeglow'],
  accessibility: ['#row-motion'],
  wellbeing: ['#well-v-total'],
  about: [],
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

test('settings capsule navigates to search page', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/');
  // B1-6a：点胶囊跳搜索页，不弹键盘
  const cap = pg.locator('#sgx-cap-settings');
  await expect(cap).toBeVisible();
  await cap.click();
  await pg.waitForURL('**/settings/search/', { timeout: 10000 });
  await expect(pg.locator('#sgx-cap-input-setsearch')).toBeVisible();
});

test('B1-6a search page: input filters and navigates', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/search/');
  const input = pg.locator('#sgx-cap-input-setsearch');
  await expect(input).toBeVisible();
  await input.fill('字体');
  // 等去抖 150ms + 渲染
  await expect(pg.locator('.setso-title')).toContainText('搜索结果', { timeout: 10000 });
  const cards = pg.locator('.setso-card');
  expect(await cards.count()).toBeGreaterThanOrEqual(1);
  // 点第一条会跳走
  await pg.locator('.setso-item').first().click();
  await pg.waitForURL((url) => new URL(url).pathname !== '/settings/search/', { timeout: 10000 });
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
  const vy = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'web', 'data', 'version.yaml'), 'utf8');
  const ui = (vy.match(/^ui:\s*"([^"]+)"/m) || [])[1];
  const sgx = (vy.match(/^sgx:\s*"([^"]+)"/m) || [])[1];
  const body = pg.locator('#sg-about');
  await expect(body).toContainText(`Styrigx UI ${ui}`);
  await expect(body).toContainText(`SGX ${sgx}`);
  await expect(body).toContainText('Hugo');
  await expect(body).toContainText('Tailwind CSS');
  await expect(body).toContainText('构建时间');
  /* B2-4：顺序 版本/内核/Hugo/Tailwind/构建/构建时间；无 GitHub 仓库行；重置移到常规管理 */
  const labels = await body.locator('.set-row > span.font-medium').allTextContents();
  expect(labels.map((t) => t.trim())).toEqual(['版本', '内核', 'Hugo', 'Tailwind CSS', '构建', '构建时间']);
  await expect(body).not.toContainText('GitHub');
  await expect(body.locator('a[href*="github.com"]')).toHaveCount(0);
  await expect(pg.locator('#row-reset')).toHaveCount(0);
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

  test('security page: three entries per final design, no unlock-methods', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
    /* 定稿 §二.1：安全页恰好三项（站长凭证/管理凭证/立即锁定），「解锁方式」已移除 */
    await expect(pg.locator('#sec-unlock-methods')).toHaveCount(0);
    const owner = pg.locator('#sec-owner-cred');
    await expect(owner).toHaveCount(1);
    await expect(owner).toContainText('站长凭证');
    const mgmt = pg.locator('#sec-mgmt-cred');
    await expect(mgmt).toHaveCount(1);
    await expect(mgmt).toContainText('管理凭证');
    const locknow = pg.locator('#sec-locknow');
    await expect(locknow).toHaveCount(1);
    await expect(locknow).toContainText('立即锁定');
  });

  test('security page (en): three entries per final design', async ({ page: pg }) => {
    await pinLang(pg, 'en');
    await blockExternalRequests(pg);
    await pg.goto('/en/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
    await expect(pg.locator('#sec-unlock-methods')).toHaveCount(0);
    await expect(pg.locator('#sec-owner-cred')).toContainText('Owner credential');
    await expect(pg.locator('#sec-mgmt-cred')).toContainText('Manage credentials');
    await expect(pg.locator('#sec-locknow')).toContainText('Lock now');
  });
});

/* v1.3 #42 → B2-7：调色板换行态（B2-7 起真实色板已有 13 个，不再注入测试色块）。
   断言换行 + 末行左对齐 + 对勾可见。
   注：像素级视觉基线需在 CI 环境生成，本地环境字体渲染有差异，故此处只做 DOM 断言。 */
test('palette 8-color test state', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/theme/');
  const grid = pg.locator('#palette-dots');
  await expect(grid).toBeVisible();
  const fs = require('fs');
  const path = require('path');
  const ids = [...fs.readFileSync(path.join(__dirname, '..', '..', '..', 'web', 'data', 'palettes.yaml'), 'utf8').matchAll(/^\s*- id: ([a-z]+)$/gm)].map((m) => m[1]);
  await pg.evaluate(() => {
    document.getElementById('palette-dots').querySelector('.swatch').setAttribute('aria-pressed', 'true');
  });
  await expect(grid.locator('.palette-cell')).toHaveCount(ids.length);
  expect(ids.length).toBeGreaterThanOrEqual(8);
  // 断言换行：13 色在 412px 宽度下必定换行
  const boxes = await grid.locator('.palette-cell').evaluateAll((els) =>
    els.map((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; })
  );
  const rows = new Set(boxes.map((b) => b.top));
  expect(rows.size).toBeGreaterThan(1);
  // 末行左对齐：最后一行第一个 cell 的 left 与第一行第一个 cell 的 left 一致（±2px）
  const firstRowLeft = Math.min(...boxes.filter((b) => b.top === Math.min(...[...rows])).map((b) => b.left));
  const lastRowTop = Math.max(...[...rows]);
  const lastRowLeft = Math.min(...boxes.filter((b) => b.top === lastRowTop).map((b) => b.left));
  expect(Math.abs(lastRowLeft - firstRowLeft)).toBeLessThanOrEqual(2);
  // 选中态对勾可见
  await expect(grid.locator('.swatch[aria-pressed="true"] .swatch-check')).toBeVisible();
});

/* B2-1：诊断留痕已删除——即使 sessionStorage 里残留旧版的留痕/信标，安全与隐私页也不显示跳转日志卡；
   站内跳转不再写留痕 */
test('B2-1 security page: no jump-trace diagnostics', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/');
  await pg.evaluate(() => {
    sessionStorage.setItem('sgx-last-jump', JSON.stringify([{ who: 'navhistory.js:59', reason: 'goback-primary;to=/', at: Date.now(), desktop: false, visibility: 'visible' }]));
    sessionStorage.setItem('sgx-door-beacon', JSON.stringify({ path: '/settings/security/owner/', at: Date.now() }));
  });
  await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('main').first()).toBeVisible({ timeout: 15000 });
  await pg.waitForTimeout(500);
  await expect(pg.locator('#sgx-jump-note')).toHaveCount(0);
  await expect(pg.locator('main')).not.toContainText(/门内跳转|门内页已加载|navhistory\.js|\.js:\d+/);
  /* 站内返回：不再写新的留痕 */
  await pg.evaluate(() => sessionStorage.removeItem('sgx-last-jump'));
  await pg.locator('.sgx-tb-back').click();
  await pg.waitForURL(/\/settings\/$/, { timeout: 15000 });
  expect(await pg.evaluate(() => sessionStorage.getItem('sgx-last-jump'))).toBeNull();
});

/* B2-2：应用商店删除；Good Lock 迁入设置（应用 与 辅助功能 之间）；邀请码站进浏览器书签「我的项目」 */
test('B2-2 Good Lock is a settings category before Accessibility', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/');
  const hrefs = await pg.locator('.set-main section[aria-label="分类"] .set-row').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  const i = hrefs.indexOf('/settings/goodlock/');
  expect(i).toBeGreaterThan(0);
  // B2-4：应用分类已删除，Good Lock 前面是常规管理
  expect(hrefs[i - 1]).toBe('/settings/manage/');
  expect(hrefs[i + 1]).toBe('/settings/accessibility/');
});

test('B2-2 Good Lock subpage: rows toggle the same keys', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/goodlock/');
  await expect(pg.locator('.subpage-title').first()).toContainText('Good Lock');
  const row = pg.locator('#mod-sound');
  const sw = row.locator('.gl-switch');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await row.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(await pg.evaluate(() => localStorage.getItem('sgx-gl-sound'))).toBe('1');
  await row.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  expect(await pg.evaluate(() => localStorage.getItem('sgx-gl-sound'))).toBeNull();
  // 默认开启的模块：关掉写 '0'
  const wb = pg.locator('#mod-wellbeing');
  await expect(wb.locator('.gl-switch')).toHaveAttribute('aria-checked', 'true');
  await wb.click();
  expect(await pg.evaluate(() => localStorage.getItem('sgx-gl-wellbeing'))).toBe('0');
});

test('B2-2 store and its apps are gone; invite site in browser bookmarks', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
  for (const sel of ['[data-dock="store"]', '[data-navpage="store"]', 'a[href="/store/"]', 'a[href="/ai/"]', 'a[href="/books/"]', 'a[href="/music/"]', 'a[href="/goodlock/"]', '#np-widget', '#books', '#music', '[data-appid]']) {
    await expect(pg.locator(sel), sel).toHaveCount(0);
  }
  /* 2026-10-19：Dock 已全部删除 */
  for (const sel of ['#mobile-dock', '#dex-dock', '#dex-drawer']) await expect(pg.locator(sel), sel).toHaveCount(0);
  for (const p of ['/store/', '/ai/', '/books/', '/music/']) {
    const r = await pg.request.get(p);
    expect(r.status(), p).toBe(404);
  }
  const idx = await (await pg.request.get('/files-index.json')).json();
  const bad = idx.items.filter((it) => it.type === 'book' || it.type === 'music' || /\/(store|ai|books|music)\//.test(it.url || ''));
  expect(bad).toEqual([]);
  // 浏览器：「我的主页」下面紧跟「我的项目」，里面是邀请码站
  await pg.goto('/browser/', { waitUntil: 'domcontentloaded' });
  const titles = await pg.locator('.brw-catgroup .brw-group-title').evaluateAll((els) => els.map((e) => Array.from(e.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()));
  expect(titles.slice(0, 3)).toEqual(['我的主页', '我的项目', 'AI 资讯与 Agent']);
  const proj = pg.locator('.brw-catgroup').nth(1);
  await expect(proj.locator('a[href="https://muse-invite.styrigx.com"]')).toHaveCount(1);
  await expect(proj).toContainText('邀请码站');
});

/* B2-4：设置里的「应用」整块删除；我的文件、浏览器的设置迁到各自顶栏 ⋮；重置所有设置在常规管理 */
test('B2-4 settings has no Apps category; reset lives in General management', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/');
  const hrefs = await pg.locator('.set-main section[aria-label="分类"] .set-row').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  expect(hrefs).not.toContain('/settings/apps/');
  await expect(pg.locator('#sg-apps, #row-app-files, #row-app-browser')).toHaveCount(0);
  await gotoSettings(pg, '/settings/manage/');
  const rows = await pg.locator('#sg-manage .set-row').evaluateAll((els) => els.map((e) => e.id));
  expect(rows[rows.length - 1]).toBe('row-reset');
  await expect(pg.locator('#row-reset')).toContainText('重置所有设置');
});

test('B2-4 settings search: no Apps entries; reset points to General management', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/search/');
  const idx = await pg.evaluate(() => JSON.parse(document.getElementById('sgx-i18n-settings').textContent).setidx);
  expect(idx.filter((a) => a[4] === 'apps')).toEqual([]);
  const reset = idx.find((a) => a[0] === '重置所有设置');
  expect(reset[4]).toBe('manage');
  expect(reset[8]).toBe('/settings/manage/');
});


test('B2-4 Internet top-bar menu: engine, address bar position, clear history', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/browser/', { waitUntil: 'domcontentloaded' });
  const more = pg.locator('.sgx-tb-pill #brw-more');
  await expect(more).toHaveCount(1);
  const sheet = pg.locator('#sheet-body');
  /* ⋮ 先被搬进顶栏，browser.js 稍后才绑定点击：点早了不出弹层（CI 偶发 30s 超时）。点到弹层出来为止 */
  const openMenu = () => expect(async () => {
    await more.click();
    await expect(sheet).toContainText('搜索引擎', { timeout: 1500 });
  }).toPass({ timeout: 15000 });
  await openMenu();
  await expect(sheet).toContainText('地址栏位置');
  await expect(sheet).toContainText('清除浏览记录');
  await sheet.getByText('地址栏位置').click();
  await pg.locator('#sheet-body').getByText('顶部', { exact: true }).click();
  await expect(pg.locator('body')).toHaveClass(/addrbar-top/);
  expect(await pg.evaluate(() => localStorage.getItem('sgx-addrbar-pos'))).toBe('top');
  await openMenu();
  await pg.locator('#sheet-body').getByText('搜索引擎').click();
  await pg.locator('#sheet-body').getByText('Bing', { exact: true }).click();
  expect(await pg.evaluate(() => localStorage.getItem('sgx-search-engine'))).toBe('bing');
});
