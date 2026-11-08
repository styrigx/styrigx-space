/**
 * 锁屏命令解锁（lock-v10，2026-11-08）测试小工具：锁屏上没有弹层，解锁 = 在终端输入行敲命令。
 * - lockCmd(page, text)：在输入行输入一行并回车（命令、密码、临时钥匙、进站凭证、编号都走它）；
 * - lockMode(page, mode)：等输入行进入某个状态（cmd / pw / temp / rkey / rpick / rpw / busy / done）；
 * - lastLine / badLine：终端最后一行输出 / 最后一行出错（`✗ …`）。
 */
const { expect } = require('@playwright/test');

/** @param {import('@playwright/test').Page} page */
async function gotoLockTerm(page, url = '/?lock=1') {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#sgx-lock-cmd')).toBeVisible({ timeout: 15000 });
}

/** @param {import('@playwright/test').Page} page @param {string} text */
async function lockCmd(page, text) {
  const input = page.locator('#sgx-lock-cmd');
  await expect(input).toBeEditable({ timeout: 8000 });
  await input.fill(text);
  await input.press('Enter');
}

/** @param {import('@playwright/test').Page} page @param {string} mode */
async function lockMode(page, mode, timeout = 8000) {
  await expect(page.locator('#sgx-lock-form')).toHaveAttribute('data-mode', mode, { timeout });
}

/** @param {import('@playwright/test').Page} page */
const badLine = (page) => page.locator('#sgx-lock-log .sgx-lock-lbad').last();
/** @param {import('@playwright/test').Page} page */
const lastLine = (page) => page.locator('#sgx-lock-log > div').last();

module.exports = { gotoLockTerm, lockCmd, lockMode, badLine, lastLine };
