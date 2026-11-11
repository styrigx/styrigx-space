/**
 * AI 窗口打开方式（Gray 2026-11-08 16:14 定，参照 Mouzan 站录屏；设计稿 ai-v1 之后讨论定的，以讨论为准）：
 * - 从右下 AI 浮钮展开、向左上长出：transform-origin 在窗口右下、对着浮钮中心；scale + opacity 240ms ease-out；关闭反向收回。电脑手机同一个动作。
 * - 手机：悬浮终端卡片——左右留 12px 页边距（同 #319），上沿在顶栏下 12px，下沿在底部 12px（盖住浮钮的位置，浮钮淡出缩小）；背景轻微变暗、点了只关窗口。
 * - 电脑：浮钮上方 390 × 560 浮窗（不压暗），浮钮变关闭态（再点 = 关）。
 * - 减弱动效：不缩放，只短淡入淡出。
 * - Esc / × / 点外部关闭，焦点回浮钮；Tab 圈不落到藏起来的浮钮上。
 * 窗口内容、功能见 quick-panel.spec.js「AI 窗口」组与 ai-window.spec.js。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

async function go(page, path) {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  /* 模型列表（GET /api/ai）回 404：头部不显示模型胶囊，和这里要验的东西无关 */
  await page.route('**/api/ai', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}
const ai = (page) => page.locator('#sgx-ai');
const fab = (page) => page.locator('.sgx-tb-ai');
const idle = (page) => page.waitForFunction(() => document.getElementById('sgx-ai').getAnimations({ subtree: true }).every((a) => a.playState !== 'running')
  && document.querySelector('.sgx-tb-ai').getAnimations().every((a) => a.playState !== 'running'));

/** 点浮钮：在 is-open 加上的那一刻（MutationObserver，同一帧内）量展开原点（不受 scale 影响的窗口框 + 计算后的 transform-origin）离浮钮中心多远、正在跑的过渡 */
async function clickAndProbe(page) {
  await page.evaluate(() => {
    const dlg = document.getElementById('sgx-ai');
    window.__aiProbe = new Promise((res) => {
      const mo = new MutationObserver(() => {
        if (!dlg.classList.contains('is-open')) return;
        mo.disconnect();
        const sh = /** @type {HTMLElement} */ (dlg.querySelector('.sgx-qp-sheet'));
        const d = dlg.getBoundingClientRect();
        const b = document.querySelector('.sgx-tb-ai').getBoundingClientRect();
        const cs = getComputedStyle(sh);
        const [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat);
        const left = d.left + sh.offsetLeft;
        const top = d.top + sh.offsetTop;
        const anims = sh.getAnimations();
        const props = anims.map((a) => /** @type {any} */ (a).transitionProperty).filter(Boolean);
        const tr = anims.find((a) => /** @type {any} */ (a).transitionProperty === 'transform');
        const kf = tr && tr.effect ? /** @type {any} */ (tr.effect).getKeyframes() : [];
        res({ dx: left + ox - (b.left + b.width / 2), dy: top + oy - (b.top + b.height / 2), props, from: kf.length ? kf[0].transform : '',
          ease: tr ? tr.effect.getTiming().easing : '', dur: tr ? tr.effect.getTiming().duration : 0, transform: cs.transform });
      });
      mo.observe(dlg, { attributes: true, attributeFilter: ['class'] });
    });
  });
  await fab(page).click();
  return page.evaluate(() => window.__aiProbe);
}

test.describe('AI 窗口从浮钮展开（2026-11-08）', () => {
  test('手机 390 深色：从浮钮向左上展开（原点 = 浮钮中心、scale + opacity、ease-out 240ms），悬浮卡左右留 12px、浮钮淡出；× 关、焦点回浮钮', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await go(page, '/zh/status/');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'phone');
    const p = await clickAndProbe(page);
    expect(Math.abs(p.dx)).toBeLessThanOrEqual(2);
    expect(Math.abs(p.dy)).toBeLessThanOrEqual(2);
    expect(p.props).toEqual(expect.arrayContaining(['transform', 'opacity']));
    expect(p.from).toMatch(/scale\(0\.2\)|matrix\(0\.2, 0, 0, 0\.2/);
    expect(p.dur).toBe(240);
    expect(p.ease).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)');
    await expect(ai(page)).toHaveAttribute('data-state', 'open');
    await idle(page);
    const g = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const sh = r('#sgx-ai .sgx-qp-sheet');
      return { vw: window.innerWidth, vh: window.innerHeight, tb: r('.sgx-topbar').bottom, left: sh.left, right: sh.right, top: sh.top, bottom: sh.bottom,
        radius: getComputedStyle(document.querySelector('#sgx-ai .sgx-qp-sheet')).borderTopLeftRadius,
        bg: getComputedStyle(document.getElementById('sgx-ai')).backgroundColor, fabVis: getComputedStyle(document.querySelector('.sgx-tb-ai')).visibility,
        fabOp: getComputedStyle(document.querySelector('.sgx-tb-ai')).opacity };
    });
    /* 悬浮卡：左右 12（同 #319 页边距），顶栏下 12，底部 12（盖过浮钮的位置），圆角 16（稿 ai-v1） */
    expect(Math.abs(g.left - 12)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.vw - g.right - 12)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.top - g.tb - 12)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.vh - g.bottom - 12)).toBeLessThanOrEqual(1);
    expect(g.radius).toBe('16px');
    /* 背景轻微变暗：有遮罩色但半透明（页面看得见） */
    const a = /(?:,|\/)\s*([\d.]+)\)$/.exec(g.bg); /* rgba(… , a) 或 color(srgb … / a) */
    expect(a && parseFloat(a[1])).toBeGreaterThan(0);
    expect(a && parseFloat(a[1])).toBeLessThan(0.5);
    /* 浮钮淡出、藏起来（卡片盖住它的位置） */
    expect(g.fabVis).toBe('hidden');
    expect(g.fabOp).toBe('0');
    /* Tab 圈不落到藏起来的浮钮上 */
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.getElementById('sgx-ai').contains(document.activeElement))).toBe(true);
    }
    await ai(page).locator('[data-ai-close]').click();
    await expect(ai(page)).toBeHidden();
    await expect(fab(page)).toBeFocused();
    await expect(fab(page)).toHaveAttribute('aria-expanded', 'false');
    await idle(page);
    expect(await fab(page).evaluate((el) => getComputedStyle(el).visibility + ' ' + getComputedStyle(el).opacity)).toBe('visible 1');
  });

  test('手机：关闭反向收回浮钮（closing 时还在 scale 过渡里、原点不变）；Esc / 点外部也关，焦点都回浮钮；页面不可交互（点到的是遮罩）', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(page, '/zh/status/');
    await fab(page).click();
    await expect(ai(page)).toHaveAttribute('data-state', 'open');
    await idle(page);
    /* 卡片外、顶栏下：点到的是 dialog（遮罩），不是页面 */
    expect(await page.evaluate(() => { const tb = document.querySelector('.sgx-topbar').getBoundingClientRect(); return document.elementFromPoint(4, tb.bottom + 6).id; })).toBe('sgx-ai');
    await page.keyboard.press('Escape');
    const c = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => {
      const sh = document.querySelector('#sgx-ai .sgx-qp-sheet');
      res({ st: document.getElementById('sgx-ai').getAttribute('data-state'), props: sh.getAnimations().map((a) => a.transitionProperty) });
    })));
    expect(c.st).toBe('closing');
    expect(c.props).toEqual(expect.arrayContaining(['transform', 'opacity']));
    await expect(ai(page)).toBeHidden();
    await expect(fab(page)).toBeFocused();
    await fab(page).click();
    await expect(ai(page)).toHaveAttribute('data-state', 'open');
    await idle(page);
    await page.mouse.click(4, 300);
    await expect(ai(page)).toBeHidden();
    await expect(fab(page)).toBeFocused();
  });

  test('电脑 1280：浮钮上方 390 × 560，从浮钮展开（原点 = 浮钮中心）；不压暗；浮钮变关闭态，再点浮钮收回、焦点回浮钮', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/status/');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'desktop');
    const p = await clickAndProbe(page);
    expect(Math.abs(p.dx)).toBeLessThanOrEqual(2);
    expect(Math.abs(p.dy)).toBeLessThanOrEqual(2);
    expect(p.props).toEqual(expect.arrayContaining(['transform', 'opacity']));
    await expect(ai(page)).toHaveAttribute('data-state', 'open');
    await idle(page);
    const g = await page.evaluate(() => {
      const sh = document.querySelector('#sgx-ai .sgx-qp-sheet').getBoundingClientRect();
      const b = document.querySelector('.sgx-tb-ai').getBoundingClientRect();
      return { w: sh.width, h: sh.height, right: sh.right, bottom: sh.bottom, fabTop: b.top, fabRight: b.right, bg: getComputedStyle(document.getElementById('sgx-ai')).backgroundColor,
        fabVis: getComputedStyle(document.querySelector('.sgx-tb-ai')).visibility, x: getComputedStyle(document.querySelector('.sgx-tb-ai'), '::after').opacity };
    });
    expect(Math.round(g.w)).toBe(390);
    expect(Math.round(g.h)).toBe(560);
    expect(Math.abs(g.right - g.fabRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.fabTop - g.bottom - 12)).toBeLessThanOrEqual(1);
    expect(g.bg).toBe('rgba(0, 0, 0, 0)');
    expect(g.fabVis).toBe('visible');
    expect(g.x).toBe('1');
    await fab(page).click();
    await expect(ai(page)).toBeHidden();
    await expect(fab(page)).toBeFocused();
    await expect(fab(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('减弱动效：不缩放（transform 一直是 none），只短淡入淡出；开合照常、焦点回浮钮', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, '/zh/status/');
    const p = await clickAndProbe(page);
    expect(p.transform).toBe('none');
    expect(p.props).not.toContain('transform');
    expect(p.props).toContain('opacity');
    await expect(ai(page)).toHaveAttribute('data-state', 'open');
    await idle(page);
    expect(await ai(page).locator('.sgx-qp-sheet').evaluate((el) => getComputedStyle(el).transform + ' ' + getComputedStyle(el).opacity)).toBe('none 1');
    await page.keyboard.press('Escape');
    await expect(ai(page)).toBeHidden();
    await expect(fab(page)).toBeFocused();
  });
});
