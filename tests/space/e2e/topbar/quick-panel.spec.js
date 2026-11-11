/**
 * 外观面板 + NAVIGATE 控件 + AI 窗口验收（2026-11-04 P5-1 方案 6.2–6.5 / 5.5；P4-3 PR-4b；2026-11 UI 重设计 PR-1 顶栏 v3）。
 * 顶栏本身（字标 · 外观 · 盾牌 · >_ · 头像的排布、尺寸）和 NAVIGATE 面板 #sgx-nav 的五项见 topbar-spec.spec.js；四站面板 DOM 同一份见 tests/curio/e2e/quick-panel-identity.spec.js。
 * - 外观面板 #sgx-qp（调色盘按钮；非模态 <dialog> show()，dialog 本身是遮罩，只盖顶栏下沿以下）：MODE（跟随系统 / 深 / 浅）+ PALETTE 色板列表 + 恢复默认。
 * - 顶栏 v3 起语言 / 布局分段、分享 / 立即锁定在 NAVIGATE（>_ 按钮）里，这里一起验（写的是同一套 setter、同一个 localStorage key）。
 * - 顶栏不被盖住、不被压暗：面板开着时 elementFromPoint(图标中心) 仍是图标；图标 aria-expanded="true" + 按下态，再点（真点击）关闭。
 * - 关闭：再点图标 / 点遮罩 / Esc / 系统返回（历史哨兵，只关面板不离开页面）/ 点顶栏别的按钮（先关面板再执行）；刚点开立刻 Esc 也能关（竞态回归）。
 * - 外观面板、NAVIGATE 和 AI 窗口互斥：开一个就先关另一个。
 * - 焦点：打开进面板，关上回到图标；Tab 在「图标 + 面板控件」里循环。
 * - 2026-11 PR-A 照设计稿：不压暗、实色卡；手机右缘对齐顶栏内容区（页边距 16px）、宽 260；桌面布局宽 260，右缘在顶栏内容区右缘往左 92px（调色盘按钮下面）。
 * - 写的是和设置同一个 localStorage key（同一套 setter，lib/prefs.js），即时生效、不刷新；刷新后保持（对齐 PR-C：风格页 /theme/ 退役，调色板只在外观面板）。
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
  /* P4-3 PR-4c：英文无前缀、中文 /zh/；中文用例传不带前缀的地址时直接去 /zh/ 那一页 */
  await page.goto(lang === 'zh' && !/^\/zh(\/|$)/.test(path) ? '/zh' + path : path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
}

const qp = (page) => page.locator('#sgx-qp');
const nav = (page) => page.locator('#sgx-nav');
const ctl = (page, id) => page.locator(`#sgx-nav [data-qp="${id}"]`);
const ls = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);

/** 等某个顶栏面板滑下结束 @param {string} id */
async function settle(page, id) {
  const d = page.locator('#' + id);
  await expect(d).toBeVisible();
  await expect(d).toHaveClass(/\bis-open\b/);
  /* 等滑下结束（data-state=open）；is-open 只是过渡起点 */
  await expect(d).toHaveAttribute('data-state', 'open');
  /* data-state=open 可能早于过渡尾巴结束（CI 机器慢时差几像素）：等面板内所有过渡跑完再量 */
  await page.waitForFunction((i) => document.getElementById(i).getAnimations({ subtree: true }).every((a) => a.playState !== 'running'), id);
}
/** 打开外观面板 */
async function openQp(page) {
  await page.locator('.sgx-tb-quick').click();
  await settle(page, 'sgx-qp');
}
/** 打开 NAVIGATE */
async function openNav(page) {
  await page.locator('.sgx-tb-grid').click();
  await settle(page, 'sgx-nav');
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
async function expectNavClosed(page) {
  await expect(nav(page)).toBeHidden();
  await expect(nav(page)).toHaveAttribute('data-state', 'closed');
  await expect(page.locator('.sgx-tb-grid')).toHaveAttribute('aria-expanded', 'false');
}

test.describe('外观按钮（调色盘）', () => {
  for (const [path, lang, name] of [['/', 'zh', '外观'], ['/status/', 'zh', '外观'], ['/', 'en', 'Appearance']]) {
    test(`${path}：顶栏「${name}」按钮控制 #sgx-qp（对话框），默认收起；面板 = PALETTE（v4 删 MODE；没有页签、导航列表、磁贴）`, async ({ page }) => {
      await go(page, path, lang);
      const q = page.locator('.sgx-tb-acts .sgx-tb-quick');
      expect(await q.evaluate((el) => el.tagName)).toBe('BUTTON');
      await expect(q).toHaveAttribute('aria-label', name);
      await expect(q).toHaveAttribute('aria-controls', 'sgx-qp');
      await expect(q).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(q).toHaveAttribute('aria-expanded', 'false');
      await expect(qp(page)).toHaveAttribute('aria-label', name);
      await expect(qp(page)).toBeHidden();
      await expect(page.locator('#sgx-qp [role="tablist"], #sgx-qp [role="tab"], #sgx-qp [role="tabpanel"], #sgx-qp [data-qp-pages], #sgx-qp .sgx-qp-tile, #sgx-qp [data-nav], #sgx-qp [data-qp-lang], #sgx-qp [data-qp-seg="layout"]')).toHaveCount(0);
      expect(await page.locator('#sgx-qp .sgx-qp-sheet').evaluate((el) => Array.from(el.children).map((c) => c.className))).toEqual(['sgx-th-hrow', 'sgx-th-pals']);
    });
  }
});

test.describe('外观面板：开合', () => {
  for (const path of ['/', '/status/']) {
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
        const hitOf = (sel) => { const b = r(document.querySelector(sel)); const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!h && !!h.closest(sel); };
        const d = document.getElementById('sgx-qp');
        return { iconHit: !!hit && q.contains(hit),
          logoHit: hitOf('.sgx-tb-logo'), aiHit: hitOf('.sgx-tb-ai'), gridHit: hitOf('.sgx-tb-grid'), shieldHit: hitOf('.sgx-tb-shield'), avHit: hitOf('.sgx-tb-av'),
          tb: r(document.querySelector('.sgx-topbar')), dlg: r(d), sheet: r(d.querySelector('.sgx-qp-sheet')),
          scrim: getComputedStyle(d).backgroundColor, rad: getComputedStyle(d.querySelector('.sgx-qp-sheet')).borderTopLeftRadius };
      });
      /* 顶栏在最上面：图标、logo、盾牌、>_、头像、AI 浮钮都还点得到 */
      expect(g.iconHit, '外观图标中心被盖住了').toBe(true);
      expect(g.logoHit).toBe(true);
      expect(g.aiHit).toBe(true);
      expect(g.gridHit).toBe(true);
      expect(g.shieldHit).toBe(true);
      expect(g.avHit).toBe(true);
      /* 2026-11 PR-A 照设计稿（tb4.html pop=1）：不压暗页面——dialog 透明（只接「点外面关」），上沿 = 顶栏下沿 */
      expect(g.scrim).toBe('rgba(0, 0, 0, 0)');
      expect(Math.abs(g.dlg.top - g.tb.bottom)).toBeLessThanOrEqual(1);
      expect(g.dlg.bottom).toBeGreaterThanOrEqual(914);
      /* 实色卡贴着顶栏下沿；手机右缘对齐顶栏内容区（页边距 12px，对齐 PR-B）、宽 260，圆角 14px */
      expect(Math.abs(g.sheet.top - g.tb.bottom)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.sheet.right - (412 - 12))).toBeLessThanOrEqual(1);
      expect(Math.abs(g.sheet.width - 260)).toBeLessThanOrEqual(1);
      expect(g.rad).toBe('14px');
      await expect(page.locator('.sgx-qp-handle, .sgx-qp-clip, .sgx-qp-all')).toHaveCount(0);
      /* 顶栏图标真点得到：再点关闭 */
      await page.locator('.sgx-tb-quick').click();
      await expectClosed(page);
      await expect(page).toHaveURL(path === '/' ? /localhost:\d+\/zh\/$/ : /\/zh\/status\/$/);
      const back = await mainTop(page);
      expect(Math.abs(back.first - before.first)).toBeLessThanOrEqual(0.5);
    });
  }

  test('出现（2026-11 PR-A 照稿：静态实色卡，不再从顶栏后面滑下来）：收起 = 透明，打开 = 不透明、原位', async ({ page }) => {
    await go(page, '/status/');
    await page.evaluate(() => {
      const d = document.getElementById('sgx-qp');
      d.querySelector('.sgx-qp-sheet').style.transition = 'none';
      d.show();
    });
    const m = await page.evaluate(() => {
      const d = document.getElementById('sgx-qp'), sh = d.querySelector('.sgx-qp-sheet');
      return { d: d.getBoundingClientRect().top, s: sh.getBoundingClientRect().top, op: getComputedStyle(sh).opacity, bf: getComputedStyle(sh).backdropFilter };
    });
    expect(m.op).toBe('0');
    expect(m.s).toBeGreaterThanOrEqual(m.d - 5);
    expect(m.bf === 'none' || m.bf === '').toBe(true);
    await page.evaluate(() => document.getElementById('sgx-qp').close());
  });

  test('顶栏 v3 不显示页名（页名胶囊标记还在，给子站脚本和锁屏顶栏用）；开面板也不改它', async ({ page }) => {
    await go(page, '/status/'); /* 进站 v3 L1：/security/ 已删，用状态页 */
    await expect(page.locator('#site-nav .sgx-tb-title')).toHaveText('状态');
    await expect(page.locator('#site-nav .sgx-tb-pill')).toBeHidden();
    await openQp(page);
    await expect(page.locator('#site-nav .sgx-tb-pill')).toBeHidden();
    expect(await page.locator('.sgx-tb-title').getAttribute('data-qp-label')).toBeNull();
  });

  /** 能 Tab 到的面板控件（tabindex ≥ 0、看得见）+ 图标 */
  const tabbables = (page) => page.evaluate(() => [document.querySelector('.sgx-tb-quick')].concat(Array.from(document.querySelectorAll('#sgx-qp a[href], #sgx-qp button:not([disabled])')))
    .filter((el) => el.offsetParent !== null && !el.closest('[inert]') && el.tabIndex >= 0).length);

  test('焦点：打开后在面板里；Tab 在图标 + 面板控件里循环；Esc 关上后回到图标', async ({ page }) => {
    await go(page, '/status/');
    await openQp(page);
    expect(await page.evaluate(() => document.getElementById('sgx-qp').contains(document.activeElement))).toBe(true);
    const allowed = () => page.evaluate(() => {
      const a = document.activeElement;
      return document.getElementById('sgx-qp').contains(a) || a === document.querySelector('.sgx-tb-quick');
    });
    let sawIcon = false;
    /* 一圈 = 图标 + 恢复默认 + 色板 25 = 27 下（调色板 v4 删了 MODE 三段；2026-11-12 加三套浅套） */
    const LOOP = 27;
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
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page.locator('.sgx-tb-quick')).toBeFocused();
  });

  test('互斥：面板开着点 AI 浮钮 → 先关面板，再打开 AI 窗口；反过来也一样；NAVIGATE 同样互斥；都不在历史里留哨兵', async ({ page }) => {
    await go(page, '/status/');
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
    /* NAVIGATE 同样互斥 */
    await openQp(page);
    await page.locator('.sgx-tb-grid').click();
    await expectClosed(page);
    await expect(nav(page)).toHaveAttribute('data-state', 'open');
    await expect(page.locator('#sgx-qp[open], #sgx-ai[open], #sgx-nav[open]')).toHaveCount(1);
    await page.locator('.sgx-tb-quick').click();
    await expect(nav(page)).toBeHidden();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page).toHaveURL(/\/status\/$/);
    await expect.poll(() => page.evaluate(() => !!(history.state && (history.state.sgxQp || history.state.sgxAi || history.state.sgxNav)))).toBe(false);
  });

  test('面板开着点顶栏 logo：先关面板，再跳转（不留哨兵）', async ({ page }) => {
    await go(page, '/');
    await page.goto('/zh/status/', { waitUntil: 'domcontentloaded' });
    await openQp(page);
    await page.locator('.sgx-tb-logo').click();
    await expect(page).toHaveURL(/localhost:\d+\/zh\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/status\/$/);
    await expect(qp(page)).toBeHidden();
  });

  test('点遮罩关闭', async ({ page }) => {
    await go(page, '/status/');
    await openQp(page);
    /* 遮罩在面板下面的正文区（真点击命中 dialog 本身） */
    expect(await page.evaluate(() => document.elementFromPoint(200, 900) === document.getElementById('sgx-qp'))).toBe(true);
    await page.mouse.click(200, 900);
    await expectClosed(page);
    await expect(page).toHaveURL(/\/status\/$/);
  });

  test('点面板里的空白处不关闭', async ({ page }) => {
    await go(page, '/status/');
    await openQp(page);
    /* 面板顶部内边距（MODE 标题上方的空白） */
    const sh = await page.locator('#sgx-qp .sgx-qp-sheet').boundingBox();
    await page.mouse.click(sh.x + sh.width / 2, sh.y + 4);
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
  });

  test('Esc 关闭', async ({ page }) => {
    await go(page, '/status/');
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page).toHaveURL(/\/status\/$/);
  });

  test('系统返回只关面板，停在本页；再返回才离开', async ({ page }) => {
    await go(page, '/');
    await page.goto('/zh/status/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openQp(page);
    await page.goBack();
    await expectClosed(page);
    await expect(page).toHaveURL(/\/status\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/localhost:\d+\/zh\/$/);
  });

  test('刚点开（滑下还没开始）就 Esc / 连点两下：照样关上，之后还能正常打开', async ({ page }) => {
    await go(page, '/status/');
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
    await expect(page).toHaveURL(/\/status\/$/);
  });

  test('减弱动效：开合立刻到位', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, '/status/');
    await page.locator('.sgx-tb-quick').click();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expectClosed(page);
  });

  test('AI 窗口照常工作（共用状态机）：开、Esc 关、焦点回到 AI 浮钮', async ({ page }) => {
    await go(page, '/status/');
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

test.describe('外观面板：内容', () => {
  test('中文：PALETTE 25 套色板 + 恢复默认（调色板 v4：没有 MODE 三段）；默认 terra（深套）', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await expect(page.locator('#sgx-qp .sgx-th-h')).toHaveText(['PALETTE']);
    await expect(page.locator('#sgx-qp [data-qp-mode], #sgx-qp .sgx-th-seg')).toHaveCount(0);
    /* 减弱动效、字体大小已删除（2026-10-23 PR-E） */
    await expect(page.locator('#sgx-qp [data-qp="motion"], #sgx-nav [data-qp="motion"]')).toHaveCount(0);
    await expect(page.locator('[data-qp-seg="font-size"]')).toHaveCount(0);
    /* 25 套七色调色板一个列表（含默认 terra 和普通色板 lake），每行 6 个前景色圆点（f1–f6，2026-11 PR-2 恢复）+ 名字（2026-11-12 起跟页面语言：中文页 zh、英文页 en；读屏同名） */
    await expect(page.locator('#sgx-qp [data-qp-palette]')).toHaveCount(25);
    await expect(page.locator('#sgx-qp .sgx-th-pal .sgx-th-sw u')).toHaveCount(150);
    {
      const sw = await page.locator('#sgx-qp [data-qp-palette="lake"] .sgx-th-sw u').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
      expect(sw).toHaveLength(6);
      expect(new Set(sw).size, '6 个前景色各不相同').toBeGreaterThan(3);
      for (const c of sw) expect(c).not.toBe('rgba(0, 0, 0, 0)');
    }
    /* 2026-11-12 Gray 改设计：名字跟页面语言（中文页 zh），不再是等宽小写英文；顺序先深后浅、段内按色相 */
    await expect(page.locator('#sgx-qp [data-qp-palette="lake"] .sgx-th-name')).toHaveText('湖蓝');
    await expect(page.locator('#sgx-qp [data-qp-palette="terra"] .sgx-th-name')).toHaveText('陶土');
    await expect(page.locator('#sgx-qp .sgx-th-name')).toHaveText(['樱桃', '橘子', '陶土', '琥珀', '抹茶', '山绿', '青碧', '湖蓝', '靛蓝', '紫', '兰紫', '莓果', '蔷薇', '石墨', '干枯玫瑰', '珊瑚', '奶油白', '香槟金', '芥末黄', '柠檬绿', '鼠尾草绿', '浅青', '冰川蓝', '雾霾蓝', '丁香']);
    await expect(page.locator('#sgx-qp [data-qp-palette="lake"]')).toHaveAccessibleName('湖蓝');
    await expect(page.locator('#sgx-qp [data-qp-palette^="x"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveText('reset');
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveAccessibleName('恢复默认');
    await expect(page.locator('#sgx-qp a')).toHaveCount(0);
    await expect(qp(page)).toHaveAccessibleName('外观');
    /* 默认色板（恢复默认置灰，默认 terra 选中；terra 是深套） */
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#sgx-qp [data-qp-palette][aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [data-qp-palette="terra"]')).toHaveAttribute('aria-pressed', 'true');
    /* 选中色板 = 衬底和未选不同 */
    const on = await page.locator('#sgx-qp [data-qp-palette="terra"]').evaluate((el) => getComputedStyle(el).backgroundColor);
    const off = await page.locator('#sgx-qp [data-qp-palette="lake"]').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(on).not.toBe(off);
  });

  test('排版：PALETTE 标题行右端恢复默认、色板列表竖排（面板内滚动）；412 / 360 / 宽屏都不溢出', async ({ page }) => {
    for (const vp of [{ width: 412, height: 915 }, { width: 360, height: 800 }, { width: 1366, height: 768 }]) {
      await page.setViewportSize(vp);
      await go(page, '/status/');
      await openQp(page);
      const g = await page.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
        const q = (s) => document.querySelector(s);
        const sheet = q('#sgx-qp .sgx-qp-sheet');
        return {
          hrow: r(q('#sgx-qp .sgx-th-hrow')), pals: r(q('#sgx-qp .sgx-th-pals')),
          p0: r(q('#sgx-qp [data-qp-palette]')), p1: r(q('#sgx-qp [data-qp-palette]:nth-child(2)')),
          reset: r(q('#sgx-qp [data-qp-reset]')), label: r(q('#sgx-qp .sgx-th-hrow .sgx-th-h')),
          palsScroll: getComputedStyle(q('#sgx-qp .sgx-th-pals')).overflowY,
          over: Array.from(sheet.querySelectorAll('*')).filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto'
            && !el.matches('.sgx-th-name')).map((el) => el.className),
          sheetOver: sheet.scrollWidth > sheet.clientWidth,
        };
      });
      /* 色板竖排、整宽 */
      expect(g.pals.y).toBeGreaterThan(g.hrow.b - 1);
      expect(g.p1.y).toBeGreaterThan(g.p0.b - 1);
      expect(Math.abs(g.p0.w - g.pals.w)).toBeLessThanOrEqual(1);
      expect(g.palsScroll).toBe('auto');
      /* 恢复默认在 PALETTE 标题行右端，与标题竖直居中 */
      expect(g.reset.x).toBeGreaterThan(g.label.r);
      expect(Math.abs(g.reset.y + g.reset.h / 2 - (g.label.y + g.label.h / 2))).toBeLessThanOrEqual(1.5);
      expect(g.sheetOver, `${vp.width}：面板横向溢出`).toBe(false);
      expect(g.over, `${vp.width}：有元素横向溢出`).toEqual([]);
      await page.keyboard.press('Escape');
      await expectClosed(page);
    }
  });

  /* 顶栏 v3 的终端风面板：实色表面（--sgx-surface，不透明、没有毛玻璃），1px 线；默认 terra（深）、紫（深）、奶油白 / 雾霾蓝（浅）都一样（v4：深浅跟调色板） */
  for (const [dark, palette] of [[true, null], [true, 'violet'], [false, 'cream'], [false, 'dustyblue']]) {
    test(`面板底 = 实色表面（${dark ? '暗色' : '亮色'}${palette ? '，调色板 ' + palette : ''}），NAVIGATE 同一个底`, async ({ page }) => {
      await page.addInitScript(([d, p]) => {
        try {
          void d;
          if (p) localStorage.setItem('sgx-palette', p);
        } catch (e) {}
      }, [dark, palette]);
      await go(page, '/');
      await openQp(page);
      const st = await page.evaluate(() => {
        const g = (sel) => {
          const cs = getComputedStyle(document.querySelector(sel));
          return { bg: cs.backgroundColor, bf: cs.backdropFilter || cs.webkitBackdropFilter || 'none' };
        };
        const role = (n) => { const d = document.createElement('div'); d.style.backgroundColor = 'var(' + n + ')'; document.body.appendChild(d);
          const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
        return { sheet: g('#sgx-qp .sgx-qp-sheet'), navSheet: g('#sgx-nav .sgx-qp-sheet'), surface: role('--sgx-surface'),
          pal: document.documentElement.getAttribute('data-palette'), dark: document.documentElement.classList.contains('dark') };
      });
      expect(st.pal).toBe(palette);
      expect(st.dark).toBe(dark);
      expect(st.sheet.bg).toBe(st.surface);
      expect(st.navSheet.bg).toBe(st.surface);
      expect(st.sheet.bf).toBe('none');
    });
  }

  test('英文文案', async ({ page }) => {
    await go(page, '/', 'en');
    await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-label', 'Appearance');
    await openQp(page);
    await expect(page.locator('#sgx-qp .sgx-th-h')).toHaveText(['PALETTE']);
    await expect(page.locator('#sgx-qp .sgx-th-name')).toHaveText(['Cherry', 'Tangerine', 'Terracotta', 'Amber', 'Matcha', 'Forest', 'Teal', 'Lake', 'Indigo', 'Violet', 'Orchid', 'Berry', 'Rose', 'Graphite', 'Dusty Rose', 'Coral', 'Cream', 'Champagne', 'Mustard', 'Lime', 'Sage', 'Aqua', 'Glacier', 'Dusty Blue', 'Lilac']);
    await expect(page.locator('#sgx-qp [data-qp-palette="lake"]')).toHaveAccessibleName('Lake');
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveText('reset');
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveAccessibleName('Reset');
    await expect(qp(page)).toHaveAccessibleName('Appearance');
  });
});

test.describe('外观面板 / NAVIGATE：设置即时生效（和设置同一个 key）', () => {
  test('调色板 v4：深浅跟调色板走——选浅套即时变浅、选深套即时变深，theme-color 跟着换；面板不关；旧 sgx-theme-mode 不起作用', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-theme-mode', 'light'); } catch (e) {} });
    await go(page, '/');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    expect(await ls(page, 'sgx-theme-mode')).toBeNull();
    await openQp(page);
    await page.locator('#sgx-qp [data-qp-palette="dustyblue"]').click();
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#ebf1f5');
    await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'light');
    await expect(qp(page)).toHaveAttribute('data-state', 'open'); /* 不关面板、不刷新 */
    await page.locator('#sgx-qp [data-qp-palette="lake"]').click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#01172b');
    await page.goto('/zh/status/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'lake');
  });

  test('系统深浅变化不影响（没有跟随系统了）', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-palette', 'sage'); } catch (e) {} });
    await go(page, '/status/');
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(100);
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  });

  test('减弱动效 / 字体大小已删除：面板和状态页都没有，旧值不起作用', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-reduced-motion', '1'); localStorage.setItem('sgx-font-size', 'large'); } catch (e) {}
    });
    await go(page, '/status/');
    await openQp(page);
    await expect(page.locator('#sgx-qp [data-qp="motion"], #sgx-nav [data-qp="motion"]')).toHaveCount(0);
    await expect(page.locator('[data-qp-seg="font-size"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page.locator('#seg-font, #row-motion, #sw-motion')).toHaveCount(0);
    expect(await ls(page, 'sgx-reduced-motion')).toBeNull();
    expect(await ls(page, 'sgx-font-size')).toBeNull();
    expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('');
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)reduced-motion(\s|$)/);
  });

  test('调色板：写 sgx-palette，即时换色；刷新保持', async ({ page }) => {
    await go(page, '/status/');
    await openQp(page);
    await page.locator('#sgx-qp [data-qp-palette="forest"]').click();
    expect(await ls(page, 'sgx-palette')).toBe('forest');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'forest');
    await expect(page.locator('#sgx-qp [data-qp-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'forest');
    await openQp(page);
    await expect(page.locator('#sgx-qp [data-qp-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
    /* 恢复默认：forest 时可点；点了回默认 terra（不存 key），按钮置灰， */
    const rs = page.locator('#sgx-qp [data-qp-reset]');
    await expect(rs).toHaveAttribute('aria-disabled', 'false');
    await rs.click();
    expect(await ls(page, 'sgx-palette')).toBeNull();
    await expect(page.locator('html')).not.toHaveAttribute('data-palette', /.+/);
    await expect(rs).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#sgx-qp [data-qp-palette][aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [data-qp-palette="terra"]')).toHaveAttribute('aria-pressed', 'true');
    /* 置灰时点了不动、面板不关；半透明但不隐藏（位置不跳） */
    const box = await rs.boundingBox();
    await rs.click({ force: true });
    expect(await ls(page, 'sgx-palette')).toBeNull();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await expect(rs).toBeVisible();
    /* 2026-11 PR-A 照稿：外观卡的 RESET 置灰 = 三级字色 + 不透明度 .6 */
    await expect.poll(() => rs.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThanOrEqual(0.6);
    expect(await rs.boundingBox()).toEqual(box);
  });

  test('旧自定义主题色（sgx-accent）首帧清掉，不再影响恢复默认', async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('qp-seeded')) { localStorage.setItem('sgx-accent', '#ff6b9d'); localStorage.setItem('sgx-accent-css', 'v7|#ff6b9d\nX'); sessionStorage.setItem('qp-seeded', '1'); } } catch (e) {} });
    await go(page, '/');
    expect(await ls(page, 'sgx-accent')).toBeNull();
    expect(await ls(page, 'sgx-accent-css')).toBeNull();
    await expect(page.locator('style#sgx-accent-roles')).toHaveCount(0);
    await openQp(page);
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveAttribute('aria-disabled', 'true');
  });

  test('NAVIGATE layout：Mobile / Auto / DeX 三档都能选（2026-11-09 Auto 在中间）；写 sgx-layout（auto / phone / desktop），即时套用', async ({ page }) => {
    await go(page, '/status/');
    await openNav(page);
    const seg = page.locator('#sgx-nav [data-qp-seg="layout"]');
    await expect(seg.locator('button')).toHaveText(['Mobile', 'Auto', 'DeX']);
    for (const v of ['phone', 'auto', 'desktop']) await expect(seg.locator(`[data-v="${v}"]`)).toBeEnabled();
    await expect(seg.locator('[data-v="dex"], [data-v="mobile"], [data-v="pc"]')).toHaveCount(0);
    await expect(seg.locator('[data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
    await seg.locator('[data-v="desktop"]').click();
    expect(await ls(page, 'sgx-layout')).toBe('desktop');
    await expect(seg.locator('[data-v="desktop"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'desktop');
    await seg.locator('[data-v="phone"]').click();
    expect(await ls(page, 'sgx-layout')).toBe('phone');
    await expect(seg.locator('[data-v="phone"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(seg.locator('[data-v="auto"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'phone');
    await seg.locator('[data-v="auto"]').click();
    expect(['auto', null]).toContain(await ls(page, 'sgx-layout'));
    await expect(seg.locator('[data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(seg.locator('[data-v="auto"]')).toHaveText('Auto');
    await expect(nav(page)).toHaveAttribute('data-state', 'open');
  });

  test('桌面布局：外观面板宽 260（2026-11 PR-A 照稿）、NAVIGATE 宽 360，都靠右落在各自按钮下面；layout 选 Mobile 立即换成手机布局，回 Auto = 桌面', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await go(page, '/status/');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'desktop');
    /* 顶栏内容区：1366 宽时 = 居中的 1080 */
    const acts = await page.locator('.sgx-tb-acts').boundingBox();
    expect(Math.abs(acts.x + acts.width - (1366 - (1366 - 1080) / 2))).toBeLessThanOrEqual(1);
    await openQp(page);
    const q = await page.locator('#sgx-qp .sgx-qp-sheet').boundingBox();
    expect(Math.abs(q.width - 260)).toBeLessThanOrEqual(1);
    expect(Math.abs(q.x + q.width - (acts.x + acts.width - 92))).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await openNav(page);
    const n = await page.locator('#sgx-nav .sgx-qp-sheet').boundingBox();
    expect(Math.abs(n.width - 360)).toBeLessThanOrEqual(1);
    expect(Math.abs(n.x + n.width - (acts.x + acts.width - 44))).toBeLessThanOrEqual(1);
    await page.locator('#sgx-nav [data-qp-seg="layout"] [data-v="phone"]').click();
    expect(await ls(page, 'sgx-layout')).toBe('phone');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'phone');
    await page.locator('#sgx-nav [data-qp-seg="layout"] [data-v="auto"]').click();
    expect(['auto', null]).toContain(await ls(page, 'sgx-layout'));
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'desktop'); /* 桌面 UA、宽 ≥ 720 → 自动 = 桌面 */
  });

  test('NAVIGATE lang：EN / Auto / 中文 分段（语言名用它自己的写法，Auto 在中间）；选 EN 写 sgx-lang=en，关面板后去英文同一页，不在历史里多留一步', async ({ page }) => {
    await go(page, '/');
    await page.goto('/zh/status/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openNav(page);
    const seg = page.locator('#sgx-nav [data-qp-langs]');
    await expect(seg).toHaveAttribute('role', 'radiogroup');
    await expect(seg.locator('[role="radio"]')).toHaveText(['EN', 'Auto', '中文']);
    await expect(seg.locator('[role="radio"]').nth(1)).toHaveAttribute('data-qp-lang', 'system');
    await expect(seg.locator('[aria-checked="true"]')).toHaveAttribute('data-qp-lang', 'zh');
    /* 行内分段，不是底部弹出窗口 */
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await seg.locator('[data-qp-lang="en"]').click();
    await expect(page).toHaveURL(/localhost:\d+\/status\/$/);
    expect(await ls(page, 'sgx-lang')).toBe('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#site-nav .sgx-tb-title')).toHaveText('Status');
    await page.goBack();
    /* 回到进子页之前的主页（语言偏好已是英文，主页 /zh/ replace 到 /） */
    await expect(page).toHaveURL(/localhost:\d+\/(zh\/)?$/);
  });

  test('NAVIGATE lang：选和本页相同的语言 = 只保存、不跳页、面板不关；键盘 ← → 在三段间移动（不保存）', async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('qp-lang-seeded')) { localStorage.setItem('sgx-lang', 'zh'); sessionStorage.setItem('qp-lang-seeded', '1'); } } catch (e) {} });
    await blockExternalRequests(page);
    await freezeTime(page);
    await page.goto('/zh/status/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
    await openNav(page);
    const seg = page.locator('#sgx-nav [data-qp-langs]');
    await seg.locator('[data-qp-lang="zh"]').click();
    await expect(nav(page)).toHaveAttribute('data-state', 'open');
    await expect(page).toHaveURL(/\/zh\/status\/$/);
    expect(await ls(page, 'sgx-lang')).toBe('zh');
    await seg.locator('[data-qp-lang="zh"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(seg.locator('[data-qp-lang="en"]')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(seg.locator('[data-qp-lang="zh"]')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(seg.locator('[data-qp-lang="system"]')).toBeFocused();
    expect(await ls(page, 'sgx-lang')).toBe('zh');
    await expect(nav(page)).toHaveAttribute('data-state', 'open');
  });

  test('NAVIGATE 没有 lock 了（v5 S6），v6 P4 也没有 share 了（分享磁贴拿掉，Gray 11-11 17:47）；上锁走终端 lock', async ({ page }) => {
    await go(page, '/', 'zh', false);
    await openNav(page);
    await expect(ctl(page, 'lock')).toHaveCount(0);
    await expect(ctl(page, 'share')).toHaveCount(0);
    await expect(page.locator('#sgx-nav [data-qp-lock-state], #sgx-nav [data-sgx-share], #sgx-nav .sgx-nav-act')).toHaveCount(0);
  });

  test('P4-3 PR-4b：面板里没有齿轮和设置项，顶栏没有「设置」标签；对齐 PR-B 起主页没有分类入口；2026-11-12 起从 NAVIGATE STATUS 按钮进状态页', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await expect(page.locator('#sgx-qp a')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-nav="settings"], #sgx-nav [data-nav="settings"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page.locator('.sgx-tb-tab, .sgx-tb-tabs')).toHaveCount(0);
    await expect(page.locator('.home-wrap [aria-label="分类"]')).toHaveCount(0);
    await openNav(page);
    await page.locator('#sgx-nav .sgx-nav-st-go[href="/zh/status/"]').click();
    await expect(page).toHaveURL(/\/zh\/status\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/localhost:\d+\/zh\/$/);
  });
});

test.describe('AI 窗口（2026-11-04 P5-1，方案 5.5）', () => {
  const ai = (page) => page.locator('#sgx-ai');
  /* 2026-11 PR-5（设计稿 ai-v1）：窗口打开时还会 GET /api/ai 读模型列表（头部模型胶囊）。下面各用例的 /api/ai 替身只管 POST 提问：
     GET 一律回 404（胶囊不显示），不进替身、不算进提问次数 */
  test.beforeEach(async ({ page }) => {
    const orig = page.route.bind(page);
    page.route = (url, handler, opts) => orig(url, url === '**/api/ai' ? (r, req) => (r.request().method() === 'GET' ? r.fulfill({ status: 404, body: '' }) : handler(r, req)) : handler, opts);
  });
  async function openAi(page) {
    await page.locator('.sgx-tb-ai').click();
    await expect(ai(page)).toHaveAttribute('data-state', 'open');
    await page.waitForFunction(() => document.getElementById('sgx-ai').getAnimations({ subtree: true }).every((a) => a.playState !== 'running'));
  }
  /* 2026-11-06 起服务端不再发 event: hits；hits 非空时照旧版服务端那样先发一条，用来验证前端不渲染来源卡片 */
  const sse = (hits, deltas) => (hits && hits.length ? ['event: hits\ndata: ' + JSON.stringify({ hits }) + '\n\n'] : [])
    .concat(deltas.map((t) => 'event: delta\ndata: ' + JSON.stringify({ text: t }) + '\n\n'), ['event: done\ndata: {}\n\n']).join('');

  test('手机悬浮卡（2026-11-08 起从浮钮展开，展开过程见 ai-open.spec.js；非模态）：顶栏下 12、左右 12；标题 Gray AI、开场白、新对话 / 历史 / 联系、输入框、范围小字', async ({ page }) => {
    await go(page, '/status/');
    await openAi(page);
    expect(await ai(page).evaluate((el) => el.open && !el.matches(':modal'))).toBe(true);
    const g = await page.evaluate(() => {
      const tb = document.querySelector('.sgx-topbar').getBoundingClientRect();
      const sh = document.querySelector('#sgx-ai .sgx-qp-sheet').getBoundingClientRect();
      return { tbBottom: tb.bottom, top: sh.top, left: sh.left, right: sh.right, vw: window.innerWidth, bottom: sh.bottom, vh: window.innerHeight };
    });
    expect(Math.abs(g.top - g.tbBottom - 12)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.left - 12)).toBeLessThanOrEqual(1); /* 对齐 PR-B：手机页边距 12 */
    expect(Math.abs(g.vw - g.right - 12)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.vh - g.bottom - 12)).toBeLessThanOrEqual(1); /* 悬浮卡下沿离底 12（盖住浮钮位置，浮钮淡出） */
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
    await expect(ai(page).locator('.sgx-ai-foot [data-ai-contact]')).toHaveText('styrigx@gmail.com');
    await expect(ai(page).locator('.sgx-ai-foot [data-ai-contact]')).toHaveAttribute('title', '联系我');
    await expect(ai(page).locator('[data-ai-contact]')).toHaveAttribute('href', 'mailto:styrigx@gmail.com');
    await expect(ai(page).locator('[data-ai-in]')).toHaveAttribute('maxlength', '200');
    await expect(ai(page).locator('[data-ai-scope]')).toHaveText('仅公开内容');
    await expect(ai(page).locator('[data-ai-clear]')).toBeDisabled();
    expect(await page.evaluate(() => document.getElementById('sgx-ai').contains(document.activeElement))).toBe(true);
  });

  test('tty4（终端统一 T6c；v5 S5 AI 窗口不动）：$ 开头 = 命令，走终端的命令表，不发 /api/ai、不进 AI 历史；↑ 翻命令历史（sgx-term-hist-4）；Tab 补全；clear 清掉命令输出', async ({ page }) => {
    await go(page, '/status/');
    let posts = 0;
    await page.route('**/api/ai', async (route) => { if (route.request().method() === 'POST') posts++; await route.fallback(); });
    await openAi(page);
    const inp = ai(page).locator('[data-ai-in]');
    await inp.fill('$ pwd');
    await inp.press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-term][data-role="user"]').last()).toHaveText('$ pwd');
    await expect(ai(page).locator('.sgx-ai-msg[data-term][data-role="assistant"]').last()).toHaveText('~');
    /* 要输入 / 验证的命令（su …；v6 P4 起旧 sudo styrigx 删了）在 AI 窗口里不跑，提示去终端 */
    await inp.fill('$ su styrigx');
    await inp.press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-term][data-role="assistant"]').last()).toHaveText('su styrigx：请在终端里运行（Ctrl K）');
    await inp.fill('$');
    await inp.press('ArrowUp');
    await expect(inp).toHaveValue('$ su styrigx');
    await inp.fill('$ pw');
    await inp.press('Tab');
    await expect(inp).toHaveValue('$ pwd');
    await inp.fill('$ clear');
    await inp.press('Enter');
    await expect(ai(page).locator('[data-term]')).toHaveCount(0);
    expect(posts).toBe(0);
    const h = await page.evaluate(() => [sessionStorage.getItem('sgx-term-hist-4'), localStorage.getItem('sgx-ai-history')]);
    expect(JSON.parse(h[0])).toEqual(['pwd', 'su styrigx', 'clear']);
    expect(h[1] || '').not.toContain('pwd');
  });

  test('问一句：POST /api/ai（问题 + 语言 + 历史），流式回答（不显示来源卡片，旧服务端发了 hits 也不显示）；范围按响应头；历史只存本地 sgx-ai-history', async ({ page }) => {
    await go(page, '/status/');
    let body = null;
    await page.route('**/api/ai', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Styrigx-AI-Scope': 'private' },
        body: sse([{ site: 'blog', title: 'AI 代理协作开发规范白皮书', url: '/blog/post/2026-10-11-agent-collaboration-whitepaper-v2/' }, { title: '外站', url: 'https://evil.example/' }], ['Muse 是', '协作代理。']) });
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
    await page.goto('/zh/status/', { waitUntil: 'domcontentloaded' });
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

  test('2026-11 AI 语义召回：回答按有限 Markdown 渲染（粗体 / 列表 / 链接，HTML 当文字）；站内链接同页、站外新标签 rel=noopener、虚下划线 + ↗；联网来源列在回答下', async ({ page }) => {
    await go(page, '/status/');
    await page.route('**/api/ai', async (route) => {
      const body = ['**锁屏**在设置里。<img src=x onerror="window.__xss=1">\n\n', '- [锁屏凭证](/security/lock/)\n', '- [外站文档](https://example.org/docs)\n', '- [坏](javascript:void0)']
        .map((t) => 'event: delta\ndata: ' + JSON.stringify({ text: t }) + '\n\n').join('')
        + 'event: sources\ndata: ' + JSON.stringify({ items: [{ title: 'example.org', url: 'https://example.org/a' }] }) + '\n\n'
        + 'event: done\ndata: {}\n\n';
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body });
    });
    await openAi(page);
    await ai(page).locator('[data-ai-in]').fill('锁屏怎么开');
    await ai(page).locator('[data-ai-in]').press('Enter');
    const md = ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span.sgx-ai-md');
    await expect(md.locator('strong')).toHaveText('锁屏');
    await expect(md.locator('img')).toHaveCount(0);
    await expect(md.locator('p').first()).toContainText('<img src=x onerror="window.__xss=1">');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    const links = md.locator('a.sgx-ai-link');
    await expect(links).toHaveCount(3);
    const inner = links.nth(0);
    await expect(inner).toHaveAttribute('href', '/security/lock/');
    expect(await inner.getAttribute('target')).toBe(null);
    await expect(inner.locator('.sgx-ai-link-icon')).toHaveText('↗');
    expect(await inner.locator('.sgx-ai-link-text').evaluate((el) => getComputedStyle(el).textDecorationStyle)).toBe('dotted');
    const ext = links.nth(1);
    await expect(ext).toHaveAttribute('target', '_blank');
    await expect(ext).toHaveAttribute('rel', 'noopener');
    await expect(md).toContainText('坏');
    await expect(md.locator('a[href^="javascript"]')).toHaveCount(0);
    /* 联网来源：追加成「来源」列表，随回答存进历史 */
    await expect(md).toContainText('来源');
    await expect(links.nth(2)).toHaveAttribute('href', 'https://example.org/a');
    const h = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h.chats[0].msgs[1].text).toContain('来源\n- [example.org](https://example.org/a)');
    /* 站内链接：关窗口后同页跳转 */
    await inner.click();
    await expect(page).toHaveURL(/\/security\/lock\/$/);
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
    await go(page, '/status/');
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

  for (const [status, err, want] of [[429, 'cooldown', '问得太快了，请一分钟后再试'], [429, 'busy', '现在问的人太多，请稍后再试'], [401, 'session', '登录后才能问：su'], [502, 'upstream', '没能拿到回答，请稍后再试']]) {
    test(`出错：${status} ${err} → 「${want}」，不进历史`, async ({ page }) => {
      await go(page, '/status/');
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

  test('P4-2d：账号页选过模型（sgx-ai-model）→ 发问带上 body.model（2026-11 PR-5 起窗口头部有模型胶囊，读不到模型列表时不显示）', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-ai-model', '@cf/openai/gpt-oss-20b'); } catch (e) {} });
    await go(page, '/status/');
    const bodies = [];
    await page.route('**/api/ai', async (route) => {
      const b = route.request().postDataJSON();
      bodies.push(b);
      await okSse(route, b.model || 'default');
    });
    await openAi(page);
    await expect(ai(page).locator('select')).toHaveCount(0);
    await expect(ai(page).locator('[data-ai-model]')).toBeHidden();
    await expect(ai(page).locator('[data-ai-models]')).toBeHidden();
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('好的。');
    expect(bodies).toEqual([{ q: '你好', lang: 'zh', history: [], model: '@cf/openai/gpt-oss-20b' }]);
    expect(await ls(page, 'sgx-ai-model')).toBe('@cf/openai/gpt-oss-20b');
  });

  test('P4-2d：选的模型被下架 → 400 bad_model：清掉本地选择、不带 model 自动重发一次，回答照常', async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('sgx-ai-model', '@cf/gone/model'); } } catch (e) {} });
    await go(page, '/status/');
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
    await go(page, '/status/');
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
    await go(page, '/status/');
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
    await go(page, '/status/');
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
    await go(page, '/status/');
    await page.route('**/api/ai', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['好的。']) }));
    await openAi(page);
    expect((await geo(page)).focused).toBe(true);
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('好的。');
    expect((await geo(page)).focused).toBe(true);
  });

  test('P4-3 后续 §4：桌面鼠标点发送，焦点回输入框；回答中和答完直接打字都进输入框', async ({ page }) => {
    await go(page, '/status/');
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
      await go(page, '/status/');
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
    await go(page, '/status/');
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
    await page.goto('/zh/status/', { waitUntil: 'domcontentloaded' });
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
    await go(page, '/status/');
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
    await go(page, '/status/');
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
    await page.goto('/zh/status/', { waitUntil: 'domcontentloaded' });
    await openAi(page);
    await expect(ai(page).locator('.sgx-ai-ops').first().locator('[data-op="up"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('P4-3 PR-3：回答进行中发送按钮变停止，点它中断；回车不中断；停下后变回发送', async ({ page }) => {
    await go(page, '/status/');
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
    await go(page, '/status/', 'en');
    await openAi(page);
    await expect(ai(page)).toHaveAccessibleName('Ask AI');
    await expect(ai(page).locator('.sgx-ai-title')).toHaveText('Gray AI');
    await expect(ai(page).locator('.sgx-ai-msg[data-greet]')).toHaveText("Hi, I'm Gray's AI assistant. Ask about this site, or talk through whatever you're working on.");
    await expect(ai(page).locator('[data-ai-scope]')).toHaveText('Public content only');
    await expect(ai(page).locator('.sgx-ai-head [data-ai-clear]')).toHaveAttribute('aria-label', 'New chat');
    await expect(ai(page).locator('.sgx-ai-head [data-ai-history]')).toHaveAttribute('aria-label', 'History');
    await expect(ai(page).locator('[data-ai-contact]')).toHaveAttribute('title', 'Contact me');
    await ai(page).locator('[data-ai-history]').click();
    await expect(ai(page).locator('[data-ai-hist]')).toHaveText('No past chats yet');
  });
});

/* 2026-10-21 品牌：站名 = 内联 SVG 字标（可访问名 Styrigx）；i 上的圆点跟主题色（--sgx-primary），字母跟 --sgx-text-primary：
   默认色板（2026-11 PR-A 起 terra）亮 / 暗、forest（含旧撞色 id xforest 迁移）都对。2026-11-04 P5-1：字标从抽屉头搬到顶栏 logo（20px 高）。
   标签页 SVG 图标：默认色板用静态 /favicon.svg，换色板后换成主题色的 data: 图标。 */
test.describe('顶栏 logo 字标 + 标签页图标跟主题色', () => {
  const CASES = [
    /* 调色板 v4：每套只有一个模式（terra / forest 深套，dustyblue 浅套） */
    { name: '默认 terra（深套）', pal: null, dark: true },
    { name: 'forest（存的是旧撞色 xforest，首屏迁到 forest）', store: 'xforest', pal: 'forest', dark: true },
    { name: '雾霾蓝 dustyblue（浅套）', pal: 'dustyblue', dark: false },
  ];
  for (const c of CASES) {
    test(`${c.name}：终端字标 ❯ styrigx :~$_ 渲染，❯ / 光标 = --sgx-primary、名字 = --sgx-text-primary`, async ({ page }) => {
      await page.addInitScript((o) => {
        try {
          if (o.store || o.pal) localStorage.setItem('sgx-palette', o.store || o.pal);
        } catch (e) {}
      }, c);
      /* helpers 的拦截会把带 favicon 的地址换成占位 PNG；这里放行真的 /favicon.svg（后注册的路由优先） */
      await blockExternalRequests(page);
      await page.route('**/favicon.svg', (r) => r.continue());
      await freezeTime(page);
      await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
      await page.goto('/zh/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
      const logo = page.locator('.sgx-tb-logo');
      await expect(logo).toHaveAccessibleName('Styrigx 首页');
      /* 2026-11 PR-2（Gray）：字标 = ❯ + SVG 字标 + 光标；没有 :~$ */
      await expect(logo.locator('.sgx-tb-name svg.sgx-wordmark')).toHaveCount(1);
      await expect(logo.locator('.sgx-tb-tl')).toHaveCount(0);
      const m = await page.evaluate(() => {
        const q = (s) => document.querySelector('.sgx-tb-logo ' + s);
        const probe = document.createElement('i');
        probe.style.cssText = 'position:absolute;color:var(--sgx-primary);background:var(--sgx-text-primary)';
        document.body.appendChild(probe);
        const cs = getComputedStyle(probe);
        const out = { ps: getComputedStyle(q('.sgx-tb-ps')).color, cu: getComputedStyle(q('.sgx-tb-cu')).backgroundColor, name: getComputedStyle(q('.sgx-tb-name')).color,
          anim: getComputedStyle(q('.sgx-tb-cu')).animationDuration, mono: getComputedStyle(q('.sgx-tb-name')).fontFamily,
          dot: getComputedStyle(q('.sgx-tb-name .wm-dot')).fill, letters: getComputedStyle(q('.sgx-tb-name .wm-letters')).fill,
          primary: cs.color, text: cs.backgroundColor,
          pal: document.documentElement.getAttribute('data-palette'), dark: document.documentElement.classList.contains('dark') };
        probe.remove();
        return out;
      });
      expect(m.pal).toBe(c.pal);
      expect(m.dark).toBe(c.dark);
      expect(m.ps).toBe(m.primary);
      expect(m.cu).toBe(m.primary);
      expect(m.name).toBe(m.text);
      /* SVG 字标：字母 = 正文色（currentColor），i 上的圆点跟主题色 */
      expect(m.letters).toBe(m.text);
      expect(m.dot).toBe(m.primary);
      expect(m.anim).toBe('1.05s');
      expect(m.mono).toMatch(/monospace/);
      /* SVG 图标：默认色板亮色用静态文件，其他换成主题色 data: 地址 */
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
    for (const p of ['/bookmarks/', '/zh/bookmarks/']) {
      const r = await page.request.get(p);
      expect(r.status(), p).not.toBe(200);
    }
  });
});
