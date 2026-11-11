/**
 * 账号的入口（S9，Gray 2026-11-11：账号卡片只展示，账号的操作都在全站终端里）：
 * 头像（非模态卡片、没 JS 时的链接）、卡片一行 → 终端预填命令（不替人回车）、旧地址 #acct=<层>、和全站终端互斥。
 * v6 P4（定稿 v5.2 §七、§十三 P4）起登录状态只看终端的 v6 身份（POST /api/identity whoami），旧的 GET /api/account、sudo root [reset] 删了。
 * 终端里的流程见同目录 keys / devices / profile / proxy.spec.js（应用授权 grants.spec.js 随应用授权删除，定稿 v5.3 §十二）。
 */
const { test } = require('@playwright/test');
const A = require('../helpers/account-term.cjs');
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


test.describe('账号卡片 #sgx-acct（S9：只展示，点一行 = 终端预填命令）', () => {
  /* 终端里的流程见 account/*.spec.js；这里只管入口：头像、卡片的行、旧地址 #acct=…、终端 sudo root、和全站终端互斥 */
  test('点头像开卡片（非模态、aria-expanded、地址不变）；头像仍是链接；没登录：一行「登录 su root」（Gray 11-11 17:51），没有命令行；esc 关、焦点回头像', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/');
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
    await expect(d.locator('[data-at-run]').last()).toHaveAttribute('data-at-run', 'su root');
    await expect(d.locator('[data-at-run]').last()).toContainText('su root');
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

  test('已登录（v6 root）：个人资料 / 设备 / 退出登录 lock（P4-3 账号安全行删除、exit → lock，定稿 v5.5 §七；应用授权行删了，定稿 v5.3 §十二）；点一行 = 收起卡片、打开终端、预填对应命令（不替人回车）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/', { route: (pg) => A.mockAccount(pg) });
    const d = page.locator('#sgx-acct');
    const rows = [['个人资料', 'profile'], ['设备', 'device'], ['退出登录', 'lock']];
    await A.openCard(page);
    await expect(d.locator('.sgx-at-r').filter({ hasText: '应用授权' })).toHaveCount(0);
    await expect(d.locator('.sgx-at-r').filter({ hasText: '账号安全' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await settled(page, 'sgx-acct');
    await page.evaluate(() => { const a = document.getElementById('e2e-acct-open'); if (a) a.remove(); });
    for (const [label, cmd] of rows) {
      await A.openCard(page);
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
      await page.evaluate(() => { const a = document.getElementById('e2e-acct-open'); if (a) a.remove(); });
    }
    /* 头像 / 编辑 → profile */
    await A.openCard(page);
    await expect(d.locator('.sgx-pop-me-a')).toHaveAttribute('data-at-run', 'profile');
    await expect(d.locator('.sgx-pop-edit')).toHaveAttribute('data-at-run', 'profile');
  });

  test('已登录（站长 styrigx）：账号页三行；点头像 = 开账号页（定稿 v5.5 §七），不预填', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/', { route: (pg) => A.mockAccount(pg, { user: A.V6_USER('styrigx') }) });
    const d = page.locator('#sgx-acct');
    await A.openCard(page);
    await expect(d).toHaveAttribute('data-acct-state', 'in');
    await expect(d.locator('.sgx-at-r')).toHaveCount(3); // 个人资料 · 设备 · 退出登录 lock（P4-3 账号安全行删除，定稿 v5.5 §七）
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await settled(page, 'sgx-acct');
    await page.locator('.sgx-tb-av').click();
    await expect(d).toHaveAttribute('data-state', 'open');
    await expect(d).toHaveAttribute('data-acct-state', 'in');
    await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
  });

  test('旧地址 #acct=devices（/zh/account/devices/ 301 过来）：打开终端预填 device，去掉 hash，不开卡片', async ({ page }) => {
    await go(page, '/zh/#acct=devices', { route: (pg) => A.mockAccount(pg) });
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
    await expect(page.locator('#sgx-term-in')).toHaveValue('device');
    await expect(page.locator('#sgx-acct')).toBeHidden();
    await expect(page).toHaveURL(/\/zh\/$/);
  });

  test('主页终端：旧的 sudo root / sudo root reset（v6 P4 删，定稿 §十三 P4）落到 sudo 用法行，不进流程、不开账号窗口', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/', { route: (pg) => A.mockAccount(pg) });
    const t = page.locator('#sgx-term');
    const inp = page.locator('#sgx-term-in');
    await page.locator('#site-nav .sgx-tb-term').click();
    await expect(t).toHaveAttribute('open', '');
    await expect(t.locator('[data-term-ps]')).toHaveText('root@space:~#');
    for (const l of ['sudo root', 'sudo root reset']) {
      await inp.fill(l);
      await inp.press('Enter');
      await expect(t.locator('[data-term-out] > *').last()).toContainText('sudo useradd');
      await expect(t.locator('[data-term-form]')).toHaveAttribute('data-mode', 'cmd');
    }
    await expect(page.locator('#sgx-acct')).toBeHidden();
  });

  test('卡片开着时 Ctrl+K 开全站终端：卡片收起，不叠开（同时只开一个）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/');
    await page.locator('.sgx-tb-av').click();
    await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Control+k');
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
    await expect(page.locator('#sgx-acct[open], #sgx-sec[open], #sgx-qp[open], #sgx-nav[open], #sgx-ai[open]')).toHaveCount(0);
  });
});

