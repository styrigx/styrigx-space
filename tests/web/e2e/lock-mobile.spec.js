/**
 * 锁屏 · 手机触屏回归（2026-10-24：Samsung Internet 上密码框点不进去 / 选不中字、连点按钮放大、空密码没提示、顶栏标题）。
 *
 * 手机模拟：412×915、isMobile、hasTouch（粗指针）。软键盘在无头浏览器里弹不出来，这里两种方式模拟它的效果：
 * - VirtualKeyboard API：给 navigator.virtualKeyboard 装一个 boundingRect，再派发 geometrychange（followKeyboard 会把弹层顶上去）；
 * - 「按在输入框里、松开在遮罩上」：拖选文字或弹层被键盘顶走时的真实手势，click 的 target 会变成 dialog 本身。
 *
 * 需要锁屏启用的构建（SGX_TEST_SUITE=lock）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
});

async function openPwByTouch(page) {
  await page.goto('/?lock=1', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
  await page.tap('#sgx-lock-go');
  await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible();
  await page.tap('#sgx-mopt-pw');
  await expect(page.locator('#sgx-pw-input')).toBeVisible();
}

/** 模拟软键盘弹出 h px（VirtualKeyboard API 路径） */
async function fakeKeyboard(page, h) {
  await page.evaluate((hh) => {
    const vk = /** @type {any} */ (navigator).virtualKeyboard;
    Object.defineProperty(vk, 'boundingRect', { configurable: true, get: () => ({ x: 0, y: innerHeight - hh, width: innerWidth, height: hh }) });
    vk.dispatchEvent(new Event('geometrychange'));
  }, h);
}

test('点「密码」后焦点留在密码框：方式弹层关闭 250ms 后不再把焦点抢回头像', async ({ page }) => {
  await openPwByTouch(page);
  const input = page.locator('#sgx-pw-input');
  await expect(input).toBeFocused();
  await page.waitForTimeout(450);
  await expect(input).toBeFocused();
});

test('键盘弹起把弹层顶上去后，点密码框 / 拖选文字松开在遮罩上，焦点都不丢', async ({ page }) => {
  await openPwByTouch(page);
  const input = page.locator('#sgx-pw-input');
  await fakeKeyboard(page, 320);
  await expect.poll(() => page.locator('.sgx-verify-dlg').evaluate((el) => el.style.transform)).toBe('translateY(-320px)');
  await page.tap('#sgx-pw-input');
  await expect(input).toBeFocused();
  await input.fill('abc');
  /* 按在输入框里，拖到弹层上方的遮罩再松开（拖选 / 弹层在手指下面移走）：click 的 target 是 dialog */
  const box = await input.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 10, 40, { steps: 4 });
  await page.mouse.up();
  await expect(input).toBeFocused();
  await expect(page.locator('.sgx-verify-dlg')).toBeVisible();
});

test('真的点遮罩：只让密码框失焦（收键盘），弹层保留', async ({ page }) => {
  await openPwByTouch(page);
  const input = page.locator('#sgx-pw-input');
  await expect(input).toBeFocused();
  await page.touchscreen.tap(200, 60);
  await expect(input).not.toBeFocused();
  await expect(page.locator('.sgx-verify-dlg')).toBeVisible();
});

test('空密码提交：输入框正下方提示「请输入密码」，输入框标 aria-invalid 并保持聚焦；输入后清除标记', async ({ page }) => {
  let posted = 0;
  await page.route('**/api/lock-password', (r) => { posted++; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false,"error":"wrong"}' }); });
  await openPwByTouch(page);
  const input = page.locator('#sgx-pw-input');
  await page.tap('#sgx-pw-go');
  const err = page.locator('#sgx-verify-err');
  await expect(err).toHaveText('请输入密码');
  await expect(err).toBeVisible();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toBeFocused();
  /* 提示紧贴在输入框下面（在「确定」按钮上面） */
  const fb = await page.locator('#sgx-verify-body .sgx-pw-field').boundingBox();
  const eb = await err.boundingBox();
  const gb = await page.locator('#sgx-pw-go').boundingBox();
  expect(eb.y).toBeGreaterThanOrEqual(fb.y + fb.height - 1);
  expect(eb.y).toBeLessThan(gb.y);
  expect(posted).toBe(0);
  await input.pressSequentially('x');
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
});

test('顶栏标题：静止「锁定屏幕」→ 打开解锁方式 / 密码弹层「解锁屏幕」→ 关掉回到「锁定屏幕」', async ({ page }) => {
  await page.goto('/?lock=1', { waitUntil: 'domcontentloaded' });
  const title = page.locator('#sgx-lock-title');
  await expect(title).toHaveText('锁定屏幕');
  await page.tap('#sgx-lock-go');
  await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible();
  await expect(title).toHaveText('解锁屏幕');
  await page.keyboard.press('Escape');
  await expect(page.locator('#sgx-method-sheet')).toHaveCount(0);
  await expect(title).toHaveText('锁定屏幕');
  await page.tap('#sgx-lock-go');
  await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible();
  await page.tap('#sgx-mopt-pw');
  await expect(page.locator('#sgx-pw-input')).toBeVisible();
  await expect(title).toHaveText('解锁屏幕');
  await page.locator('.sgx-verify-dlg .sgx-dlg-close').click();
  await expect(page.locator('.sgx-verify-dlg')).toBeHidden();
  await expect(title).toHaveText('锁定屏幕');
});

test('不触发双击放大：html touch-action = manipulation；触屏上输入框字号 ≥ 16px', async ({ page }) => {
  await openPwByTouch(page);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('manipulation');
  const sizes = await page.evaluate(() => Array.from(document.querySelectorAll('input:not([type=hidden])'))
    .filter((el) => el.getClientRects().length && getComputedStyle(el).opacity !== '0')
    .map((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(sizes.length).toBeGreaterThan(0);
  for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16);
});
