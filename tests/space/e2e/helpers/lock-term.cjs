/**
 * 进站终端测试小工具（v5 S5 终端合一：锁屏界面 #sgx-entry 删了，进站 = 全站终端里敲 sudo styrigx；shell/space/layer.js + shell/terminal.js）。
 * DOM 是全站终端：<dialog id="sgx-term"> 里的 [data-term-out]（输出区）、form[data-term-form][data-mode]（输入行状态）、#sgx-term-in（输入框）、
 * [data-term-ps]（提示符）、[data-term-pmu]（密码管理器隐藏用户名）、[data-term-hint]（输入行下面的注释 + 触屏 ^C）。
 * 主页上终端是首屏那个（#home-term），其他页是顶栏打开的窗口；这里默认用 /wild/（窗口），主页单独测。
 * - gotoLockTerm(page, url)：打开地址（默认 /wild/?entry=1：旧锁屏地址 = 打开终端、预填 sudo styrigx），等终端出来；
 * - lockCmd(page, text)：在输入行输入一行并回车（命令、密码、恢复钥匙、编号都走它）；
 * - lockMode(page, mode)：等输入行进入某个状态（cmd / pick / pw / rkey / newpw / newpw2 / pkname / busy / done）；
 * - lockPick(page, key)：点选项按钮 [data-term-pick]；
 * - lastLine / badLine：终端最后一行输出 / 最后一行出错。
 */
const { expect } = require('@playwright/test');

/** 旧锁屏地址（分享链接失效时网关回的 /?entry=1、旧书签）：v5 S5 起 = 打开终端、预填 sudo styrigx（不替人回车） */
const ENTRY_URL = '/wild/?entry=1';
const SEL = Object.freeze({
  dlg: '#sgx-term',
  in: '#sgx-term-in',
  out: '#sgx-term [data-term-out]',
  form: '#sgx-term [data-term-form]',
  ps: '#sgx-term [data-term-ps]',
  pmu: '#sgx-term [data-term-pmu]',
  hint: '#sgx-term [data-term-hint]',
  title: '#sgx-term [data-term-title]',
});

/** @param {import('@playwright/test').Page} page */
async function gotoLockTerm(page, url = ENTRY_URL) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator(SEL.dlg)).toHaveAttribute('open', '', { timeout: 15000 });
  await expect(page.locator(SEL.in)).toBeVisible({ timeout: 15000 });
}

/** @param {import('@playwright/test').Page} page @param {string} text */
async function lockCmd(page, text) {
  const input = page.locator(SEL.in);
  await expect(input).toBeEditable({ timeout: 8000 });
  await input.fill(text);
  await input.press('Enter');
}

/** @param {import('@playwright/test').Page} page @param {string} mode */
async function lockMode(page, mode, timeout = 8000) {
  await expect(page.locator(SEL.form)).toHaveAttribute('data-mode', mode, { timeout });
}

/** @param {import('@playwright/test').Page} page @param {string} key */
async function lockPick(page, key) {
  await page.locator(SEL.out + ' [data-term-pick="' + key + '"]').last().click();
}

/** 出错行：钥匙层打的（.sgx-at-l--er）和命令表打的（.sgx-term-err） @param {import('@playwright/test').Page} page */
const badLine = (page) => page.locator(SEL.out + ' .sgx-at-l--er, ' + SEL.out + ' .sgx-term-err').last();
/** @param {import('@playwright/test').Page} page */
const lastLine = (page) => page.locator(SEL.out + ' > div').last();

module.exports = { ENTRY_URL, SEL, gotoLockTerm, lockCmd, lockMode, lockPick, badLine, lastLine };
