/**
 * 顶栏弹层打开时不滚 / 不缩放可视视口（2026-11-07 Gray 真机：S23 Ultra 三星浏览器开「桌面版网站」，点九宫格 / 快捷设置 / AI，
 * 整页突然放大并左移、只看得见面板一角，关掉才恢复）。
 * 根因（本机能复现的那一半）：<dialog>.show() 自带的「对话框聚焦」把 [autofocus] 的面板滚进视野，不能带 preventScroll；
 * 桌面版网站下页面缩小显示，用户放大过（或浏览器给焦点元素做放大）时，这次滚动把可视视口平移到面板那边（offsetLeft 0 → 445）。
 * 修法见 space/web/assets/common/js/ui/modal-sheet.js showDialog：开的那一下 inert，开完自己 focus({ preventScroll: true })。
 * 这里模拟桌面版网站：手机屏 412 + 触屏 + 桌面 UA + 布局视口 980（三星桌面版网站不理 viewport meta，用 980 宽排版），
 * 再用 CDP 把页面放大到 1 倍（只看得见左边 412），打开三个弹层，可视视口的位置 / 缩放都不能变，焦点要在弹层里。
 * 另：弹层里的输入框字号不小于 16px（iOS / 部分安卓浏览器聚焦小于 16px 的输入框会自动放大）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

const DESK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: DESK_UA, colorScheme: 'light' });

/** 三星「桌面版网站」：文档里的 viewport meta 换成 width=980 */
async function desktopSite(page) {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const res = await route.fetch();
    const body = (await res.text()).replace(/<meta name=viewport content="[^"]*">|<meta name="viewport" content="[^"]*">/, '<meta name="viewport" content="width=980">');
    await route.fulfill({ response: res, body });
  });
}

/** Esc 关弹层。终端停在某个输入模式时 Esc 先退出当前命令（^C）、再按才关（term.js），所以最多按 3 次 */
async function escClose(page, dlg) {
  for (let i = 0; i < 3 && await page.locator(dlg).isVisible(); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
  }
  await expect(page.locator(dlg)).toBeHidden();
}

const vv = (page) => page.evaluate(() => ({ scale: Math.round(visualViewport.scale * 100) / 100, left: Math.round(visualViewport.offsetLeft), top: Math.round(visualViewport.offsetTop), x: scrollX, y: scrollY }));

test('桌面版网站 + 放大到 1 倍：打开九宫格 / 快捷设置 / AI，可视视口不平移、不缩放，焦点在弹层里', async ({ page, context }) => {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await desktopSite(page);
  await page.goto('/zh/', { waitUntil: 'load' });
  await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'desktop');
  expect(await page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(980);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await expect.poll(() => page.evaluate(() => Math.round(visualViewport.scale * 100) / 100)).toBe(1);
  const before = await vv(page);
  expect(before.left).toBe(0);
  for (const [btn, dlg] of [['.sgx-tb-grid', '#sgx-nav'], ['.sgx-tb-quick', '#sgx-qp'], ['.sgx-tb-ai', '#sgx-ai'], ['.sgx-tb-av', '#sgx-acct']]) { /* v5 S5：盾牌下拉 #sgx-sec 删了（盾牌打开终端） */
    /* 按钮在放大后的可视视口外（右边），用脚本点（同真机点到之后的那一步：打开 <dialog>） */
    await page.$eval(btn, (b) => /** @type {HTMLElement} */ (b).click());
    await expect(page.locator(dlg)).toBeVisible();
    await page.waitForTimeout(350);
    expect(await vv(page), `${dlg} 打开后可视视口`).toEqual(before);
    expect(await page.evaluate((d) => !!document.activeElement && document.querySelector(d).contains(document.activeElement), dlg), `${dlg} 焦点在弹层里`).toBe(true);
    await escClose(page, dlg);
    expect(await vv(page), `${dlg} 关上后可视视口`).toEqual(before);
  }
});

test('弹层里的输入框字号 ≥ 16px（AI 窗口输入框；小于 16px 聚焦时浏览器会自动放大）', async ({ page }) => {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await page.goto('/zh/', { waitUntil: 'load' });
  await page.locator('.sgx-tb-ai').click();
  await expect(page.locator('#sgx-ai')).toBeVisible();
  const small = await page.evaluate(() => Array.from(document.querySelectorAll('#sgx-nav, #sgx-qp, #sgx-ai')).flatMap((d) => Array.from(d.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select')))
    .map((el) => [el.className, parseFloat(getComputedStyle(el).fontSize)]).filter(([, fs]) => fs < 16));
  expect(small).toEqual([]);
  /* 触屏打开 AI 窗口不自动聚焦输入框（程序化聚焦弹键盘；桌面版网站下浏览器还会放大到输入框） */
  expect(await page.evaluate(() => document.activeElement && document.activeElement.matches('textarea, input'))).toBe(false);
});

/* 2026-11-07 Gray 真机（S23 Ultra 三星浏览器「桌面版网站」）：单点九宫格 / 快捷，打开那 0.5–1 秒面板方框里画出放大约 2.5 倍（≈ 1 / 页面缩放 0.42）的页面右上角和面板内容。
   headless 是软件合成，复现不了这个放大；这里锁住修法：手机屏 + 桌面布局时面板不用毛玻璃（backdrop-filter 要单独合成面）、不做位移滑入（合成器驱动的 transform），只淡入。 */
test('桌面版网站（手机屏 + 桌面布局）：面板打开过程中没有 backdrop-filter / transform，只淡入到不透明', async ({ page }) => {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await desktopSite(page);
  await page.goto('/zh/', { waitUntil: 'load' });
  await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'desktop');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-device', 'phone');
  for (const [btn, dlg] of [['.sgx-tb-grid', '#sgx-nav'], ['.sgx-tb-quick', '#sgx-qp'], ['.sgx-tb-ai', '#sgx-ai'], ['.sgx-tb-av', '#sgx-acct']]) { /* v5 S5：盾牌下拉 #sgx-sec 删了（盾牌打开终端） */
    /* 点下去之后连续取几帧的计算样式（打开动画期间） */
    const samples = await page.evaluate(async ([b, d]) => {
      const sheet = document.querySelector(d + ' .sgx-qp-sheet');
      /** @type {HTMLElement} */ (document.querySelector(b)).click();
      const out = [];
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const cs = getComputedStyle(sheet);
        out.push({ bf: cs.backdropFilter || 'none', wbf: cs.webkitBackdropFilter || 'none', tf: cs.transform });
      }
      return out;
    }, [btn, dlg]);
    for (const s of samples) expect(s, `${dlg} 打开中`).toEqual({ bf: 'none', wbf: 'none', tf: 'none' });
    await expect.poll(() => page.$eval(dlg + ' .sgx-qp-sheet', (el) => getComputedStyle(el).opacity)).toBe('1');
    await escClose(page, dlg);
  }
});

test.describe('电脑', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, colorScheme: 'light' });
  test('不是手机屏：面板照旧滑入；外观 / NAVIGATE（2026-11 PR-1）和 AI 窗口 / 账号 / 安全下拉（PR-5）都是终端风实色', async ({ page }) => {
    await blockExternalRequests(page);
    await freezeTime(page);
    await page.goto('/zh/', { waitUntil: 'load' });
    await expect(page.locator('html')).toHaveAttribute('data-sgx-device', 'desktop');
    const st = (sel) => page.$eval(sel, (el) => ({ bf: getComputedStyle(el).backdropFilter, tp: getComputedStyle(el).transitionProperty }));
    for (const sel of ['#sgx-qp .sgx-qp-sheet', '#sgx-nav .sgx-qp-sheet', '#sgx-ai .sgx-qp-sheet', '#sgx-acct .sgx-qp-sheet']) { /* v5 S5：没有盾牌下拉了 */
      const c = await st(sel);
      expect(c.bf, sel).toBe('none');
      expect(c.tp, sel).toContain('transform');
    }
  });
});
