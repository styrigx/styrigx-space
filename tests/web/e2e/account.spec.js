/**
 * 账号页 E2E（站长凭证升级为账号；静态构建 + API mock，无需真实后端）。
 *
 * 覆盖：
 * - 账号登录三个入口平级（账号通行密钥 / 账号密码 / 根凭证），中英文
 * - 密码登录：错误行内提示；成功后进账号总览（账号卡、登录方式、「安全与隐私」一行；没有密码/通行密钥分组）
 * - 根凭证登录走 /api/root-auth { key, target:'account' }
 * - 通行密钥：取消系统验证不报错；点行立即 busy，只发一次 challenge
 * - 安全与隐私子页（/settings/account/security/）：修改密码（根凭证登录时标题为「重置账号密码」）、
 *   删除通行密钥（两步确认）、注册后命名弹层（A1/A2/A3）、列表内重命名、signalCurrentUserDetails；
 *   未登录 → 跳账号页 ?return= 登录后回来
 * - 账号总览：退出账号
 * - 管理操作返回 account-stale → 回登录区并提示重新验证
 * - 只有锁屏会话（GET /api/account session=null）→ 显示登录区，不当作已登录
 * - 服务器缺账号钥匙（ready=false）→ 登录区显示配置提示
 *
 * 运行：npx playwright test --config=tests/config/playwright.config.js account.spec.js
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

const SEC = '/settings/account/security/';
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
    /* 总览：账号卡 + 已登录卡 + 安全与隐私（已保护）；密码/通行密钥分组不在总览 */
    await expect(page.locator('#acct-main .sgx-account-card')).toBeVisible();
    await expect(page.locator('#acct-sec-row')).toContainText('安全与隐私');
    await expect(page.locator('#acct-sec-sub')).toHaveText('已保护');
    await expect(page.locator('#acct-sec-row')).toHaveAttribute('href', '/settings/account/security/');
    await expect(page.locator('#lockmgr-pwrow, #lockmgr-pklist, #lockmgr-pkadd')).toHaveCount(0);
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
    await expect(page.locator('#acct-sec-sub')).toHaveText('未设置登录方式');
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

test.describe('安全与隐私子页', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  test('根凭证登录：密码标题为「重置账号密码」，重置成功提示已修改', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: Object.assign(RECENT(), { by: 'root' }) },
      handlers: { list: [200, { ok: true, keys: [] }], password: [200, { ok: true, changed: true }] },
    });
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sec')).toBeVisible();
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
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
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
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    const del = page.locator('#lockmgr-pklist .lockmgr-pkdel');
    await expect(del).toHaveText('删除');
    await del.click();
    await expect(del).toHaveText('再点一次删除');
    expect(calls.filter((c) => c.action === 'delete').length).toBe(0);
    await del.click();
    await expect(page.locator('#lockmgr-pkempty')).toBeVisible();
    expect(calls.find((c) => c.action === 'delete')).toEqual({ action: 'delete', credId: 'k1' });
  });

  test('管理操作 account-stale（登录超过 10 分钟）→ 跳账号页登录并提示重新验证', async ({ page }) => {
    await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: Object.assign(RECENT(), { recent: false }) },
      handlers: { list: [200, { ok: true, keys: [] }], password: [403, { ok: false, error: 'account-stale' }] },
    });
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sec')).toBeVisible();
    await page.locator('#lockmgr-pwrow').click();
    await page.locator('#lockpw-1').fill('another-pass-1');
    await page.locator('#lockpw-2').fill('another-pass-1');
    await page.locator('#lockpw-go').click();
    await page.waitForURL(/\/settings\/account\/\?return=%2Fsettings%2Faccount%2Fsecurity%2F&stale=1$/);
    await expect(page.locator('#acct-login')).toBeVisible();
    await expect(page.locator('#acct-login-notice')).toHaveText('登录已超过 10 分钟，请重新验证');
  });

});

test.describe('账号总览', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

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

/* 假 credential（注册用）：桩掉 navigator.credentials.create */
async function stubCreate(page) {
  await page.evaluate(() => {
    // @ts-ignore
    window.__createArgs = null;
    navigator.credentials.create = function (opts) {
      // @ts-ignore
      window.__createArgs = { name: opts.publicKey.user.name, displayName: opts.publicKey.user.displayName };
      return Promise.resolve(/** @type {any} */ ({
        id: 'new-cred',
        rawId: new Uint8Array([1, 2, 3]).buffer,
        type: 'public-key',
        response: { clientDataJSON: new Uint8Array([4, 5, 6]).buffer, attestationObject: new Uint8Array([7, 8, 9]).buffer },
      }));
    };
  });
}

test.describe('安全与隐私子页：进入与回跳', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  test('未登录账号 → 跳账号页 ?return=子页；登录后回子页', async ({ page }) => {
    let loggedIn = false;
    await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: false, ready: true, session: loggedIn ? RECENT() : null }),
      handlers: {
        'login-password': () => { loggedIn = true; return [200, { ok: true }]; },
        list: [200, { ok: true, keys: [] }],
      },
    });
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/settings\/account\/\?return=%2Fsettings%2Faccount%2Fsecurity%2F$/);
    await expect(page.locator('#acct-login')).toBeVisible();
    await expect(page.locator('#acct-login-notice')).toBeHidden();
    await page.locator('.sgx-door-row').filter({ hasText: '账号密码' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('pw-123456');
    await page.locator('.sgx-door-expand .sgx-door-btn-primary').click();
    await page.waitForURL(/\/settings\/account\/security\/$/);
    await expect(page.locator('#acct-sec')).toBeVisible();
    await expect(page.locator('#lockmgr-pwsub')).toHaveText('已设置');
  });

  test('英文子页：标题 Security & privacy，总览行链接到英文子页', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await mockAccount(page, {
      status: { ok: true, password: false, passkey: true, ready: true, session: RECENT() },
      handlers: { list: [200, { ok: true, keys: [] }] },
    });
    await page.goto('/en/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sec-row')).toHaveAttribute('href', '/en/settings/account/security/');
    await expect(page.locator('#acct-sec-sub')).toHaveText('Protected');
    await page.locator('#acct-sec-row').click();
    await page.waitForURL(/\/en\/settings\/account\/security\/$/);
    await expect(page.locator('.subpage-title')).toHaveText('Security & privacy');
    await expect(page.locator('#lockmgr-pwsub')).toHaveText('Not set');
  });
});

test.describe('安全与隐私子页：账号通行密钥命名', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  /** @returns {Promise<{calls: Array<object>, keys: () => Array<object>}>} */
  async function setup(page) {
    let keys = [];
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: RECENT() },
      handlers: {
        list: () => [200, { ok: true, keys: keys, userHandle: 'acct-h', userName: 'accountkey', displayName: 'Sloan Gray' }],
        'register-challenge': [200, { ok: true, cid: 'c1', challenge: 'dGVzdC1jaGFsbGVuZ2U', rpId: 'localhost', rp: { name: 'Styrigx' }, user: { id: 'YWNjdC1o', name: 'accountkey', displayName: 'Sloan Gray' }, excludeCredentials: [] }],
        register: (b) => { keys = [{ credId: 'new-cred-id', name: b.name, provider: 'Samsung Pass', createdAt: 1760000000000, lastUsedAt: 0 }]; return [200, { ok: true, credId: 'new-cred-id' }]; },
        rename: (b) => { keys = keys.map((k) => (k.credId === b.credId ? Object.assign({}, k, { name: b.name }) : k)); return [200, { ok: true, name: b.name }]; },
      },
    });
    return { calls, keys: () => keys };
  }

  test('注册成功弹命名弹层（预填设备名）；改名保存 → rename；user.name 为 accountkey', async ({ page }) => {
    const { calls } = await setup(page);
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sec')).toBeVisible();
    await stubCreate(page);
    await page.locator('#lockmgr-pkadd').click();
    const dlg = page.locator('#lockpkname-dlg');
    await expect(dlg).toBeVisible();
    const reg = calls.find((c) => c.action === 'register');
    expect(reg.name.length).toBeGreaterThan(0);
    await expect(page.locator('#lockpkname-input')).toHaveValue(reg.name);
    expect(await page.evaluate(() => /** @type {any} */ (window).__createArgs)).toEqual({ name: 'accountkey', displayName: 'Sloan Gray' });
    await page.locator('#lockpkname-input').fill('我的 S26 Ultra');
    await page.locator('#lockpkname-save').click();
    await expect(dlg).toBeHidden();
    expect(calls.find((c) => c.action === 'rename')).toEqual({ action: 'rename', credId: 'new-cred-id', name: '我的 S26 Ultra' });
    await expect(page.locator('#lockmgr-pklist .lockmgr-pkname input')).toHaveValue('我的 S26 Ultra');
  });

  test('没改名直接保存 / 跳过：不调 rename；空名提示「名字不能为空」', async ({ page }) => {
    const { calls } = await setup(page);
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sec')).toBeVisible();
    await stubCreate(page);
    await page.locator('#lockmgr-pkadd').click();
    await expect(page.locator('#lockpkname-dlg')).toBeVisible();
    await page.locator('#lockpkname-input').fill('   ');
    await page.locator('#lockpkname-save').click();
    await expect(page.locator('#lockpkname-err')).toHaveText('名字不能为空');
    await page.locator('#lockpkname-skip').click();
    await expect(page.locator('#lockpkname-dlg')).toBeHidden();
    expect(calls.filter((c) => c.action === 'rename').length).toBe(0);
  });

  test('A1 点遮罩不关；A3 × 关闭；Escape（无软键盘）关闭', async ({ page }) => {
    await setup(page);
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sec')).toBeVisible();
    await stubCreate(page);
    const dlg = page.locator('#lockpkname-dlg');
    await page.locator('#lockmgr-pkadd').click();
    await expect(dlg).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(dlg).toBeVisible();
    await expect(page.locator('#lockpkname-input')).not.toBeFocused();
    await dlg.locator('[data-dlg-close]').click();
    await expect(dlg).toBeHidden();
    await page.locator('#lockmgr-pkadd').click();
    await expect(dlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
  });

  test('列表内点名字重命名：回车保存调 rename；清空 → 恢复原名不调接口', async ({ page }) => {
    const keys0 = [{ credId: 'k1', name: 'Galaxy S26', provider: 'Samsung Pass', createdAt: 1760000000000, lastUsedAt: 0 }];
    let keys = keys0;
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: true, ready: true, session: RECENT() },
      handlers: {
        list: () => [200, { ok: true, keys: keys }],
        rename: (b) => { keys = [Object.assign({}, keys0[0], { name: b.name })]; return [200, { ok: true, name: b.name }]; },
      },
    });
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    const input = page.locator('#lockmgr-pklist .lockmgr-pkname input');
    await expect(input).toHaveValue('Galaxy S26');
    await expect(page.locator('#lockmgr-pklist .lockmgr-pkdate')).toContainText('Samsung Pass');
    await input.fill('');
    await input.press('Enter');
    await expect(input).toHaveValue('Galaxy S26');
    expect(calls.filter((c) => c.action === 'rename').length).toBe(0);
    await input.fill('平板');
    await input.press('Enter');
    await expect.poll(() => calls.filter((c) => c.action === 'rename').length).toBe(1);
    expect(calls.find((c) => c.action === 'rename')).toEqual({ action: 'rename', credId: 'k1', name: '平板' });
    await expect(input).toHaveValue('平板');
  });

  test('rename 返回 account-stale → 恢复原名并跳账号页重新登录', async ({ page }) => {
    await mockAccount(page, {
      status: { ok: true, password: true, passkey: true, ready: true, session: Object.assign(RECENT(), { recent: false }) },
      handlers: {
        list: [200, { ok: true, keys: [{ credId: 'k1', name: 'Galaxy S26', provider: '', createdAt: 1760000000000, lastUsedAt: 0 }] }],
        rename: [403, { ok: false, error: 'account-stale' }],
      },
    });
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    const input = page.locator('#lockmgr-pklist .lockmgr-pkname input');
    await input.fill('新名字');
    await input.press('Enter');
    await page.waitForURL(/\/settings\/account\/\?return=.*&stale=1$/);
    await expect(page.locator('#acct-login-notice')).toHaveText('登录已超过 10 分钟，请重新验证');
  });

  test('signalCurrentUserDetails：list 带账号 handle 时发一次（name=accountkey）', async ({ page }) => {
    await setup(page);
    await page.addInitScript(() => {
      // @ts-ignore
      window.__sig = [];
      // @ts-ignore
      window.PublicKeyCredential = window.PublicKeyCredential || function () {};
      // @ts-ignore
      window.PublicKeyCredential.signalCurrentUserDetails = function (o) { window.__sig.push(o); return Promise.resolve(); };
    });
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sec')).toBeVisible();
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__sig.length)).toBe(1);
    expect(await page.evaluate(() => /** @type {any} */ (window).__sig[0])).toEqual({ rpId: 'localhost', userId: 'acct-h', name: 'accountkey', displayName: 'Sloan Gray' });
  });
});

test.describe('账号总览：signalCurrentUserDetails', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  test('支持时进总览拉一次 list 发改名（通行密钥登录后同样走这里）', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: true, ready: true, session: Object.assign(RECENT(), { by: 'passkey' }) },
      handlers: { list: [200, { ok: true, keys: [], userHandle: 'acct-h', userName: 'accountkey', displayName: 'Sloan Gray' }] },
    });
    await page.addInitScript(() => {
      // @ts-ignore
      window.__sig = [];
      // @ts-ignore
      window.PublicKeyCredential = window.PublicKeyCredential || function () {};
      // @ts-ignore
      window.PublicKeyCredential.signalCurrentUserDetails = function (o) { window.__sig.push(o); return Promise.resolve(); };
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-main')).toBeVisible();
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__sig.length)).toBe(1);
    expect(await page.evaluate(() => /** @type {any} */ (window).__sig[0])).toEqual({ rpId: 'localhost', userId: 'acct-h', name: 'accountkey', displayName: 'Sloan Gray' });
    expect(calls.filter((c) => c.action === 'list').length).toBe(1);
  });

  test('不支持 signalCurrentUserDetails：总览不拉 list', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: true, ready: true, session: RECENT() },
      handlers: { list: [200, { ok: true, keys: [] }] },
    });
    await page.addInitScript(() => {
      // @ts-ignore
      if (window.PublicKeyCredential) delete window.PublicKeyCredential.signalCurrentUserDetails;
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-main')).toBeVisible();
    await expect(page.locator('#acct-sec-sub')).toHaveText('已保护');
    expect(calls.filter((c) => c.action === 'list').length).toBe(0);
  });
});
