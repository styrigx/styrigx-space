/**
 * 主站顶栏三栏左右滑切换（2026-10-24，shell/tab-swipe.js；手感同子站 daymark / curio / blog）。
 * 2026-10-24 PR4：三栏是 主页 / 聊天 / 设置（设置占了原来「状态」的位置），滑动顺序跟着变。
 * 2026-11-04 P5-1：去掉「聊天」，只剩 主页 / 设置两栏，左右滑只在两栏间切换。
 * 手机模拟（412×915、hasTouch），用 CDP Input.dispatchTouchEvent 发真实的触摸序列。
 * 运行：npx playwright test --config=tests/config/playwright.config.js tab-swipe.spec.js（测试构建，锁屏禁用）
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');

test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await page.route('**/api/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' }));
});

/** 从 (x0,y0) 滑到 (x1,y1)，steps 步、总时长约 ms */
async function swipe(page, x0, y0, x1, y1, ms = 200, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) });
  for (let i = 1; i <= steps; i++) {
    // TODO(C8): 手势节奏（touchMove 之间的真实间隔；shell/tab-swipe.js 用 Date.now() 判 MAX_MS），不是等某个状态，没有可替代的条件，保留。
    await page.waitForTimeout(ms / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const cur = (page) => page.locator('.sgx-tb-tab[aria-current="page"]');

test('主页左滑 → 设置，药丸跟过去；设置再左滑（最后一栏）不动；设置右滑 → 回主页；主页再右滑（第一栏）不动', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(cur(page)).toHaveAttribute('data-tab', 'home');
  expect(await page.locator('.sgx-tb-tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-tab')))).toEqual(['home', 'settings']);
  await swipe(page, 300, 500, 120, 510);
  await page.waitForURL('**/settings/');
  await expect(cur(page)).toHaveAttribute('data-tab', 'settings');
  await swipe(page, 300, 500, 100, 500);
  // TODO(C8): 「滑了不动」是静默窗口：touchend 判定通过时 goTab() 可能先异步取栏 / 模块再切（inpage-tabs.js go()），
  // 「手势被拒、不会切」在页面上不留可观察状态；要确定性需在生产代码加标记。保留原等待。
  await page.waitForTimeout(600);
  expect(new URL(page.url()).pathname, '最后一栏左滑不动').toBe('/settings/');
  await swipe(page, 120, 400, 320, 390);
  await page.waitForURL((u) => u.pathname === '/');
  await expect(cur(page)).toHaveAttribute('data-tab', 'home');
  await swipe(page, 120, 300, 320, 290);
  // TODO(C8): 同上，静默窗口。保留原等待。
  await page.waitForTimeout(600);
  expect(new URL(page.url()).pathname, '第一栏右滑不动').toBe('/');
});

test('不抢的手势：边缘起手、竖着滑、太短、输入框里、可横向滚动的容器里、弹层打开时', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const stay = async (label) => {
    // TODO(C8): 同上，静默窗口（手势被拒没有可观察状态）。保留原等待。
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname, label).toBe('/');
    await expect(cur(page), label).toHaveAttribute('data-tab', 'home');
  };
  await swipe(page, 405, 500, 200, 500);
  await stay('右边缘起手');
  await swipe(page, 300, 300, 200, 600);
  await stay('竖着滑（角度不够）');
  await swipe(page, 300, 500, 250, 500);
  await stay('太短');
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'hs';
    d.style.cssText = 'position:fixed;left:40px;top:400px;width:300px;height:80px;overflow-x:auto;z-index:50;background:#ccc';
    d.innerHTML = '<div style="width:1200px;height:60px"></div>';
    document.body.appendChild(d);
  });
  await swipe(page, 300, 440, 100, 440);
  await stay('横向滚动容器');
  await page.evaluate(() => { document.getElementById('hs').remove(); const dl = document.createElement('dialog'); dl.id = 'tdlg'; dl.textContent = 'x'; document.body.appendChild(dl); dl.showModal(); });
  await swipe(page, 300, 700, 100, 700);
  await stay('弹层打开');
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById('tdlg')).close());

  /* 输入框里（原来量的是聊天页输入框；2026-11-04 P5-1 起 /chat/ 不在标签里，改在主页上放一个输入框） */
  await page.evaluate(() => {
    const t = document.createElement('textarea');
    t.id = 'tin';
    t.style.cssText = 'position:fixed;left:20px;top:600px;width:372px;height:60px;z-index:50';
    document.body.appendChild(t);
  });
  const box = await page.locator('#tin').boundingBox();
  await swipe(page, box.x + box.width - 10, box.y + box.height / 2, box.x + 10, box.y + box.height / 2);
  await stay('输入框');
});
