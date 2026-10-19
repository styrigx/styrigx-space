/**
 * 账号页返回（顶栏右圆头像进入 → 返回回到点头像时的页面）。
 *
 * 规则（shell/navhistory.js）：
 * - 点头像记来源；总览返回：同源且上一条就是来源 → history.back()，否则 replace(来源)；
 *   没有来源（直接打开）→ /settings/
 * - 安全与隐私子页返回固定回总览，来源保留；登录（原地 / 子页 ?return= 回跳）、退出后来源仍在
 * - 子站（book/blog.styrigx.com）点头像过来：跨站 referrer 只有 origin，回到子站首页
 *
 * 运行：npx playwright test --config=tests/config/playwright.config.js account-back.spec.js
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

const RECENT = () => ({ by: 'password', authAt: Date.now() - 1000, expiresAt: Date.now() + 3600000, recent: true });

/** @param {import('@playwright/test').Page} page @param {{session: () => any}} o */
async function mockAccount(page, o) {
  await page.route('**/api/account', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({ json: { ok: true, password: true, passkey: false, ready: true, session: o.session() } });
      return;
    }
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    if (body.action === 'login-password') { o.login(); await route.fulfill({ json: { ok: true } }); return; }
    if (body.action === 'logout') { o.logout(); await route.fulfill({ json: { ok: true } }); return; }
    await route.fulfill({ json: { ok: true, keys: [] } });
  });
}

/** @param {import('@playwright/test').Page} page @param {boolean} [loggedIn] */
async function setup(page, loggedIn = true) {
  await blockExternalRequests(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  const st = { in: loggedIn, recent: true };
  await mockAccount(page, {
    session: () => (st.in ? Object.assign(RECENT(), { recent: st.recent }) : null),
    login: () => { st.in = true; st.recent = true; },
    logout: () => { st.in = false; },
  });
  return st;
}

/** 点顶栏返回 */
async function back(page) {
  await page.locator('.sgx-tb-back').click();
}
/** 点顶栏右圆头像 */
async function avatar(page) {
  await page.locator('.sgx-tb-me').click();
  await page.waitForURL(/\/settings\/account\/$/);
  await expect(page.locator('#acct-main:visible, #acct-login:visible')).toHaveCount(1);
}

test.use({ viewport: { width: 412, height: 915 } });

test('同站：/browser/ 点头像 → 账号 → 返回 = /browser/', async ({ page }) => {
  await setup(page);
  await page.goto('/browser/', { waitUntil: 'domcontentloaded' });
  await avatar(page);
  await expect(page.locator('#acct-main')).toBeVisible();
  await back(page);
  await page.waitForURL(/\/browser\/$/);
});

test('子站：book.styrigx.com 点头像 → 账号 → 返回 = 子站（跨站 referrer 只有 origin）', async ({ page }) => {
  await setup(page);
  await page.route('https://book.styrigx.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>book</title><p id="book">book</p>' }));
  await page.goto('/settings/account/', { waitUntil: 'domcontentloaded', referer: 'https://book.styrigx.com/' });
  await expect(page.locator('#acct-main')).toBeVisible();
  await back(page);
  await page.waitForURL('https://book.styrigx.com/');
  await expect(page.locator('#book')).toBeVisible();
});

test('头像 → 账号 → 安全与隐私 → 返回 = 账号 → 返回 = 来源（不在两页之间来回）', async ({ page }) => {
  await setup(page);
  await page.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
  await avatar(page);
  await page.locator('#acct-sec-row').click();
  await page.waitForURL(/\/settings\/account\/security\/$/);
  await expect(page.locator('#acct-sec')).toBeVisible();
  await back(page);
  await page.waitForURL(/\/settings\/account\/$/);
  await expect(page.locator('#acct-main')).toBeVisible();
  await back(page);
  await page.waitForURL(/\/settings\/display\/$/);
});

test('直接打开账号页 → 返回 = /settings/', async ({ page }) => {
  await setup(page);
  await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#acct-main')).toBeVisible();
  await back(page);
  await page.waitForURL(/\/settings\/$/);
});

test('直接打开账号页（之前点过头像，来源已过期）→ 返回仍 = /settings/', async ({ page }) => {
  await setup(page);
  await page.goto('/browser/', { waitUntil: 'domcontentloaded' });
  await avatar(page);
  /* 地址栏直接打开（无 referrer）：清掉旧来源 */
  await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#acct-main')).toBeVisible();
  await back(page);
  await page.waitForURL(/\/settings\/$/);
});

test('未登录：头像 → 账号登录 → 原地登录 → 返回 = 来源', async ({ page }) => {
  await setup(page, false);
  await page.goto('/browser/', { waitUntil: 'domcontentloaded' });
  await avatar(page);
  await expect(page.locator('#acct-login')).toBeVisible();
  await page.locator('.sgx-door-row').filter({ hasText: '账号密码' }).click();
  await page.locator('.sgx-door-expand input[type="password"]').fill('pw-123456');
  await page.locator('.sgx-door-expand .sgx-door-btn-primary').click();
  await expect(page.locator('#acct-main')).toBeVisible();
  await back(page);
  await page.waitForURL(/\/browser\/$/);
});

test('退出账号后返回 = 来源', async ({ page }) => {
  await setup(page);
  await page.goto('/browser/', { waitUntil: 'domcontentloaded' });
  await avatar(page);
  await page.locator('#acct-logout').click();
  await expect(page.locator('#acct-login')).toBeVisible();
  await back(page);
  await page.waitForURL(/\/browser\/$/);
});

test('子页登录过旧 → 账号页 ?return= 重新登录 → 回子页 → 返回 → 返回 = 来源', async ({ page }) => {
  const st = await setup(page);
  st.recent = false;
  await page.goto('/browser/', { waitUntil: 'domcontentloaded' });
  await avatar(page);
  await page.locator('#acct-sec-row').click();
  await page.waitForURL(/\/settings\/account\/security\/$/);
  /* 改密码 → 服务端 account-stale（这里由子页 GET 后的操作触发：直接点删除不方便，改用密码弹层） */
  await page.route('**/api/account', async (route) => {
    const req = route.request();
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    if (req.method() === 'POST' && body.action === 'password') {
      await route.fulfill({ status: 403, json: { ok: false, error: 'account-stale' } });
      return;
    }
    await route.fallback();
  });
  await page.locator('#lockmgr-pwrow').click();
  await page.locator('#lockpw-1').fill('another-pass-1');
  await page.locator('#lockpw-2').fill('another-pass-1');
  await page.locator('#lockpw-go').click();
  await page.waitForURL(/\/settings\/account\/\?return=.*&stale=1$/);
  await page.locator('.sgx-door-row').filter({ hasText: '账号密码' }).click();
  await page.locator('.sgx-door-expand input[type="password"]').fill('pw-123456');
  await page.locator('.sgx-door-expand .sgx-door-btn-primary').click();
  await page.waitForURL(/\/settings\/account\/security\/$/);
  await back(page);
  await page.waitForURL(/\/settings\/account\/$/);
  await expect(page.locator('#acct-main')).toBeVisible();
  await back(page);
  await page.waitForURL(/\/browser\/$/);
});

test('安全与隐私子页返回固定回账号总览（即使是直接打开）', async ({ page }) => {
  await setup(page);
  await page.goto('/settings/account/security/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#acct-sec')).toBeVisible();
  await back(page);
  await page.waitForURL(/\/settings\/account\/$/);
  await back(page);
  await page.waitForURL(/\/settings\/$/);
});
