/**
 * 快捷面板 + AI 窗口验收（2026-11-04 P5-1 方案 6.2–6.5 / 5.5；P4-3 PR-4b 定稿：快捷面板只有一页，四站同一套）。
 * 顶栏本身（字标 · 页名胶囊 · 九宫格 · 快捷设置 · AI 的排布、尺寸）和九宫格导航面板 #sgx-nav 见 topbar-spec.spec.js；四站快捷面板 DOM 同一份见 tests/curio/e2e/quick-panel-identity.spec.js。
 * - 快捷面板 #sgx-qp（非模态 <dialog> show()，dialog 本身是遮罩，只盖顶栏下沿以下）；面板顶边在顶栏下沿下面，正文不动。
 *   单页（PR-4b 去掉「导航 | 快捷设置」两页、页签和横向滑动；导航在九宫格面板）：
 *   磁贴 深色模式 | 跟随系统、分享本页 | 立即锁定（两两一行）；语言整行（点开行内展开单选 跟随系统 / 中文 / English）；调色板；布局。
 * - 顶栏不被盖住、不被压暗：面板开着时 elementFromPoint(图标中心) 仍是图标；图标 aria-expanded="true" + 按下态，再点（真点击）关闭。
 * - 关闭：再点图标 / 点遮罩 / Esc / 系统返回（历史哨兵，只关面板不离开页面）/ 点顶栏别的按钮（先关面板再执行）；刚点开立刻 Esc 也能关（竞态回归）。
 * - 快捷面板、导航面板和 AI 窗口互斥：开一个就先关另一个。
 * - 焦点：打开进面板，关上回到图标；Tab 在「图标 + 面板控件」里循环。
 * - 手机：左右对齐顶栏页边距 16px；宽屏（≥ 980px）宽 400，右缘对齐顶栏右缘。
 * - 磁贴写的是和设置同一个 localStorage key（同一套 setter，lib/prefs.js），即时生效、不刷新；风格页 /theme/ 的调色板随之同步显示。
 *   PR-4b 起主站也有「分享本页」磁贴（四站快捷面板同一套）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, armNavProbe, expect } = require('../helpers/helpers');

test.use({ viewport: { width: 412, height: 915 }, colorScheme: 'light' });

async function go(page, path, lang = 'zh', freeze = true) {
  await blockExternalRequests(page);
  /* 冻结时间会让 Date.now() 恒定，立即锁定的防误触窗口（400ms）永远过不去，那条测试不冻结 */
  if (freeze) await freezeTime(page);
  /* 只在没有偏好时写（语言切换后不要被 init script 改回去） */
  await page.addInitScript((l) => {
    try { if (!localStorage.getItem('sgx-lang')) localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
}

const qp = (page) => page.locator('#sgx-qp');
const tile = (page, id) => page.locator(`#sgx-qp [data-qp="${id}"]`);
const ls = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);

/** 打开快捷面板，等滑下结束 */
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

test.describe('快捷设置按钮', () => {
  for (const [path, lang, name] of [['/', 'zh', '快捷设置'], ['/theme/', 'zh', '快捷设置'], ['/en/', 'en', 'Quick settings']]) {
    test(`${path}：顶栏「${name}」按钮控制 #sgx-qp（对话框），默认收起；面板只有一页（没有页签、导航列表、横向翻页）`, async ({ page }) => {
      await go(page, path, lang);
      const q = page.locator('.sgx-tb-acts .sgx-tb-quick');
      expect(await q.evaluate((el) => el.tagName)).toBe('BUTTON');
      await expect(q).toHaveAttribute('aria-label', name);
      await expect(q).toHaveAttribute('aria-controls', 'sgx-qp');
      await expect(q).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(q).toHaveAttribute('aria-expanded', 'false');
      await expect(qp(page)).toHaveAttribute('aria-label', name);
      await expect(qp(page)).toBeHidden();
      /* PR-4b 删掉的：两页页签、翻页容器、导航列表（导航在九宫格面板 #sgx-nav） */
      await expect(page.locator('#sgx-qp [role="tablist"], #sgx-qp [role="tab"], #sgx-qp [role="tabpanel"], #sgx-qp [data-qp-pages], #sgx-qp-tab-nav, #sgx-qp-tab-set, #sgx-qp-page-nav, #sgx-qp-page-set, #sgx-qp .sgx-qp-nav-item, #sgx-qp [data-nav]')).toHaveCount(0);
      /* sheet 里直接是磁贴网格、语言行、调色板、布局 */
      expect(await page.locator('#sgx-qp .sgx-qp-sheet').evaluate((el) => Array.from(el.children).map((c) => c.className))).toEqual(['sgx-qp-grid', 'sgx-qp-row sgx-qp-lang', 'sgx-qp-row', 'sgx-qp-row']);
    });
  }
});

test.describe('快捷面板：开合', () => {
  for (const path of ['/', '/theme/']) {
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
        const hitOf = (sel) => { const b = r(document.querySelector(sel)); const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!h && !!h.closest(sel); };
        const d = document.getElementById('sgx-qp');
        return { iconHit: !!hit && q.contains(hit), pillHit: !!hitPill && !!hitPill.closest('.sgx-topbar'),
          logoHit: hitOf('.sgx-tb-logo'), aiHit: hitOf('.sgx-tb-ai'), gridHit: hitOf('.sgx-tb-grid'),
          tb: r(document.querySelector('.sgx-topbar')), dlg: r(d), sheet: r(d.querySelector('.sgx-qp-sheet')),
          scrim: getComputedStyle(d).backgroundColor, rad: getComputedStyle(d.querySelector('.sgx-qp-sheet')).borderTopLeftRadius };
      });
      /* 顶栏在最上面：图标、长条、logo、九宫格、AI 都还点得到 */
      expect(g.iconHit, '快捷面板图标中心被盖住了').toBe(true);
      expect(g.pillHit).toBe(true);
      expect(g.logoHit).toBe(true);
      expect(g.aiHit).toBe(true);
      expect(g.gridHit).toBe(true);
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
      await expect(page).toHaveURL(path === '/' ? /localhost:\d+\/$/ : /\/theme\/$/);
      const back = await mainTop(page);
      expect(Math.abs(back.first - before.first)).toBeLessThanOrEqual(0.5);
    });
  }

  test('滑下：从顶栏底下钻出来（收起位置在遮罩上沿之外，被裁掉）', async ({ page }) => {
    await go(page, '/theme/');
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
    await go(page, '/security/');
    expect(await page.locator('.sgx-tb-title').getAttribute('data-qp-label')).toBeNull();
    await openQp(page);
    const after = await page.locator('.sgx-tb-title').evaluate((el) => getComputedStyle(el, '::after').content);
    expect(['none', 'normal']).toContain(after);
    await expect(page.locator('.sgx-tb-title')).toHaveText('安全');
  });

  /** 能 Tab 到的面板控件（tabindex ≥ 0、看得见）+ 图标 */
  const tabbables = (page) => page.evaluate(() => [document.querySelector('.sgx-tb-quick')].concat(Array.from(document.querySelectorAll('#sgx-qp a[href], #sgx-qp button:not([disabled])')))
    .filter((el) => el.offsetParent !== null && !el.closest('[inert]') && el.tabIndex >= 0).length);

  test('焦点：打开后在面板里；Tab 在图标 + 面板控件里循环；Esc 关上后回到图标', async ({ page }) => {
    await go(page, '/theme/');
    await openQp(page);
    expect(await page.evaluate(() => document.getElementById('sgx-qp').contains(document.activeElement))).toBe(true);
    const allowed = () => page.evaluate(() => {
      const a = document.activeElement;
      return document.getElementById('sgx-qp').contains(a) || a === document.querySelector('.sgx-tb-quick');
    });
    let sawIcon = false;
    /* 一圈 = 图标 + 4 磁贴（深色 / 跟随系统 / 分享 / 锁定）+ 语言行（选项收着）+ 恢复默认 + 七色调色板 22 + 布局可用 2（412 宽 DeX 置灰）= 31 下 */
    const LOOP = 31;
    expect(await tabbables(page)).toBe(LOOP);
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
    /* 语言行展开后，选中项（只有它 tabindex=0）进圈：多 1 下 */
    await tile(page, 'lang').click();
    await expect(page.locator('#sgx-qp-lang-opts')).toBeVisible();
    expect(await tabbables(page)).toBe(LOOP + 1);
    await page.keyboard.press('Escape');
    /* 焦点在语言行按钮上（不在选项里）：Esc 关的是面板 */
    await expectClosed(page);
    await expect(page.locator('.sgx-tb-quick')).toBeFocused();
  });

  test('互斥：面板开着点 AI 图标 → 先关面板，再打开 AI 窗口；反过来也一样；都不在历史里留哨兵', async ({ page }) => {
    await go(page, '/theme/');
    const ai = page.locator('#sgx-ai');
    await openQp(page);
    await page.locator('.sgx-tb-ai').click();
    await expectClosed(page);
    await expect(ai).toHaveAttribute('data-state', 'open');
    await expect(page.locator('.sgx-tb-ai')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sgx-qp[open], #sgx-ai[open]')).toHaveCount(1);
    await page.locator('.sgx-tb-quick').click();
    await expect(ai).toBeHidden();
    await expect(page.locator('.sgx-tb-ai')).toHaveAttribute('aria-expanded', 'false');
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await expect(page.locator('#sgx-qp[open], #sgx-ai[open]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    /* 九宫格导航面板同样互斥 */
    await openQp(page);
    await page.locator('.sgx-tb-grid').click();
    await expectClosed(page);
    await expect(page.locator('#sgx-nav')).toHaveAttribute('data-state', 'open');
    await expect(page.locator('#sgx-qp[open], #sgx-ai[open], #sgx-nav[open]')).toHaveCount(1);
    await page.locator('.sgx-tb-quick').click();
    await expect(page.locator('#sgx-nav')).toBeHidden();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page).toHaveURL(/\/theme\/$/);
    await expect.poll(() => page.evaluate(() => !!(history.state && (history.state.sgxQp || history.state.sgxAi || history.state.sgxNav)))).toBe(false);
  });

  test('面板开着点顶栏 logo：先关面板，再跳转（不留哨兵）', async ({ page }) => {
    await go(page, '/');
    await page.goto('/theme/', { waitUntil: 'domcontentloaded' });
    await openQp(page);
    await page.locator('.sgx-tb-logo').click();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/theme\/$/);
    await expect(qp(page)).toBeHidden();
  });

  test('点遮罩关闭', async ({ page }) => {
    await go(page, '/theme/');
    await openQp(page);
    /* 遮罩在面板下面的正文区（真点击命中 dialog 本身） */
    expect(await page.evaluate(() => document.elementFromPoint(200, 900) === document.getElementById('sgx-qp'))).toBe(true);
    await page.mouse.click(200, 900);
    await expectClosed(page);
    await expect(page).toHaveURL(/\/theme\/$/);
  });

  test('点面板里的空白处不关闭', async ({ page }) => {
    await go(page, '/theme/');
    await openQp(page);
    /* 面板顶部内边距（磁贴上方的空白） */
    const sh = await page.locator('#sgx-qp .sgx-qp-sheet').boundingBox();
    await page.mouse.click(sh.x + sh.width / 2, sh.y + 5);
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
  });

  test('Esc 关闭', async ({ page }) => {
    await go(page, '/theme/');
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page).toHaveURL(/\/theme\/$/);
  });

  test('系统返回只关面板，停在本页；再返回才离开', async ({ page }) => {
    await go(page, '/');
    await page.goto('/theme/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openQp(page);
    await page.goBack();
    await expectClosed(page);
    await expect(page).toHaveURL(/\/theme\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });

  test('刚点开（滑下还没开始）就 Esc / 连点两下：照样关上，之后还能正常打开', async ({ page }) => {
    await go(page, '/theme/');
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
    await expect(page).toHaveURL(/\/theme\/$/);
  });

  test('减弱动效：开合立刻到位', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, '/theme/');
    await page.locator('.sgx-tb-quick').click();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expectClosed(page);
  });

  test('AI 窗口照常工作（共用状态机）：开、Esc 关、焦点回到 AI 图标', async ({ page }) => {
    await go(page, '/theme/');
    await page.locator('.sgx-tb-ai').click();
    await expect(page.locator('#sgx-ai')).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expect(page.locator('#sgx-ai')).toBeHidden();
    await expect(page.locator('.sgx-tb-ai')).toBeFocused();
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
  });
});

test.describe('快捷面板：内容', () => {
  test('中文：磁贴、语言行、调色板、布局（只有设置里已有的项）；主站也有分享本页', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await expect(page.locator('#sgx-qp .sgx-qp-tile .sgx-qp-label')).toHaveText(['深色模式', '跟随系统', '分享本页', '立即锁定']);
    await expect(page.locator('#sgx-qp .sgx-qp-tile')).toHaveCount(4);
    /* 减弱动效、字体大小已删除（2026-10-23 PR-E） */
    await expect(page.locator('#sgx-qp [data-qp="motion"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-qp-seg="font-size"]')).toHaveCount(0);
    /* 语言是整行（不是磁贴）：名字 + 当前值 + 展开箭头，选项默认收着 */
    const lang = tile(page, 'lang');
    await expect(lang).toHaveClass(/\bsgx-qp-line\b/);
    await expect(lang.locator('.sgx-qp-label')).toHaveText('语言');
    await expect(lang.locator('[data-qp-lang-val]')).toHaveText('中文');
    await expect(lang).toHaveAttribute('aria-expanded', 'false');
    await expect(lang).toHaveAttribute('aria-controls', 'sgx-qp-lang-opts');
    await expect(page.locator('#sgx-qp-lang-opts')).toBeHidden();
    await expect(page.locator('#sgx-qp-lang-opts [role="radio"]')).toHaveText(['跟随系统', '中文', 'English']);
    await expect(page.locator('#sgx-qp .sgx-qp-row-label')).toHaveText(['调色板', '布局']);
    /* 2026-10-23 PR-G：22 套七色调色板一个网格（含默认 dustyblue 和普通色板 lake），都是光晕方块 .pal-tile，没有撞色胶囊 */
    await expect(page.locator('#sgx-qp [data-qp-palette]')).toHaveCount(22);
    await expect(page.locator('#sgx-qp .sgx-qp-sw.pal-tile')).toHaveCount(22);
    await expect(page.locator('#sgx-qp [data-qp-palette="lake"]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [data-qp-palette^="x"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp .swatch-clash')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveText('恢复默认');
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] button')).toHaveText(['Mobile', 'Auto', 'DeX']);
    /* 没有标题和齿轮（全部设置），面板第一项就是磁贴网格；读屏名字是「快捷设置」（aria-label） */
    await expect(page.locator('#sgx-qp .sgx-qp-head, #sgx-qp .sgx-qp-title, #sgx-qp .sgx-qp-set, #sgx-qp .sgx-qp-all')).toHaveCount(0);
    await expect(page.locator('#sgx-qp a')).toHaveCount(0);
    await expect(qp(page)).toHaveAccessibleName('快捷设置');
    expect(await page.locator('#sgx-qp .sgx-qp-sheet').evaluate((el) => el.firstElementChild.className)).toBe('sgx-qp-grid');
    /* PR-4b：主站也有「分享本页」磁贴（四站同一套，share.js 接手） */
    await expect(tile(page, 'share')).toHaveAttribute('data-sgx-share', '');
    await expect(tile(page, 'share').locator('.sgx-qp-state')).toHaveText('短链，24 小时');
    await expect(tile(page, 'lock').locator('[data-qp-lock-state]')).toHaveText('回到锁屏');
    /* 默认：浅色、跟随系统开、默认色板（恢复默认置灰，默认 dustyblue 色块选中）、自动布局 */
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'false');
    await expect(tile(page, 'dark').locator('[data-qp-state]')).toHaveText('关');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system').locator('[data-qp-state]')).toHaveText('开');
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#sgx-qp [data-qp-palette][aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [data-qp-palette="dustyblue"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
    /* 开着的磁贴是主色容器底色 */
    const on = await tile(page, 'system').evaluate((el) => getComputedStyle(el).backgroundColor);
    const off = await tile(page, 'dark').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(on).not.toBe(off);
  });

  test('排版：深色模式 | 跟随系统、分享本页 | 立即锁定两两一行（半宽），下面语言行、调色板、布局；412 / 360 / 宽屏都不溢出（语言展开时也不溢出）', async ({ page }) => {
    for (const vp of [{ width: 412, height: 915 }, { width: 360, height: 800 }, { width: 1366, height: 768 }]) {
      await page.setViewportSize(vp);
      await go(page, '/theme/');
      await openQp(page);
      await tile(page, 'lang').click();
      await expect(page.locator('#sgx-qp-lang-opts')).toBeVisible();
      const g = await page.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
        const q = (s) => document.querySelector(s);
        const sheet = q('#sgx-qp .sgx-qp-sheet');
        const ids = ['dark', 'system', 'share', 'lock'];
        const rows = Array.from(sheet.querySelectorAll('.sgx-qp-row'));
        return {
          t: Object.fromEntries(ids.map((id) => [id, r(q('#sgx-qp [data-qp="' + id + '"]'))])),
          grid: r(q('#sgx-qp .sgx-qp-grid')), rows: rows.map(r), labels: rows.map((x) => { const l = x.querySelector('.sgx-qp-row-label, .sgx-qp-line .sgx-qp-label'); return l ? l.textContent : ''; }),
          over: Array.from(sheet.querySelectorAll('*')).filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto'
            && !el.matches('.sgx-qp-label, .sgx-qp-state, .sgx-qp-val')).map((el) => el.className),
          sheetOver: sheet.scrollWidth > sheet.clientWidth,
          reset: r(q('#sgx-qp [data-qp-reset]')), label: r(q('#sgx-qp .sgx-qp-row-head .sgx-qp-row-label')), rowPal: r(q('#sgx-qp [data-qp-reset]').closest('.sgx-qp-row')),
          lang: r(q('#sgx-qp [data-qp="lang"]')), opts: Array.from(document.querySelectorAll('#sgx-qp-lang-opts [role="radio"]')).map(r),
        };
      });
      const { dark, system, share, lock } = g.t;
      /* 行 1 / 行 2 各两块，同高同顶、各占一半 */
      expect(Math.abs(dark.y - system.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(share.y - lock.y)).toBeLessThanOrEqual(0.5);
      expect(share.y).toBeGreaterThan(dark.y + dark.h - 1);
      for (const t of [dark, system, share, lock]) expect(Math.abs(t.w - (g.grid.w - 8) / 2)).toBeLessThanOrEqual(1);
      expect(dark.x).toBeLessThan(system.x);
      expect(share.x).toBeLessThan(lock.x);
      /* 语言行在磁贴下面，调色板在语言下面，布局在调色板下面；行都是整宽 */
      expect(g.labels).toEqual(['语言', '调色板', '布局']);
      expect(g.rows[0].y).toBeGreaterThan(g.grid.b);
      expect(g.rows[1].y).toBeGreaterThan(g.rows[0].b);
      expect(g.rows[2].y).toBeGreaterThan(g.rows[1].b);
      for (const rw of g.rows) expect(Math.abs(rw.w - g.grid.w)).toBeLessThanOrEqual(1);
      /* 展开的三个选项在语言行按钮下面，竖排 */
      expect(g.opts.length).toBe(3);
      expect(g.opts[0].y).toBeGreaterThanOrEqual(g.lang.b - 1);
      expect(g.opts[1].y).toBeGreaterThan(g.opts[0].y);
      expect(g.opts[2].y).toBeGreaterThan(g.opts[1].y);
      expect(g.opts[2].b).toBeLessThanOrEqual(g.rows[0].b + 0.5);
      /* 恢复默认在调色板标题行右端，与标题竖直居中 */
      expect(Math.abs(g.rowPal.r - 12 - g.reset.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.reset.y + g.reset.h / 2 - (g.label.y + g.label.h / 2))).toBeLessThanOrEqual(1.5);
      expect(g.sheetOver, `${vp.width}：面板横向溢出`).toBe(false);
      expect(g.over, `${vp.width}：有元素横向溢出`).toEqual([]);
      await page.keyboard.press('Escape');
      await expectClosed(page);
    }
  });

  test('配色（2026-10-23 PR-G 修订）：兰紫浅色下磁贴 / 行 / 齿轮 = 中性玻璃（不铺 secondary-container）；深色模式开 = primary-container + 填充档图标圆', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-palette', 'orchid'); } catch (e) {} });
    await go(page, '/theme/');
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

  /* 2026-10-22：面板底是悬浮层磨砂（与顶栏同一份 --sgx-mat + 毛玻璃；2026-11-04 P5-1 起材质在整条胶囊 .sgx-topbar 上，长条本身透明），不是不透明的纯白 / 纯色卡；
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
        return { sheet: g('#sgx-qp .sgx-qp-sheet'), pill: g('.sgx-topbar'), lowest: role('--sgx-surface-container-lowest'),
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
    await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-label', 'Quick settings');
    await openQp(page);
    await expect(page.locator('#sgx-qp .sgx-qp-tile .sgx-qp-label')).toHaveText(['Dark mode', 'Follow system', 'Share this page', 'Lock now']);
    await expect(tile(page, 'share').locator('.sgx-qp-state')).toHaveText('Short link, 24 h');
    await expect(tile(page, 'lock').locator('[data-qp-lock-state]')).toHaveText('Back to lock screen');
    await expect(tile(page, 'lang').locator('.sgx-qp-label')).toHaveText('Language');
    await expect(tile(page, 'lang').locator('[data-qp-lang-val]')).toHaveText('English');
    await expect(page.locator('#sgx-qp-lang-opts [role="radio"]')).toHaveText(['Follow system', '中文', 'English']);
    await expect(page.locator('#sgx-qp .sgx-qp-row-label')).toHaveText(['Color palette', 'Layout']);
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveText('Reset');
    await expect(tile(page, 'system').locator('[data-qp-state]')).toHaveText('On');
    await expect(qp(page)).toHaveAccessibleName('Quick settings');
    await expect(page.locator('#sgx-qp .sgx-qp-title, #sgx-qp .sgx-qp-set')).toHaveCount(0);
  });
});

test.describe('快捷面板：设置即时生效（和设置同一个 key）', () => {
  test('深色模式：写 sgx-theme-mode，即时变深 / 变浅，面板不关；换页后照旧', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await tile(page, 'dark').click();
    expect(await ls(page, 'sgx-theme-mode')).toBe('dark');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'dark').locator('[data-qp-state]')).toHaveText('开');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'false');
    await expect(qp(page)).toHaveAttribute('data-state', 'open'); /* 不关面板、不刷新 */
    await page.goto('/theme/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await openQp(page);
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
    await tile(page, 'dark').click();
    expect(await ls(page, 'sgx-theme-mode')).toBe('light');
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'false');
  });

  test('跟随系统：关 = 固定为当前看到的外观；开 = 不存 key；跟着系统深浅变', async ({ page }) => {
    await go(page, '/theme/');
    await openQp(page);
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'true');
    await tile(page, 'system').click();
    /* 关掉跟随系统 → 固定为当前看到的浅色 */
    expect(await ls(page, 'sgx-theme-mode')).toBe('light');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'false');
    await expect(tile(page, 'system').locator('[data-qp-state]')).toHaveText('关');
    await tile(page, 'system').click();
    /* 改回跟随系统：默认值不存 */
    expect(await ls(page, 'sgx-theme-mode')).toBeNull();
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'true');
    /* 跟随系统时系统变深：页面变深，面板开着即时重绘（深色模式磁贴跟着亮） */
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'true');
  });

  test('减弱动效 / 字体大小已删除：面板和风格页都没有，旧值不起作用', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-reduced-motion', '1'); localStorage.setItem('sgx-font-size', 'large'); } catch (e) {}
    });
    await go(page, '/theme/');
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
    await go(page, '/theme/');
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

  test('布局：窄屏 DeX 置灰；写 sgx-layout，即时套用', async ({ page }) => {
    await go(page, '/theme/');
    await openQp(page);
    const seg = page.locator('#sgx-qp [data-qp-seg="layout"]');
    await expect(seg.locator('[data-v="dex"]')).toBeDisabled();
    await expect(seg.locator('[data-v="pc"]')).toHaveCount(0);
    await seg.locator('[data-v="mobile"]').click();
    expect(await ls(page, 'sgx-layout')).toBe('mobile');
    await expect(seg.locator('[data-v="mobile"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(seg.locator('[data-v="auto"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('html')).not.toHaveClass(/\blayout-dex\b/);
    await seg.locator('[data-v="auto"]').click();
    /* 自动 = 默认值；baseof.html __layoutMode 会把空值补写成 auto */
    expect(['auto', null]).toContain(await ls(page, 'sgx-layout'));
    await expect(seg.locator('[data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
  });

  test('布局（宽屏）：选 DeX 立即换成 DeX 布局', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await go(page, '/theme/');
    await openQp(page);
    /* 宽屏（≥ 980px）：宽 400，右缘对齐顶栏右缘 */
    const sb = await page.locator('#sgx-qp .sgx-qp-sheet').boundingBox();
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

  test('语言：行内展开单选（不弹底部窗口）；选 English 写 sgx-lang=en，关面板后去英文同一页，不在历史里多留一步', async ({ page }) => {
    await go(page, '/');
    await page.goto('/theme/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openQp(page);
    const lang = tile(page, 'lang');
    const opts = page.locator('#sgx-qp-lang-opts');
    await lang.click();
    await expect(lang).toHaveAttribute('aria-expanded', 'true');
    await expect(opts).toBeVisible();
    await expect(opts).toHaveAttribute('role', 'radiogroup');
    /* 行内，不是底部弹出窗口 */
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await expect(opts.locator('[aria-checked="true"]')).toHaveAttribute('data-qp-lang', 'zh');
    /* 再点行收起 */
    await lang.click();
    await expect(lang).toHaveAttribute('aria-expanded', 'false');
    await expect(opts).toBeHidden();
    await lang.click();
    await opts.locator('[data-qp-lang="en"]').click();
    await expect(page).toHaveURL(/\/en\/theme\/$/);
    expect(await ls(page, 'sgx-lang')).toBe('en');
    await expect(page.locator('.sgx-tb-title')).toHaveText('Style');
    await page.goBack();
    /* 回到进子页之前的旷野页（语言偏好已是英文，旷野页 replace 到 /en/） */
    await expect(page).toHaveURL(/localhost:\d+\/(en\/)?$/);
  });

  test('语言：选和本页相同的语言 = 只保存、收起，不跳页；键盘 ↑↓ 在选项间移动，Esc 收起回到语言行；跟随系统按浏览器语言', async ({ page }) => {
    /* 只在第一次加载时写 zh（go() 的 init script 每次加载都补写，会把「跟随系统」删掉的 key 又写回去） */
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('qp-lang-seeded')) { localStorage.setItem('sgx-lang', 'zh'); sessionStorage.setItem('qp-lang-seeded', '1'); } } catch (e) {} });
    await blockExternalRequests(page);
    await freezeTime(page);
    await page.goto('/theme/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
    await openQp(page);
    const lang = tile(page, 'lang');
    const opts = page.locator('#sgx-qp-lang-opts');
    await lang.click();
    await opts.locator('[data-qp-lang="zh"]').click();
    await expect(opts).toBeHidden();
    await expect(lang).toBeFocused();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await expect(page).toHaveURL(/\/theme\/$/);
    expect(await ls(page, 'sgx-lang')).toBe('zh');
    /* 键盘：↓ 到下一个，↑ 回来（移动不保存）；Esc 只收起选项、面板不关 */
    await lang.click();
    await opts.locator('[data-qp-lang="zh"]').focus();
    await page.keyboard.press('ArrowDown');
    await expect(opts.locator('[data-qp-lang="en"]')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(opts.locator('[data-qp-lang="zh"]')).toBeFocused();
    expect(await ls(page, 'sgx-lang')).toBe('zh');
    await page.keyboard.press('Escape');
    await expect(opts).toBeHidden();
    await expect(lang).toBeFocused();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    /* 跟随系统：删掉 sgx-lang，按浏览器语言去对应语言的同一页 */
    const navLang = await page.evaluate(() => navigator.language);
    await lang.click();
    await opts.locator('[data-qp-lang="system"]').click();
    await expect(page).toHaveURL(/^zh/i.test(navLang) ? /localhost:\d+\/theme\/$/ : /\/en\/theme\/$/);
    expect(await ls(page, 'sgx-lang')).toBeNull();
  });

  test('立即锁定：关面板后弹出与安全页相同的确认层，确认后调 /api/lock-now', async ({ page }) => {
    let called = false;
    await go(page, '/', 'zh', false);
    await page.route('**/api/lock-now', async (route) => {
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
    /* 防误触窗口（400ms）过去。C8：原来固定等 450ms；改成直接看页面自己的判据——
       lib/dialog-behavior.js 关弹层时记 window.__sgxLastDialogClosedAt，Date.now() 与它相差 < 400 就忽略点击（这个用例不冻结时间） */
    await page.waitForFunction(() => Date.now() - (/** @type {any} */ (window).__sgxLastDialogClosedAt || 0) >= 400);
    await openQp(page);
    await tile(page, 'lock').click();
    await expect(dlg).toBeVisible();
    await dlg.locator('[data-act="ok"]').click();
    await expect(page).toHaveURL(/\?lock=1/);
    expect(called).toBe(true);
  });

  test('P4-3 PR-4b：设置入口 = 旷野页的分类入口（面板里没有齿轮和链接，顶栏没有「设置」标签）', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await expect(page.locator('#sgx-qp a')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-nav="settings"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page.locator('.sgx-tb-tab')).toHaveCount(1);
    await expect(page.locator('.sgx-tb-tab[data-tab="settings"], .sgx-tb-tab[data-tab="home"]')).toHaveCount(0);
    await page.locator('.home-wrap [aria-label="分类"] a[href="/theme/"]').click();
    await expect(page).toHaveURL(/\/theme\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });
});

test.describe('AI 窗口（2026-11-04 P5-1，方案 5.5）', () => {
  const ai = (page) => page.locator('#sgx-ai');
  async function openAi(page) {
    await page.locator('.sgx-tb-ai').click();
    await expect(ai(page)).toHaveAttribute('data-state', 'open');
    await page.waitForFunction(() => document.getElementById('sgx-ai').getAnimations({ subtree: true }).every((a) => a.playState !== 'running'));
  }
  /* 2026-11-06 起服务端不再发 event: hits；hits 非空时照旧版服务端那样先发一条，用来验证前端不渲染来源卡片 */
  const sse = (hits, deltas) => (hits && hits.length ? ['event: hits\ndata: ' + JSON.stringify({ hits }) + '\n\n'] : [])
    .concat(deltas.map((t) => 'event: delta\ndata: ' + JSON.stringify({ text: t }) + '\n\n'), ['event: done\ndata: {}\n\n']).join('');

  test('从顶栏下方落下（非模态，和快捷面板同一种形式）：标题 Gray AI、开场白、新对话 / 历史 / 联系、输入框、范围小字', async ({ page }) => {
    await go(page, '/theme/');
    await openAi(page);
    expect(await ai(page).evaluate((el) => el.open && !el.matches(':modal'))).toBe(true);
    const g = await page.evaluate(() => {
      const tb = document.querySelector('.sgx-topbar').getBoundingClientRect();
      const sh = document.querySelector('#sgx-ai .sgx-qp-sheet').getBoundingClientRect();
      return { tbBottom: tb.bottom, top: sh.top, left: sh.left, w: sh.width };
    });
    expect(Math.abs(g.top - g.tbBottom - 8)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.left - 16)).toBeLessThanOrEqual(1);
    await expect(ai(page).locator('.sgx-ai-title')).toHaveText('Gray AI');
    /* 空态 = 开场白（助手气泡样式、不带操作行），没有旧的空态文案 */
    const greet = ai(page).locator('.sgx-ai-msg[data-greet]');
    await expect(greet).toHaveText('你好，我是 Gray 的 AI 助手。想了解站里的内容，或者聊聊你手上的问题，都行。');
    await expect(greet).toHaveAttribute('data-role', 'assistant');
    await expect(ai(page).locator('.sgx-ai-ops')).toHaveCount(0);
    await expect(ai(page)).not.toContainText('回答来自站内内容');
    /* PR-4b：新对话 / 历史 / 头像在标题行（排布见 topbar-spec.spec.js），没有第 2 行按钮；联系在底部小字 */
    await expect(ai(page).locator('.sgx-ai-actions')).toHaveCount(0);
    await expect(ai(page).locator('.sgx-ai-head [data-ai-clear]')).toHaveAttribute('aria-label', '新对话');
    await expect(ai(page).locator('.sgx-ai-head [data-ai-history]')).toHaveAttribute('aria-label', '历史');
    await expect(ai(page).locator('.sgx-ai-foot [data-ai-contact]')).toHaveText('联系我');
    await expect(ai(page).locator('[data-ai-contact]')).toHaveAttribute('href', 'mailto:styrigx@gmail.com');
    await expect(ai(page).locator('[data-ai-in]')).toHaveAttribute('maxlength', '200');
    await expect(ai(page).locator('[data-ai-scope]')).toHaveText('仅公开内容');
    await expect(ai(page).locator('[data-ai-clear]')).toBeDisabled();
    expect(await page.evaluate(() => document.getElementById('sgx-ai').contains(document.activeElement))).toBe(true);
  });

  test('问一句：POST /api/ai（问题 + 语言 + 历史），流式回答（不显示来源卡片，旧服务端发了 hits 也不显示）；范围按响应头；历史只存本地 sgx-ai-history', async ({ page }) => {
    await go(page, '/theme/');
    let body = null;
    await page.route('**/api/ai', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Styrigx-AI-Scope': 'private' },
        body: sse([{ site: 'blog', title: 'Muse 手册', url: '/blog/post/2026-10-07-muse-playbook/' }, { title: '外站', url: 'https://evil.example/' }], ['Muse 是', '协作代理。']) });
    });
    await openAi(page);
    await ai(page).locator('[data-ai-in]').fill('Muse 是什么？');
    await ai(page).locator('[data-ai-in]').press('Enter');
    const ans = ai(page).locator('.sgx-ai-msg[data-role="assistant"]');
    await expect(ans.locator('> span')).toHaveText('Muse 是协作代理。');
    expect(body).toEqual({ q: 'Muse 是什么？', lang: 'zh', history: [] });
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveText('Muse 是什么？');
    /* 2026-11-06：只显示模型正文，0 张来源卡片、0 个卡片链接 */
    await expect(ai(page).locator('.sgx-ai-hits')).toHaveCount(0);
    await expect(ans.locator('a')).toHaveCount(0);
    await expect(ai(page).locator('[data-ai-scope]')).toHaveText('包含私密内容');
    const h = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h.v).toBe(2);
    expect(h.chats).toHaveLength(1);
    expect(h.cur).toBe(h.chats[0].id);
    expect(h.chats[0].title).toBe('Muse 是什么？');
    expect(h.chats[0].msgs.map((m) => [m.role, m.text])).toEqual([['user', 'Muse 是什么？'], ['assistant', 'Muse 是协作代理。']]);
    /* 第二问带上历史 */
    await ai(page).locator('[data-ai-in]').fill('再说说');
    await ai(page).locator('.sgx-ai-send').click();
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"]')).toHaveCount(2);
    expect(body.history).toEqual([{ role: 'user', text: 'Muse 是什么？' }, { role: 'assistant', text: 'Muse 是协作代理。' }]);
    /* 第二条回答流式结束后才写历史：等写满 4 条再换页，否则换页早于写入会只剩 3 条 */
    await expect.poll(async () => {
      const v = await ls(page, 'sgx-ai-history');
      return v ? JSON.parse(v).chats[0].msgs.length : 0;
    }).toBe(4);
    /* 换页再开：同一份本地历史 */
    await page.goto('/theme/', { waitUntil: 'domcontentloaded' });
    await openAi(page);
    await expect(ai(page).locator('.sgx-ai-msg')).toHaveCount(4);
    /* 新对话：当前对话留在历史里，窗口回到开场白 */
    await ai(page).locator('[data-ai-clear]').click();
    await expect(ai(page).locator('.sgx-ai-msg')).toHaveCount(1);
    await expect(ai(page).locator('.sgx-ai-msg[data-greet]')).toBeVisible();
    const h2 = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h2.chats).toHaveLength(1);
    expect(h2.chats[0].msgs).toHaveLength(4);
    expect(h2.cur).not.toBe(h2.chats[0].id);
  });

  test('2026-11-06：旧历史里带 hits 的回答，点开也是 0 张来源卡片', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('sgx-ai-history', JSON.stringify({ v: 1, msgs: [
          { role: 'user', text: '锁屏怎么开', ts: 1 },
          { role: 'assistant', text: '设置 → 安全 → 锁屏凭证。', hits: [{ site: 'space', title: '锁屏凭证', subtitle: '安全', url: '/security/lock/' }], ts: 2 },
        ] }));
      } catch (e) {}
    });
    await go(page, '/theme/');
    await openAi(page);
    await expect(ai(page).locator('.sgx-ai-msg')).toHaveCount(2);
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('设置 → 安全 → 锁屏凭证。');
    await expect(ai(page).locator('.sgx-ai-hits')).toHaveCount(0);
    await expect(ai(page).locator('.sgx-ai-msg a')).toHaveCount(0);
    /* v1 → v2 迁移：包成一份对话（标题 = 首问），hits 不再存 */
    const h = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h.v).toBe(2);
    expect(h.chats.map((c) => c.title)).toEqual(['锁屏怎么开']);
    expect(h.cur).toBe(h.chats[0].id);
    expect(JSON.stringify(h)).not.toContain('hits');
  });

  for (const [status, err, want] of [[429, 'cooldown', '问得太快了，请一分钟后再试'], [429, 'busy', '现在问的人太多，请稍后再试'], [401, 'session', '锁屏会话已失效，请重新解锁后再问'], [502, 'upstream', '没能拿到回答，请稍后再试']]) {
    test(`出错：${status} ${err} → 「${want}」，不进历史`, async ({ page }) => {
      await go(page, '/theme/');
      await page.route('**/api/ai', (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: err }) }));
      await openAi(page);
      await ai(page).locator('[data-ai-in]').fill('你好');
      await ai(page).locator('[data-ai-in]').press('Enter');
      const ans = ai(page).locator('.sgx-ai-msg[data-role="assistant"]');
      await expect(ans).toHaveAttribute('data-state', 'error');
      await expect(ans).toHaveText(want);
      const h = JSON.parse((await ls(page, 'sgx-ai-history')) || '{"chats":[]}');
      expect(h.chats.flatMap((c) => c.msgs).filter((m) => m.role === 'assistant')).toEqual([]);
    });
  }

  /* P4-2d：模型在账号页选（localStorage sgx-ai-model），AI 窗口只负责带上；窗口里没有切换 */
  const okSse = (route, model) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Styrigx-AI-Scope': 'private', 'X-Styrigx-AI-Model': model },
    body: sse([], ['好的。']) });

  test('P4-2d：账号页选过模型（sgx-ai-model）→ 发问带上 body.model；窗口里没有模型切换', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-ai-model', '@cf/openai/gpt-oss-20b'); } catch (e) {} });
    await go(page, '/theme/');
    const bodies = [];
    await page.route('**/api/ai', async (route) => {
      const b = route.request().postDataJSON();
      bodies.push(b);
      await okSse(route, b.model || 'default');
    });
    await openAi(page);
    await expect(ai(page).locator('select, [role="radiogroup"], [data-ai-model]')).toHaveCount(0);
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('好的。');
    expect(bodies).toEqual([{ q: '你好', lang: 'zh', history: [], model: '@cf/openai/gpt-oss-20b' }]);
    expect(await ls(page, 'sgx-ai-model')).toBe('@cf/openai/gpt-oss-20b');
  });

  test('P4-2d：选的模型被下架 → 400 bad_model：清掉本地选择、不带 model 自动重发一次，回答照常', async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('sgx-ai-model', '@cf/gone/model'); } } catch (e) {} });
    await go(page, '/theme/');
    const bodies = [];
    await page.route('**/api/ai', async (route) => {
      const b = route.request().postDataJSON();
      bodies.push(b);
      if (b.model) await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'bad_model' }) });
      else await okSse(route, '@cf/google/gemma-4-26b-a4b-it');
    });
    await openAi(page);
    await page.evaluate(() => { window.__chg = 0; window.addEventListener('sgx-settings-changed', () => { window.__chg++; }); });
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    const ans = ai(page).locator('.sgx-ai-msg[data-role="assistant"]');
    await expect(ans.locator('> span')).toHaveText('好的。');
    await expect(ans).not.toHaveAttribute('data-state', 'error');
    expect(bodies).toEqual([
      { q: '你好', lang: 'zh', history: [], model: '@cf/gone/model' },
      { q: '你好', lang: 'zh', history: [] },
    ]);
    expect(await ls(page, 'sgx-ai-model')).toBe(null);
    expect(await page.evaluate(() => window.__chg)).toBeGreaterThan(0);
    /* 下一问不再带 model，也不再多发 */
    await ai(page).locator('[data-ai-in]').fill('再问');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ans).toHaveCount(2);
    await expect(ans.nth(1).locator('> span')).toHaveText('好的。');
    expect(bodies.length).toBe(3);
    expect(bodies[2].model).toBeUndefined();
  });

  test('P4-2d：只重发一次——重发仍出错就按普通错误显示，不再重试；没带 model 时的 400 bad_model 不重发', async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('sgx-ai-model', '@cf/gone/model'); } } catch (e) {} });
    await go(page, '/theme/');
    const bodies = [];
    await page.route('**/api/ai', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'bad_model' }) });
    });
    await openAi(page);
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    const ans = ai(page).locator('.sgx-ai-msg[data-role="assistant"]');
    await expect(ans).toHaveAttribute('data-state', 'error');
    await expect(ans).toHaveText('没能拿到回答，请稍后再试');
    expect(bodies.map((b) => b.model)).toEqual(['@cf/gone/model', undefined]);
    /* 本地已清掉：再问只发一次 */
    await ai(page).locator('[data-ai-in]').fill('再问');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ans).toHaveCount(2);
    await expect(ans.nth(1)).toHaveAttribute('data-state', 'error');
    expect(bodies.length).toBe(3);
  });

  /* P4-3 PR-3：键盘跟随。用假的 VirtualKeyboard API（vk.js 优先用它）驱动键盘高度；触屏用假的 matchMedia('(pointer: coarse)') */
  async function fakeKeyboard(page) {
    await page.addInitScript(() => {
      const vk = new EventTarget();
      vk.overlaysContent = false;
      vk.boundingRect = { height: 0 };
      Object.defineProperty(navigator, 'virtualKeyboard', { value: vk, configurable: true });
      window.__kb = (h) => { vk.boundingRect = { height: h }; vk.dispatchEvent(new Event('geometrychange')); };
    });
  }
  async function fakeCoarse(page) {
    await page.addInitScript(() => {
      const mm = window.matchMedia.bind(window);
      const noop = () => {};
      window.matchMedia = (q) => (/pointer:\s*coarse/.test(q) ? { matches: true, media: q, onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop } : mm(q));
    });
  }
  const geo = (page) => page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    return { vh: window.innerHeight, tb: r('.sgx-topbar').bottom, title: r('#sgx-ai .sgx-ai-title').top, sheet: r('#sgx-ai .sgx-qp-sheet').bottom,
      input: r('#sgx-ai [data-ai-in]').bottom, focused: document.activeElement === document.querySelector('#sgx-ai [data-ai-in]') };
  });

  test('P4-3 PR-3：输入框聚焦后跟键盘——窗口下沿抬到键盘上沿，标题栏和输入框都在可视区；键盘收了自动失焦', async ({ page }) => {
    await fakeKeyboard(page);
    await go(page, '/theme/');
    await openAi(page);
    await ai(page).locator('[data-ai-in]').click();
    await page.evaluate(() => window.__kb(320));
    await expect(ai(page)).toHaveAttribute('data-kb', '');
    expect(await page.evaluate(() => document.documentElement.classList.contains('sgx-vk') && navigator.virtualKeyboard.overlaysContent)).toBe(true);
    await page.waitForFunction(() => document.getElementById('sgx-ai').getAnimations({ subtree: true }).every((a) => a.playState !== 'running'));
    const g = await geo(page);
    expect(g.focused).toBe(true);
    expect(g.sheet).toBeLessThanOrEqual(g.vh - 320 + 1);
    expect(g.input).toBeLessThanOrEqual(g.vh - 320 + 1);
    expect(g.title).toBeGreaterThanOrEqual(g.tb);
    /* 键盘高度变化（换输入法 / 候选栏）跟着走 */
    await page.evaluate(() => window.__kb(400));
    expect((await geo(page)).input).toBeLessThanOrEqual((await geo(page)).vh - 400 + 1);
    /* 系统手势收键盘：高度回 0 → 输入框失焦，窗口回原位 */
    await page.evaluate(() => window.__kb(0));
    await expect(ai(page)).not.toHaveAttribute('data-kb', '');
    expect((await geo(page)).focused).toBe(false);
    expect(await ai(page).evaluate((el) => el.style.getPropertyValue('--sgx-kb'))).toBe('0px');
    expect(await page.evaluate(() => document.documentElement.classList.contains('sgx-vk'))).toBe(false);
    /* 再点输入框又跟上 */
    await ai(page).locator('[data-ai-in]').click();
    await page.evaluate(() => window.__kb(300));
    await expect(ai(page)).toHaveAttribute('data-kb', '');
    /* 关窗口 = 复位 */
    await page.keyboard.press('Escape');
    await expect(ai(page)).not.toHaveAttribute('data-kb', '');
  });

  test('P4-3 PR-3：触屏打开不自动聚焦（不弹键盘）；发送后收键盘', async ({ page }) => {
    await fakeCoarse(page);
    await go(page, '/theme/');
    await page.route('**/api/ai', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['好的。']) }));
    await openAi(page);
    expect((await geo(page)).focused).toBe(false);
    expect(await page.evaluate(() => document.getElementById('sgx-ai').contains(document.activeElement))).toBe(true);
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('好的。');
    expect((await geo(page)).focused).toBe(false);
  });

  test('P4-3 PR-3：桌面（细指针）照旧——打开即聚焦，发送后焦点留在输入框', async ({ page }) => {
    await go(page, '/theme/');
    await page.route('**/api/ai', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['好的。']) }));
    await openAi(page);
    expect((await geo(page)).focused).toBe(true);
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('好的。');
    expect((await geo(page)).focused).toBe(true);
  });

  test('P4-3 后续 §4：桌面鼠标点发送，焦点回输入框；回答中和答完直接打字都进输入框', async ({ page }) => {
    await go(page, '/theme/');
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/api/ai', async (r) => { await gate; await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['巴黎。']) }); });
    await openAi(page);
    await ai(page).locator('[data-ai-in]').fill('法国首都是哪');
    await ai(page).locator('.sgx-ai-send').click();
    await expect(ai(page).locator('.sgx-ai-send')).toHaveAttribute('data-stop', '');
    expect((await geo(page)).focused).toBe(true);
    await page.keyboard.type('X');
    await expect(ai(page).locator('[data-ai-in]')).toHaveValue('X');
    release();
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('巴黎。');
    await page.keyboard.type('Y');
    await expect(ai(page).locator('[data-ai-in]')).toHaveValue('XY');
  });

  test('P4-3 后续 §5：触屏键盘弹着时点发送，一次就发出去；不让输入框先失焦把点击吃掉', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, colorScheme: 'light' });
    const page = await ctx.newPage();
    try {
      await fakeKeyboard(page);
      await fakeCoarse(page);
      await go(page, '/theme/');
      await page.route('**/api/ai', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['我是 Gray 的 AI 助手。']) }));
      await openAi(page);
      await ai(page).locator('[data-ai-in]').tap();
      await page.evaluate(() => window.__kb(320));
      await expect(ai(page)).toHaveAttribute('data-kb', '');
      await ai(page).locator('[data-ai-in]').fill('你是谁');
      /* 输入框失焦就收键盘（模拟真机：键盘高度回 0，窗口下沿落回底部、发送按钮下移） */
      await page.evaluate(() => document.querySelector('#sgx-ai [data-ai-in]').addEventListener('blur', () => window.__kb(0), { once: true }));
      await ai(page).locator('.sgx-ai-send').tap();
      await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveText('你是谁');
      await expect(ai(page).locator('[data-ai-in]')).toHaveValue('');
      await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('我是 Gray 的 AI 助手。');
      /* 发出去后照旧收键盘 */
      expect((await geo(page)).focused).toBe(false);
      await expect(ai(page)).not.toHaveAttribute('data-kb', '');
    } finally {
      await ctx.close();
    }
  });

  test('P4-3 后续 §3：新对话存进历史；历史是窗口内的列表（倒序、标题 + 时间），点一条载入，输入框里的字不丢', async ({ page }) => {
    await go(page, '/theme/');
    await page.route('**/api/ai', async (r) => {
      const q = r.request().postDataJSON().q;
      await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['答：' + q]) });
    });
    await openAi(page);
    const inp = ai(page).locator('[data-ai-in]');
    const last = ai(page).locator('.sgx-ai-msg[data-role="assistant"]').last().locator('> span');
    await inp.fill('第一份对话的问题，比二十个字还要长一点点再多几个字');
    await inp.press('Enter');
    await expect(last).toHaveText('答：第一份对话的问题，比二十个字还要长一点点再多几个字');
    await ai(page).locator('[data-ai-clear]').click();
    await inp.fill('第二份');
    await inp.press('Enter');
    await expect(last).toHaveText('答：第二份');
    /* 打开历史：窗口内视图（不是 dialog / 底部弹出），替换消息列表；按时间倒序 */
    await inp.fill('还没发的字');
    const hb = ai(page).locator('[data-ai-history]');
    await hb.click();
    await expect(hb).toHaveAttribute('aria-expanded', 'true');
    const items = ai(page).locator('[data-ai-hist] .sgx-ai-hist-item');
    await expect(items).toHaveCount(2);
    await expect(items.locator('.sgx-ai-hist-title')).toHaveText(['第二份', '第一份对话的问题，比二十个字还要长一点点']);
    await expect(items.first().locator('.sgx-ai-hist-time')).toHaveText(/\d{2}:\d{2}/);
    await expect(items.first()).toHaveAttribute('aria-current', 'true');
    await expect(ai(page).locator('[data-ai-list]')).toBeHidden();
    expect(await page.locator('dialog[open]').count()).toBe(1);
    /* 点旧的一份载入 */
    await items.nth(1).click();
    await expect(ai(page).locator('[data-ai-hist]')).toBeHidden();
    await expect(hb).toHaveAttribute('aria-expanded', 'false');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveText(['第一份对话的问题，比二十个字还要长一点点再多几个字']);
    await expect(inp).toHaveValue('还没发的字');
    /* 换页再开：停在刚载入的那份 */
    await page.goto('/theme/', { waitUntil: 'domcontentloaded' });
    await openAi(page);
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveText(['第一份对话的问题，比二十个字还要长一点点再多几个字']);
  });

  test('P4-3 后续 §3.3：历史最多 20 份，超了删最旧的；空历史显示提示', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        const chats = [];
        for (let i = 0; i < 20; i++) chats.push({ id: 'c' + i, title: '旧' + i, time: 1000 + i, msgs: [{ role: 'user', text: '旧' + i, ts: 1000 + i }, { role: 'assistant', text: '答', ts: 1000 + i }] });
        localStorage.setItem('sgx-ai-history', JSON.stringify({ v: 2, cur: '', chats }));
      } catch (e) {}
    });
    await go(page, '/theme/');
    await page.route('**/api/ai', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['好']) }));
    await openAi(page);
    await ai(page).locator('[data-ai-in]').fill('新的');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('好');
    await expect.poll(async () => JSON.parse(await ls(page, 'sgx-ai-history')).chats.length).toBe(20);
    const h = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h.chats[0].title).toBe('新的');
    expect(h.chats.map((c) => c.id)).not.toContain('c0');
    await page.evaluate(() => localStorage.removeItem('sgx-ai-history'));
    await ai(page).locator('[data-ai-history]').click();
    await expect(ai(page).locator('[data-ai-hist]')).toHaveText('还没有历史对话');
  });

  test('P4-3 后续 §3.4：助手回答下有复制 / 重试 / 👍 / 👎；用户提问下没有；重试替换这条回答；👍👎 只存本地、再点取消', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await go(page, '/theme/');
    let n = 0;
    const bodies = [];
    await page.route('**/api/ai', async (r) => {
      bodies.push(r.request().postDataJSON());
      n += 1;
      await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['第 ' + n + ' 次回答']) });
    });
    await openAi(page);
    const inp = ai(page).locator('[data-ai-in]');
    await inp.fill('问一');
    await inp.press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('第 1 次回答');
    await inp.fill('问二');
    await inp.press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText(['第 1 次回答', '第 2 次回答']);
    const ops = ai(page).locator('.sgx-ai-ops');
    await expect(ops).toHaveCount(2);
    await expect(ops.first().locator('button')).toHaveText(['复制', '重试', '👍', '👎']);
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"] .sgx-ai-ops')).toHaveCount(0);
    /* 复制 */
    await ops.first().locator('[data-op="copy"]').click();
    await expect(ops.first().locator('[data-op="copy"]')).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('第 1 次回答');
    /* 重试第一条：重问「问一」，历史只带它前面的（空），替换这条回答，不追加 */
    await ops.first().locator('[data-op="retry"]').click();
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText(['第 3 次回答', '第 2 次回答']);
    expect(bodies[2]).toEqual({ q: '问一', lang: 'zh', history: [] });
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveCount(2);
    /* 👍 / 👎：同一条只能选一个，再点取消；存在本地这条消息上 */
    const up = ops.nth(1).locator('[data-op="up"]');
    const dn = ops.nth(1).locator('[data-op="down"]');
    await up.click();
    await expect(up).toHaveAttribute('aria-pressed', 'true');
    await dn.click();
    await expect(up).toHaveAttribute('aria-pressed', 'false');
    await expect(dn).toHaveAttribute('aria-pressed', 'true');
    let h = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h.chats[0].msgs.map((m) => m.rate || '')).toEqual(['', '', '', 'down']);
    await dn.click();
    await expect(dn).toHaveAttribute('aria-pressed', 'false');
    h = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h.chats[0].msgs.map((m) => m.rate || '')).toEqual(['', '', '', '']);
    expect(n).toBe(3);
    /* 换页再开：👍👎 随历史 */
    await ops.nth(0).locator('[data-op="up"]').click();
    await page.goto('/theme/', { waitUntil: 'domcontentloaded' });
    await openAi(page);
    await expect(ai(page).locator('.sgx-ai-ops').first().locator('[data-op="up"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('P4-3 PR-3：回答进行中发送按钮变停止，点它中断；回车不中断；停下后变回发送', async ({ page }) => {
    await go(page, '/theme/');
    let release;
    const hold = new Promise((r) => { release = r; });
    await page.route('**/api/ai', async (r) => {
      await hold;
      try { await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['迟到的回答。']) }); } catch (e) {}
    });
    await openAi(page);
    const send = ai(page).locator('.sgx-ai-send');
    await expect(send).toHaveAttribute('aria-label', '发送');
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(send).toHaveAttribute('data-stop', '');
    await expect(send).toHaveAttribute('aria-label', '停止');
    await expect(send).toBeEnabled();
    /* 回答中回车：不发、不中断，输入留着 */
    await ai(page).locator('[data-ai-in]').fill('再问');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(send).toHaveAttribute('data-stop', '');
    await expect(ai(page).locator('[data-ai-in]')).toHaveValue('再问');
    await send.click();
    await expect(send).not.toHaveAttribute('data-stop', '');
    await expect(send).toHaveAttribute('aria-label', '发送');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveText('你好');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"]')).toHaveCount(0);
    release();
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"]')).toHaveCount(0);
  });

  test('英文文案', async ({ page }) => {
    await go(page, '/en/theme/', 'en');
    await openAi(page);
    await expect(ai(page)).toHaveAccessibleName('Ask AI');
    await expect(ai(page).locator('.sgx-ai-title')).toHaveText('Gray AI');
    await expect(ai(page).locator('.sgx-ai-msg[data-greet]')).toHaveText("Hi, I'm Gray's AI assistant. Ask about this site, or talk through whatever you're working on.");
    await expect(ai(page).locator('[data-ai-scope]')).toHaveText('Public content only');
    await expect(ai(page).locator('.sgx-ai-head [data-ai-clear]')).toHaveAttribute('aria-label', 'New chat');
    await expect(ai(page).locator('.sgx-ai-head [data-ai-history]')).toHaveAttribute('aria-label', 'History');
    await expect(ai(page).locator('[data-ai-contact]')).toHaveText('Contact me');
    await ai(page).locator('[data-ai-history]').click();
    await expect(ai(page).locator('[data-ai-hist]')).toHaveText('No past chats yet');
  });
});

/* 2026-10-21 品牌：站名 = 内联 SVG 字标（可访问名 Styrigx）；i 上的圆点跟主题色（--sgx-primary），字母跟 --sgx-text-primary：
   默认 dustyblue 亮 / 暗、forest（含旧撞色 id xforest 迁移）都对。2026-11-04 P5-1：字标从抽屉头搬到顶栏 logo（20px 高）。
   标签页 SVG 图标：默认色板用静态 /favicon.svg，换色板后换成主题色的 data: 图标。 */
test.describe('顶栏 logo 字标 + 标签页图标跟主题色', () => {
  const CASES = [
    { name: 'dustyblue 亮色', pal: null, dark: false },
    { name: 'dustyblue 深色', pal: null, dark: true },
    { name: 'forest 亮色（存的是旧撞色 xforest，首屏迁到 forest）', store: 'xforest', pal: 'forest', dark: false },
    { name: 'forest 深色', pal: 'forest', dark: true },
  ];
  for (const c of CASES) {
    test(`${c.name}：字标渲染、圆点 = --sgx-primary、字母 = --sgx-text-primary`, async ({ page }) => {
      await page.addInitScript((o) => {
        try {
          if (o.store || o.pal) localStorage.setItem('sgx-palette', o.store || o.pal);
          localStorage.setItem('sgx-theme-mode', o.dark ? 'dark' : 'light');
        } catch (e) {}
      }, c);
      /* helpers 的拦截会把带 favicon 的地址换成占位 PNG；这里放行真的 /favicon.svg（后注册的路由优先） */
      await blockExternalRequests(page);
      await page.route('**/favicon.svg', (r) => r.continue());
      await freezeTime(page);
      await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
      const wm = page.locator('.sgx-tb-logo svg.sgx-wordmark');
      await expect(wm).toHaveCount(1);
      await expect(wm).toHaveAttribute('role', 'img');
      await expect(wm).toHaveAttribute('aria-label', 'Styrigx');
      await expect(page.locator('.sgx-tb-logo').getByRole('img', { name: 'Styrigx' })).toHaveCount(1);
      const m = await page.evaluate(() => {
        const svg = document.querySelector('.sgx-tb-logo .sgx-wordmark');
        const r = svg.getBoundingClientRect();
        const br = svg.parentElement.getBoundingClientRect();
        const probe = document.createElement('i');
        probe.style.cssText = 'position:absolute;color:var(--sgx-primary);background:var(--sgx-text-primary)';
        document.body.appendChild(probe);
        const cs = getComputedStyle(probe);
        const out = { w: r.width, h: r.height, inTop: r.top - br.top, inBottom: br.bottom - r.bottom, inLeft: r.left - br.left, inRight: br.right - r.right,
          dot: getComputedStyle(svg.querySelector('.wm-dot')).fill, ink: getComputedStyle(svg.querySelector('.wm-letters')).fill, primary: cs.color, text: cs.backgroundColor,
          pal: document.documentElement.getAttribute('data-palette'), dark: document.documentElement.classList.contains('dark') };
        probe.remove();
        return out;
      });
      expect(m.pal).toBe(c.pal);
      expect(m.dark).toBe(c.dark);
      expect(m.dot).toBe(m.primary);
      expect(m.ink).toBe(m.text);
      expect(m.dot).not.toBe(m.ink);
      /* 顶栏 logo：字标高 20px，宽按 viewBox 比例；整个在 logo 按钮里 */
      expect(Math.abs(m.h - 20)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(m.w - m.h * 5924 / 2010)).toBeLessThanOrEqual(0.5);
      for (const k of ['inTop', 'inBottom', 'inLeft', 'inRight']) expect(m[k], k).toBeGreaterThanOrEqual(-0.5);
      /* SVG 图标：默认 dustyblue 亮色用静态文件，其他换成主题色 data: 地址 */
      const icon = page.locator('link[rel="icon"][type="image/svg+xml"]');
      await expect(page.locator('link[rel="icon"][href="/favicon.ico"][sizes="32x32"]')).toHaveCount(1);
      if (!c.pal && !c.dark) {
        await expect(icon).toHaveAttribute('href', '/favicon.svg');
      } else {
        await expect(icon).toHaveAttribute('href', /^data:image\/svg\+xml,/);
        const svg = decodeURIComponent((await icon.getAttribute('href')).slice('data:image/svg+xml,'.length));
        const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('');
        expect(svg).toContain('fill="' + hex(m.primary) + '"');
      }
    });
  }
});

/* 原 nav-drawer.spec.js 里和抽屉无关的两组，原样搬过来 */
test.describe('主站书签已下线', () => {
  test('没有 /bookmarks/ 页面（/browser/ 的去向见 site-search.spec.js）', async ({ page }) => {
    await go(page, '/');
    for (const p of ['/bookmarks/', '/en/bookmarks/']) {
      const r = await page.request.get(p);
      expect(r.status(), p).not.toBe(200);
    }
  });
});
