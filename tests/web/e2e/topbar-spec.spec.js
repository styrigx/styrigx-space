/**
 * 顶栏 v2.0（与 Book 同一套）验收：左圆 + 长条（头像 + 居中 Styrigx + ⋮）+ 导航圆。
 * 顶栏 v3（2026-10-19，全站同一套）：左圆九宫格、右圆头像；长条主页 = 搜索 / Styrigx / 设置，子页面 = 返回 / Styrigx / ⋮。
 * 顶栏 v4（2026-10-20）：子页面长条里 ‹ 和 ⋮ 删除；九宫格改为左侧导航抽屉（见 nav-drawer.spec.js）。
 * 通版顶栏（2026-10-20）：全站长条 = 最前端搜索图标 + 当前页名（主页「首页」，不再显示 Styrigx）；点长条进全网搜索。
 * 主页长条里没有单独的设置 / 搜索按钮；没有滚动换标题；子页面没有大标题区，正文从顶栏下方 16px 开始（--sgx-content-top）。
 * 快捷面板（2026-10-20）：长条与头像之间多一个快捷面板圆（与左圆同尺寸同材质），长条相应变短（见 quick-panel.spec.js）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

async function go(page, path, opts = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  if (opts.dark) {
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-theme-mode', 'dark'); } catch (e) {}
    });
  }
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(300);
}

async function box(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error('no box: ' + sel);
  return b;
}

function near(a, b, tol = 1) {
  return Math.abs(a - b) <= tol;
}

for (const dark of [false, true]) {
  test.describe(`390×844 ${dark ? '暗色' : '亮色'}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    for (const path of ['/', '/settings/']) {
      test(`${path}：左圆九宫格、长条（搜索图标 + 居中页名）、快捷面板圆、右圆头像，坐标、高度、底色一致`, async ({ page }) => {
        await go(page, path, { dark });
        const nav = await box(page, '.sgx-tb-nav');
        const pill = await box(page, '.sgx-tb-pill');
        const quick = await box(page, '.sgx-tb-quick');
        const me = await box(page, '.sgx-tb-me');
        expect(near(nav.x, 16) && near(nav.x + nav.width, 68), `导航圆 x ${nav.x}–${nav.x + nav.width}`).toBe(true);
        expect(near(pill.x, 76) && near(pill.x + pill.width, 254), `长条 x ${pill.x}–${pill.x + pill.width}`).toBe(true);
        expect(near(quick.x, 262) && near(quick.x + quick.width, 314), `快捷面板圆 x ${quick.x}–${quick.x + quick.width}`).toBe(true);
        expect(near(me.x, 322) && near(me.x + me.width, 374), `头像圆 x ${me.x}–${me.x + me.width}`).toBe(true);
        for (const b of [nav, pill, quick, me]) {
          expect(near(b.y, 16), `y ${b.y}`).toBe(true);
          expect(near(b.height, 52), `高 ${b.height}`).toBe(true);
        }
        await expect(page.locator('.sgx-tb-back')).toHaveCount(0);
        await expect(page.locator('[data-go-back]')).toHaveCount(0);
        await expect(page.locator('.sgx-tb-more')).toHaveCount(0);
        await expect(page.locator('.sgx-tb-pill .sgx-tb-avatar')).toHaveCount(0);
        const av = await box(page, '.sgx-tb-me .sgx-tb-avatar');
        expect(near(av.width, 50, 2) && near(av.height, 50, 2), `头像铺满圆 ${av.width}×${av.height}`).toBe(true);
        /* 搜索图标在长条最前端：中心距长条左边 26（与左圆图标同一节奏） */
        const ic = await box(page, '.sgx-tb-cap-ic');
        expect(near(ic.x + ic.width / 2 - pill.x, 26), `搜索图标中心距长条左边 ${ic.x + ic.width / 2 - pill.x}`).toBe(true);
        /* 页名在长条内水平垂直居中 */
        const tx = await box(page, '.sgx-tb-title');
        expect(near(tx.x + tx.width / 2, pill.x + pill.width / 2), `页名水平居中 ${tx.x + tx.width / 2}`).toBe(true);
        expect(near(tx.y + tx.height / 2, pill.y + pill.height / 2), `页名垂直居中 ${tx.y + tx.height / 2}`).toBe(true);
        const bgs = await page.evaluate(() =>
          ['.sgx-tb-nav', '.sgx-tb-pill', '.sgx-tb-quick'].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor)
        );
        expect(bgs[0]).toBe(bgs[1]);
        expect(bgs[2]).toBe(bgs[0]);
      });
    }
  });
}

test.describe('390×844 行为', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('旧顶栏元素、标题区旧按钮、大标题区、Styrigx 品牌字都已删除', async ({ page }) => {
    await go(page, '/settings/');
    for (const sel of ['#nav-time-center', '#nav-wx', '#nav-music-note', '.nav-inner', '.subpage-back', '#nav-brand', '.sgx-tb-text', '.subpage-mini-title']) {
      await expect(page.locator(sel), sel).toHaveCount(0);
    }
    await expect(page.locator('[data-tb-more]')).toHaveCount(0);
  });

  const NAMES = [
    ['/', '首页'],
    ['/bookmarks/', '书签'],
    ['/search/', '全网搜索'],
    ['/settings/', '设置'],
    ['/settings/account/', '账号'],
    ['/settings/security/', '安全与隐私'],
    ['/settings/security/mgmt/', '管理凭证'],
    ['/settings/display/', '显示'],
    ['/settings/search/', '设置搜索'],
    ['/en/', 'Home'],
    ['/en/settings/', 'Settings'],
    ['/en/settings/account/', 'Account'],
  ];
  for (const [path, name] of NAMES) {
    test(`${path}：长条显示当前页名「${name}」（不是 Styrigx），没有大标题区`, async ({ page }) => {
      await page.addInitScript((en) => { try { localStorage.setItem('sgx-lang', en ? 'en' : 'zh'); } catch (e) {} }, path.startsWith('/en/'));
      await go(page, path);
      await expect(page.locator('.sgx-tb-title')).toHaveText(name);
      await expect(page.locator('.sgx-tb-pill')).not.toContainText('Styrigx');
      await expect(page.locator('.subpage-title, .subpage-hero, [data-subpage-head]')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-pill .sgx-tb-cap-ic svg')).toHaveCount(1);
    });
  }

  test('主页长条里没有设置按钮、没有单独的搜索按钮（只有一个长条链接）', async ({ page }) => {
    await go(page, '/');
    await expect(page.locator('.sgx-tb-set')).toHaveCount(0);
    await expect(page.locator('.sgx-tb-psearch')).toHaveCount(0);
    await expect(page.locator('.sgx-tb-pill a, .sgx-tb-pill button')).toHaveCount(1);
    await expect(page.locator('.sgx-topbar a[href$="/settings/"]')).toHaveCount(0);
  });

  for (const path of ['/settings/', '/settings/account/', '/bookmarks/']) {
    test(`${path}：正文从顶栏下方 16px 开始（--sgx-content-top，全站同一个值）`, async ({ page }) => {
      await go(page, path);
      const m = await page.evaluate(() => {
        const bar = document.querySelector('.sgx-tb-pill').getBoundingClientRect();
        const main = document.getElementById('sgx-main');
        const first = main.firstElementChild.getBoundingClientRect();
        return { barBottom: bar.bottom, firstTop: first.top, scrollY: window.scrollY };
      });
      expect(m.scrollY).toBe(0);
      expect(Math.abs(m.firstTop - (m.barBottom + 16)), `首块顶 ${m.firstTop}，顶栏下沿 ${m.barBottom}`).toBeLessThanOrEqual(1);
    });
  }

  test('滚动时长条不变：页名一直显示，没有 sgx-stuck 切换，头像和按钮不动', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/settings/security/');
    const before = await Promise.all(['.sgx-tb-pill', '.sgx-tb-me', '.sgx-tb-nav'].map((s) => box(page, s)));
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.body.classList.contains('sgx-stuck'))).toBe(false);
    await expect(page.locator('.sgx-tb-title')).toHaveText('安全与隐私');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.sgx-tb-title')).opacity)).toBe('1');
    const after = await Promise.all(['.sgx-tb-pill', '.sgx-tb-me', '.sgx-tb-nav'].map((s) => box(page, s)));
    for (let i = 0; i < 3; i++) {
      expect(near(after[i].x, before[i].x) && near(after[i].y, before[i].y)).toBe(true);
    }
  });

  test('主页点长条：进全网搜索页并聚焦', async ({ page }) => {
    await go(page, '/');
    await page.locator('#sgx-tb-cap').click();
    await expect(page).toHaveURL(/\/search\/$/);
    await expect(page.locator('#sgx-cap-input-brwsearch')).toBeFocused({ timeout: 5000 });
  });

  test('子页面点长条（点页名）：同样进全网搜索页', async ({ page }) => {
    await go(page, '/settings/account/');
    await Promise.all([page.waitForURL(/\/search\/$/), page.locator('.sgx-tb-title').click()]);
  });

  test('顶栏切页过渡名挂在有尺寸的 .sgx-topbar 上', async ({ page }) => {
    await go(page, '/settings/');
    const names = await page.evaluate(() => ({
      bar: getComputedStyle(document.querySelector('.sgx-topbar')).viewTransitionName,
      nav: getComputedStyle(document.getElementById('site-nav')).viewTransitionName,
    }));
    expect(names).toEqual({ bar: 'sgx-topbar', nav: 'none' });
  });

  test('主页头像圆：点了进账号页（账号体系入口）', async ({ page }) => {
    /* 固定中文：不设 sgx-lang 时语言跟随浏览器（en-US）会把 / 带到 /en/ */
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/');
    await expect(page.locator('.sgx-tb-me')).toHaveAttribute('href', '/settings/account/');
    await page.locator('.sgx-tb-me').click();
    await page.waitForURL(/\/settings\/account\/$/);
    await expect(page.locator('#acct-login')).toBeVisible();
  });

  test('英文页头像圆链到英文账号页', async ({ page }) => {
    await go(page, '/en/');
    await expect(page.locator('.sgx-tb-me')).toHaveAttribute('href', '/en/settings/account/');
  });

  test('九宫格打开左侧导航抽屉，Esc 关闭', async ({ page }) => {
    await go(page, '/');
    await page.locator('.sgx-tb-nav').click();
    const dr = page.locator('#sgx-drawer');
    await expect(dr).toBeVisible();
    await expect(dr.locator('.sgx-drawer-item')).toHaveCount(5);
    await page.keyboard.press('Escape');
    await expect(dr).toBeHidden();
    await expect(dr).toHaveAttribute('data-state', 'closed');
    await expect(dr).not.toHaveClass(/\bis-open\b/);
  });
});

test.describe('1280×800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('容器宽 1068 居中，三块尺寸与手机相同', async ({ page }) => {
    await go(page, '/settings/');
    const bar = await box(page, '.sgx-topbar');
    expect(near(bar.width, 1068), `宽 ${bar.width}`).toBe(true);
    expect(near(bar.x, (1280 - 1068) / 2), `x ${bar.x}`).toBe(true);
    const me = await box(page, '.sgx-tb-me');
    const nav = await box(page, '.sgx-tb-nav');
    const pill = await box(page, '.sgx-tb-pill');
    expect(near(me.width, 52) && near(nav.width, 52) && near(pill.height, 52)).toBe(true);
  });

  for (const path of ['/', '/settings/', '/search/']) {
    test(`${path}：宽屏正文同样从顶栏下方 16px 开始，没有大标题区`, async ({ page }) => {
      await go(page, path);
      const m = await page.evaluate(() => {
        const bar = document.querySelector('.sgx-tb-pill').getBoundingClientRect();
        const first = document.getElementById('sgx-main').firstElementChild.getBoundingClientRect();
        return { barBottom: bar.bottom, firstTop: first.top };
      });
      expect(Math.abs(m.firstTop - (m.barBottom + 16)), `首块顶 ${m.firstTop}，顶栏下沿 ${m.barBottom}`).toBeLessThanOrEqual(1);
      await expect(page.locator('.subpage-title, [data-subpage-head]')).toHaveCount(0);
    });
  }
});
