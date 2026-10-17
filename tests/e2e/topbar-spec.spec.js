/**
 * 顶栏 v2.0（与 Book 同一套）验收：左圆 + 长条（头像 + 居中 Styrigx + ⋮）+ 导航圆。
 * B2-3：主页左圆是搜索（进浏览器并打开搜索），不是返回；三块位置与子页面完全一致。
 * Styrigx 在长条内水平垂直居中，头像始终显示；滚动后 Styrigx 淡出、小标题淡入。
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

    test('子页面：三块坐标、高度、品牌和 ⋮ 位置、底色一致', async ({ page }) => {
      await go(page, '/settings/', { dark });
      const back = await box(page, '.sgx-tb-back');
      const pill = await box(page, '.sgx-tb-pill');
      const nav = await box(page, '.sgx-tb-nav');
      expect(near(back.x, 16) && near(back.x + back.width, 68), `返回圆 x ${back.x}–${back.x + back.width}`).toBe(true);
      expect(near(pill.x, 76) && near(pill.x + pill.width, 314), `长条 x ${pill.x}–${pill.x + pill.width}`).toBe(true);
      expect(near(nav.x, 322) && near(nav.x + nav.width, 374), `导航圆 x ${nav.x}–${nav.x + nav.width}`).toBe(true);
      for (const b of [back, pill, nav]) {
        expect(near(b.y, 16), `y ${b.y}`).toBe(true);
        expect(near(b.height, 52), `高 ${b.height}`).toBe(true);
      }
      const av = await box(page, '.sgx-tb-avatar');
      expect(near(av.x - pill.x, 12), `头像左距 ${av.x - pill.x}`).toBe(true);
      const tx = await box(page, '.sgx-tb-text');
      expect(near(tx.x + tx.width / 2, pill.x + pill.width / 2), `Styrigx 水平居中 ${tx.x + tx.width / 2}`).toBe(true);
      expect(near(tx.y + tx.height / 2, pill.y + pill.height / 2), `Styrigx 垂直居中 ${tx.y + tx.height / 2}`).toBe(true);
      const more = await box(page, '.sgx-tb-pill .sgx-tb-more');
      expect(near(pill.x + pill.width - (more.x + more.width / 2), 26), '⋮ 中心距长条右边 26').toBe(true);
      const bgs = await page.evaluate(() =>
        ['.sgx-tb-back', '.sgx-tb-pill', '.sgx-tb-nav'].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor)
      );
      expect(bgs[0]).toBe(bgs[1]);
      expect(bgs[2]).toBe(bgs[1]);
    });

    test('主页：左圆是搜索、不是返回，三块位置、底色与子页面一致，Styrigx 居中', async ({ page }) => {
      await go(page, '/', { dark });
      await expect(page.locator('.sgx-tb-back')).toHaveCount(0);
      await expect(page.locator('[data-go-back]')).toHaveCount(0);
      const search = await box(page, '.sgx-tb-search');
      const pill = await box(page, '.sgx-tb-pill');
      const nav = await box(page, '.sgx-tb-nav');
      expect(near(search.x, 16) && near(search.x + search.width, 68), `搜索圆 x ${search.x}–${search.x + search.width}`).toBe(true);
      expect(near(pill.x, 76) && near(pill.x + pill.width, 314), `长条 x ${pill.x}–${pill.x + pill.width}`).toBe(true);
      expect(near(nav.x, 322) && near(nav.x + nav.width, 374), `导航圆 x ${nav.x}–${nav.x + nav.width}`).toBe(true);
      for (const b of [search, pill, nav]) {
        expect(near(b.y, 16), `y ${b.y}`).toBe(true);
        expect(near(b.height, 52), `高 ${b.height}`).toBe(true);
      }
      const tx = await box(page, '.sgx-tb-text');
      expect(near(tx.x + tx.width / 2, pill.x + pill.width / 2), 'Styrigx 水平居中').toBe(true);
      const bgs = await page.evaluate(() =>
        ['.sgx-tb-search', '.sgx-tb-pill', '.sgx-tb-nav'].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor)
      );
      expect(bgs[0]).toBe(bgs[1]);
      expect(bgs[2]).toBe(bgs[1]);
    });
  });
}

test.describe('390×844 行为', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('旧顶栏元素和标题区旧按钮都已删除', async ({ page }) => {
    await go(page, '/files/');
    for (const sel of ['#nav-time-center', '#nav-wx', '#nav-music-note', '.nav-inner', '.subpage-back']) {
      await expect(page.locator(sel), sel).toHaveCount(0);
    }
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('.subpage-head [data-tb-more]')].filter((e) => getComputedStyle(e).display !== 'none').length
    );
    expect(shown).toBe(0);
  });

  test('标题区下沉：高度 max(280, 35% 可见高度)，padding-top 84，padding-bottom 76', async ({ page }) => {
    await go(page, '/settings/');
    const m = await page.evaluate(() => {
      const h = document.querySelector('[data-subpage-head]');
      const cs = getComputedStyle(h);
      return { h: h.offsetHeight, pt: cs.paddingTop, pb: cs.paddingBottom, vh: window.innerHeight };
    });
    expect(m.h).toBeGreaterThanOrEqual(Math.max(280, Math.round(m.vh * 0.35)) - 1);
    expect(m.pt).toBe('84px');
    expect(m.pb).toBe('76px');
  });

  test('滚过标题区 × 0.55：头像不动、Styrigx 淡出、小标题在长条内可见、三个按钮不动', async ({ page }) => {
    await go(page, '/settings/');
    const before = await Promise.all(['.sgx-tb-back', '.sgx-tb-pill .sgx-tb-more', '.sgx-tb-nav'].map((s) => box(page, s)));
    const headH = await page.evaluate(() => document.querySelector('[data-subpage-head]').offsetHeight);
    await page.evaluate((y) => window.scrollTo(0, y), Math.round(headH * 0.55 + 50));
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.sgx-tb-text')).opacity)).toBe('0');
    const op = await page.evaluate(() => ({
      brand: getComputedStyle(document.querySelector('.sgx-tb-brand')).opacity,
      avatar: getComputedStyle(document.querySelector('.sgx-tb-avatar')).opacity,
    }));
    expect(op, '头像一直显示').toEqual({ brand: '1', avatar: '1' });
    await expect(page.locator('.sgx-tb-pill .subpage-mini-title')).toHaveCount(1);
    await expect.poll(() =>
      page.evaluate(() => Number(getComputedStyle(document.querySelector('.sgx-tb-pill .subpage-mini-title')).opacity))
    ).toBeGreaterThan(0.5);
    const after = await Promise.all(['.sgx-tb-back', '.sgx-tb-pill .sgx-tb-more', '.sgx-tb-nav'].map((s) => box(page, s)));
    for (let i = 0; i < 3; i++) {
      expect(near(after[i].x, before[i].x) && near(after[i].y, before[i].y)).toBe(true);
    }
  });

  test('九宫点：3 项，当前站点有 ✓，菜单在按钮下方 8px 右对齐，Esc 关闭', async ({ page }) => {
    await go(page, '/settings/');
    await page.locator('.sgx-tb-nav').click();
    const menu = page.locator('#sgx-tb-navmenu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.sgx-tb-menu-item')).toHaveCount(3);
    /* 三站统一：第一项叫「主站」（不是「主页」），顺序 主站 / 书库 / 博客 */
    const labels = (await menu.locator('.sgx-tb-menu-item').allInnerTexts()).map((t) => t.trim());
    const en = (await page.evaluate(() => document.documentElement.lang)) === 'en';
    expect(labels).toEqual(en ? ['Main Site', 'Library', 'Blog'] : ['主站', '书库', '博客']);
    await expect(menu.locator('[aria-current="true"] svg')).toHaveCount(1);
    const b = await box(page, '.sgx-tb-nav');
    const m = await box(page, '#sgx-tb-navmenu');
    expect(near(m.y, b.y + b.height + 8, 2)).toBe(true);
    expect(near(m.x + m.width, b.x + b.width)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('我的文件：顶栏 ⋮ 就是页面自己的菜单按钮，点开原来的菜单', async ({ page }) => {
    await go(page, '/files/');
    await expect(page.locator('.sgx-tb-pill #files-more.sgx-tb-more')).toHaveCount(1);
    await page.locator('.sgx-tb-pill .sgx-tb-more').click();
    await expect(page.locator('dialog[open]').first()).toBeVisible({ timeout: 5000 });
  });

  test('主页搜索圆：进浏览器并打开搜索', async ({ page }) => {
    await go(page, '/');
    await page.locator('.sgx-tb-search').click();
    await expect(page).toHaveURL(/\/browser\/#focus$/);
    await expect(page.locator('#brw-overlay')).toHaveClass(/\bopen\b/, { timeout: 10000 });
    await expect(page.locator('#brw-input')).toBeFocused({ timeout: 5000 });
  });

  test('返回圆回上一级', async ({ page }) => {
    await go(page, '/settings/');
    await page.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-tb-back')).toBeVisible({ timeout: 15000 });
    await page.locator('.sgx-tb-back').click();
    await expect(page).toHaveURL(/\/settings\/$/);
  });
});

test.describe('1280×800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('容器宽 1068 居中，三块尺寸与手机相同', async ({ page }) => {
    await go(page, '/settings/');
    const bar = await box(page, '.sgx-topbar');
    expect(near(bar.width, 1068), `宽 ${bar.width}`).toBe(true);
    expect(near(bar.x, (1280 - 1068) / 2), `x ${bar.x}`).toBe(true);
    const back = await box(page, '.sgx-tb-back');
    const nav = await box(page, '.sgx-tb-nav');
    const pill = await box(page, '.sgx-tb-pill');
    expect(near(back.width, 52) && near(nav.width, 52) && near(pill.height, 52)).toBe(true);
  });
});
