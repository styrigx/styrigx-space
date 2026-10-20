/**
 * 快捷面板（2026-10-20，One UI 快捷面板式）验收：
 * - 顶栏右侧（长条与头像之间）全站都有快捷面板圆 .sgx-tb-quick；点开 #sgx-qp，面板从顶部滑下。
 * - 关闭：再点图标 / 点遮罩 / Esc / 系统返回（历史哨兵，只关面板不离开页面）；刚点开立刻 Esc 也能关（竞态回归）。
 * - 磁贴只放设置里已有的项，写的是和设置页同一个 localStorage key（同一套 setter，lib/prefs.js），
 *   即时生效、不刷新；设置页随之同步显示。
 * - 390px 宽：长条页名放得下「安全与隐私」，英文长页名省略号，不压到快捷面板圆。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 }, colorScheme: 'light' });

async function go(page, path, lang = 'zh', freeze = true) {
  await blockExternalRequests(page);
  /* 冻结时间会让 Date.now() 恒定，立即锁定的防误触窗口（400ms）永远过不去，那条测试不冻结 */
  if (freeze) await freezeTime(page);
  /* 只在没有偏好时写（语言磁贴切换后不要被 init script 改回去） */
  await page.addInitScript((l) => {
    try { if (!localStorage.getItem('sgx-lang')) localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
}

const qp = (page) => page.locator('#sgx-qp');
const tile = (page, id) => page.locator(`#sgx-qp [data-qp="${id}"]`);
const ls = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);

async function openQp(page) {
  await page.locator('.sgx-tb-quick').click();
  await expect(qp(page)).toBeVisible();
  await expect(qp(page)).toHaveClass(/\bis-open\b/);
  /* 等滑下结束（data-state=open）；is-open 只是过渡起点 */
  await expect(qp(page)).toHaveAttribute('data-state', 'open');
}
async function expectClosed(page) {
  await expect(qp(page)).toBeHidden();
  await expect(qp(page)).toHaveAttribute('data-state', 'closed');
  await expect(qp(page)).not.toHaveClass(/\bis-open\b/);
  await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'false');
}

test.describe('顶栏：快捷面板圆', () => {
  const PAGES = ['/', '/bookmarks/', '/search/', '/settings/', '/settings/display/', '/settings/security/', '/settings/account/'];
  for (const path of PAGES) {
    test(`${path}：九宫格 · 搜索圆 · 长条 · 快捷面板圆 · 头像`, async ({ page }) => {
      await go(page, path);
      const order = await page.evaluate(() =>
        Array.from(document.querySelector('.sgx-topbar').children).map((el) => el.className.split(' ')[0]));
      expect(order).toEqual(['sgx-tb-nav', 'sgx-tb-search', 'sgx-tb-pill', 'sgx-tb-quick', 'sgx-tb-me']);
      const q = page.locator('.sgx-tb-quick');
      await expect(q).toHaveAttribute('aria-label', '快捷面板');
      await expect(q).toHaveAttribute('aria-controls', 'sgx-qp');
      const qb = await q.boundingBox();
      const nb = await page.locator('.sgx-tb-nav').boundingBox();
      expect(Math.round(qb.width)).toBe(Math.round(nb.width));
      expect(Math.round(qb.height)).toBe(Math.round(nb.height));
    });
  }

  test('390px：「安全与隐私」完整显示，英文长页名省略号，页名不出长条', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(page, '/settings/security/');
    const t = page.locator('.sgx-tb-title');
    await expect(t).toHaveText('安全与隐私');
    expect(await t.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.evaluate(() => localStorage.setItem('sgx-lang', 'en'));
    await page.goto('/en/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(t).toHaveText('Security and privacy');
    const st = await t.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, to: getComputedStyle(el).textOverflow }));
    expect(st.to).toBe('ellipsis');
    expect(st.sw).toBeGreaterThan(st.cw);
    const tb = await t.boundingBox();
    const pill = await page.locator('.sgx-tb-pill').boundingBox();
    /* 页名在长条内居中（左右对称），不出长条 */
    expect(Math.abs(tb.x + tb.width / 2 - (pill.x + pill.width / 2))).toBeLessThanOrEqual(1);
    expect(tb.x).toBeGreaterThanOrEqual(pill.x);
    expect(tb.x + tb.width).toBeLessThanOrEqual(pill.x + pill.width);
  });
});

test.describe('快捷面板：开合', () => {
  test('点图标打开 / 再点关闭；面板从顶部滑下', async ({ page }) => {
    await go(page, '/settings/');
    await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'false');
    await openQp(page);
    await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'true');
    const sb = await page.locator('.sgx-qp-sheet').boundingBox();
    expect(sb.y).toBeLessThanOrEqual(16);
    /* <dialog> 模态在顶层，图标被遮罩盖住：用 JS 点（与键盘 / 读屏触发一致） */
    await page.evaluate(() => document.querySelector('.sgx-tb-quick').click());
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
  });

  test('点遮罩关闭', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    await page.mouse.click(200, 900);
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
  });

  test('点面板里的空白处不关闭', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    await page.locator('.sgx-qp-head').click();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
  });

  test('Esc 关闭', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
  });

  test('系统返回只关面板，停在本页；再返回才离开', async ({ page }) => {
    await go(page, '/');
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openQp(page);
    await page.goBack();
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });

  test('刚点开（滑下还没开始）就 Esc / 连点两下：照样关上，之后还能正常打开', async ({ page }) => {
    await go(page, '/settings/');
    /* 同一任务里点开再发 cancel（= Esc），保证落在 is-open 那两帧 rAF 之前 */
    await page.evaluate(() => {
      document.querySelector('.sgx-tb-quick').click();
      document.getElementById('sgx-qp').dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    await expectClosed(page);
    /* 真键盘：点开后立刻按 Esc */
    await page.locator('.sgx-tb-quick').click();
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await page.evaluate(() => {
      const b = document.querySelector('.sgx-tb-quick');
      b.click();
      b.click();
    });
    await expectClosed(page);
    /* 关完历史里不留哨兵 */
    await expect.poll(() => page.evaluate(() => !!(history.state && history.state.sgxQp))).toBe(false);
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
  });

  test('减弱动效：开合立刻到位', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, '/settings/');
    await page.locator('.sgx-tb-quick').click();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expectClosed(page);
  });

  test('导航抽屉照常工作（共用状态机）', async ({ page }) => {
    await go(page, '/settings/');
    await page.locator('.sgx-tb-nav').click();
    await expect(page.locator('#sgx-drawer')).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expect(page.locator('#sgx-drawer')).toBeHidden();
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
  });
});

test.describe('快捷面板：内容', () => {
  test('中文：磁贴与行（只有设置里已有的项）+ 全部设置', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await expect(page.locator('#sgx-qp .sgx-qp-tile .sgx-qp-label')).toHaveText(['深色模式', '跟随系统', '减弱动效', '语言', '立即锁定']);
    await expect(page.locator('#sgx-qp .sgx-qp-row-label')).toHaveText(['调色板', '字体大小', '布局']);
    await expect(page.locator('#sgx-qp [data-qp-palette]')).toHaveCount(13);
    await expect(page.locator('#sgx-qp [data-qp-seg="font-size"] button')).toHaveText(['小', '标准', '大']);
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] button')).toHaveText(['自动', 'Mobile', 'DeX', 'PC']);
    await expect(page.locator('#sgx-qp .sgx-qp-all')).toHaveText('全部设置');
    await expect(page.locator('#sgx-qp .sgx-qp-all')).toHaveAttribute('href', '/settings/');
    /* 默认：浅色、跟随系统开、减弱动效关、默认色板、标准字体、自动布局 */
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'false');
    await expect(tile(page, 'dark').locator('[data-qp-state]')).toHaveText('关');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system').locator('[data-qp-state]')).toHaveText('开');
    await expect(tile(page, 'motion')).toHaveAttribute('aria-pressed', 'false');
    await expect(tile(page, 'lang').locator('.sgx-qp-state')).toHaveText('中文');
    await expect(page.locator('#sgx-qp [data-qp-palette="lake"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sgx-qp [data-qp-seg="font-size"] [data-v="standard"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
    /* 开着的磁贴是主色容器底色 */
    const on = await tile(page, 'system').evaluate((el) => getComputedStyle(el).backgroundColor);
    const off = await tile(page, 'dark').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(on).not.toBe(off);
  });

  test('英文文案', async ({ page }) => {
    await go(page, '/en/', 'en');
    await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-label', 'Quick panel');
    await openQp(page);
    await expect(page.locator('#sgx-qp .sgx-qp-tile .sgx-qp-label')).toHaveText(['Dark mode', 'Follow system', 'Reduce motion', 'Language', 'Lock now']);
    await expect(page.locator('#sgx-qp .sgx-qp-row-label')).toHaveText(['Color palette', 'Font size', 'Layout']);
    await expect(tile(page, 'system').locator('[data-qp-state]')).toHaveText('On');
    await expect(page.locator('#sgx-qp .sgx-qp-all')).toHaveText('All settings');
    await expect(page.locator('#sgx-qp .sgx-qp-all')).toHaveAttribute('href', '/en/settings/');
  });
});

test.describe('快捷面板：与设置页同一个设置', () => {
  test('深色模式：写 sgx-theme-mode，即时变深 / 变浅；设置页同步', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await tile(page, 'dark').click();
    expect(await ls(page, 'sgx-theme-mode')).toBe('dark');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'false');
    await expect(qp(page)).toHaveAttribute('data-state', 'open'); /* 不关面板、不刷新 */
    await page.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#theme-previews [data-mode="dark"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'false');
    await openQp(page);
    await tile(page, 'dark').click();
    expect(await ls(page, 'sgx-theme-mode')).toBe('light');
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    /* 设置页开着时即时同步（同一页的设置行跟着变） */
    await expect(page.locator('#theme-previews [data-mode="light"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('跟随系统：与设置页「跟随系统」开关同一语义', async ({ page }) => {
    await go(page, '/settings/display/');
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'true');
    await openQp(page);
    await tile(page, 'system').click();
    /* 关掉跟随系统 → 固定为当前看到的浅色 */
    expect(await ls(page, 'sgx-theme-mode')).toBe('light');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'false');
    await tile(page, 'system').click();
    /* 改回跟随系统：默认值不存 */
    expect(await ls(page, 'sgx-theme-mode')).toBeNull();
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'true');
    /* 反向：在设置页改，面板打开时反映 */
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await page.locator('#theme-previews [data-mode="dark"]').click();
    await openQp(page);
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'false');
  });

  test('减弱动效：写 sgx-reduced-motion；设置页同步', async ({ page }) => {
    await go(page, '/settings/accessibility/');
    await openQp(page);
    await tile(page, 'motion').click();
    expect(await ls(page, 'sgx-reduced-motion')).toBe('1');
    await expect(page.locator('html')).toHaveClass(/\breduced-motion\b/);
    await expect(tile(page, 'motion')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sw-motion')).toHaveAttribute('aria-checked', 'true');
    await tile(page, 'motion').click();
    expect(await ls(page, 'sgx-reduced-motion')).toBeNull();
    await expect(page.locator('html')).not.toHaveClass(/\breduced-motion\b/);
    await expect(page.locator('#sw-motion')).toHaveAttribute('aria-checked', 'false');
  });

  test('调色板：写 sgx-palette，即时换色；设置页同步', async ({ page }) => {
    await go(page, '/settings/theme/');
    await openQp(page);
    await page.locator('#sgx-qp [data-qp-palette="forest"]').click();
    expect(await ls(page, 'sgx-palette')).toBe('forest');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'forest');
    await expect(page.locator('#sgx-qp [data-qp-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#palette-dots [data-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#sgx-qp [data-qp-palette="lake"]').click();
    expect(await ls(page, 'sgx-palette')).toBeNull();
    await expect(page.locator('html')).not.toHaveAttribute('data-palette', /.+/);
    await expect(page.locator('#palette-dots [data-palette="lake"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('字体大小：写 sgx-font-size，即时生效；设置页同步', async ({ page }) => {
    await go(page, '/settings/display/');
    await openQp(page);
    await page.locator('#sgx-qp [data-qp-seg="font-size"] [data-v="large"]').click();
    expect(await ls(page, 'sgx-font-size')).toBe('large');
    expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('112.5%');
    await expect(page.locator('#seg-font [data-v="large"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#sgx-qp [data-qp-seg="font-size"] [data-v="standard"]').click();
    expect(await ls(page, 'sgx-font-size')).toBeNull();
    expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('');
    /* 反向：设置页改小 → 面板打开时反映 */
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await page.locator('#seg-font [data-v="small"]').click();
    await openQp(page);
    await expect(page.locator('#sgx-qp [data-qp-seg="font-size"] [data-v="small"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('布局：窄屏 DeX / PC 置灰；写 sgx-layout；设置页同步', async ({ page }) => {
    await go(page, '/settings/display/');
    await openQp(page);
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="dex"]')).toBeDisabled();
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="pc"]')).toBeDisabled();
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="mobile"]').click();
    expect(await ls(page, 'sgx-layout')).toBe('mobile');
    await expect(page.locator('#seg-layout [data-v="mobile"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]').click();
    /* 自动 = 默认值；baseof.html __layoutMode 会把空值补写成 auto（与设置页相同） */
    expect(['auto', null]).toContain(await ls(page, 'sgx-layout'));
    await expect(page.locator('#seg-layout [data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('布局（宽屏）：选 DeX 立即换成 DeX 布局', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await go(page, '/settings/display/');
    await openQp(page);
    const sb = await page.locator('.sgx-qp-sheet').boundingBox();
    const qb = await page.locator('.sgx-tb-quick').boundingBox();
    /* 宽屏：面板靠右，在快捷面板圆这一侧 */
    expect(sb.x + sb.width).toBeGreaterThan(qb.x);
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="dex"]').click();
    expect(await ls(page, 'sgx-layout')).toBe('dex');
    await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="pc"]').click();
    await expect(page.locator('html')).toHaveClass(/\blayout-pc\b/);
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]').click();
    expect(['auto', null]).toContain(await ls(page, 'sgx-layout'));
    await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/); /* 1366×768 横屏 < 1600 → 自动 = DeX */
  });

  test('语言：切到 English（sgx-lang=en），同一页，不在历史里多留一步', async ({ page }) => {
    await go(page, '/');
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openQp(page);
    await expect(tile(page, 'lang')).toHaveAttribute('aria-label', /English/);
    await tile(page, 'lang').click();
    await expect(page).toHaveURL(/\/en\/settings\/$/);
    expect(await ls(page, 'sgx-lang')).toBe('en');
    await expect(page.locator('.sgx-tb-title')).toHaveText('Settings');
    await page.goBack();
    /* 回到进设置页之前的主页（语言偏好已是英文，主页 replace 到 /en/） */
    await expect(page).toHaveURL(/localhost:\d+\/(en\/)?$/);
  });

  test('立即锁定：关面板后弹出与安全页相同的确认层，确认后调 /api/lock', async ({ page }) => {
    let called = false;
    await go(page, '/', 'zh', false);
    await page.route('**/api/lock', async (route) => {
      called = true;
      await route.fulfill({ status: 200, body: '{}' });
    });
    await openQp(page);
    await tile(page, 'lock').click();
    await expectClosed(page);
    const dlg = page.locator('#sec-locknow-confirm');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('立即锁定？');
    /* 取消：不调接口 */
    await dlg.locator('[data-act="cancel"]').click();
    await expect(dlg).toBeHidden();
    expect(called).toBe(false);
    await page.waitForTimeout(450); /* 防误触窗口（400ms）过去 */
    await openQp(page);
    await tile(page, 'lock').click();
    await expect(dlg).toBeVisible();
    await dlg.locator('[data-act="ok"]').click();
    await expect(page).toHaveURL(/\?lock=1/);
    expect(called).toBe(true);
  });

  test('全部设置：进设置页，返回回到原页（不多一步）', async ({ page }) => {
    await go(page, '/');
    await page.goto('/bookmarks/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openQp(page);
    await page.locator('#sgx-qp .sgx-qp-all').click();
    await expect(page).toHaveURL(/\/settings\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/bookmarks\/$/);
    await expect(qp(page)).toBeHidden();
  });
});
