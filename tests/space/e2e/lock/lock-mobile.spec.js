/**
 * 锁屏 · 手机触屏回归（lock-v10 命令解锁，2026-11-08）：
 * 锁屏上没有弹层，解锁在终端输入行里敲命令；触屏上用快捷键（替你敲命令）或软键盘输入。
 * - 触屏不自动聚焦（不一进来就弹键盘）；点快捷键后焦点在输入行；
 * - 软键盘弹起时整组上移刚好够的距离，输入行不被盖住；
 * - 空密码回车：终端里提示「请输入密码」，不发请求，焦点留在输入行；
 * - 顶栏标题跟着状态变；不触发双击放大，输入框字号 ≥ 16px。
 *
 * 手机模拟：412×915、isMobile、hasTouch（粗指针）。软键盘用 VirtualKeyboard API 模拟（boundingRect + geometrychange）。
 * 需要锁屏启用的构建（SGX_TEST_SUITE=lock）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');
const { gotoLockTerm, lockMode, badLine } = require('../helpers/lock-term.cjs');

test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await page.route('**/api/lock-entry', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"passkey":true,"password":true}' }));
});

async function openPwByTouch(page) {
  await gotoLockTerm(page, '/?lock=1');
  await expect(page.locator('#sgx-lock-k-pw')).toBeVisible();
  await page.tap('#sgx-lock-k-pw');
  await lockMode(page, 'pw');
}

/** 模拟软键盘弹出 h px（VirtualKeyboard API 路径） */
async function fakeKeyboard(page, h) {
  await page.evaluate((hh) => {
    const vk = /** @type {any} */ (navigator).virtualKeyboard;
    Object.defineProperty(vk, 'boundingRect', { configurable: true, get: () => ({ x: 0, y: innerHeight - hh, width: innerWidth, height: hh }) });
    vk.dispatchEvent(new Event('geometrychange'));
  }, h);
}

test('触屏不自动聚焦；点 password 快捷键 → 焦点留在输入行（密码态）', async ({ page }) => {
  await gotoLockTerm(page, '/?lock=1');
  await expect(page.locator('#sgx-lock-cmd')).not.toBeFocused();
  await page.tap('#sgx-lock-k-pw');
  await lockMode(page, 'pw');
  await expect(page.locator('#sgx-lock-cmd')).toBeFocused();
  await expect(page.locator('#sgx-method-sheet, .sgx-verify-dlg')).toHaveCount(0);
});

test('键盘弹起：整组上移刚好够，输入行在键盘上方；收起键盘 / 失焦后回原位', async ({ page }) => {
  await openPwByTouch(page);
  const input = page.locator('#sgx-lock-cmd');
  await expect(input).toBeFocused();
  await fakeKeyboard(page, 420);
  await expect.poll(() => page.locator('#sgx-lock-stage').evaluate((el) => el.style.transform)).toMatch(/^translateY\(-\d+px\)$/);
  const r = await page.evaluate(() => ({ bottom: document.getElementById('sgx-lock-term').getBoundingClientRect().bottom, vb: innerHeight - 420 }));
  expect(r.bottom).toBeLessThanOrEqual(r.vb + 1);
  await fakeKeyboard(page, 0);
  await expect.poll(() => page.locator('#sgx-lock-stage').evaluate((el) => el.style.transform)).toBe('');
  await page.tap('#sgx-lock-cmd');
  await expect(input).toBeFocused();
});

test('空密码回车：终端提示「请输入密码」，不发请求，焦点留在输入行', async ({ page }) => {
  let posted = 0;
  await page.route('**/api/lock-password', (r) => { posted++; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false,"error":"wrong"}' }); });
  await openPwByTouch(page);
  const input = page.locator('#sgx-lock-cmd');
  await input.press('Enter');
  await expect(badLine(page)).toHaveText('✗ 请输入密码');
  await expect(input).toBeFocused();
  await lockMode(page, 'pw');
  expect(posted).toBe(0);
  await expect(page.locator('#sgx-lock-live')).toContainText('请输入密码');
});

/* 2026-11 PR-A 起锁屏顶栏不显示；标题节点 #sgx-lock-title 仍由 lock.js 按状态改写，这里照测 */
test('顶栏标题（节点）：静止「锁定屏幕」→ 密码态「解锁屏幕」→ 点 Ctrl+C 回到「锁定屏幕」', async ({ page }) => {
  await gotoLockTerm(page, '/?lock=1');
  const title = page.locator('#sgx-lock-title');
  await expect(title).toHaveText('锁定屏幕');
  await page.tap('#sgx-lock-k-pw');
  await lockMode(page, 'pw');
  await expect(title).toHaveText('解锁屏幕');
  await page.tap('#sgx-lock-cc');
  await lockMode(page, 'cmd');
  await expect(title).toHaveText('锁定屏幕');
  /* 输凭证途中点另一个快捷键 = 先 Ctrl+C 再换 */
  await page.tap('#sgx-lock-k-pw');
  await lockMode(page, 'pw');
  await page.route('**/api/lock-passkey', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"challenge":"dGVzdA","cid":"c1","allowCredentials":[]}' }));
  await page.evaluate(() => { window.__pkCalled = false; navigator.credentials.get = () => { window.__pkCalled = true; return new Promise(() => {}); }; });
  await page.tap('#sgx-lock-k-pk');
  await page.waitForFunction(() => window.__pkCalled === true, null, { timeout: 8000 });
  await lockMode(page, 'busy');
  await expect(page.locator('#sgx-lock-log')).toContainText('^C');
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
