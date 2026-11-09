/**
 * 锁屏 · 手机触屏回归（进站 v3 L1，2026-11-09：entry@space 终端，没有快捷键按钮）：
 * 锁屏上没有弹层，进站在终端输入行里敲 sudo styrigx；选项（[1] passkey …）可以点，^C 是输入行下面的按钮（只在触屏显示）。
 * - 触屏不自动聚焦（不一进来就弹键盘）；要输秘密时自动聚焦；
 * - 软键盘弹起时整组上移刚好够的距离，输入行不被盖住；
 * - 空密码回车：不发请求，还在密码态，焦点留在输入行；
 * - 顶栏标题跟着状态变；不触发双击放大，输入框字号 ≥ 16px。
 *
 * 手机模拟：412×915、isMobile、hasTouch（粗指针）。软键盘用 VirtualKeyboard API 模拟（boundingRect + geometrychange）。
 * 需要锁屏启用的构建（SGX_TEST_SUITE=lock）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');
const { gotoLockTerm, lockCmd, lockMode } = require('../helpers/lock-term.cjs');

test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await page.route('**/api/lock-entry', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"passkey":true,"password":true}' }));
});

/** 点输入行（弹键盘）→ 敲 sudo styrigx → 点选项 [2] password → 密码态 */
async function openPwByTouch(page) {
  await gotoLockTerm(page);
  await page.tap('#sgx-entry-cmd');
  await lockCmd(page, 'sudo styrigx');
  await lockMode(page, 'pick');
  await page.tap('#sgx-entry-log [data-term-pick="2"]');
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

test('触屏不自动聚焦；sudo styrigx → 点选项 [2] password → 焦点在输入行（密码态），^C 键可见', async ({ page }) => {
  await gotoLockTerm(page);
  await expect(page.locator('#sgx-entry-cmd')).not.toBeFocused();
  await expect(page.locator('#sgx-lock-k-pw, [id^="sgx-entry-k-"]')).toHaveCount(0);
  await openPwByTouch(page);
  await expect(page.locator('#sgx-entry-cmd')).toBeFocused();
  await expect(page.locator('#sgx-entry-hint [data-term-cc]')).toBeVisible();
  await expect(page.locator('#sgx-method-sheet, .sgx-verify-dlg')).toHaveCount(0);
});

test('键盘弹起：整组上移刚好够，输入行在键盘上方；收起键盘 / 失焦后回原位', async ({ page }) => {
  await openPwByTouch(page);
  const input = page.locator('#sgx-entry-cmd');
  await expect(input).toBeFocused();
  await fakeKeyboard(page, 420);
  await expect.poll(() => page.locator('#sgx-entry-stage').evaluate((el) => el.style.transform)).toMatch(/^translateY\(-\d+px\)$/);
  const r = await page.evaluate(() => ({ bottom: document.getElementById('sgx-entry-term').getBoundingClientRect().bottom, vb: innerHeight - 420 }));
  expect(r.bottom).toBeLessThanOrEqual(r.vb + 1);
  await fakeKeyboard(page, 0);
  await expect.poll(() => page.locator('#sgx-entry-stage').evaluate((el) => el.style.transform)).toBe('');
  await page.tap('#sgx-entry-cmd');
  await expect(input).toBeFocused();
});

test('空密码回车：不发请求，还在密码态，焦点留在输入行', async ({ page }) => {
  let posted = 0;
  await page.route('**/api/lock-password', (r) => { posted++; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false,"error":"wrong"}' }); });
  await openPwByTouch(page);
  const input = page.locator('#sgx-entry-cmd');
  await input.press('Enter');
  await lockMode(page, 'pw');
  await expect(input).toBeFocused();
  expect(posted).toBe(0);
});

/* 锁屏顶栏不显示；标题节点 #sgx-entry-title 仍由 entry.js 按状态改写，这里照测 */
test('顶栏标题（节点）：静止「锁定屏幕」→ 密码态「解锁屏幕」→ 点 ^C 回到「锁定屏幕」；等通行密钥时 ^C 也能退出', async ({ page }) => {
  await gotoLockTerm(page);
  const title = page.locator('#sgx-entry-title');
  await expect(title).toHaveText('锁定屏幕');
  await openPwByTouch(page);
  await expect(title).toHaveText('解锁屏幕');
  await page.tap('#sgx-entry-hint [data-term-cc]');
  await lockMode(page, 'cmd');
  await expect(title).toHaveText('锁定屏幕');
  await page.route('**/api/lock-passkey', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"challenge":"dGVzdA","cid":"c1","allowCredentials":[]}' }));
  await page.evaluate(() => { window.__pkCalled = false; navigator.credentials.get = () => { window.__pkCalled = true; return new Promise(() => {}); }; });
  await lockCmd(page, 'sudo styrigx passkey');
  await page.waitForFunction(() => window.__pkCalled === true, null, { timeout: 8000 });
  await lockMode(page, 'busy');
  await page.tap('#sgx-entry-hint [data-term-cc]');
  await lockMode(page, 'cmd');
  await expect(page.locator('#sgx-entry-log')).toContainText('^C');
});

test('不触发双击放大：html touch-action = manipulation；触屏上输入框字号 ≥ 16px', async ({ page }) => {
  await openPwByTouch(page);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('manipulation');
  /* 只看锁屏里的输入框：主页首屏终端的输入行 2026-11-09 起（Gray 细节 3）跟输出同字号，16px 只留给 iOS（@supports -webkit-touch-callout），锁屏底下那个不算 */
  const sizes = await page.evaluate(() => Array.from(document.querySelectorAll('#sgx-entry input:not([type=hidden])'))
    .filter((el) => el.getClientRects().length && getComputedStyle(el).opacity !== '0')
    .map((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(sizes.length).toBeGreaterThan(0);
  for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16);
});
