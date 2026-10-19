/**
 * 进门（管理凭证）E2E —— 账号体系后（静态构建 + API mock，无需真实后端）。
 *
 * 原「两扇门验证弹层」已移除：站长凭证升级为账号（顶栏头像 → 账号页），
 * 管理凭证的门票据由近期（≤10 分钟）账号登录换取（POST /api/stepup { action:'enter' }）。
 *
 * 覆盖：
 * - 近期账号登录 → 点管理凭证直接进管理凭证索引页（不弹任何验证框）
 * - 未登录账号（401 account）/ 登录过旧（403 account-stale）→ 去账号登录页（?door=1&return=），
 *   账号页提示原因；登录成功后自动 enter 并回到门内页
 * - 门内页过期回跳（?verify=mgmt&return=<门内页>）→ 自动走进门流程，回原门内页
 * - 访客：直接去账号登录（不调 enter）
 * - A-1：连续 10 次进门都成功、无 JS 错误；离开门后重进仍走 enter
 * - A-3：账号登录选择框样式（圆角 16px 等）保持
 *
 * 运行：npx playwright test --config=tests/config/playwright.config.js door-verify.spec.js
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

/** @param {import('@playwright/test').Page} page */
async function mockJson(page, pattern, status, body) {
  await page.route(pattern, async (route) => {
    await route.fulfill({ status: status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

/**
 * /api/stepup mock：enter 按 enterResult() 返回；status/clear 照常有效。
 * @returns {Promise<{enter:number}>}
 */
async function mockStepup(page, enterResult) {
  const counts = { enter: 0 };
  await page.route('**/api/stepup', async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    if (body.action === 'enter') {
      counts.enter++;
      const r = enterResult(counts.enter);
      await route.fulfill({ status: r[0], contentType: 'application/json', body: JSON.stringify(r[1]) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, valid: true, expiresAt: Date.now() + 175000 }) });
  });
  return counts;
}

async function setup(page) {
  await blockExternalRequests(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
  await mockJson(page, '**/api/lock-config', 200, { ok: true, password: true, passkey: true });
}

test.describe('管理凭证：账号登录换门票据', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await mockJson(page, '**/api/account', 200, { ok: true, password: true, passkey: true, ready: true, session: null });
  });

  test('近期账号登录 → 直接进管理凭证索引页，不弹验证框', async ({ page }) => {
    const c = await mockStepup(page, () => [200, { ok: true }]);
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sec-mgmt-cred')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#sec-owner-cred')).toHaveCount(0);
    await expect(page.locator('#sec-verify-dlg')).toHaveCount(0);
    await page.click('#sec-mgmt-cred');
    await page.waitForURL('**/settings/security/mgmt/', { timeout: 10000 });
    expect(c.enter).toBe(1);
  });

  test('未登录账号（401 account）→ 账号登录页（door=1&return），提示先登录', async ({ page }) => {
    await mockStepup(page, () => [401, { ok: false, error: 'account', reason: 'no-cookie' }]);
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await page.click('#sec-mgmt-cred');
    await page.waitForURL(/\/settings\/account\/\?door=1&return=%2Fsettings%2Fsecurity%2Fmgmt%2F$/, { timeout: 10000 });
    await expect(page.locator('#acct-login')).toBeVisible();
    await expect(page.locator('#acct-login-notice')).toHaveText('进入管理凭证前请先登录账号');
    await expect(page.locator('#acct-methods .sgx-door-row')).toHaveCount(3);
  });

  test('账号登录过旧（403 account-stale）→ 账号登录页；登录成功后自动 enter 回到门内页', async ({ page }) => {
    let loggedIn = false;
    const c = await mockStepup(page, () => (loggedIn ? [200, { ok: true }] : [403, { ok: false, error: 'account-stale' }]));
    await page.unroute('**/api/account');
    await page.route('**/api/account', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, password: true, passkey: false, ready: true, session: { by: 'password', authAt: Date.now() - 20 * 60000, recent: false } }) });
        return;
      }
      loggedIn = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto('/settings/security/?verify=mgmt&return=' + encodeURIComponent('/settings/security/lock/'), { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/settings\/account\/\?door=1&return=%2Fsettings%2Fsecurity%2Flock%2F$/, { timeout: 10000 });
    await expect(page.locator('#acct-login-notice')).toHaveText('登录已超过 10 分钟，请重新验证');
    await page.locator('.sgx-door-row').filter({ hasText: '账号密码' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('account-pw-1');
    await page.locator('.sgx-door-expand .sgx-door-btn-primary').click();
    await page.waitForURL('**/settings/security/lock/', { timeout: 10000 });
    expect(c.enter).toBe(2);
  });

  test('门内页过期回跳 ?verify=mgmt&return=<门内页> → 近期登录直接回原门内页', async ({ page }) => {
    await mockStepup(page, () => [200, { ok: true }]);
    await page.goto('/settings/security/?verify=mgmt&return=' + encodeURIComponent('/settings/security/apps/'), { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/settings/security/apps/', { timeout: 10000 });
  });

  test('return 不是门内页 → 忽略，进管理凭证索引页', async ({ page }) => {
    await mockStepup(page, () => [200, { ok: true }]);
    await page.goto('/settings/security/?verify=mgmt&return=' + encodeURIComponent('https://evil.example/'), { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/settings/security/mgmt/', { timeout: 10000 });
  });

  test('访客：直接去账号登录，不调 enter', async ({ page }) => {
    const c = await mockStepup(page, () => [200, { ok: true }]);
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { document.documentElement.dataset.sgxRole = 'visitor'; });
    await page.click('#sec-mgmt-cred');
    await page.waitForURL(/\/settings\/account\/\?door=1/, { timeout: 10000 });
    expect(c.enter).toBe(0);
  });
});

test.describe('A-1 进门不能马上被判过期（10 次连续进门）', () => {
  let pageErrors;
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    await setup(page);
    await mockJson(page, '**/api/account', 200, { ok: true, password: true, passkey: true, ready: true, session: null });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'keys' });
  });

  test('近期账号登录进管理凭证门：连续 10 次都成功，倒计时出现', async ({ page }) => {
    const c = await mockStepup(page, () => [200, { ok: true }]);
    for (let i = 0; i < 10; i++) {
      await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
      await page.locator('#sec-mgmt-cred').click();
      await expect(page).toHaveURL(/\/settings\/security\/mgmt\//, { timeout: 10000 });
      await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    }
    expect(c.enter).toBe(10);
    expect(pageErrors).toEqual([]);
  });

  test('离开门后重进仍走 enter（门票据由账号登录重新换取）', async ({ page }) => {
    const c = await mockStepup(page, () => [200, { ok: true }]);
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await page.locator('#sec-mgmt-cred').click();
    await expect(page).toHaveURL(/\/settings\/security\/mgmt\//, { timeout: 10000 });
    await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    await page.locator('.sgx-tb-back').click();
    await expect(page).toHaveURL(/\/settings\/security\/$/, { timeout: 10000 });
    await page.locator('#sec-mgmt-cred').click();
    await expect(page).toHaveURL(/\/settings\/security\/mgmt\//, { timeout: 10000 });
    expect(c.enter).toBe(2);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('A-3 账号登录选择框样式', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await mockJson(page, '**/api/account', 200, { ok: true, password: true, passkey: true, ready: true, session: null });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-methods .sgx-door-row')).toHaveCount(3);
  });

  test('选择框：圆角 16px、静止底色不透明、行间距 12px、无分隔线、按下态比静止态深', async ({ page }) => {
    const rows = page.locator('#acct-methods .sgx-door-row');
    const row = rows.first();
    expect(await row.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('16px');
    const pad = await row.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { top: cs.paddingTop, left: cs.paddingLeft };
    });
    expect(pad.top).toBe('12px');
    expect(pad.left).toBe('16px');
    expect(await row.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe('0px');
    const gap = await page.locator('#acct-methods').evaluate((el) => getComputedStyle(el).rowGap);
    expect(gap).toBe('12px');
    const bg = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    const b1 = await rows.nth(0).boundingBox();
    const b2 = await rows.nth(1).boundingBox();
    expect(Math.round(b2.y - (b1.y + b1.height))).toBe(12);
    await row.evaluate((el) => el.classList.add('sgx-row-pressed'));
    const pressed = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(pressed).not.toBe(bg);
  });
});
