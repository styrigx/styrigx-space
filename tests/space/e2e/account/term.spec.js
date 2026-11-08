/**
 * 账号终端的入口（2026-11-08 账号 UI 改版；原 topbar/acct-sec-pop.spec.js 账号那一组，按功能拆文件）：
 * 头像（非模态下拉、没 JS 时的链接）、旧地址 #acct=<层>、主页终端 sudo root [reset]、和其他下拉 / 全站终端互斥。
 * 终端里的流程见同目录 session / reauth / reset / keys / devices / grants / profile.spec.js。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

async function go(page, path, opts = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  /* 中文页：先存语言偏好，免得按浏览器语言跳回英文页（同 topbar-spec.spec.js） */
  if (path.indexOf('/zh/') === 0) await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  if (opts.route) await opts.route(page);
  if (opts.account !== undefined) {
    await page.route('**/api/account', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.account) }));
  }
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}
const settled = (page, id) => page.waitForFunction((i) => document.getElementById(i).getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || (a.effect && a.effect.getTiming().iterations === Infinity)), id);
/* 页面时钟被 freezeTime 冻住：接口替身里的时间按页面的 Date.now() 算 */
const pageNow = (page) => page.evaluate(() => Date.now());

const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

test.describe('账号下拉 = 账号终端 #sgx-acct（2026-11-08 账号 UI 改版）', () => {
  /* 账号终端里面的流程见 account/*.spec.js；这里只管入口：头像、旧地址 #acct=…、主页终端 sudo root、和别的下拉互斥 */
  test('点头像开下拉（非模态、aria-expanded、地址不变）；头像仍是链接（没 JS → /zh/account/ 301 首页 #acct）；esc 先退出 sudo root 再关、焦点回头像', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/', { account: { ok: true, ready: true, password: true, passkey: true, session: null } });
    const av = page.locator('.sgx-tb-av');
    await expect(av).toHaveAttribute('href', '/zh/account/');
    await expect(av).toHaveAccessibleName('账号');
    await av.click();
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-state', 'open');
    expect(await d.evaluate((el) => el.open && !el.matches(':modal'))).toBe(true);
    await expect(av).toHaveAttribute('aria-expanded', 'true');
    await expect(page).toHaveURL(/\/zh\/wild\/$/);
    await expect(d).toHaveAttribute('data-acct-state', 'guest');
    await expect(d.locator('.sgx-at')).toHaveAttribute('data-at-mode', 'pick');
    /* 旧下拉的东西都没了：没有去 /account/ 子页的链接、没有 accountkey */
    await expect(d.locator('a[href*="/account/"]')).toHaveCount(0);
    await expect(d).not.toContainText('accountkey');
    await settled(page, 'sgx-acct');
    await page.keyboard.press('Escape');
    await expect(d.locator('.sgx-at')).toHaveAttribute('data-at-mode', 'cmd');
    await expect(d).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await expect(av).toHaveAttribute('aria-expanded', 'false');
    await expect(av).toBeFocused();
  });

  test('旧地址 #acct=devices（/zh/account/devices/ 301 过来）：打开设备层，去掉 hash', async ({ page }) => {
    await go(page, '/zh/#acct=devices', { route: (pg) => pg.route('**/api/account', (r) => {
      if (r.request().method() === 'POST') return r.fulfill(json({ ok: true, devices: [], grants: [] }));
      return r.fulfill(json({ ok: true, ready: true, password: true, passkey: true, session: { by: 'passkey', device: 'Galaxy S23 Ultra' } }));
    }) });
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-state', 'open');
    await expect(d.locator('.sgx-at')).toHaveAttribute('data-at-layer', 'devices');
    await expect(page).toHaveURL(/\/zh\/$/);
  });

  test('主页终端 sudo root → 打开账号终端；sudo root reset → 直接要恢复密钥', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/', { account: { ok: true, ready: true, password: true, passkey: true, session: null } });
    const inp = page.locator('#home-term-in');
    await inp.fill('sudo root');
    await inp.press('Enter');
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-state', 'open');
    await expect(d.locator('.sgx-at')).toHaveAttribute('data-at-layer', 'guest');
    await settled(page, 'sgx-acct');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await inp.fill('sudo root reset');
    await inp.press('Enter');
    await expect(d).toHaveAttribute('data-state', 'open');
    await expect(d.locator('.sgx-at')).toHaveAttribute('data-at-mode', 'rkey');
    await expect(d.locator('[data-at-ps]')).toHaveText('[sudo] recovery key:');
  });

  test('Ctrl+K 开全站终端时账号下拉不叠开（同时只开一个）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/', { account: { ok: true, ready: true, password: true, passkey: true, session: null } });
    await page.locator('.sgx-tb-av').click();
    await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
    await page.locator('#sgx-acct [data-at-in]').press('Control+c');
    await page.keyboard.press('Escape');
    await expect(page.locator('#sgx-acct')).toBeHidden();
    await page.keyboard.press('Control+k');
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
    await expect(page.locator('#sgx-acct[open], #sgx-sec[open], #sgx-qp[open], #sgx-nav[open], #sgx-ai[open]')).toHaveCount(0);
  });
});

