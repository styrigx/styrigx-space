/**
 * 2026-10-20 导航改版验收：
 * - 顶栏全站同一套（v5）：九宫格圆 | 长条（搜索图标 · 页名 · 快捷面板图标，屏幕居中）| 头像圆；没有 ‹ 返回、没有 ⋮。
 * - 抽屉宽（2026-10-21 v5）：手机竖屏（< 600px）右缘对齐长条右端直边与右圆弧的切线（412 → 310，360 → 258）；更宽固定 320px。
 *   面板底色 = 顶栏材质（跟随调色板与明暗）；阴影往右投、清楚可见。
 * - 抽屉头（v6）：同一行 大号 Styrigx（26px/800）+ 搜索框长条（AI 搜索图标 + 「搜索」→ /search/，在搜索页上只关抽屉并聚焦输入框），
 *   右缘对齐药丸右缘；头部和首页之间留足间距。
 * - 九宫格 → Gmail 式左侧导航抽屉：首页 / 珍格 / 日刻 / 博客（2026-10-21 起没有 设置；书签项换成子站 珍格 Curio，入口在快捷面板齿轮）；每项有描边图标，
 *   当前页是药丸高亮；没有 我的文件 / 帮助与反馈；点遮罩 / Esc / 系统返回关闭。
 * - 2026-10-21 主站书签下线（迁到子站 珍格 Curio）：/bookmarks/ 线上 301 到 curio.styrigx.com；/browser/ → 全网搜索 /search/。
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
  /* 等滑入结束（data-state=open）再量位置 / 截图；is-open 只是过渡起点 */
  await expect(drawer(page)).toHaveAttribute('data-state', 'open');
}

test.describe('顶栏：全站同一套，没有 ‹ 和 ⋮', () => {
  const PAGES = ['/', '/search/', '/settings/', '/settings/display/', '/settings/security/', '/settings/account/'];
  for (const path of PAGES) {
    test(`${path}：九宫格 + 长条（搜索 · 页名 · 快捷面板）+ 头像，没有返回圆和 ⋮`, async ({ page }) => {
      await go(page, path);
      await expect(page.locator('.sgx-tb-back')).toHaveCount(0);
      await expect(page.locator('[data-go-back]')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-more')).toHaveCount(0);
      await expect(page.locator('[data-tb-more]')).toHaveCount(0);
      await expect(page.locator('.sgx-topbar > *')).toHaveCount(3);
      await expect(page.locator('.sgx-topbar > .sgx-tb-nav')).toHaveCount(1);
      await expect(page.locator('.sgx-topbar > .sgx-tb-pill')).toHaveCount(1);
      await expect(page.locator('.sgx-topbar > .sgx-tb-me')).toHaveCount(1);
      /* 搜索、快捷面板（见 quick-panel.spec.js）都收进长条 */
      await expect(page.locator('.sgx-tb-pill > .sgx-tb-search')).toHaveCount(1);
      await expect(page.locator('.sgx-tb-pill > .sgx-tb-quick')).toHaveCount(1);
    });
  }

  test('子页长条：两端搜索 / 快捷面板图标，页名在长条内居中', async ({ page }) => {
    await go(page, '/settings/display/');
    await expect(page.locator('.sgx-tb-pill a, .sgx-tb-pill button')).toHaveCount(2);
    const pill = await page.locator('.sgx-tb-pill').boundingBox();
    const tx = await page.locator('.sgx-tb-title').boundingBox();
    expect(Math.abs(tx.x + tx.width / 2 - (pill.x + pill.width / 2))).toBeLessThanOrEqual(1);
  });
});

test.describe('导航抽屉', () => {
  test('打开：首页 / 珍格 / 日刻 / 博客，没有 设置 和分隔线；每项有图标；没有 我的文件 / 帮助', async ({ page }) => {
    await go(page, '/settings/display/');
    await expect(page.locator('.sgx-tb-nav')).toHaveAttribute('aria-expanded', 'false');
    await openDrawer(page);
    await expect(page.locator('.sgx-tb-nav')).toHaveAttribute('aria-expanded', 'true');
    const lists = drawer(page).locator('.sgx-drawer-list');
    await expect(lists).toHaveCount(1);
    await expect(lists.nth(0).locator('.sgx-drawer-label')).toHaveText(['首页', '珍格', '日刻', '博客']);
    await expect(drawer(page).locator('hr.sgx-drawer-div')).toHaveCount(0);
    await expect(drawer(page).locator('[data-nav="settings"]')).toHaveCount(0);
    await expect(drawer(page).locator('a[href$="/settings/"]')).toHaveCount(0);
    await expect(drawer(page).locator('.sgx-drawer-label', { hasText: '设置' })).toHaveCount(0);
    const items = drawer(page).locator('.sgx-drawer-item');
    await expect(items).toHaveCount(4);
    for (let i = 0; i < 4; i++) await expect(items.nth(i).locator('.sgx-drawer-ic svg')).toHaveCount(1);
    await expect(drawer(page)).not.toContainText('我的文件');
    await expect(drawer(page)).not.toContainText('帮助');
    await expect(drawer(page).locator('a[href*="/files/"]')).toHaveCount(0);
    /* 链接 */
    await expect(items.nth(0)).toHaveAttribute('href', '/');
    await expect(items.nth(1)).toHaveAttribute('href', 'https://curio.styrigx.com/');
    await expect(items.nth(1)).toHaveAttribute('data-nav', 'curio');
    await expect(items.nth(2)).toHaveAttribute('href', 'https://daymark.styrigx.com/');
    await expect(items.nth(3)).toHaveAttribute('href', 'https://blog.styrigx.com/');
    /* 设置子页：抽屉里没有对应项，没有高亮 */
    await expect(drawer(page).locator('[aria-current="page"]')).toHaveCount(0);
    /* 抽屉贴左边 */
    const sheet = await drawer(page).locator('.sgx-drawer-sheet').boundingBox();
    expect(Math.abs(sheet.x)).toBeLessThanOrEqual(1);
  });

  test('当前页高亮：主页 → 首页', async ({ page }) => {
    await go(page, '/');
    await openDrawer(page);
    await expect(drawer(page).locator('[aria-current="page"] .sgx-drawer-label')).toHaveText('首页');
  });

  test('当前页高亮：药丸底色与普通项不同', async ({ page }) => {
    await go(page, '/');
    await openDrawer(page);
    const items = drawer(page).locator('.sgx-drawer-item');
    await expect(items.nth(0)).toHaveAttribute('aria-current', 'page');
    const bg = await items.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor);
    const bg0 = await items.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe(bg0);
  });

  test('英文：Home / Curio / Daymark / Blog，没有 Settings；搜索框 → /en/search/', async ({ page }) => {
    await go(page, '/en/', 'en');
    await openDrawer(page);
    await expect(drawer(page).locator('.sgx-drawer-label')).toHaveText(['Home', 'Curio', 'Daymark', 'Blog']);
    await expect(drawer(page).locator('.sgx-drawer-item').nth(1)).toHaveAttribute('href', 'https://curio.styrigx.com/en/');
    const s = drawer(page).locator('.sgx-drawer-head a.sgx-drawer-search');
    await expect(s).toHaveAttribute('href', '/en/search/');
    await expect(s).toHaveAttribute('aria-label', 'Search');
    await expect(s.locator('.sgx-drawer-search-label')).toHaveText('Search');
    expect(await s.locator('.sgx-drawer-search-label').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test('刚点开（滑入还没开始）就 Esc / 再点九宫格：照样关上，不卡在打开状态', async ({ page }) => {
    await go(page, '/settings/');
    /* 同一任务里点开再发 cancel（= Esc），保证落在 is-open 那两帧 rAF 之前 */
    await page.evaluate(() => {
      document.querySelector('.sgx-tb-nav').click();
      document.getElementById('sgx-drawer').dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    await expect(drawer(page)).toBeHidden();
    await expect(drawer(page)).toHaveAttribute('data-state', 'closed');
    await expect(drawer(page)).not.toHaveClass(/\bis-open\b/);
    await expect(page.locator('.sgx-tb-nav')).toHaveAttribute('aria-expanded', 'false');
    /* 连点两下九宫格（第二下落在滑入前）同样关上；之后还能正常再打开 */
    await page.evaluate(() => {
      const b = document.querySelector('.sgx-tb-nav');
      b.click();
      b.click();
    });
    await expect(drawer(page)).toBeHidden();
    await expect(drawer(page)).toHaveAttribute('data-state', 'closed');
    await openDrawer(page);
    const sheet = await drawer(page).locator('.sgx-drawer-sheet').boundingBox();
    expect(Math.abs(sheet.x)).toBeLessThanOrEqual(1);
  });

  test('减弱动效：开合立刻到位', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, '/settings/');
    await openDrawer(page);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toBeHidden();
    await expect(drawer(page)).toHaveAttribute('data-state', 'closed');
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
    await drawer(page).locator('.sgx-drawer-item', { hasText: '首页' }).click();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/$/);
    await expect(drawer(page)).toBeHidden();
  });

  test('点当前页那一项只关闭', async ({ page }) => {
    await go(page, '/');
    await openDrawer(page);
    await drawer(page).locator('.sgx-drawer-item', { hasText: '首页' }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });
});

test.describe('抽屉头：大号站名 + 搜索框', () => {
  for (const w of [412, 360]) {
    test(`${w}px：同一行 Styrigx（26px/800）+ 搜索框长条（→ /search/，ai-search 图标 + 「搜索」），右缘对齐药丸右缘；头部和首页之间留足间距`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 915 });
      await go(page, '/');
      await openDrawer(page);
      const head = drawer(page).locator('.sgx-drawer-head');
      await expect(head.locator('.sgx-drawer-brand')).toHaveText('Styrigx');
      const s = head.locator('a.sgx-drawer-search');
      await expect(s).toHaveCount(1);
      await expect(s).toHaveAttribute('href', '/search/');
      await expect(s).toHaveAttribute('aria-label', '搜索');
      await expect(s.locator('.sgx-drawer-search-label')).toHaveText('搜索');
      /* 图标：断口放大镜 + 实心四角星，24px */
      await expect(s.locator('.sgx-drawer-search-ic svg path')).toHaveCount(3);
      expect(await s.locator('svg path').first().getAttribute('d')).toBe('M14.9 9.6A6 6 0 1 1 11.6 7.2');
      expect(await s.locator('svg path').nth(2).getAttribute('fill')).toBe('currentColor');
      /* 抽屉里没有设置 */
      await expect(drawer(page).locator('a[href$="/settings/"], [data-nav="settings"]')).toHaveCount(0);
      const m = await page.evaluate(() => {
        const q = (sel) => document.querySelector(sel);
        const r = (sel) => q(sel).getBoundingClientRect();
        const b = q('#sgx-drawer .sgx-drawer-search');
        const t = q('#sgx-drawer .sgx-drawer-brand');
        const lb = q('#sgx-drawer .sgx-drawer-search-label');
        return { s: r('#sgx-drawer .sgx-drawer-search'), t: r('#sgx-drawer .sgx-drawer-brand'), it: r('#sgx-drawer .sgx-drawer-item'),
          ic: r('#sgx-drawer .sgx-drawer-search-ic svg'), head: r('#sgx-drawer .sgx-drawer-head'),
          rad: getComputedStyle(b).borderTopLeftRadius, bg: getComputedStyle(b).backgroundColor,
          fs: getComputedStyle(t).fontSize, fw: getComputedStyle(t).fontWeight,
          lbTrunc: lb.scrollWidth > lb.clientWidth };
      });
      expect(m.fs).toBe('26px');
      expect(m.fw).toBe('800');
      expect(Math.round(m.s.height)).toBe(48);
      expect(m.rad).toBe('999px');
      expect(m.bg).not.toBe('rgba(0, 0, 0, 0)');
      expect(Math.round(m.ic.width)).toBe(24);
      /* 搜索框在站名右边 12px，右缘 = 药丸右缘（不再贴着抽屉边），与站名竖直居中 */
      expect(Math.abs(m.s.left - m.t.right - 12)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.s.right - m.it.right), `搜索框右缘 ${m.s.right}，药丸右缘 ${m.it.right}`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.s.top + m.s.height / 2 - (m.t.top + m.t.height / 2))).toBeLessThanOrEqual(1);
      /* 360 宽也放得下「搜索」，不截断 */
      expect(m.lbTrunc).toBe(false);
      expect(m.s.width).toBeGreaterThanOrEqual(90);
      /* 头部和第一项（首页）之间至少 28px */
      expect(m.it.top - m.head.bottom).toBeGreaterThanOrEqual(28);
    });
  }

  test('点搜索框：关抽屉后进全网搜索页，不在历史里多留一步', async ({ page }) => {
    await go(page, '/');
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openDrawer(page);
    await drawer(page).locator('a.sgx-drawer-search').click();
    await expect(page).toHaveURL(/\/search\/$/);
    /* 搜索页自己会占历史（键盘 / 当前页哨兵）：一直返回到离开 /search/，落点是设置页且不是抽屉哨兵 */
    for (let i = 0; i < 4 && new URL(page.url()).pathname === '/search/'; i++) {
      await page.goBack();
      await page.waitForTimeout(300);
    }
    await expect(page).toHaveURL(/\/settings\/$/);
    expect(await page.evaluate(() => !!(history.state && history.state.sgxDrawer))).toBe(false);
    await expect(drawer(page)).toBeHidden();
  });

  test('在全网搜索页上点搜索框：只关抽屉并聚焦底部输入框', async ({ page }) => {
    await go(page, '/search/');
    await expect(page.locator('#sgx-cap-input-brwsearch')).toHaveCount(1);
    await openDrawer(page);
    await drawer(page).locator('a.sgx-drawer-search').click();
    await expect(drawer(page)).toBeHidden();
    await expect(page).toHaveURL(/\/search\/$/);
    await expect(page.locator('#sgx-cap-input-brwsearch')).toBeFocused();
  });
});

test.describe('主站书签已下线', () => {
  test('/browser/ 跳到全网搜索 /search/（中英，查询串保留）；没有 /bookmarks/ 页面', async ({ page }) => {
    await go(page, '/browser/?q=hello');
    await expect(page).toHaveURL(/\/search\/\?q=hello$/);
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await page.goto('/en/browser/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/en\/search\/$/);
    for (const p of ['/bookmarks/', '/en/bookmarks/']) {
      const r = await page.request.get(p);
      expect(r.status(), p).not.toBe(200);
    }
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

test.describe('抽屉宽度与底色', () => {
  async function sheetAndQuick(page) {
    /* 等滑入真正到位（负载高时 data-state=open 可能早于 transform 结束一两帧） */
    await expect.poll(() => page.locator('#sgx-drawer .sgx-drawer-sheet').evaluate((el) => Math.abs(el.getBoundingClientRect().left))).toBeLessThanOrEqual(0.5);
    return page.evaluate(() => {
      const s = document.querySelector('#sgx-drawer .sgx-drawer-sheet').getBoundingClientRect();
      const p = document.querySelector('.sgx-tb-pill').getBoundingClientRect();
      const it = document.querySelector('#sgx-drawer .sgx-drawer-item').getBoundingClientRect();
      /* 长条右圆弧半径 = 长条高 / 2：直边在 右缘 − 半高 处接上圆弧 */
      return { left: s.left, right: s.right, width: s.width, tangent: p.right - p.height / 2, itemLeft: it.left, itemRight: it.right };
    });
  }

  for (const [w, want] of [[360, 258], [390, 288], [412, 310]]) {
    test(`手机竖屏 ${w}px：抽屉宽 ${want}，右缘 = 长条右端直边与右圆弧的切线（±1px）`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 844 });
      await go(page, '/settings/');
      await openDrawer(page);
      const m = await sheetAndQuick(page);
      expect(Math.abs(m.left), `左缘 ${m.left}`).toBeLessThanOrEqual(1);
      /* 视口宽 − 16 − 52 − 8 − 26 */
      expect(Math.abs(m.width - want), `宽 ${m.width}`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.right - m.tangent), `抽屉右缘 ${m.right}，长条右圆弧切线 ${m.tangent}`).toBeLessThanOrEqual(1);
      /* 药丸左右各留 12px */
      expect(Math.abs(m.itemLeft - 12)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.right - m.itemRight - 12)).toBeLessThanOrEqual(1);
    });
  }

  for (const [w, h] of [[1280, 800], [1920, 1080]]) {
    test(`宽屏 ${w}px：抽屉固定 320px，药丸左右各 12px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await go(page, '/settings/');
      await openDrawer(page);
      const m = await sheetAndQuick(page);
      expect(Math.abs(m.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.width - 320), `宽 ${m.width}`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.itemLeft - 12)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.right - m.itemRight - 12)).toBeLessThanOrEqual(1);
    });
  }

  test('收起位置：面板（连同往右投的阴影）完全在屏幕左侧外', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(page, '/settings/');
    /* 只 showModal、不加 is-open：就是滑入起点 / 滑出终点 */
    const r = await page.evaluate(() => {
      const d = document.getElementById('sgx-drawer');
      d.showModal();
      const b = d.querySelector('.sgx-drawer-sheet').getBoundingClientRect();
      d.close();
      return b.right;
    });
    /* 阴影最远 16px 偏移 + 48px 模糊：面板右缘要在 −64px 以外 */
    expect(r).toBeLessThanOrEqual(-64);
  });

  for (const dark of [false, true]) {
    test(`阴影往右投、清楚可见（${dark ? '暗色加深' : '亮色'}）`, async ({ page }) => {
      await page.setViewportSize({ width: 412, height: 915 });
      await page.addInitScript((d) => { try { localStorage.setItem('sgx-theme-mode', d ? 'dark' : 'light'); } catch (e) {} }, dark);
      await go(page, '/');
      await openDrawer(page);
      const sh = await drawer(page).locator('.sgx-drawer-sheet').evaluate((el) => getComputedStyle(el).boxShadow);
      expect(sh).toContain(dark ? 'rgba(0, 0, 0, 0.22) 4px 0px 12px' : 'rgba(0, 0, 0, 0.1) 4px 0px 12px');
      expect(sh).toContain(dark ? 'rgba(0, 0, 0, 0.5) 16px 0px 48px' : 'rgba(0, 0, 0, 0.24) 16px 0px 48px');
    });
  }

  for (const [dark, palette] of [[false, null], [true, null], [false, 'forest'], [true, 'forest']]) {
    test(`面板底色 = 顶栏材质（${dark ? '暗色' : '亮色'}${palette ? '，调色板 ' + palette : ''}）`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(([d, p]) => {
        try {
          localStorage.setItem('sgx-theme-mode', d ? 'dark' : 'light');
          if (p) localStorage.setItem('sgx-palette', p);
        } catch (e) {}
      }, [dark, palette]);
      await go(page, '/settings/');
      await openDrawer(page);
      const st = await page.evaluate(() => {
        const g = (sel) => {
          const cs = getComputedStyle(document.querySelector(sel));
          return { bg: cs.backgroundColor, bf: cs.backdropFilter || cs.webkitBackdropFilter };
        };
        return { sheet: g('#sgx-drawer .sgx-drawer-sheet'), nav: g('.sgx-tb-nav'), pill: g('.sgx-tb-pill'), pal: document.documentElement.getAttribute('data-palette') };
      });
      expect(st.pal).toBe(palette);
      expect(st.sheet.bg).toBe(st.nav.bg);
      expect(st.sheet.bg).toBe(st.pill.bg);
      expect(st.sheet.bf).toBe(st.nav.bf);
      expect(st.sheet.bf).toContain('blur');
    });
  }

  test('调色板变了抽屉底色跟着变（lake ≠ forest）', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(page, '/settings/');
    await openDrawer(page);
    const a = await page.locator('#sgx-drawer .sgx-drawer-sheet').evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.evaluate(() => document.documentElement.setAttribute('data-palette', 'forest'));
    const b = await page.locator('#sgx-drawer .sgx-drawer-sheet').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(b).not.toBe(a);
    /* 顶栏圆有 .15s 底色过渡：等过渡结束再比 */
    await expect.poll(() => page.locator('.sgx-tb-nav').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(b);
  });
});
