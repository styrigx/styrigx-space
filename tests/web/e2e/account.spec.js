/**
 * 账号页 E2E（站长凭证升级为账号；静态构建 + API mock，无需真实后端）。
 *
 * 覆盖：
 * - 账号登录（PR3）：顶栏页名「登录账号」；头像 + 欢迎回来；通行密钥登录（强调色主按钮）/ 密码登录（原地展开）/
 *   无法登录？；设了哪个显示哪个（读不到状态两个都显示），中英文；根凭证不再是登录入口
 * - 密码登录：错误行内提示；成功后进账号总览（账号卡、「安全与隐私」一行）
 * - 重置登录页：根凭证走 /api/root-auth { key, purpose:'account' }，成功直接进安全与隐私
 * - 通行密钥：取消系统验证不报错；点了立即 busy，只发一次 challenge
 * - 安全与隐私子页（/settings/account/security/）：修改密码（根凭证登录时标题为「重置账号密码」）、
 *   删除通行密钥（两步确认）、注册后命名弹层（A1/A2/A3）、列表内重命名、signalCurrentUserDetails；
 *   未登录 → 跳账号页 ?return= 登录后回来
 * - 账号总览：点账号卡进「账号信息」子页，在那里退出账号
 * - 安全与隐私子页的门：没有门票 → 验证行（设了哪个显示哪个），door:true 验证后进门 + 倒计时；
 *   管理操作返回 403 door → 回门口并提示「验证已过期」
 * - 只有锁屏会话（GET /api/account session=null）→ 显示登录区，不当作已登录
 * - 服务器缺账号钥匙（ready=false）→ 登录区显示配置提示
 *
 * 运行：npx playwright test --config=tests/config/playwright.config.js account.spec.js
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

const SEC = '/settings/account/security/';
const RECENT = () => ({ by: 'password', authAt: Date.now() - 1000, expiresAt: Date.now() + 3600000, recent: true });
/* 安全与隐私子页的门票（3 分钟） */
const DOOR = () => ({ by: 'password', expiresAt: Date.now() + 170000 });

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

  test('PR3 版面：顶栏页名「登录账号」；头像 + 欢迎回来；通行密钥登录（主）/ 密码登录（次）/ 无法登录？；没有大标题、盾牌、构建号、根凭证入口', async ({ page }) => {
    await mockAccount(page, { status: { ok: true, password: true, passkey: true, ready: true, session: null } });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-login')).toBeVisible();
    await expect(page.locator('#acct-main')).toBeHidden();
    await expect(page.locator('.sgx-tb-title')).toHaveText('登录账号');
    await expect(page.locator('.acct-login-welcome')).toHaveText('欢迎回来');
    await expect(page.locator('.acct-login-avatar')).toBeVisible();
    await expect(page.locator('#acct-pk-btn')).toBeVisible();
    await expect(page.locator('#acct-pk-btn')).toContainText('通行密钥登录');
    await expect(page.locator('#acct-pw-btn')).toHaveText('密码登录');
    await expect(page.locator('#acct-pw-form')).toBeHidden();
    await expect(page.locator('#acct-cant')).toHaveText('无法登录？');
    await expect(page.locator('#acct-cant')).toHaveAttribute('href', '/settings/account/reset/');
    /* 正文里没有大标题 / 盾牌 / 构建号 / 根凭证 */
    await expect(page.locator('#acct-login .set-gh, #acct-login .sgx-build-tag-wrap, #acct-login .set-ic')).toHaveCount(0);
    await expect(page.locator('#acct-login')).not.toContainText('根凭证', { useInnerText: true });
    /* 主按钮 = 主题色主色角色（--sgx-btn-primary-bg），次按钮 = 主色容器角色 */
    const bg = await page.locator('#acct-pk-btn').evaluate((el) => getComputedStyle(el).backgroundColor);
    const bg2 = await page.locator('#acct-pw-btn').evaluate((el) => getComputedStyle(el).backgroundColor);
    const role = (v) => page.evaluate((vv) => {
      const d = document.createElement('div');
      d.style.color = 'var(' + vv + ')';
      document.body.appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    }, v);
    expect(bg2).toBe(await role('--sgx-btn-secondary-bg'));
    const accent = await page.evaluate(() => {
      const d = document.createElement('div');
      d.style.color = 'var(--sgx-btn-primary-bg)';
      document.body.appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    });
    expect(bg).toBe(accent);
    await expect(page.locator('#acct-login-notice')).toBeHidden();
  });

  test('设了哪个显示哪个：只设密码 → 只有密码登录；都没设 → 提示 + 无法登录？', async ({ page }) => {
    let st = { ok: true, password: true, passkey: false, ready: true, session: null };
    await mockAccount(page, { status: () => st });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-pw-btn')).toBeVisible();
    await expect(page.locator('#acct-pk-btn')).toBeHidden();
    await expect(page.locator('#acct-login-none')).toBeHidden();
    st = { ok: true, password: false, passkey: false, ready: true, session: null };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-login-none')).toBeVisible();
    await expect(page.locator('#acct-pk-btn')).toBeHidden();
    await expect(page.locator('#acct-pw-btn')).toBeHidden();
    await expect(page.locator('#acct-cant')).toBeVisible();
  });

  test('英文页：Sign in / Welcome back / 两个按钮 / Can’t sign in?（访客读不到状态也显示两个）', async ({ page }) => {
    /* beforeEach 写了 sgx-lang=zh，会被语言跟随带回中文页；这里改成 en（后注册的 init script 后执行） */
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await mockAccount(page, { status: { ok: false, error: 'session' } });
    await page.goto('/en/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-tb-title')).toHaveText('Sign in');
    await expect(page.locator('.acct-login-welcome')).toHaveText('Welcome back');
    await expect(page.locator('#acct-pk-btn')).toContainText('Sign in with passkey');
    await expect(page.locator('#acct-pw-btn')).toHaveText('Sign in with password');
    await expect(page.locator('#acct-cant')).toHaveAttribute('href', '/en/settings/account/reset/');
  });

  test('密码登录：原地展开；错误行内提示并清空；改对后进账号页，顶栏页名回到「账号」', async ({ page }) => {
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
    await page.click('#acct-pw-btn');
    await expect(page.locator('#acct-pw-form')).toBeVisible();
    await expect(page.locator('#acct-pw-btn')).toHaveAttribute('aria-expanded', 'true');
    const input = page.locator('#acct-pw-input');
    await expect(input).toBeFocused();
    await input.fill('wrong-password');
    await page.click('#acct-pw-go');
    await expect(page.locator('#acct-pw-err')).toHaveText('密码不正确');
    await expect(input).toHaveValue('');
    await input.fill('right-password');
    await input.press('Enter');
    await expect(page.locator('#acct-main')).toBeVisible();
    await expect(page.locator('#acct-login')).toBeHidden();
    await expect(page.locator('.sgx-tb-title')).toHaveText('账号');
    await expect(page.locator('#acct-logout, #acct-by')).toHaveCount(0);
    await expect(page.locator('#acct-main .sgx-account-card')).toBeVisible();
    await expect(page.locator('#acct-sec-row')).toContainText('安全与隐私');
    await expect(page.locator('#acct-sec-sub')).toHaveText('已保护');
    await expect(page.locator('#acct-sec-row')).toHaveAttribute('href', '/settings/account/security/');
    expect(calls.filter((c) => c.action === 'login-password').length).toBe(2);
  });

  test('再点「密码登录」收起密码框', async ({ page }) => {
    await mockAccount(page, { status: { ok: true, password: true, passkey: true, ready: true, session: null } });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await page.click('#acct-pw-btn');
    await expect(page.locator('#acct-pw-form')).toBeVisible();
    await page.click('#acct-pw-btn');
    await expect(page.locator('#acct-pw-form')).toBeHidden();
    await expect(page.locator('#acct-pw-btn')).toHaveAttribute('aria-expanded', 'false');
  });

  test('通行密钥登录：点了立即 busy、只发一次 challenge；取消系统验证不报错', async ({ page }) => {
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
    const btn = page.locator('#acct-pk-btn');
    await btn.click();
    await expect(btn).toBeDisabled();
    await expect(btn).toContainText('正在唤起通行密钥…');
    await btn.click({ force: true });
    await page.waitForFunction(() => typeof (/** @type {any} */ (window)).__release === 'function');
    await page.evaluate(() => (/** @type {any} */ (window)).__release());
    await expect(btn).toBeEnabled();
    await expect(btn).toContainText('通行密钥登录');
    await expect(page.locator('#acct-pk-err')).toBeHidden();
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
    await page.click('#acct-pw-btn');
    /* 模拟自动填充：直接写 value（不触发 input 事件） */
    await page.locator('#acct-pw-input').evaluate((el) => { /** @type {HTMLInputElement} */ (el).value = 'autofilled-pw'; });
    await page.click('#acct-pw-go');
    await expect(page.locator('#acct-pw-err')).toHaveText('密码不正确');
    expect(calls.find((c) => c.action === 'login-password').password).toBe('autofilled-pw');
  });
});

test.describe('重置登录（/settings/account/reset/）', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  test('顶栏页名「重置登录」；根凭证 → /api/root-auth { key, purpose:account } → 直接进安全与隐私', async ({ page }) => {
    let rootBody = null;
    await mockAccount(page, {
      status: { ok: true, password: false, passkey: false, ready: true, session: Object.assign(RECENT(), { by: 'root' }), door: { by: 'root', expiresAt: Date.now() + 170000 } },
      handlers: { list: [200, { ok: true, by: 'root', keys: [] }] },
    });
    await page.route('**/api/root-auth', async (route) => {
      rootBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto('/settings/account/reset/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-tb-title')).toHaveText('重置登录');
    await expect(page.locator('.sgx-reset-lead')).toHaveText('先用根凭证验证身份');
    /* 全站同一个根凭证框：隐藏用户名 root（Samsung Pass 能填） */
    await expect(page.locator('.sgx-reset input[autocomplete="username"]')).toHaveValue('root');
    await page.fill('#sgx-reset-root', 'root-key-xyz');
    await page.click('#sgx-reset-go');
    await expect(page).toHaveURL(/\/settings\/account\/security\/$/);
    expect(rootBody).toMatchObject({ key: 'root-key-xyz', purpose: 'account' }); /* 另带 device（型号 / 平台，设备页用） */
  });

  test('根凭证错误 → 行内「根凭证不正确」并清空；空值提示', async ({ page }) => {
    await mockAccount(page, { status: { ok: true, password: false, passkey: false, ready: true, session: null } });
    await page.route('**/api/root-auth', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"auth"}' }));
    await page.goto('/settings/account/reset/', { waitUntil: 'domcontentloaded' });
    await page.click('#sgx-reset-go');
    await expect(page.locator('#sgx-reset-err')).toHaveText('请输入根凭证');
    await page.fill('#sgx-reset-root', 'nope');
    await page.press('#sgx-reset-root', 'Enter');
    await expect(page.locator('#sgx-reset-err')).toHaveText('根凭证不正确');
    await expect(page.locator('#sgx-reset-root')).toHaveValue('');
    await expect(page).toHaveURL(/\/settings\/account\/reset\/$/);
  });

  test('英文：Reset sign-in', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await mockAccount(page, { status: { ok: false, error: 'session' } });
    await page.goto('/en/settings/account/reset/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-tb-title')).toHaveText('Reset sign-in');
    await expect(page.locator('#sgx-reset-go')).toHaveText('Continue');
  });
});

test.describe('安全与隐私子页', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  test('根凭证登录：密码标题为「重置账号密码」，重置成功提示已修改', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: Object.assign(RECENT(), { by: 'root' }), door: DOOR() },
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
      status: { ok: true, password: false, passkey: false, ready: true, session: RECENT(), door: DOOR() },
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
      status: { ok: true, password: true, passkey: true, ready: true, session: RECENT(), door: DOOR() },
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

  test('门：没有门票 → 验证行（设了哪个显示哪个）；密码验证带 door:true → 进门 + 倒计时胶囊', async ({ page }) => {
    let door = null;
    const calls = await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: false, ready: true, session: RECENT(), door: door }),
      handlers: {
        'login-password': (b) => { if (b.door === true) door = DOOR(); return [200, { ok: true }]; },
        list: [200, { ok: true, keys: [] }],
      },
    });
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-door')).toBeVisible();
    await expect(page.locator('#acct-sec')).toBeHidden();
    await expect(page.locator('#acct-door-methods .sgx-door-row .sgx-door-rowtitle')).toHaveText(['账号密码']);
    await expect(page.locator('#acct-door-cant')).toHaveAttribute('href', '/settings/account/reset/');
    await page.locator('#acct-door-methods .sgx-door-row').filter({ hasText: '账号密码' }).click();
    await page.locator('#acct-door-methods .sgx-door-expand input[type="password"]').fill('pw-123456');
    await expect(page.locator('#acct-door-methods .sgx-door-btn-primary')).toHaveText('验证');
    await page.locator('#acct-door-methods .sgx-door-btn-primary').click();
    await expect(page.locator('#acct-sec')).toBeVisible();
    await expect(page.locator('#acct-door')).toBeHidden();
    expect(calls.find((c) => c.action === 'login-password')).toMatchObject({ action: 'login-password', password: 'pw-123456', door: true });
    await expect(page.locator('#sgx-door-countdown')).toContainText(/验证剩余 [23]:\d\d/);
  });

  test('门：根凭证不再是验证入口；都没设 → 没有验证行，只有「无法登录？」进重置登录', async ({ page }) => {
    await mockAccount(page, {
      status: () => ({ ok: true, password: false, passkey: false, ready: true, session: RECENT(), door: null }),
      handlers: { list: [200, { ok: true, keys: [] }] },
    });
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-door')).toBeVisible();
    await expect(page.locator('#acct-door-methods .sgx-door-row')).toHaveCount(0);
    await expect(page.locator('#acct-door')).not.toContainText('根凭证', { useInnerText: true });
    await page.click('#acct-door-cant');
    await expect(page).toHaveURL(/\/settings\/account\/reset\/$/);
  });

  test('管理操作返回 403 door（门票过期）→ 回门口并提示「验证已过期」', async ({ page }) => {
    await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: RECENT(), door: DOOR() },
      handlers: { list: [200, { ok: true, keys: [] }], password: [403, { ok: false, error: 'door' }] },
    });
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sec')).toBeVisible();
    await page.locator('#lockmgr-pwrow').click();
    await page.locator('#lockpw-1').fill('another-pass-1');
    await page.locator('#lockpw-2').fill('another-pass-1');
    await page.locator('#lockpw-go').click();
    await expect(page.locator('#acct-door')).toBeVisible();
    await expect(page.locator('#acct-sec')).toBeHidden();
    await expect(page.locator('#acct-door-notice')).toHaveText('验证已过期，请重新验证');
    await expect(page.locator('#sgx-door-countdown')).toHaveCount(0);
  });

  test('离开本页（pagehide）：发 door-clear 作废门票', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: RECENT(), door: DOOR() },
      handlers: { list: [200, { ok: true, keys: [] }], 'door-clear': [200, { ok: true }] },
    });
    /* keepalive 请求在页面卸载时发出，route 拦不稳；在 context 上听请求体 */
    const sent = [];
    page.context().on('request', (r) => {
      if (r.url().endsWith('/api/account') && r.method() === 'POST') sent.push(r.postData() || '');
    });
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sec')).toBeVisible();
    /* 真实导航时的 keepalive 请求 Playwright 不一定看得到；直接派发 pagehide 验证监听器发出了 door-clear */
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await expect.poll(() => sent.concat(calls.map((c) => JSON.stringify(c))).filter((b) => b.includes('door-clear')).length).toBeGreaterThan(0);
  });

});

test.describe('账号总览', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  test('点账号卡 → 账号信息子页（已登录卡）；退出账号 → 回账号页登录区', async ({ page }) => {
    let loggedIn = true;
    const calls = await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: false, ready: true, session: loggedIn ? RECENT() : null }),
      handlers: { list: [200, { ok: true, keys: [] }], logout: () => { loggedIn = false; return [200, { ok: true }]; } },
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await page.locator('#acct-main [data-acct-card] .sgx-ac-name').click();
    await page.waitForURL(/\/settings\/account\/profile\/$/);
    await expect(page.locator('#acct-profile')).toBeVisible();
    await expect(page.locator('#acct-by')).toHaveText('已用账号密码登录');
    await page.locator('#acct-logout').click();
    await page.waitForURL(/\/settings\/account\/$/);
    await expect(page.locator('#acct-login')).toBeVisible();
    expect(calls.some((c) => c.action === 'logout')).toBe(true);
  });

  test('账号信息子页：没有账号会话 → 跳账号页 ?return=子页', async ({ page }) => {
    await mockAccount(page, { status: { ok: true, password: true, passkey: false, ready: true, session: null } });
    await page.goto('/settings/account/profile/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/settings\/account\/\?return=%2Fsettings%2Faccount%2Fprofile%2F$/);
    await expect(page.locator('#acct-login')).toBeVisible();
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
    await page.click('#acct-pw-btn');
    await page.fill('#acct-pw-input', 'pw-123456');
    await page.click('#acct-pw-go');
    await page.waitForURL(/\/settings\/account\/security\/$/);
    /* 登录只是进账号；安全与隐私还要过门 */
    await expect(page.locator('#acct-door')).toBeVisible();
    await expect(page.locator('#acct-sec')).toBeHidden();
  });

  test('英文子页：标题 Security & privacy，总览行链接到英文子页', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await mockAccount(page, {
      status: { ok: true, password: false, passkey: true, ready: true, session: RECENT(), door: DOOR() },
      handlers: { list: [200, { ok: true, keys: [] }] },
    });
    await page.goto('/en/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sec-row')).toHaveAttribute('href', '/en/settings/account/security/');
    await expect(page.locator('#acct-sec-sub')).toHaveText('Protected');
    await page.locator('#acct-sec-row').click();
    await page.waitForURL(/\/en\/settings\/account\/security\/$/);
    await expect(page.locator('.sgx-tb-title')).toHaveText('Security & privacy');
    await expect(page.locator('#lockmgr-pwsub')).toHaveText('Not set');
  });
});

test.describe('安全与隐私子页：账号通行密钥命名', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  /** @returns {Promise<{calls: Array<object>, keys: () => Array<object>}>} */
  async function setup(page) {
    let keys = [];
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: RECENT(), door: DOOR() },
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
      status: { ok: true, password: true, passkey: true, ready: true, session: RECENT(), door: DOOR() },
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

  test('rename 返回 403 door → 回门口重新验证', async ({ page }) => {
    await mockAccount(page, {
      status: { ok: true, password: true, passkey: true, ready: true, session: RECENT(), door: DOOR() },
      handlers: {
        list: [200, { ok: true, keys: [{ credId: 'k1', name: 'Galaxy S26', provider: '', createdAt: 1760000000000, lastUsedAt: 0 }] }],
        rename: [403, { ok: false, error: 'door' }],
      },
    });
    await page.goto(SEC, { waitUntil: 'domcontentloaded' });
    const input = page.locator('#lockmgr-pklist .lockmgr-pkname input');
    await input.fill('新名字');
    await input.press('Enter');
    await expect(page.locator('#acct-door')).toBeVisible();
    await expect(page.locator('#acct-door-notice')).toHaveText('验证已过期，请重新验证');
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

test.describe('访客头像', () => {
  test('访客：抽屉头的头像只是装饰 —— 没有链接、点了不跳转', async ({ page }) => {
    await zh(page);
    /* 像线上 L1 那样把会话角色写进 <html> */
    await page.route(/^http:\/\/localhost:\d+\/$/, async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(/<html([^>]*)>/i, '<html$1 data-sgx-session="valid" data-sgx-role="visitor">');
      await route.fulfill({ response: res, body: body });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const me = page.locator('.sgx-drawer-me');
    await page.locator('.sgx-tb-nav').click();
    await expect(page.locator('#sgx-drawer')).toHaveAttribute('data-state', 'open');
    await expect(me).not.toHaveAttribute('href', /.*/);
    await expect(me).toHaveAttribute('aria-disabled', 'true');
    expect(await me.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    await me.click({ force: true });
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('站长：头像照常链到账号页', async ({ page }) => {
    await zh(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-drawer-me')).toHaveAttribute('href', '/settings/account/');
  });
});

test.describe('主题色角色（PR3）', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  const roleOf = (page, v) => page.evaluate((vv) => getComputedStyle(document.documentElement).getPropertyValue(vv).trim(), v);

  test('预设色板：登录页按钮用该预设手调的角色（terra 浅色主色 = 种子 #8a4b2d，次按钮 = secondary-container）', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-palette', 'terra'); localStorage.setItem('sgx-theme-mode', 'light'); } catch (e) {} });
    await mockAccount(page, { status: { ok: true, password: true, passkey: true, ready: true, session: null } });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-pk-btn')).toBeVisible();
    expect(await roleOf(page, '--sgx-primary')).toBe('#8a4b2d');
    expect(await page.locator('#acct-pk-btn').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(138, 75, 45)');
    expect(await roleOf(page, '--sgx-btn-secondary-bg')).toBe(await roleOf(page, '--sgx-secondary-container'));
  });

  test('自定义 #rrggbb：设置页按种子算出整套角色并缓存，之后页面首屏直接用缓存；点预设回到预设', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem('seeded')) { localStorage.setItem('sgx-accent', '#ff6b9d'); localStorage.setItem('sgx-theme-mode', 'light'); sessionStorage.setItem('seeded', '1'); }
      } catch (e) {}
    });
    await page.goto('/settings/theme/', { waitUntil: 'domcontentloaded' });
    /* 设计稿校验种子：#ff6b9d → 最近预设 cherry，浅色主色压到 #ba2863（2026-10-21 容器阶梯加深后要在更深的 container-high 上仍 ≥4.6:1，比原来的 #bb2a65 深一点） */
    await expect.poll(() => roleOf(page, '--sgx-primary')).toBe('#ba2863');
    const cache = await page.evaluate(() => localStorage.getItem('sgx-accent-css'));
    expect(cache && cache.indexOf('v5|#ff6b9d\n')).toBe(0);
    await mockAccount(page, { status: { ok: true, password: true, passkey: true, ready: true, session: null } });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('style#sgx-accent-roles')).toHaveCount(1);
    expect(await roleOf(page, '--sgx-primary')).toBe('#ba2863');
    expect(await page.locator('#acct-pk-btn').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(186, 40, 99)');
    /* 深色：同一种子的深色角色 */
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    expect(await roleOf(page, '--sgx-primary')).not.toBe('#ba2863');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    /* 回设置页点「恢复默认」（2026-10-21：lake 不再有色块）：清掉自定义色 */
    await page.goto('/settings/theme/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#palette-reset')).toHaveAttribute('aria-disabled', 'false');
    await page.locator('#palette-reset').click();
    await expect(page.locator('#palette-reset')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('style#sgx-accent-roles')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('sgx-accent'))).toBeNull();
    expect(await roleOf(page, '--sgx-primary')).toBe('#2f5f86');
  });
});

test.describe('设备子页（2026-10-22）', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  const DEVS = () => [
    { sid: 'aaaaaaaaaaaaaaaa', current: true, name: 'Galaxy S23 Ultra', model: 'SM-S918B', platform: 'Android', browser: 'Samsung Internet', country: 'CN', lastSeen: Date.now() },
    { sid: 'bbbbbbbbbbbbbbbb', current: false, name: 'Windows', platform: 'Windows', browser: 'Chrome', country: 'CN', lastSeen: Date.now() - 3 * 3600e3 },
  ];

  test('总览「设备」一行显示此设备名字 → 进设备页；此设备在最上面，其他设备两步确认退出', async ({ page }) => {
    let devs = DEVS();
    const calls = await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: false, ready: true, session: { ...RECENT(), device: 'Galaxy S23 Ultra' } }),
      handlers: {
        list: [200, { ok: true, keys: [] }],
        devices: () => [200, { ok: true, devices: devs }],
        'device-revoke': (b) => { devs = devs.filter((d) => d.sid !== b.sid); return [200, { ok: true }]; },
      },
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-dev-sub')).toHaveText('Galaxy S23 Ultra');
    await page.locator('#acct-dev-row').click();
    await page.waitForURL(/\/settings\/account\/devices\/$/);
    await expect(page.locator('#acct-devices')).toBeVisible();
    await expect(page.locator('#acct-dev-this')).toContainText('Galaxy S23 Ultra');
    await expect(page.locator('#acct-dev-this')).toContainText('当前在线');
    const rows = page.locator('#acct-dev-list .acct-dev-item');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Windows');
    await expect(rows.first()).toContainText('3 小时前活动 · Chrome');
    const btn = rows.first().locator('button');
    await btn.click();
    await expect(btn).toHaveText('再点一次退出');
    expect(calls.some((c) => c.action === 'device-revoke')).toBe(false);
    await btn.click();
    await expect(page.locator('#acct-dev-empty')).toBeVisible();
    expect(calls.find((c) => c.action === 'device-revoke').sid).toBe('bbbbbbbbbbbbbbbb');
  });

  test('设备子页：没有账号会话（401）→ 跳账号页 ?return=子页', async ({ page }) => {
    await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: null },
      handlers: { devices: [401, { ok: false, error: 'account' }] },
    });
    await page.goto('/settings/account/devices/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/settings\/account\/\?return=%2Fsettings%2Faccount%2Fdevices%2F$/);
    await expect(page.locator('#acct-login')).toBeVisible();
  });
});

test.describe('云同步一行（2026-10-22）', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  test('在安全与隐私下面；默认开，点一下关（sgx-cloud-sync=0），再点打开', async ({ page }) => {
    await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: false, ready: true, session: RECENT() }),
      handlers: { list: [200, { ok: true, keys: [] }] },
    });
    await page.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-main')).toBeVisible();
    const ids = await page.locator('#acct-main section .set-row').evaluateAll((els) => els.map((e) => e.id));
    expect(ids).toEqual(['acct-dev-row', 'acct-sec-row', 'acct-sync-row']);
    const sw = page.locator('#acct-sync-sw');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#acct-sync-sub')).toHaveText('已开启，设置在登录的设备间同步');
    await page.locator('#acct-sync-row').click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#acct-sync-sub')).toHaveText('已关闭，设置只存在此设备');
    expect(await page.evaluate(() => localStorage.getItem('sgx-cloud-sync'))).toBe('0');
    await page.locator('#acct-sync-row').click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => localStorage.getItem('sgx-cloud-sync'))).toBe(null);
  });
});
