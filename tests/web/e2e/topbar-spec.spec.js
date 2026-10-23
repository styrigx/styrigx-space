/**
 * 顶栏 v2.0（与 Book 同一套）验收：左圆 + 长条（头像 + 居中 Styrigx + ⋮）+ 导航圆。
 * 顶栏 v3（2026-10-19，全站同一套）：左圆九宫格、右圆头像；长条主页 = 搜索 / Styrigx / 设置，子页面 = 返回 / Styrigx / ⋮。
 * 顶栏 v4（2026-10-20）：子页面长条里 ‹ 和 ⋮ 删除；九宫格改为左侧导航抽屉（见 nav-drawer.spec.js）。
 * 通版顶栏（2026-10-20）：全站长条 = 最前端搜索图标 + 当前页名（主页「首页」，不再显示 Styrigx）；点长条进全网搜索。
 * 主页长条里没有单独的设置 / 搜索按钮；没有滚动换标题；子页面没有大标题区，正文从顶栏下方 16px 开始（--sgx-content-top）。
 * 快捷面板（2026-10-20）：长条与头像之间多一个快捷面板圆（与左圆同尺寸同材质），长条相应变短（见 quick-panel.spec.js）。
 * 对称顶栏（2026-10-20）：九宫格圆 + 搜索圆 | 长条（只显示页名，不可点）| 快捷面板圆 + 头像圆；
 * 左右两组同宽，长条中心 = 屏幕中心（390 / 1280 / 1920 都量）；搜索圆进全网搜索页。
 * 顶栏 v5（2026-10-20）：两个圆 + 一个长条：九宫格圆 | 长条（左端搜索图标 · 页名 · 右端快捷面板图标）| 头像圆；
 * 两个图标各 40px 圆形点击区、对称内缩（图标中心距长条外缘 26 = 圆半径），页名在长条正中，长条在屏幕正中。
 * 顶栏 v8（2026-10-22，三个站同一套）：九宫格圆 | 长条（只有页名）| 右圆（每站自定义；主站 = 快捷面板）；头像挪进导航抽屉头（字标右边）。
 * 主站顶栏三栏（2026-10-22 PR2，只在主站）：主页 / 聊天 / 设置（2026-10-24 PR4 第三栏由「状态」换成「设置」）这三页长条里是三个标签（.sgx-tb-tabs），
 * 不放页名；其他页照旧只有页名。三栏本身的验收见 account-status.spec.js。
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
      test(`${path}：九宫格圆、长条（只有页名，屏幕居中）、右圆（快捷面板），坐标、高度、底色一致；顶栏里没有头像`, async ({ page }) => {
        await go(page, path, { dark });
        const nav = await box(page, '.sgx-tb-nav');
        const pill = await box(page, '.sgx-tb-pill');
        const end = await box(page, '.sgx-tb-end');
        expect(near(nav.x, 16) && near(nav.x + nav.width, 68), `导航圆 x ${nav.x}–${nav.x + nav.width}`).toBe(true);
        expect(near(pill.x, 76) && near(pill.x + pill.width, 314), `长条 x ${pill.x}–${pill.x + pill.width}`).toBe(true);
        /* 长条中心 = 屏幕中心 */
        expect(near(pill.x + pill.width / 2, 195), `长条中心 ${pill.x + pill.width / 2}`).toBe(true);
        expect(near(end.x, 322) && near(end.x + end.width, 374), `右圆 x ${end.x}–${end.x + end.width}`).toBe(true);
        for (const b of [nav, pill, end]) {
          expect(near(b.y, 16), `y ${b.y}`).toBe(true);
          expect(near(b.height, 52), `高 ${b.height}`).toBe(true);
        }
        expect(near(end.width, 52)).toBe(true);
        await expect(page.locator('.sgx-tb-back, [data-go-back], .sgx-tb-more, .sgx-tb-search, #sgx-tb-search, .sgx-tb-me, .sgx-topbar .sgx-tb-avatar')).toHaveCount(0);
        /* 顶栏 = 两个圆 + 一个长条；右圆就是快捷面板按钮；长条里只有页名（主页 / 设置首页 = 主页 / 聊天 / 设置三栏，见 account-status.spec.js） */
        const home = path === '/' || path === '/settings/';
        expect(await page.locator('.sgx-topbar > *').evaluateAll((els) => els.map((e) => e.className))).toEqual(['sgx-tb-nav', home ? 'sgx-tb-pill sgx-tb-pill-tabs' : 'sgx-tb-pill', 'sgx-tb-end sgx-tb-quick']);
        expect(await page.locator('.sgx-tb-pill > *').evaluateAll((els) => els.map((e) => e.className))).toEqual([home ? 'sgx-tb-tabs' : 'sgx-tb-title']);
        await expect(page.locator('.sgx-tb-pill svg, .sgx-tb-pill button')).toHaveCount(0);
        await expect(page.locator('.sgx-tb-pill a')).toHaveCount(home ? 3 : 0);
        await expect(page.locator('.sgx-tb-end svg')).toHaveCount(1);
        /* 页名（主页：三栏标签组）在长条内水平垂直居中 */
        const tx = await box(page, home ? '.sgx-tb-tabs' : '.sgx-tb-title');
        expect(near(tx.x + tx.width / 2, pill.x + pill.width / 2), `页名水平居中 ${tx.x + tx.width / 2}`).toBe(true);
        expect(near(tx.y + tx.height / 2, pill.y + pill.height / 2), `页名垂直居中 ${tx.y + tx.height / 2}`).toBe(true);
        /* 三块同材质 */
        const st = await page.evaluate(() =>
          ['.sgx-tb-nav', '.sgx-tb-pill', '.sgx-tb-end'].map((s) => { const c = getComputedStyle(document.querySelector(s)); return [c.backgroundColor, c.borderTopColor, c.boxShadow].join('|'); })
        );
        expect(st[0]).toBe(st[1]);
        expect(st[2]).toBe(st[1]);
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

  /* 主页（/、/en/）、设置首页（/settings/、/en/settings/）长条里是三栏标签、没有页名（account-status.spec.js） */
  const NAMES = [
    ['/account/status/', '服务状态'],
    ['/account/sync/', '云同步'],
    /* PR3：账号页没登录（这里没有账号会话）时页名是「登录账号」，登录后才是「账号」 */
    ['/account/', '登录账号'],
    ['/account/reset/', '重置登录'],
    ['/settings/security/', '安全与隐私'],
    ['/settings/security/lock/', '锁屏凭证'],
    ['/settings/display/', '显示'],
    ['/en/account/status/', 'Service status'],
    ['/en/account/', 'Sign in'],
    ['/en/account/reset/', 'Reset sign-in'],
  ];
  for (const [path, name] of NAMES) {
    test(`${path}：长条显示当前页名「${name}」（不是 Styrigx），没有大标题区`, async ({ page }) => {
      await page.addInitScript((en) => { try { localStorage.setItem('sgx-lang', en ? 'en' : 'zh'); } catch (e) {} }, path.startsWith('/en/'));
      await go(page, path);
      await expect(page.locator('.sgx-tb-title')).toHaveText(name);
      await expect(page.locator('.sgx-tb-pill')).not.toContainText('Styrigx');
      await expect(page.locator('.subpage-title, .subpage-hero, [data-subpage-head]')).toHaveCount(0);
      /* 长条里没有图标 */
      await expect(page.locator('.sgx-tb-pill svg')).toHaveCount(0);
    });
  }

  test('主页长条里没有设置按钮、没有搜索图标；长条只有 主页 / 聊天 / 设置 三栏（2026-10-22 起不放页名），长条本身不可点', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/');
    await expect(page.locator('.sgx-tb-set')).toHaveCount(0);
    await expect(page.locator('.sgx-tb-psearch')).toHaveCount(0);
    expect(await page.locator('.sgx-tb-pill > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['sgx-tb-tabs']);
    await expect(page.locator('.sgx-tb-pill .sgx-tb-tab')).toHaveText(['主页', '聊天', '设置']);
    await expect(page.locator('.sgx-tb-title')).toHaveCount(0);
    await expect(page.locator('#sgx-tb-cap')).toHaveCount(0);
    await expect(page.locator('.sgx-topbar .sgx-tb-search, #sgx-tb-search')).toHaveCount(0);
    expect(await page.locator('.sgx-tb-pill').evaluate((el) => getComputedStyle(el).cursor)).toBe('default');
    /* 设置入口只有三栏里的「设置」标签（PR4），没有别的设置按钮 */
    await expect(page.locator('.sgx-topbar a[href$="/settings/"]:not(.sgx-tb-tab)')).toHaveCount(0);
  });

  for (const path of ['/settings/', '/account/', '/settings/display/']) {
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
    const before = await Promise.all(['.sgx-tb-pill', '.sgx-tb-end', '.sgx-tb-nav'].map((s) => box(page, s)));
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.body.classList.contains('sgx-stuck'))).toBe(false);
    await expect(page.locator('.sgx-tb-title')).toHaveText('安全与隐私');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.sgx-tb-title')).opacity)).toBe('1');
    const after = await Promise.all(['.sgx-tb-pill', '.sgx-tb-end', '.sgx-tb-nav'].map((s) => box(page, s)));
    for (let i = 0; i < 3; i++) {
      expect(near(after[i].x, before[i].x) && near(after[i].y, before[i].y)).toBe(true);
    }
  });

  test('点长条（页名）不跳转', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/account/');
    await page.locator('.sgx-tb-title').click();
    await page.waitForTimeout(400);
    expect(new URL(page.url()).pathname).toBe('/account/');
  });

  test('顶栏切页过渡名挂在有尺寸的 .sgx-topbar 上', async ({ page }) => {
    await go(page, '/settings/');
    const names = await page.evaluate(() => ({
      bar: getComputedStyle(document.querySelector('.sgx-topbar')).viewTransitionName,
      nav: getComputedStyle(document.getElementById('site-nav')).viewTransitionName,
    }));
    expect(names).toEqual({ bar: 'sgx-topbar', nav: 'none' });
  });

  test('抽屉头的头像圆：点了进账号页（账号体系入口）', async ({ page }) => {
    /* 固定中文：不设 sgx-lang 时语言跟随浏览器（en-US）会把 / 带到 /en/ */
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/');
    await expect(page.locator('.sgx-drawer-me')).toHaveAttribute('href', '/account/');
    await page.locator('.sgx-tb-nav').click();
    await expect(page.locator('#sgx-drawer')).toHaveAttribute('data-state', 'open');
    await page.locator('.sgx-drawer-me').click();
    await page.waitForURL(/\/account\/$/);
    await expect(page.locator('#acct-login')).toBeVisible();
  });

  test('英文页抽屉头像链到英文账号页', async ({ page }) => {
    await go(page, '/en/');
    await expect(page.locator('.sgx-drawer-me')).toHaveAttribute('href', '/en/account/');
  });

  test('九宫格打开左侧导航抽屉，Esc 关闭', async ({ page }) => {
    await go(page, '/');
    await page.locator('.sgx-tb-nav').click();
    const dr = page.locator('#sgx-drawer');
    await expect(dr).toBeVisible();
    await expect(dr.locator('.sgx-drawer-item')).toHaveCount(4);
    await page.keyboard.press('Escape');
    await expect(dr).toBeHidden();
    await expect(dr).toHaveAttribute('data-state', 'closed');
    await expect(dr).not.toHaveClass(/\bis-open\b/);
  });
});

test.describe('1280×800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  /* 2026-10-23 PR-D：顶栏 = 外壳框 --sgx-shell-w = min(100% − 2 × 页边距, 最宽)，最宽 DeX 1440 / Mobile 640；
     页边距 ≥ 600 宽 = clamp(16, 5.333 + 2.2222vw, 48)；圆按钮 clamp(52, 42 + 1.667vw, 56)（≥ 840 宽 56），间距 clamp(8, −2 + 1.667vw, 12） */
  for (const [w, h] of [[600, 900], [840, 600], [1280, 800], [1920, 1080], [2560, 1440]]) {
    test(`${w}×${h}：外壳框宽 / 页边距 / 圆按钮按公式（±1px），居中`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await go(page, '/settings/');
      const m = Math.min(48, Math.max(16, 5.333 + 0.022222 * w));
      const max = w >= 840 && h >= 500 && w > h ? 1440 : 640;
      const want = Math.min(w - 2 * m, max);
      const btn = Math.min(56, Math.max(52, 42 + 0.01667 * w));
      const gap = Math.min(12, Math.max(8, -2 + 0.01667 * w));
      const bar = await box(page, '.sgx-topbar');
      expect(near(bar.width, want), `宽 ${bar.width} ≠ ${want}`).toBe(true);
      expect(near(bar.x, (w - want) / 2), `x ${bar.x}`).toBe(true);
      const me = await box(page, '.sgx-tb-end');
      const nav = await box(page, '.sgx-tb-nav');
      const pill = await box(page, '.sgx-tb-pill');
      expect(near(me.width, btn) && near(nav.width, btn) && near(pill.height, btn), `圆 ${nav.width} / ${me.width}，长条高 ${pill.height}，应为 ${btn}`).toBe(true);
      expect(near(nav.x, bar.x) && near(me.x + me.width, bar.x + bar.width), '两侧圆外缘 = 框边').toBe(true);
      const g = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.sgx-topbar')).columnGap));
      expect(Math.abs(g - gap), `间距 ${g} ≠ ${gap}`).toBeLessThanOrEqual(0.5);
    });
  }

  for (const [w, h] of [[1280, 800], [1920, 1080]]) {
    test(`${w}px：两侧圆同宽贴顶栏两端，长条只包住页名、中心 = 屏幕中心、页名中心 = 屏幕中心（±1px）`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await go(page, '/settings/security/');
      const [bar, nav, pill, me] = await Promise.all(['.sgx-topbar', '.sgx-tb-nav', '.sgx-tb-pill', '.sgx-tb-end'].map((s) => box(page, s)));
      expect(near(pill.x + pill.width / 2, w / 2), `长条中心 ${pill.x + pill.width / 2}`).toBe(true);
      expect(near(pill.x - nav.x, me.x + me.width - (pill.x + pill.width)), '两侧同宽').toBe(true);
      /* 2026-10-23：宽屏长条按内容定宽（min 160 / max 480），不再拉满；两侧圆仍贴顶栏两端 */
      expect(near(nav.x, bar.x) && near(me.x + me.width, bar.x + bar.width), '两侧圆贴顶栏两端').toBe(true);
      expect(pill.width, `长条宽 ${pill.width}`).toBeGreaterThanOrEqual(159);
      expect(pill.width, `长条宽 ${pill.width}`).toBeLessThanOrEqual(481);
      expect(pill.x - (nav.x + nav.width), '长条和左圆之间留空').toBeGreaterThan(8);
      const tx = await box(page, '.sgx-tb-title');
      expect(near(tx.x + tx.width / 2, w / 2), `页名中心 ${tx.x + tx.width / 2}`).toBe(true);
    });
  }

  for (const path of ['/', '/settings/']) {
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
