/**
 * 账号的入口（S9，Gray 2026-11-11：账号卡片只展示，账号的操作都在全站终端里）：
 * 头像（非模态卡片、没 JS 时的链接）、卡片一行 → 终端预填命令（不替人回车）、旧地址 #acct=<层>、终端 sudo root [reset]、和全站终端互斥。
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
    await page.route('**/api/account**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.account) }));
  }
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}
const settled = (page, id) => page.waitForFunction((i) => document.getElementById(i).getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || (a.effect && a.effect.getTiming().iterations === Infinity)), id);
/* 页面时钟被 freezeTime 冻住：接口替身里的时间按页面的 Date.now() 算 */
const pageNow = (page) => page.evaluate(() => Date.now());

const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

test.describe('账号卡片 #sgx-acct（S9：只展示，点一行 = 终端预填命令）', () => {
  /* 终端里的流程见 account/*.spec.js；这里只管入口：头像、卡片的行、旧地址 #acct=…、终端 sudo root、和全站终端互斥 */
  test('点头像开卡片（非模态、aria-expanded、地址不变）；头像仍是链接；没登录：一行「登录 sudo root」，没有命令行；esc 关、焦点回头像', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/', { account: { ok: true, signing: true, configured: { password: true, passkey: true }, session: null } });
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
    await expect(d.locator('.sgx-at')).toHaveAttribute('data-at-layer', 'guest');
    await expect(d.locator('[data-at-run]').last()).toContainText('登录账号');
    await expect(d.locator('[data-at-run]').last()).toContainText('sudo root');
    /* 只展示：没有输入框、没有输出区；没有去 /account/ 子页的链接、没有 accountkey */
    await expect(d.locator('input, [data-at-in], [data-at-log]')).toHaveCount(0);
    await expect(d.locator('a[href*="/account/"]')).toHaveCount(0);
    await expect(d).not.toContainText('accountkey');
    await settled(page, 'sgx-acct');
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await expect(av).toHaveAttribute('aria-expanded', 'false');
    await expect(av).toBeFocused();
  });

  test('已登录：个人资料 / 设备 / 账号安全 / 应用授权 / 退出登录；点一行 = 收起卡片、打开终端、预填对应命令（不替人回车）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/', { route: (pg) => pg.route('**/api/account**', (r) => {
      if (r.request().method() === 'POST') return r.fulfill(json({ ok: true, grants: [] }));
      return r.fulfill(json({ ok: true, signing: true, configured: { password: true, passkey: true }, session: { by: 'passkey', device: 'Galaxy S23 Ultra' } }));
    }) });
    await page.addInitScript(() => { try { document.cookie = 'sgx-account-signed-in=1; Path=/'; } catch (e) {} });
    const d = page.locator('#sgx-acct');
    const rows = [['个人资料', 'profile'], ['设备', 'device'], ['账号安全', 'passkey'], ['应用授权', 'app'], ['退出登录', 'exit']];
    for (const [label, cmd] of rows) {
      await page.locator('.sgx-tb-av').click();
      await expect(d).toHaveAttribute('data-acct-state', 'in');
      const r = d.locator('.sgx-at-r').filter({ hasText: label });
      await expect(r).toHaveAttribute('data-at-run', cmd);
      await r.click();
      await expect(d).toBeHidden();
      await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
      await expect(page.locator('#sgx-term-in')).toHaveValue(cmd);
      await expect(page.locator('#sgx-term-in')).toBeFocused();
      /* 没替人回车：输出区没有这条命令的回显 */
      await expect(page.locator('#sgx-term [data-term-out]')).not.toContainText('# ' + cmd);
      await page.locator('#sgx-term-in').fill('');
      await page.keyboard.press('Escape');
      await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
    }
    /* 头像 / 编辑 → profile */
    await page.locator('.sgx-tb-av').click();
    await expect(d.locator('.sgx-pop-me-a')).toHaveAttribute('data-at-run', 'profile');
    await expect(d.locator('.sgx-pop-edit')).toHaveAttribute('data-at-run', 'profile');
  });

  test('旧地址 #acct=devices（/zh/account/devices/ 301 过来）：打开终端预填 device，去掉 hash，不开卡片', async ({ page }) => {
    await go(page, '/zh/#acct=devices', { route: (pg) => pg.route('**/api/account**', (r) => {
      if (r.request().method() === 'POST') return r.fulfill(json({ ok: true, devices: [], grants: [] }));
      return r.fulfill(json({ ok: true, signing: true, configured: { password: true, passkey: true }, session: { by: 'passkey', device: 'Galaxy S23 Ultra' } }));
    }) });
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
    await expect(page.locator('#sgx-term-in')).toHaveValue('device');
    await expect(page.locator('#sgx-acct')).toBeHidden();
    await expect(page).toHaveURL(/\/zh\/$/);
  });

  test('主页终端（顶栏 >_ 打开；v5 S7 首屏不再嵌终端）sudo root（v5 S5 终端合一）：在终端里原地登录，不开账号窗口；访客先要 sudo styrigx；sudo root reset → 终端里直接要恢复密钥', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    let entered = false;
    /* 线上每页都过网关、带 <html data-sgx-lock-session>（访客 locked / 进站 valid），终端首帧按它、标了 valid 再问服务端 */
    const route = async (pg) => {
      await pg.route('**/api/lock-session-check**', (r) => r.fulfill(entered ? json({ ok: true, by: 'password' }) : { status: 401, contentType: 'application/json', body: '{"ok":false}' }));
      await pg.route((u) => u.pathname === '/zh/', async (r) => {
        const res = await r.fetch();
        const html = (await res.text()).replace(/<html(\s|>)/, '<html data-sgx-lock-session="' + (entered ? 'valid' : 'locked') + '"$1');
        await r.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
      });
    };
    await go(page, '/zh/', { route, account: { ok: true, signing: true, configured: { password: true, passkey: true }, session: null } });
    const t = page.locator('#sgx-term');
    const inp = page.locator('#sgx-term-in');
    await page.locator('#site-nav .sgx-tb-term').click();
    await expect(t).toHaveAttribute('open', '');
    await inp.fill('sudo root');
    await inp.press('Enter');
    await expect(t.locator('[data-term-out] > *').last()).toHaveText('没有登录 · 先 su <用户>');
    entered = true;
    await page.reload({ waitUntil: 'load' });
    await page.locator('#site-nav .sgx-tb-term').click();
    await expect(t).toHaveAttribute('open', '');
    await expect(t.locator('[data-term-ps]')).toHaveText('styrigx@space:~#');
    await inp.fill('sudo root');
    await inp.press('Enter');
    await expect(t.locator('[data-term-form]')).toHaveAttribute('data-mode', 'pick');
    await expect(page.locator('#sgx-acct')).toBeHidden();
    await inp.press('Control+c');
    await expect(t.locator('[data-term-form]')).toHaveAttribute('data-mode', 'cmd');
    await inp.fill('sudo root reset');
    await inp.press('Enter');
    await expect(t.locator('[data-term-form]')).toHaveAttribute('data-mode', 'rkey');
    await expect(t.locator('[data-term-ps]')).toHaveText('[sudo] recovery key:');
    await expect(page.locator('#sgx-acct')).toBeHidden();
  });

  test('卡片开着时 Ctrl+K 开全站终端：卡片收起，不叠开（同时只开一个）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/', { account: { ok: true, signing: true, configured: { password: true, passkey: true }, session: null } });
    await page.locator('.sgx-tb-av').click();
    await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Control+k');
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
    await expect(page.locator('#sgx-acct[open], #sgx-sec[open], #sgx-qp[open], #sgx-nav[open], #sgx-ai[open]')).toHaveCount(0);
  });
});

