/**
 * 进站 · 手机触屏回归（v5 S5 终端合一：锁屏界面删了，进站 = 全站终端里敲 sudo styrigx）。
 * - 旧锁屏地址 ?entry=1 打开终端（手机上整块卡片）、预填 su ；选项（[1] passkey …）可以点；^C 是输入行下面的按钮（触屏显示）
 * - 要输秘密时输入行聚焦；空密码回车不发请求、还在密码态
 * - ^C 从密码态 / 等通行密钥时都能退出
 * - 不触发双击放大（html touch-action = manipulation），触屏上终端输入框字号 ≥ 16px
 * 原锁屏的「软键盘弹起整组上移」随锁屏界面删除：终端窗口是 <dialog>，键盘让位交给浏览器（PR 正文「偏离」）。
 *
 * 手机模拟：412×915、isMobile、hasTouch（粗指针）。需要锁屏启用的构建（SGX_TEST_SUITE=lock）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');
const { SEL, gotoLockTerm, lockCmd, lockMode } = require('../helpers/lock-term.cjs');

test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await page.route('**/api/lock-entry', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"passkey":true,"password":true}' }));
});

/** 打开终端 → 点输入行 → 回车跑预填的 sudo styrigx → 点选项 [2] password → 密码态 */
async function openPwByTouch(page) {
  await gotoLockTerm(page);
  await expect(page.locator(SEL.in)).toHaveValue('su ');
  await page.tap(SEL.in);
  /* 割接：访客预填 su （v6）；这里测旧入口 sudo styrigx（P4 删） */
  await page.locator(SEL.in).fill('sudo styrigx');
  await page.locator(SEL.in).press('Enter');
  await lockMode(page, 'pick');
  await page.tap(SEL.out + ' [data-term-pick="2"]');
  await lockMode(page, 'pw');
}

test('手机：?entry=1 打开终端卡片（在视口里）；sudo styrigx → 点选项 [2] password → 焦点在输入行（密码态），^C 键可见；没有弹层', async ({ page }) => {
  await openPwByTouch(page);
  const box = await page.locator('#sgx-term .sgx-term').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(412);
  await expect(page.locator(SEL.in)).toBeFocused();
  await expect(page.locator(SEL.hint + ' [data-term-cc]')).toBeVisible();
  await expect(page.locator('#sgx-method-sheet, .sgx-verify-dlg, #sgx-entry')).toHaveCount(0);
});

test('空密码回车：不发请求，还在密码态，焦点留在输入行', async ({ page }) => {
  let posted = 0;
  await page.route('**/api/lock-password', (r) => { posted++; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false,"error":"wrong"}' }); });
  await openPwByTouch(page);
  const input = page.locator(SEL.in);
  await input.press('Enter');
  await lockMode(page, 'pw');
  await expect(input).toBeFocused();
  expect(posted).toBe(0);
});

test('点 ^C：密码态回命令行；等通行密钥时 ^C 也能退出', async ({ page }) => {
  await openPwByTouch(page);
  await page.tap(SEL.hint + ' [data-term-cc]');
  await lockMode(page, 'cmd');
  await page.route('**/api/lock-passkey', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"challenge":"dGVzdA","cid":"c1","allowCredentials":[]}' }));
  await page.evaluate(() => { window.__pkCalled = false; navigator.credentials.get = () => { window.__pkCalled = true; return new Promise(() => {}); }; });
  await lockCmd(page, 'sudo styrigx');
  await lockMode(page, 'pick');
  await page.tap(SEL.out + ' [data-term-pick="1"]');
  await page.waitForFunction(() => window.__pkCalled === true, null, { timeout: 8000 });
  await lockMode(page, 'busy');
  await page.tap(SEL.hint + ' [data-term-cc]');
  await lockMode(page, 'cmd');
  await expect(page.locator(SEL.out)).toContainText('^C');
});

test('不触发双击放大：html touch-action = manipulation；触屏上终端输入框字号 ≥ 16px', async ({ page }) => {
  await openPwByTouch(page);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('manipulation');
  const sizes = await page.evaluate(() => Array.from(document.querySelectorAll('#sgx-term input:not([type=hidden])'))
    .filter((el) => el.getClientRects().length && getComputedStyle(el).opacity !== '0')
    .map((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(sizes.length).toBeGreaterThan(0);
  for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16);
});
