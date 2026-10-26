/**
 * 主站顶栏三栏左右滑切换（2026-10-24，shell/tab-swipe.js；手感同子站 daymark / curio / blog）。
 * 2026-10-24 PR4：三栏是 主页 / 聊天 / 设置（设置占了原来「状态」的位置），滑动顺序跟着变。
 * 手机模拟（412×915、hasTouch），用 CDP Input.dispatchTouchEvent 发真实的触摸序列。
 * 运行：npx playwright test --config=tests/config/playwright.config.js tab-swipe.spec.js（测试构建，锁屏禁用）
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

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

test('主页左滑 → 聊天，药丸跟过去；聊天左滑 → 设置；设置右滑 → 回聊天；设置再左滑（最后一栏）不动；聊天右滑 → 回主页', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(cur(page)).toHaveAttribute('data-tab', 'home');
  await swipe(page, 300, 500, 120, 510);
  await page.waitForURL('**/chat/');
  await expect(cur(page)).toHaveAttribute('data-tab', 'chat');
  expect(await page.locator('.sgx-tb-tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-tab')))).toEqual(['home', 'chat', 'settings']);
  await swipe(page, 300, 300, 100, 300);
  await page.waitForURL('**/settings/');
  await expect(cur(page)).toHaveAttribute('data-tab', 'settings');
  await swipe(page, 300, 500, 100, 500);
  // TODO(C8): 「滑了不动」是静默窗口：touchend 判定通过时 goTab() 可能先异步取栏 / 模块再切（inpage-tabs.js go()），
  // 「手势被拒、不会切」在页面上不留可观察状态；要确定性需在生产代码加标记。保留原等待。
  await page.waitForTimeout(600);
  expect(new URL(page.url()).pathname, '最后一栏左滑不动').toBe('/settings/');
  await swipe(page, 120, 400, 320, 390);
  await page.waitForURL('**/chat/');
  await expect(cur(page)).toHaveAttribute('data-tab', 'chat');
  await swipe(page, 120, 300, 320, 290);
  await page.waitForURL((u) => u.pathname === '/');
});

test('不抢的手势：边缘起手、竖着滑、太短、聊天输入框里、可横向滚动的容器里、弹层打开时', async ({ page }) => {
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

  await page.goto('/chat/', { waitUntil: 'domcontentloaded' });
  const box = await page.locator('#chat-input').boundingBox();
  await swipe(page, box.x + box.width - 10, box.y + box.height / 2, box.x + 10, box.y + box.height / 2);
  // TODO(C8): 同上，静默窗口。保留原等待。
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname, '聊天输入框').toBe('/chat/');
});
