/**
 * 账号页 E2E（站长凭证升级为账号；静态构建 + API mock，无需真实后端）。
 *
 * 覆盖：
 * - 账号登录三个入口平级（账号通行密钥 / 账号密码 / 根凭证），中英文
 * - 密码登录：错误行内提示；成功后进账号页（显示登录方式、密码状态、通行密钥列表）
 * - 根凭证登录走 /api/root-auth { key, target:'account' }
 * - 通行密钥：取消系统验证不报错；点行立即 busy，只发一次 challenge
 * - 账号页：修改密码（根凭证登录时标题为「重置账号密码」）、删除通行密钥（两步确认）、退出账号
 * - 管理操作返回 account-stale → 回登录区并提示重新验证
 * - 只有锁屏会话（GET /api/account session=null）→ 显示登录区，不当作已登录
 * - 服务器缺账号钥匙（ready=false）→ 登录区显示配置提示
 *
 * 运行：npx playwright test --config=tests/config/playwright.config.js account.spec.js
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

const RECENT = () => ({ by: 'password', authAt: Date.now() - 1000, expiresAt: Date.now() + 3600000, recent: true });

/**
 * /api/account mock：GET 返回 status；POST 按 action 返回 handlers[action]。
 * @param {import('@playwright/test').Page} page
 * @param {{status?: object, handlers?: Record<string, [number, object]>}} o
 * @returns {Promise<Array<object>>} 记录 POST 请求体
 */
async function mockAccount(page, o) {
  const calls = [];
  await page.route('**/api/account', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      const st = typeof o.status === 'function' ? o.status() : o.status;
      await route.fulfill({ status: st && st.ok === false ? 401 : 200, contentType: 'application/json', body: JSON.stringify(st || { ok: false, error: 'session' }) });
      return;
    }
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    calls.push(body);
    const h = (o.handlers || {})[body.action] || [400, { ok: false, error: 'action' }];
    const r = typeof h === 'function' ? h(body) : h;
    await route.fulfill({ status: r[0], contentType: 'application/json', body: JSON.stringify(r[1]) });
  });
  return calls;
}

async function zh(page) {
  await blockExternalRequests(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
}

test.describe('账号登录', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  test('三个入口平级：账号通行密钥 / 账号密码 / 根凭证；只有锁屏会话时不算已登录', async ({ page }) => {
    await mockAccount(page, { status: { ok: true, password: true, passkey: true, ready: true, session: null } });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-login')).toBeVisible();
    await expect(page.locator('#acct-main')).toBeHidden();
    const rows = page.locator('#acct-methods .sgx-door-row .sgx-door-rowtitle');
    await expect(rows).toHaveText(['账号通行密钥', '账号密码', '根凭证']);
    await expect(page.locator('#acct-login-notice')).toBeHidden();
  });

  test('英文页三个入口', async ({ page }) => {
    /* beforeEach 写了 sgx-lang=zh，会被语言跟随带回中文页；这里改成 en（后注册的 init script 后执行） */
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await mockAccount(page, { status: { ok: false, error: 'session' } });
    await page.goto('/en/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-methods .sgx-door-row .sgx-door-rowtitle'))
      .toHaveText(['Account passkey', 'Account password', 'Root credential']);
  });

  test('密码错误：行内提示并清空；改对后进账号页', async ({ page }) => {
    let loggedIn = false;
    const calls = await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: false, ready: true, session: loggedIn ? RECENT() : null }),
      handlers: {
        'login-password': (b) => {
          if (b.password === 'right-password') { loggedIn = true; return [200, { ok: true }]; }
          return [403, { ok: false, error: 'wrong' }];
        },
        list: [200, { ok: true, by: 'password', keys: [{ credId: 'k1', name: 'Galaxy S26', provider: 'Samsung Pass', createdAt: 1760000000000, lastUsedAt: 0 }] }],
      },
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await page.locator('.sgx-door-row').filter({ hasText: '账号密码' }).click();
    const input = page.locator('.sgx-door-expand input[type="password"]');
    await input.fill('wrong-password');
    await page.locator('.sgx-door-expand .sgx-door-btn-primary').click();
    await expect(page.locator('.sgx-door-expand .sgx-door-err')).toHaveText('密码不正确');
    await expect(input).toHaveValue('');
    await input.fill('right-password');
    await input.press('Enter');
    await expect(page.locator('#acct-main')).toBeVisible();
    await expect(page.locator('#acct-login')).toBeHidden();
    await expect(page.locator('#acct-by')).toHaveText('已用账号密码登录');
    await expect(page.locator('#lockmgr-pwsub')).toHaveText('已设置');
    await expect(page.locator('#lockmgr-pklist .lockmgr-pkitem')).toHaveCount(1);
    await expect(page.locator('#lockmgr-pklist')).toContainText('Galaxy S26');
    expect(calls.filter((c) => c.action === 'login-password').length).toBe(2);
  });

  test('根凭证登录走 /api/root-auth target=account', async ({ page }) => {
    let rootBody = null;
    let loggedIn = false;
    await mockAccount(page, {
      status: () => ({ ok: true, password: false, passkey: false, ready: true, session: loggedIn ? Object.assign(RECENT(), { by: 'root' }) : null }),
      handlers: { list: [200, { ok: true, by: 'root', keys: [] }] },
    });
    await page.route('**/api/root-auth', async (route) => {
      rootBody = JSON.parse(route.request().postData() || '{}');
      loggedIn = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('root-key-xyz');
    await page.locator('.sgx-door-expand .sgx-door-btn-primary').click();
    await expect(page.locator('#acct-main')).toBeVisible();
    expect(rootBody).toEqual({ key: 'root-key-xyz', target: 'account' });
    await expect(page.locator('#acct-by')).toContainText('已用根凭证登录');
    await expect(page.locator('#lockmgr-pkempty')).toBeVisible();
    await expect(page.locator('#lockmgr-pwsub')).toHaveText('未设置');
  });

  test('根凭证错误 → 行内「根凭证不正确」', async ({ page }) => {
    await mockAccount(page, { status: { ok: true, password: false, passkey: false, ready: true, session: null } });
    await page.route('**/api/root-auth', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"auth"}' }));
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('nope');
    await page.locator('.sgx-door-expand .sgx-door-btn-primary').click();
    await expect(page.locator('.sgx-door-expand .sgx-door-err')).toHaveText('根凭证不正确');
  });

  test('通行密钥：点行立即 busy、只发一次 challenge；取消系统验证不报错', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: { ok: true, password: false, passkey: true, ready: true, session: null },
      handlers: { challenge: [200, { ok: true, challenge: 'dGVzdC1jaGFsbGVuZ2U', cid: 'c1', rpId: 'localhost', allowCredentials: [] }] },
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      // @ts-ignore
      window.__release = null;
      navigator.credentials.get = function () {
        return new Promise(function (_, reject) {
          // @ts-ignore
          window.__release = function () { reject(Object.assign(new Error('cancel'), { name: 'NotAllowedError' })); };
        });
      };
    });
    const row = page.locator('.sgx-door-row').filter({ hasText: '账号通行密钥' });
    await row.click();
    await expect(row.locator('.sgx-door-spin')).toBeVisible();
    await expect(row).toBeDisabled();
    await row.click({ force: true });
    await page.waitForFunction(() => typeof (/** @type {any} */ (window)).__release === 'function');
    await page.evaluate(() => (/** @type {any} */ (window)).__release());
    await expect(row.locator('.sgx-door-spin')).toHaveCount(0);
    await expect(row).toBeEnabled();
    await expect(page.locator('.sgx-door-err:not([hidden])')).toHaveCount(0);
    expect(calls.filter((c) => c.action === 'challenge').length).toBe(1);
  });

  test('缺账号钥匙（ready=false）→ 登录区显示配置提示', async ({ page }) => {
    await mockAccount(page, { status: { ok: true, password: true, passkey: true, ready: false, session: null } });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-login-notice')).toContainText('缺少账号密钥配置');
  });

  test('密码自动填充后直接点登录，不报「请输入凭证」', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: null },
      handlers: { 'login-password': [403, { ok: false, error: 'wrong' }] },
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await page.locator('.sgx-door-row').filter({ hasText: '账号密码' }).click();
    /* 模拟自动填充：直接写 value（不触发 input 事件） */
    await page.locator('.sgx-door-expand input[type="password"]').evaluate((el) => { /** @type {HTMLInputElement} */ (el).value = 'autofilled-pw'; });
    await page.locator('.sgx-door-expand .sgx-door-btn-primary').click();
    await expect(page.locator('.sgx-door-expand .sgx-door-err')).toHaveText('密码不正确');
    expect(calls.find((c) => c.action === 'login-password').password).toBe('autofilled-pw');
  });
});

test.describe('账号页', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  test('根凭证登录：密码标题为「重置账号密码」，重置成功提示已修改', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: Object.assign(RECENT(), { by: 'root' }) },
      handlers: { list: [200, { ok: true, keys: [] }], password: [200, { ok: true, changed: true }] },
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-main')).toBeVisible();
    await page.locator('#lockmgr-pwrow').click();
    await expect(page.locator('#lockpw-title')).toHaveText('重置账号密码');
    await page.locator('#lockpw-1').fill('brand-new-pass');
    await page.locator('#lockpw-2').fill('brand-new-pass');
    await page.locator('#lockpw-go').click();
    await expect(page.locator('#lockpw-dlg')).toBeHidden();
    expect(calls.find((c) => c.action === 'password')).toEqual({ action: 'password', password: 'brand-new-pass' });
  });

  test('密码与解锁密码相同 → 弹层内「不能与解锁密码相同」', async ({ page }) => {
    await mockAccount(page, {
      status: { ok: true, password: false, passkey: false, ready: true, session: RECENT() },
      handlers: { list: [200, { ok: true, keys: [] }], password: [403, { ok: false, error: 'same-as-lock' }] },
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await page.locator('#lockmgr-pwrow').click();
    await expect(page.locator('#lockpw-title')).toHaveText('设置账号密码');
    await page.locator('#lockpw-1').fill('same-as-lock-1');
    await page.locator('#lockpw-2').fill('same-as-lock-1');
    await page.locator('#lockpw-go').click();
    await expect(page.locator('#lockpw-err')).toHaveText('不能与解锁密码相同');
  });

  test('删除通行密钥：两步确认后调 delete 并刷新列表', async ({ page }) => {
    let keys = [{ credId: 'k1', name: 'Galaxy S26', provider: '', createdAt: 1760000000000, lastUsedAt: 1760000000000 }];
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: true, ready: true, session: RECENT() },
      handlers: {
        list: () => [200, { ok: true, keys: keys }],
        delete: () => { keys = []; return [200, { ok: true }]; },
      },
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    const del = page.locator('#lockmgr-pklist .lockmgr-pkdel');
    await expect(del).toHaveText('删除');
    await del.click();
    await expect(del).toHaveText('再点一次删除');
    expect(calls.filter((c) => c.action === 'delete').length).toBe(0);
    await del.click();
    await expect(page.locator('#lockmgr-pkempty')).toBeVisible();
    expect(calls.find((c) => c.action === 'delete')).toEqual({ action: 'delete', credId: 'k1' });
  });

  test('管理操作 account-stale（登录超过 10 分钟）→ 回登录区并提示重新验证', async ({ page }) => {
    await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: Object.assign(RECENT(), { recent: false }) },
      handlers: { list: [200, { ok: true, keys: [] }], password: [403, { ok: false, error: 'account-stale' }] },
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-main')).toBeVisible();
    await page.locator('#lockmgr-pwrow').click();
    await page.locator('#lockpw-1').fill('another-pass-1');
    await page.locator('#lockpw-2').fill('another-pass-1');
    await page.locator('#lockpw-go').click();
    await expect(page.locator('#acct-login')).toBeVisible();
    await expect(page.locator('#acct-login-notice')).toHaveText('登录已超过 10 分钟，请重新验证');
  });

  test('退出账号 → 回登录区', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: RECENT() },
      handlers: { list: [200, { ok: true, keys: [] }], logout: [200, { ok: true }] },
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await page.locator('#acct-logout').click();
    await expect(page.locator('#acct-login')).toBeVisible();
    expect(calls.some((c) => c.action === 'logout')).toBe(true);
  });
});
