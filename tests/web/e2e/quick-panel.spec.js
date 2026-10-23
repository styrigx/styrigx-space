/**
 * 快捷面板（2026-10-21 v6：从顶栏底下落下的覆盖层，One UI 快捷面板式）验收：
 * - 顶栏右圆（2026-10-22 起，原来在长条右端）全站都是快捷面板按钮 .sgx-tb-end.sgx-tb-quick（aria-haspopup="dialog"）；点开 #sgx-qp（非模态 <dialog> show()，
 *   dialog 本身是遮罩，只盖顶栏下沿以下）；面板顶边在顶栏下沿下面，正文不动（#sgx-main 位置不变）。
 * - 顶栏不被盖住、不被压暗：面板开着时 elementFromPoint(图标中心) 仍是图标；图标 aria-expanded="true" + 按下态，再点（真点击）关闭。
 * - 关闭：再点图标 / 点遮罩 / Esc / 系统返回（历史哨兵，只关面板不离开页面）/ 点顶栏别的按钮（先关面板再执行）；刚点开立刻 Esc 也能关（竞态回归）。
 * - 焦点：打开进面板，关上回到图标；Tab 在「图标 + 面板控件」里循环。
 * - 面板顶部一行：左「快捷面板」标题，右齿轮圆钮（全部设置 → /settings/）；底部不再有「全部设置」行。
 * - 手机：左右对齐顶栏页边距 16px、最宽 480 居中；宽屏（≥ 980px）宽 400，右缘对齐顶栏右缘。
 * - 磁贴只放设置里已有的项，写的是和设置页同一个 localStorage key（同一套 setter，lib/prefs.js），
 *   即时生效、不刷新；设置页随之同步显示。
 * - 2026-10-21：磁贴只剩 4 个（深色模式 | 跟随系统、语言 | 立即锁定，两两一行），减弱动效、字体大小只在设置页；
 *   行：调色板（2026-10-23 PR-G：22 套七色调色板一个网格，含默认 dustyblue；标题右端「恢复默认」，已是默认时 aria-disabled）、布局；磁贴 / 行底色跟色板走（不是中性灰）。
 * - 390px 宽：长条页名放得下「安全与隐私」，英文长页名省略号，不压到两端图标；长条页名不再换成「快捷面板」。
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
  /* data-state=open 可能早于过渡尾巴结束（CI 机器慢时差几像素）：等面板内所有过渡跑完再量 */
  await page.waitForFunction(() => document.getElementById('sgx-qp').getAnimations({ subtree: true }).every((a) => a.playState !== 'running'));
}
/** #sgx-main 第一块内容的位置（覆盖层开合不该动它） */
const mainTop = (page) => page.evaluate(() => {
  const m = document.getElementById('sgx-main');
  const el = Array.from(m.children).find((c) => c.getBoundingClientRect().height > 0) || m;
  return { main: m.getBoundingClientRect().top, first: el.getBoundingClientRect().top, scroll: window.scrollY };
});
async function expectClosed(page) {
  await expect(qp(page)).toBeHidden();
  await expect(qp(page)).toHaveAttribute('data-state', 'closed');
  await expect(qp(page)).not.toHaveClass(/\bis-open\b/);
  await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'false');
}

test.describe('顶栏：右圆 = 快捷面板按钮', () => {
  const TABS = (p) => p === '/' || p === '/settings/';
  const PAGES = ['/', '/settings/', '/settings/display/', '/settings/security/', '/account/'];
  for (const path of PAGES) {
    test(`${path}：九宫格 · 长条（${TABS(path) ? '主页 / 聊天 / 设置三栏' : '只有页名'}）· 右圆快捷面板`, async ({ page }) => {
      await go(page, path);
      const order = await page.evaluate(() =>
        Array.from(document.querySelector('.sgx-topbar').children).map((el) => el.className.split(' ')[0]));
      expect(order).toEqual(['sgx-tb-nav', 'sgx-tb-pill', 'sgx-tb-end']);
      const inner = await page.evaluate(() =>
        Array.from(document.querySelector('.sgx-tb-pill').children).map((el) => el.className.split(' ')[0]));
      /* 主页、设置首页长条里是三栏标签（2026-10-22；PR4 第三栏换成设置，account-status.spec.js），其他页是页名 */
      expect(inner).toEqual([TABS(path) ? 'sgx-tb-tabs' : 'sgx-tb-title']);
      const q = page.locator('.sgx-tb-quick');
      expect(await q.evaluate((el) => el.tagName)).toBe('BUTTON');
      await expect(q).toHaveAttribute('aria-label', '快捷面板');
      await expect(q).toHaveAttribute('aria-controls', 'sgx-qp');
      await expect(q).toHaveAttribute('aria-expanded', 'false');
      /* 打开的是对话框（覆盖层） */
      await expect(q).toHaveAttribute('aria-haspopup', 'dialog');
      /* 52px 圆，在长条右边 8px，右缘贴顶栏页边距 16 */
      const qb = await q.boundingBox();
      const pb = await page.locator('.sgx-tb-pill').boundingBox();
      expect(Math.round(qb.width)).toBe(52);
      expect(Math.round(qb.height)).toBe(52);
      expect(Math.abs(qb.x - (pb.x + pb.width) - 8)).toBeLessThanOrEqual(1);
      expect(Math.abs(412 - (qb.x + qb.width) - 16)).toBeLessThanOrEqual(1);
    });
  }

  test('390px：「安全与隐私」「Security and privacy」完整显示，更长的页名省略号，页名不出长条', async ({ page }) => {
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
    /* 2026-10-22：长条里没有图标了，390 宽放得下「Security and privacy」；更长的照样省略号 */
    expect(st.sw).toBeLessThanOrEqual(st.cw);
    await t.evaluate((el) => { el.textContent = 'A very long English page name that cannot fit'; });
    expect(await t.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const tb = await t.boundingBox();
    const pill = await page.locator('.sgx-tb-pill').boundingBox();
    /* 页名在长条内居中（左右对称），不出长条 */
    expect(Math.abs(tb.x + tb.width / 2 - (pill.x + pill.width / 2))).toBeLessThanOrEqual(1);
    expect(tb.x).toBeGreaterThanOrEqual(pill.x);
    expect(tb.x + tb.width).toBeLessThanOrEqual(pill.x + pill.width);
  });
});

test.describe('快捷面板：开合', () => {
  for (const path of ['/', '/settings/']) {
    test(`${path}：点图标打开，面板落在顶栏下方（顶栏不被盖住、不压暗），正文不动；再点图标关闭`, async ({ page }) => {
      await go(page, path);
      await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'false');
      expect(await qp(page).evaluate((el) => el.tagName)).toBe('DIALOG');
      /* 不在正文流里 */
      expect(await qp(page).evaluate((el) => !!el.closest('#sgx-main'))).toBe(false);
      const before = await mainTop(page);
      const pressedOff = await page.locator('.sgx-tb-quick').evaluate((el) => getComputedStyle(el).backgroundColor);
      await openQp(page);
      /* 非模态（不进顶层，顶栏留在它上面） */
      expect(await qp(page).evaluate((el) => el.open && !el.matches(':modal'))).toBe(true);
      await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'true');
      expect(await page.locator('.sgx-tb-quick').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(pressedOff);
      /* 正文位置不变（覆盖层不推开内容） */
      const after = await mainTop(page);
      expect(Math.abs(after.main - before.main)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(after.first - before.first)).toBeLessThanOrEqual(0.5);
      const g = await page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect();
        const q = document.querySelector('.sgx-tb-quick');
        const qr = r(q);
        const hit = document.elementFromPoint(qr.left + qr.width / 2, qr.top + qr.height / 2);
        const pill = r(document.querySelector('.sgx-tb-pill'));
        const hitPill = document.elementFromPoint(pill.left + pill.width / 2, pill.top + pill.height / 2);
        const nav = r(document.querySelector('.sgx-tb-nav'));
        const hitNav = document.elementFromPoint(nav.left + nav.width / 2, nav.top + nav.height / 2);
        const d = document.getElementById('sgx-qp');
        return { iconHit: !!hit && q.contains(hit), pillHit: !!hitPill && !!hitPill.closest('.sgx-topbar'),
          navHit: !!hitNav && !!hitNav.closest('.sgx-tb-nav'),
          tb: r(document.querySelector('.sgx-topbar')), dlg: r(d), sheet: r(d.querySelector('.sgx-qp-sheet')),
          scrim: getComputedStyle(d).backgroundColor, rad: getComputedStyle(d.querySelector('.sgx-qp-sheet')).borderTopLeftRadius };
      });
      /* 顶栏在最上面：图标、长条、九宫格都还点得到 */
      expect(g.iconHit, '快捷面板图标中心被盖住了').toBe(true);
      expect(g.pillHit).toBe(true);
      expect(g.navHit).toBe(true);
      /* 遮罩 = dialog 本身（--sgx-scrim），上沿 = 顶栏下沿：顶栏不被压暗 */
      expect(g.scrim).not.toBe('rgba(0, 0, 0, 0)');
      expect(Math.abs(g.dlg.top - g.tb.bottom)).toBeLessThanOrEqual(1);
      expect(g.dlg.bottom).toBeGreaterThanOrEqual(914);
      /* 面板顶边在顶栏下沿下面 8px；手机左右对齐顶栏页边距 16px，圆角 28px */
      expect(g.sheet.top).toBeGreaterThanOrEqual(g.tb.bottom);
      expect(Math.abs(g.sheet.top - g.tb.bottom - 8)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.sheet.left - 16)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.sheet.left - g.tb.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.sheet.width - (412 - 32))).toBeLessThanOrEqual(1);
      expect(g.rad).toBe('28px');
      /* 没有内嵌版的把手 / 裁切层 */
      await expect(page.locator('.sgx-qp-handle, .sgx-qp-clip, .sgx-qp-all')).toHaveCount(0);
      /* 顶栏图标真点得到：再点关闭 */
      await page.locator('.sgx-tb-quick').click();
      await expectClosed(page);
      await expect(page).toHaveURL(path === '/' ? /localhost:\d+\/$/ : /\/settings\/$/);
      const back = await mainTop(page);
      expect(Math.abs(back.first - before.first)).toBeLessThanOrEqual(0.5);
    });
  }

  test('滑下：从顶栏底下钻出来（收起位置在遮罩上沿之外，被裁掉）', async ({ page }) => {
    await go(page, '/settings/');
    await page.evaluate(() => {
      const d = document.getElementById('sgx-qp');
      d.querySelector('.sgx-qp-sheet').style.transition = 'none';
      d.show();
    });
    const m = await page.evaluate(() => {
      const d = document.getElementById('sgx-qp');
      return { d: d.getBoundingClientRect().top, s: d.querySelector('.sgx-qp-sheet').getBoundingClientRect().bottom, of: getComputedStyle(d).overflow };
    });
    expect(m.of).toBe('hidden');
    expect(m.s).toBeLessThanOrEqual(m.d);
    await page.evaluate(() => document.getElementById('sgx-qp').close());
  });

  test('长条页名不再换成「快捷面板」（面板盖住顶栏，自己有标题）', async ({ page }) => {
    await go(page, '/settings/security/');
    expect(await page.locator('.sgx-tb-title').getAttribute('data-qp-label')).toBeNull();
    await openQp(page);
    const after = await page.locator('.sgx-tb-title').evaluate((el) => getComputedStyle(el, '::after').content);
    expect(['none', 'normal']).toContain(after);
    await expect(page.locator('.sgx-tb-title')).toHaveText('安全与隐私');
  });

  test('焦点：打开后在面板里；Tab 在图标 + 面板控件里循环；Esc 关上后回到图标', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    const inside = await page.evaluate(() => document.getElementById('sgx-qp').contains(document.activeElement));
    expect(inside).toBe(true);
    const allowed = () => page.evaluate(() => {
      const a = document.activeElement;
      return document.getElementById('sgx-qp').contains(a) || a === document.querySelector('.sgx-tb-quick');
    });
    let sawIcon = false;
    /* 2026-10-23 PR-G：一圈 = 图标 + 4 磁贴 + 恢复默认 + 七色调色板 22 + 布局可用 2（412 宽 DeX 置灰）= 30 下（2026-10-24 PR4 删了齿轮，少一下） */
    const LOOP = 30;
    expect(await page.evaluate(() => [document.querySelector('.sgx-tb-quick')].concat(Array.from(document.querySelectorAll('#sgx-qp a[href], #sgx-qp button:not([disabled])')))
      .filter((el) => el.offsetParent !== null).length)).toBe(LOOP);
    for (let i = 0; i < LOOP + 10; i++) {
      await page.keyboard.press('Tab');
      expect(await allowed()).toBe(true);
      if (await page.evaluate(() => document.activeElement === document.querySelector('.sgx-tb-quick'))) sawIcon = true;
    }
    expect(sawIcon).toBe(true);
    /* 从图标出发正好 LOOP 下回到图标 */
    await page.locator('.sgx-tb-quick').focus();
    for (let i = 0; i < LOOP - 1; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement === document.querySelector('.sgx-tb-quick'))).toBe(false);
    await page.keyboard.press('Tab');
    await expect(page.locator('.sgx-tb-quick')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await allowed()).toBe(true);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page.locator('.sgx-tb-quick')).toBeFocused();
  });

  test('面板开着点顶栏九宫格：先关面板，再打开导航抽屉', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    await page.locator('.sgx-tb-nav').click();
    await expectClosed(page);
    await expect(page.locator('#sgx-drawer')).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expect(page.locator('#sgx-drawer')).toBeHidden();
    await expect(page).toHaveURL(/\/settings\/$/);
    expect(await page.evaluate(() => !!(history.state && (history.state.sgxQp || history.state.sgxDrawer)))).toBe(false);
  });

  test('点遮罩关闭', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    /* 遮罩在面板下面的正文区（真点击命中 dialog 本身） */
    expect(await page.evaluate(() => document.elementFromPoint(200, 900) === document.getElementById('sgx-qp'))).toBe(true);
    await page.mouse.click(200, 900);
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
  });

  test('点面板里的空白处不关闭', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    /* 面板顶部内边距（PR4 起没有标题行，磁贴上方的空白）和磁贴之间的缝 */
    const sh = await page.locator('.sgx-qp-sheet').boundingBox();
    await page.mouse.click(sh.x + sh.width / 2, sh.y + 5);
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
    await expect(page.locator('#sgx-qp .sgx-qp-tile .sgx-qp-label')).toHaveText(['深色模式', '跟随系统', '语言', '立即锁定']);
    await expect(page.locator('#sgx-qp .sgx-qp-tile')).toHaveCount(4);
    /* 减弱动效、字体大小已删除（2026-10-23 PR-E） */
    await expect(page.locator('#sgx-qp [data-qp="motion"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-qp-seg="font-size"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp .sgx-qp-row-label')).toHaveText(['调色板', '布局']);
    /* 2026-10-23 PR-G：22 套七色调色板一个网格（含默认 dustyblue 和普通色板 lake），都是光晕方块 .pal-tile，没有撞色胶囊 */
    await expect(page.locator('#sgx-qp [data-qp-palette]')).toHaveCount(22);
    await expect(page.locator('#sgx-qp .sgx-qp-sw.pal-tile')).toHaveCount(22);
    await expect(page.locator('#sgx-qp [data-qp-palette="lake"]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [data-qp-palette^="x"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp .swatch-clash')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveText('恢复默认');
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] button')).toHaveText(['Mobile', 'Auto', 'DeX']);
    /* 2026-10-24 PR4：没有「快捷面板」标题和齿轮（全部设置），面板第一项就是磁贴网格；读屏名字仍是「快捷面板」（aria-label） */
    await expect(page.locator('#sgx-qp .sgx-qp-head, #sgx-qp .sgx-qp-title, #sgx-qp .sgx-qp-set, #sgx-qp .sgx-qp-all')).toHaveCount(0);
    await expect(page.locator('#sgx-qp a[href$="/settings/"]')).toHaveCount(0);
    await expect(qp(page)).toHaveAccessibleName('快捷面板');
    expect(await page.locator('.sgx-qp-sheet').evaluate((el) => el.firstElementChild.className)).toContain('sgx-qp-grid');
    await expect(page.locator('#sgx-qp')).not.toContainText('快捷面板');
    /* 默认：浅色、跟随系统开、默认色板（恢复默认置灰，默认 dustyblue 色块选中）、自动布局 */
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'false');
    await expect(tile(page, 'dark').locator('[data-qp-state]')).toHaveText('关');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system').locator('[data-qp-state]')).toHaveText('开');
    await expect(tile(page, 'lang').locator('.sgx-qp-state')).toHaveText('中文');
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#sgx-qp [data-qp-palette][aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [data-qp-palette="dustyblue"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
    /* 开着的磁贴是主色容器底色 */
    const on = await tile(page, 'system').evaluate((el) => getComputedStyle(el).backgroundColor);
    const off = await tile(page, 'dark').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(on).not.toBe(off);
  });

  test('排版：深色模式 | 跟随系统、语言 | 立即锁定两两一行（半宽），下面调色板、布局；412 / 360 / 宽屏都不溢出', async ({ page }) => {
    for (const vp of [{ width: 412, height: 915 }, { width: 360, height: 800 }, { width: 1366, height: 768 }]) {
      await page.setViewportSize(vp);
      await go(page, '/settings/');
      await openQp(page);
      const g = await page.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
        const q = (s) => document.querySelector(s);
        const sheet = q('.sgx-qp-sheet');
        const ids = ['dark', 'system', 'lang', 'lock'];
        const rows = Array.from(sheet.querySelectorAll('.sgx-qp-row'));
        return {
          t: Object.fromEntries(ids.map((id) => [id, r(q('#sgx-qp [data-qp="' + id + '"]'))])),
          grid: r(q('.sgx-qp-grid')), rows: rows.map(r), labels: rows.map((x) => x.querySelector('.sgx-qp-row-label').textContent),
          over: Array.from(sheet.querySelectorAll('*')).filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto'
            && !el.matches('.sgx-qp-label, .sgx-qp-state')).map((el) => el.className),
          sheetOver: sheet.scrollWidth > sheet.clientWidth,
          reset: r(q('#sgx-qp [data-qp-reset]')), label: r(q('#sgx-qp .sgx-qp-row-head .sgx-qp-row-label')), row0: r(rows[0]),
        };
      });
      const { dark, system, lang, lock } = g.t;
      /* 行 1 / 行 2 各两块，同高同顶、各占一半 */
      expect(Math.abs(dark.y - system.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(lang.y - lock.y)).toBeLessThanOrEqual(0.5);
      expect(lang.y).toBeGreaterThan(dark.y + dark.h - 1);
      for (const t of [dark, system, lang, lock]) expect(Math.abs(t.w - (g.grid.w - 8) / 2)).toBeLessThanOrEqual(1);
      expect(dark.x).toBeLessThan(system.x);
      expect(lang.x).toBeLessThan(lock.x);
      /* 调色板在磁贴下面，布局在调色板下面 */
      expect(g.labels).toEqual(['调色板', '布局']);
      expect(g.rows[0].y).toBeGreaterThan(g.grid.b);
      expect(g.rows[1].y).toBeGreaterThan(g.rows[0].b);
      /* 恢复默认在调色板标题行右端，与标题竖直居中 */
      expect(Math.abs(g.row0.r - 12 - g.reset.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.reset.y + g.reset.h / 2 - (g.label.y + g.label.h / 2))).toBeLessThanOrEqual(1.5);
      expect(g.sheetOver, `${vp.width}：面板横向溢出`).toBe(false);
      expect(g.over, `${vp.width}：有元素横向溢出`).toEqual([]);
      await page.keyboard.press('Escape');
      await expectClosed(page);
    }
  });

  test('配色（2026-10-23 PR-G 修订）：兰紫浅色下磁贴 / 行 / 齿轮 = 中性玻璃（不铺 secondary-container）；深色模式开 = primary-container + 填充档图标圆', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-palette', 'orchid'); } catch (e) {} });
    await go(page, '/settings/');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'orchid');
    await openQp(page);
    const cs = (sel, prop = 'backgroundColor') => page.locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p], prop);
    const role = (name, prop = 'color') => page.evaluate(([n, p]) => {
      const d = document.createElement('div');
      d.style[p] = 'var(' + n + ')';
      document.body.appendChild(d);
      const c = getComputedStyle(d)[p];
      d.remove();
      return c;
    }, [name, prop]);
    const glass = await role('--sgx-qp-glass', 'backgroundColor');
    expect(await cs('#sgx-qp [data-qp="dark"]')).toBe(glass);
    expect(await cs('#sgx-qp .sgx-qp-row')).toBe(glass);
    const sec = await role('--m-secondary-container');
    for (const sel of ['#sgx-qp [data-qp="dark"]', '#sgx-qp .sgx-qp-row']) expect(await cs(sel)).not.toBe(sec);
    await tile(page, 'dark').click();
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => cs('#sgx-qp [data-qp="dark"]')).toBe(await role('--m-primary-container'));
    expect(await cs('#sgx-qp [data-qp="dark"] .sgx-qp-ic')).toBe(await role('--m-primary-fill'));
    expect(await cs('#sgx-qp [data-qp="dark"] .sgx-qp-ic', 'color')).toBe(await role('--m-on-primary-fill'));
  });

  /* 2026-10-22：面板底是悬浮层磨砂（与顶栏长条 / 导航抽屉同一份 --sgx-mat + 毛玻璃），不是不透明的纯白 / 纯色卡；
     亮 / 暗、默认 dustyblue、紫、新色板奶油白都一样（2026-10-23 PR-G 撞色 x* 已合并） */
  for (const [dark, palette] of [[false, null], [true, null], [false, 'violet'], [false, 'cream'], [true, 'cream']]) {
    test(`面板底 = 悬浮层磨砂（${dark ? '暗色' : '亮色'}${palette ? '，调色板 ' + palette : ''}）`, async ({ page }) => {
      await page.addInitScript(([d, p]) => {
        try {
          localStorage.setItem('sgx-theme-mode', d ? 'dark' : 'light');
          if (p) localStorage.setItem('sgx-palette', p);
        } catch (e) {}
      }, [dark, palette]);
      await go(page, '/');
      await openQp(page);
      const st = await page.evaluate(() => {
        const g = (sel) => {
          const cs = getComputedStyle(document.querySelector(sel));
          return { bg: cs.backgroundColor, bf: cs.backdropFilter || cs.webkitBackdropFilter };
        };
        const role = (n) => { const d = document.createElement('div'); d.style.color = 'var(' + n + ')'; document.body.appendChild(d);
          const c = getComputedStyle(d).color; d.remove(); return c; };
        return { sheet: g('#sgx-qp .sgx-qp-sheet'), pill: g('.sgx-tb-pill'), lowest: role('--sgx-surface-container-lowest'),
          pal: document.documentElement.getAttribute('data-palette'), dark: document.documentElement.classList.contains('dark') };
      });
      expect(st.pal).toBe(palette);
      expect(st.dark).toBe(dark);
      expect(st.sheet.bg).toBe(st.pill.bg);
      expect(st.sheet.bg).not.toBe(st.lowest);
      /* 半透明（alpha < 1）+ 毛玻璃 */
      const alpha = (c) => { const m = c.match(/\/\s*([\d.]+)\s*\)$/) || c.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/); return m ? +m[1] : 1; };
      expect(alpha(st.sheet.bg), st.sheet.bg).toBeLessThan(1);
      expect(alpha(st.sheet.bg), st.sheet.bg).toBeGreaterThan(0.5);
      expect(st.sheet.bf).toBe(st.pill.bf);
      expect(st.sheet.bf).toContain('blur');
    });
  }

  test('英文文案', async ({ page }) => {
    await go(page, '/en/', 'en');
    await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-label', 'Quick panel');
    await openQp(page);
    await expect(page.locator('#sgx-qp .sgx-qp-tile .sgx-qp-label')).toHaveText(['Dark mode', 'Follow system', 'Language', 'Lock now']);
    await expect(page.locator('#sgx-qp .sgx-qp-row-label')).toHaveText(['Color palette', 'Layout']);
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveText('Reset');
    await expect(tile(page, 'system').locator('[data-qp-state]')).toHaveText('On');
    await expect(qp(page)).toHaveAccessibleName('Quick panel');
    await expect(page.locator('#sgx-qp .sgx-qp-title, #sgx-qp .sgx-qp-set')).toHaveCount(0);
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

  test('减弱动效 / 字体大小已删除：面板和设置页都没有，旧值不起作用', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-reduced-motion', '1'); localStorage.setItem('sgx-font-size', 'large'); } catch (e) {}
    });
    await go(page, '/settings/display/');
    await openQp(page);
    await expect(page.locator('#sgx-qp [data-qp="motion"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-qp-seg="font-size"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page.locator('#seg-font, #row-motion, #sw-motion')).toHaveCount(0);
    /* 旧 localStorage 值：首屏清掉，<html> 不放大、不带 reduced-motion（系统没开减弱动效） */
    expect(await ls(page, 'sgx-reduced-motion')).toBeNull();
    expect(await ls(page, 'sgx-font-size')).toBeNull();
    expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('');
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)reduced-motion(\s|$)/);
  });

  test('调色板：写 sgx-palette，即时换色；设置页同步', async ({ page }) => {
    await go(page, '/settings/theme/');
    await openQp(page);
    await page.locator('#sgx-qp [data-qp-palette="forest"]').click();
    expect(await ls(page, 'sgx-palette')).toBe('forest');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'forest');
    await expect(page.locator('#sgx-qp [data-qp-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#palette-dots [data-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
    /* 恢复默认：forest 时可点；点了回默认 dustyblue（不存 key），按钮置灰，设置页的恢复默认也同步置灰 */
    const rs = page.locator('#sgx-qp [data-qp-reset]');
    await expect(rs).toHaveAttribute('aria-disabled', 'false');
    await expect(page.locator('#palette-reset')).toHaveAttribute('aria-disabled', 'false');
    await rs.click();
    expect(await ls(page, 'sgx-palette')).toBeNull();
    await expect(page.locator('html')).not.toHaveAttribute('data-palette', /.+/);
    await expect(rs).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#sgx-qp [data-qp-palette][aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [data-qp-palette="dustyblue"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#palette-reset')).toHaveAttribute('aria-disabled', 'true');
    /* 置灰时点了不动、面板不关；半透明但不隐藏（位置不跳） */
    const box = await rs.boundingBox();
    await rs.click({ force: true }); /* aria-disabled：Playwright 默认不点，强制点一下验证没反应 */
    expect(await ls(page, 'sgx-palette')).toBeNull();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await expect(rs).toBeVisible();
    await expect.poll(() => rs.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.6); /* opacity 有 .15s 过渡 */
    expect(await rs.boundingBox()).toEqual(box);
  });

  test('恢复默认：自定义主题色时可点，点了清掉自定义色回到默认 dustyblue', async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('qp-seeded')) { localStorage.setItem('sgx-accent', '#ff6b9d'); sessionStorage.setItem('qp-seeded', '1'); } } catch (e) {} });
    await go(page, '/');
    await openQp(page);
    const rs = page.locator('#sgx-qp [data-qp-reset]');
    await expect(rs).toHaveAttribute('aria-disabled', 'false');
    await rs.click();
    expect(await ls(page, 'sgx-accent')).toBeNull();
    expect(await ls(page, 'sgx-palette')).toBeNull();
    await expect(page.locator('style#sgx-accent-roles')).toHaveCount(0);
    await expect(rs).toHaveAttribute('aria-disabled', 'true');
  });

  test('布局：窄屏 DeX 置灰；写 sgx-layout；设置页同步', async ({ page }) => {
    await go(page, '/settings/display/');
    await openQp(page);
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="dex"]')).toBeDisabled();
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="pc"]')).toHaveCount(0);
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
    /* 宽屏（≥ 980px）：宽 400，右缘对齐顶栏右缘 */
    const sb = await page.locator('.sgx-qp-sheet').boundingBox();
    const tb = await page.locator('.sgx-topbar').boundingBox();
    expect(Math.abs(sb.width - 400)).toBeLessThanOrEqual(1);
    expect(Math.abs(sb.x + sb.width - (tb.x + tb.width))).toBeLessThanOrEqual(1);
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="dex"]').click();
    expect(await ls(page, 'sgx-layout')).toBe('dex');
    await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]').click();
    expect(['auto', null]).toContain(await ls(page, 'sgx-layout'));
    await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/); /* 1366×768 横屏、宽 ≥ 840、高 ≥ 500 → 自动 = DeX */
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
    await expect(page.locator('.sgx-tb-tab[data-tab="settings"]')).toHaveText('Settings');
    await expect(page.locator('.sgx-tb-tab[data-tab="settings"]')).toHaveAttribute('aria-current', 'page');
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

  test('PR4：设置入口 = 顶栏三栏的「设置」（面板里不再有齿轮）；从主页点它进设置首页', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await expect(page.locator('#sgx-qp a')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await page.locator('.sgx-tb-tab[data-tab="settings"]').click();
    await expect(page).toHaveURL(/\/settings\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });
});
