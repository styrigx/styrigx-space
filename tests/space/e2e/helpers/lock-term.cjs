/**
 * 锁屏（进站）终端测试小工具（进站 v3 L1，SPACE-V3 §2.2 A；shell/space/entry.js + term.js）：锁屏上没有弹层，进站 = 在终端输入行敲命令。
 * DOM 是 entry：#sgx-entry（全屏）、#sgx-entry-cmd（输入行）、#sgx-entry-form[data-mode]、#sgx-entry-log（输出区）。
 * - gotoLockTerm(page, url)：打开锁屏地址（默认 /?entry=1），等终端出来；
 * - lockCmd(page, text)：在输入行输入一行并回车（命令 sudo styrigx…、密码、临时钥匙、恢复钥匙、编号都走它）；
 * - lockMode(page, mode)：等输入行进入某个状态（cmd / pick / pw / temp / rkey / newpw / newpw2 / pkname / busy / done）；
 * - lockPick(page, key)：点选项按钮 [data-term-pick]；
 * - lastLine / badLine：终端最后一行输出 / 最后一行出错（.sgx-entry-l--er）。
 */
const { expect } = require('@playwright/test');

/** 锁屏地址（守卫 guard.js 认 ?entry=1，旧的 ?lock=1 也认） */
const ENTRY_URL = '/?entry=1';

/** @param {import('@playwright/test').Page} page */
async function gotoLockTerm(page, url = ENTRY_URL) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sgx-entry')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#sgx-entry-cmd')).toBeVisible({ timeout: 15000 });
}

/** @param {import('@playwright/test').Page} page @param {string} text */
async function lockCmd(page, text) {
  const input = page.locator('#sgx-entry-cmd');
  await expect(input).toBeEditable({ timeout: 8000 });
  await input.fill(text);
  await input.press('Enter');
}

/** @param {import('@playwright/test').Page} page @param {string} mode */
async function lockMode(page, mode, timeout = 8000) {
  await expect(page.locator('#sgx-entry-form')).toHaveAttribute('data-mode', mode, { timeout });
}

/** @param {import('@playwright/test').Page} page @param {string} key */
async function lockPick(page, key) {
  await page.locator('#sgx-entry-log [data-term-pick="' + key + '"]').last().click();
}

/** @param {import('@playwright/test').Page} page */
const badLine = (page) => page.locator('#sgx-entry-log .sgx-entry-l--er').last();
/** @param {import('@playwright/test').Page} page */
const lastLine = (page) => page.locator('#sgx-entry-log > div').last();

module.exports = { ENTRY_URL, gotoLockTerm, lockCmd, lockMode, lockPick, badLine, lastLine };
