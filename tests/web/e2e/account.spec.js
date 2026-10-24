/**
 * 账号页 E2E（站长凭证升级为账号；静态构建 + API mock，无需真实后端）。
 *
 * 覆盖：
 * - 账号登录（PR3）：顶栏页名「登录账号」；头像 + 欢迎回来；通行密钥登录（强调色主按钮）/ 密码登录（原地展开）/
 *   无法登录？；设了哪个显示哪个（读不到状态两个都显示），中英文；根凭证不再是登录入口
 * - 密码登录：错误行内提示；成功后进账号总览（账号卡、「安全与隐私」一行）
 * - 重置登录页：根凭证走 /api/root-auth { key, purpose:'account' }，成功直接进安全与隐私
 * - 通行密钥：取消系统验证不报错；点了立即 busy，只发一次 challenge
 * - 安全与隐私子页（/account/security/）：修改密码（根凭证登录时标题为「重置账号密码」）、
 *   删除通行密钥（两步确认）、注册后命名弹层（A1/A2/A3）、列表内重命名、signalCurrentUserDetails；
 *   未登录 → 跳账号页 ?return= 登录后回来
 * - 账号总览（2026-10-24 PR4）：账号卡只展示（已登录，点头像换头像，见 avatar-edit.spec.js），「账号信息」子页删除；
 *   登录方式 / 退出账号 / 保持登录说明在设备页「此设备」卡；云同步一行进 /account/sync/（总开关 + 同步项）
 * - 安全与隐私子页的门：没有门票 → 验证行（设了哪个显示哪个），door:true 验证后进门 + 倒计时；
 *   管理操作返回 403 door → 回门口并提示「验证已过期」
 * - 只有锁屏会话（GET /api/account session=null）→ 显示登录区，不当作已登录
 * - 服务器缺账号钥匙（ready=false）→ 登录区显示配置提示
 *
 * 运行：npx playwright test --config=tests/config/playwright.config.js account.spec.js
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

const SEC = '/account/security/';
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

  /** 「登录」→ 方式弹层（与锁屏同一个组件） */
  async function openSheet(page) {
    await page.click('#acct-login-go');
    await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible();
  }
  async function openPw(page) {
    await openSheet(page);
    await page.click('#acct-pw-btn');
    await expect(page.locator('#acct-pw-input')).toBeVisible();
  }

  test('与锁屏同一套版面：顶栏页名「登录账号」；头像 + 欢迎回来 + 记录 · 收藏 · 探索 · 享受 + 「登录」（与锁屏「解锁」同款）；没有大标题、盾牌、构建号、根凭证入口', async ({ page }) => {
    await mockAccount(page, { status: { ok: true, password: true, passkey: true, ready: true, session: null } });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-login')).toBeVisible();
    await expect(page.locator('#acct-main')).toBeHidden();
    await expect(page.locator('.sgx-tb-title')).toHaveText('登录账号');
    await expect(page.locator('.acct-login-welcome')).toHaveText('欢迎回来');
    await expect(page.locator('.acct-login-sub')).toHaveText('记录 · 收藏 · 探索 · 享受');
    await expect(page.locator('.acct-login-avatar')).toBeVisible();
    const go = page.locator('#acct-login-go');
    await expect(go).toHaveText('登录');
    await expect(go).toHaveClass(/sgx-lock-go/);
    await expect(page.locator('#acct-login .sgx-lock-halo')).toHaveCount(1);
    /* 2026-10-24：按钮与锁屏「解锁」同宽（100%，上限 360px），不再缩成内容宽 */
    const gw = await go.evaluate((el) => el.getBoundingClientRect().width);
    const vw = await page.evaluate(() => window.innerWidth);
    expect(gw).toBeGreaterThanOrEqual(Math.min(360, vw - 48) - 1);
    /* 页面上不再有两个按钮 / 原地展开的密码框 */
    await expect(page.locator('#acct-pk-btn, #acct-pw-btn, #acct-pw-form, #acct-pw-input')).toHaveCount(0);
    await expect(page.locator('#acct-login .acct-gh, #acct-login .acct-ic')).toHaveCount(0);
    await expect(page.locator('#acct-login')).not.toContainText('根凭证', { useInnerText: true });
    /* 主按钮 = 主题色主色角色 */
    const bg = await go.evaluate((el) => getComputedStyle(el).backgroundColor);
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
    /* 光晕背景铺满视口；整组上下居中（组中心离 main 可用区中心不超过 40px） */
    await expect(page.locator('.acct-glass')).toBeVisible();
    const gb = await page.locator('.acct-glass').boundingBox();
    const vp = page.viewportSize();
    expect(gb && vp && Math.round(gb.width) === vp.width && Math.round(gb.height) === vp.height).toBe(true);
    await expect(page.locator('.acct-brand')).toHaveCount(0);
    await expect(page.locator('.acct-login-foot')).toHaveCount(0);
    /* 点「登录」→ 方式弹层：标题「登录」，通行密钥 / 密码 / 无法登录？（链接到重置登录） */
    await openSheet(page);
    await expect(page.locator('#sgx-method-sheet .sgx-sheet-title')).toHaveText('登录');
    await expect(page.locator('#acct-pk-btn .sgx-method-name')).toHaveText('通行密钥');
    await expect(page.locator('#acct-pw-btn .sgx-method-name')).toHaveText('密码');
    await expect(page.locator('#acct-cant')).toHaveText('无法登录？');
    await expect(page.locator('#acct-cant')).toHaveAttribute('href', '/account/reset/');
    /* 点头像也是同一个入口 */
    await page.keyboard.press('Escape');
    await expect(page.locator('#sgx-method-sheet')).toHaveCount(0);
    await page.click('#acct-login-avatar');
    await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible();
  });

  test('设了哪个显示哪个：只设密码 → 弹层只有密码；都没设 → 提示 + 弹层只剩「无法登录？」', async ({ page }) => {
    let st = { ok: true, password: true, passkey: false, ready: true, session: null };
    await mockAccount(page, { status: () => st });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-login-none')).toBeHidden();
    await openSheet(page);
    await expect(page.locator('#acct-pw-btn')).toBeVisible();
    await expect(page.locator('#acct-pk-btn')).toHaveCount(0);
    st = { ok: true, password: false, passkey: false, ready: true, session: null };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-login-none')).toBeVisible();
    await openSheet(page);
    await expect(page.locator('#sgx-method-sheet .sgx-method-opt')).toHaveCount(0);
    await expect(page.locator('#acct-cant')).toBeVisible();
  });

  test('英文页：Sign in / Welcome back / Passkey · Password / Can’t sign in?（访客读不到状态也显示两个）', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await mockAccount(page, { status: { ok: false, error: 'session' } });
    await page.goto('/en/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-tb-title')).toHaveText('Sign in');
    await expect(page.locator('.acct-login-welcome')).toHaveText('Welcome back');
    await expect(page.locator('#acct-login-go')).toHaveText('Sign in');
    await openSheet(page);
    await expect(page.locator('#acct-pk-btn .sgx-method-name')).toHaveText('Passkey');
    await expect(page.locator('#acct-pw-btn .sgx-method-name')).toHaveText('Password');
    await expect(page.locator('#acct-cant')).toHaveAttribute('href', '/en/account/reset/');
  });

  test('密码登录：与锁屏同一个密码弹层；空密码行内提示；错误行内提示并清空；改对后进账号页，顶栏页名回到「账号」', async ({ page }) => {
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
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await openPw(page);
    await expect(page.locator('dialog.sgx-verify-dlg[open]')).toBeVisible();
    await expect(page.locator('#sgx-verify-title')).toHaveText('输入密码');
    const input = page.locator('#acct-pw-input');
    await expect(input).toBeFocused();
    /* 2026-10-24：弹层打开时头像那组淡出避让（与锁屏同一个 body.sgx-dlg-open；首次访问的入场动画不能把它钉住） */
    await expect(page.locator('body')).toHaveClass(/sgx-dlg-open/);
    await expect.poll(() => page.locator('.acct-login-user').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await page.click('#acct-pw-go');
    await expect(page.locator('#acct-pw-err')).toHaveText('请输入账号密码');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toBeFocused();
    await input.fill('wrong-password');
    await page.click('#acct-pw-go');
    await expect(page.locator('#acct-pw-err')).toHaveText('密码不正确');
    await expect(input).toHaveValue('');
    await input.fill('right-password');
    await input.press('Enter');
    await expect(page.locator('#acct-main')).toBeVisible();
    await expect(page.locator('#acct-login')).toBeHidden();
    await expect(page.locator('dialog.sgx-verify-dlg[open]')).toHaveCount(0);
    await expect(page.locator('.sgx-tb-title')).toHaveText('账号');
    await expect(page.locator('#acct-main .sgx-account-card')).toBeVisible();
    await expect(page.locator('#acct-sec-sub')).toHaveText('已保护');
    expect(calls.filter((c) => c.action === 'login-password').length).toBe(2);
  });

  test('通行密钥失败（非取消）：同一弹层里给错误 + 重试 / 使用密码', async ({ page }) => {
    await mockAccount(page, {
      status: { ok: true, password: true, passkey: true, ready: true, session: null },
      handlers: { challenge: [500, { ok: false, error: 'server' }] },
    });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await openSheet(page);
    await page.click('#acct-pk-btn');
    await expect(page.locator('#acct-pk-err')).toBeVisible();
    await expect(page.locator('#acct-pk-retry')).toBeVisible();
    await page.click('#acct-pk-topw');
    await expect(page.locator('#acct-pw-input')).toBeFocused();
  });

  test('缺账号钥匙（ready=false）→ 登录区显示配置提示', async ({ page }) => {
    await mockAccount(page, { status: { ok: true, password: true, passkey: true, ready: false, session: null } });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-login-notice')).toContainText('缺少账号密钥配置');
  });

  test('密码自动填充后直接点登录，不报「请输入账号密码」', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: null },
      handlers: { 'login-password': [403, { ok: false, error: 'wrong' }] },
    });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await openPw(page);
    await page.locator('#acct-pw-input').evaluate((el) => { /** @type {HTMLInputElement} */ (el).value = 'autofilled-pw'; });
    await page.click('#acct-pw-go');
    await expect(page.locator('#acct-pw-err')).toHaveText('密码不正确');
    expect(calls.find((c) => c.action === 'login-password').password).toBe('autofilled-pw');
  });
});

test.describe('重置登录（/account/reset/）', () => {
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
    await page.goto('/account/reset/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-tb-title')).toHaveText('重置登录');
    await expect(page.locator('.sgx-reset-lead')).toHaveText('先用根凭证验证身份');
    /* 全站同一个根凭证框：隐藏用户名 root（Samsung Pass 能填） */
    await expect(page.locator('.sgx-reset input[autocomplete="username"]')).toHaveValue('RootKey');
    await page.fill('#sgx-reset-root', 'root-key-xyz');
    await page.click('#sgx-reset-go');
    await expect(page).toHaveURL(/\/account\/security\/$/);
    expect(rootBody).toMatchObject({ key: 'root-key-xyz', purpose: 'account' }); /* 另带 device（型号 / 平台，设备页用） */
  });

  test('根凭证错误 → 行内「根凭证不正确」并清空；空值提示', async ({ page }) => {
    await mockAccount(page, { status: { ok: true, password: false, passkey: false, ready: true, session: null } });
    await page.route('**/api/root-auth', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"auth"}' }));
    await page.goto('/account/reset/', { waitUntil: 'domcontentloaded' });
    await page.click('#sgx-reset-go');
    await expect(page.locator('#sgx-reset-err')).toHaveText('请输入根凭证');
    await page.fill('#sgx-reset-root', 'nope');
    await page.press('#sgx-reset-root', 'Enter');
    await expect(page.locator('#sgx-reset-err')).toHaveText('根凭证不正确');
    await expect(page.locator('#sgx-reset-root')).toHaveValue('');
    await expect(page).toHaveURL(/\/account\/reset\/$/);
  });

  test('英文：Reset sign-in', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await mockAccount(page, { status: { ok: false, error: 'session' } });
    await page.goto('/en/account/reset/', { waitUntil: 'domcontentloaded' });
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
    await expect(page.locator('#acct-door-cant')).toHaveAttribute('href', '/account/reset/');
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
    await expect(page).toHaveURL(/\/account\/reset\/$/);
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

  test('PR4：账号卡点了不跳页（没有「账号信息」子页）；两组：设备 / 临时钥匙 / 安全与隐私，云同步 / 服务状态', async ({ page }) => {
    await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: false, ready: true, session: RECENT() }),
      handlers: { list: [200, { ok: true, keys: [] }] },
    });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-main')).toBeVisible();
    await expect(page.locator('#acct-main [data-acct-card] .sgx-ac-state')).toHaveText('已登录');
    await page.locator('#acct-main [data-acct-card] .sgx-ac-name').click();
    await page.waitForTimeout(400);
    expect(new URL(page.url()).pathname).toBe('/account/');
    await expect(page.locator('a[href*="/account/profile/"]')).toHaveCount(0);
    const groups = await page.locator('#acct-main section').evaluateAll((els) => els.map((x) => Array.from(x.querySelectorAll('.acct-row')).map((r) => r.id)));
    expect(groups).toEqual([['acct-dev-row', 'acct-tk-row', 'acct-sec-row'], ['acct-sync-row', 'acct-st-row']]);
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
    await page.waitForURL(/\/account\/\?return=%2Faccount%2Fsecurity%2F$/);
    await expect(page.locator('#acct-login')).toBeVisible();
    await expect(page.locator('#acct-login-notice')).toBeHidden();
    await page.click('#acct-login-go');
    await page.click('#acct-pw-btn');
    await page.fill('#acct-pw-input', 'pw-123456');
    await page.click('#acct-pw-go');
    await page.waitForURL(/\/account\/security\/$/);
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
    await page.goto('/en/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sec-row')).toHaveAttribute('href', '/en/account/security/');
    await expect(page.locator('#acct-sec-sub')).toHaveText('Protected');
    await page.locator('#acct-sec-row').click();
    await page.waitForURL(/\/en\/account\/security\/$/);
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
        list: () => [200, { ok: true, keys: keys, userHandle: 'acct-h', userName: 'AccountKey', displayName: 'Sloan Gray' }],
        'register-challenge': [200, { ok: true, cid: 'c1', challenge: 'dGVzdC1jaGFsbGVuZ2U', rpId: 'localhost', rp: { name: 'Styrigx' }, user: { id: 'YWNjdC1o', name: 'AccountKey', displayName: 'Sloan Gray' }, excludeCredentials: [] }],
        register: (b) => { keys = [{ credId: 'new-cred-id', name: b.name, provider: 'Samsung Pass', createdAt: 1760000000000, lastUsedAt: 0 }]; return [200, { ok: true, credId: 'new-cred-id' }]; },
        rename: (b) => { keys = keys.map((k) => (k.credId === b.credId ? Object.assign({}, k, { name: b.name }) : k)); return [200, { ok: true, name: b.name }]; },
      },
    });
    return { calls, keys: () => keys };
  }

  test('注册成功弹命名弹层（预填设备名）；改名保存 → rename；user.name 为 AccountKey', async ({ page }) => {
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
    expect(await page.evaluate(() => /** @type {any} */ (window).__createArgs)).toEqual({ name: 'AccountKey', displayName: 'Sloan Gray' });
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

  test('signalCurrentUserDetails：list 带账号 handle 时发一次（name=AccountKey）', async ({ page }) => {
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
    expect(await page.evaluate(() => /** @type {any} */ (window).__sig[0])).toEqual({ rpId: 'localhost', userId: 'acct-h', name: 'AccountKey', displayName: 'Sloan Gray' });
  });
});

test.describe('账号总览：signalCurrentUserDetails', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  test('支持时进总览拉一次 list 发改名（通行密钥登录后同样走这里）', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: { ok: true, password: true, passkey: true, ready: true, session: Object.assign(RECENT(), { by: 'passkey' }) },
      handlers: { list: [200, { ok: true, keys: [], userHandle: 'acct-h', userName: 'AccountKey', displayName: 'Sloan Gray' }] },
    });
    await page.addInitScript(() => {
      // @ts-ignore
      window.__sig = [];
      // @ts-ignore
      window.PublicKeyCredential = window.PublicKeyCredential || function () {};
      // @ts-ignore
      window.PublicKeyCredential.signalCurrentUserDetails = function (o) { window.__sig.push(o); return Promise.resolve(); };
    });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-main')).toBeVisible();
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__sig.length)).toBe(1);
    expect(await page.evaluate(() => /** @type {any} */ (window).__sig[0])).toEqual({ rpId: 'localhost', userId: 'acct-h', name: 'AccountKey', displayName: 'Sloan Gray' });
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
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
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
    await expect(page.locator('.sgx-drawer-me')).toHaveAttribute('href', '/account/');
  });
});

test.describe('主题色角色（PR3）', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  const roleOf = (page, v) => page.evaluate((vv) => getComputedStyle(document.documentElement).getPropertyValue(vv).trim(), v);

  test('预设色板：登录页按钮用该预设的角色（2026-10-23 PR-G 七色：terra 浅色主色（ink）= 前景 1 鼠尾草按对比度压深 #566a44；主按钮 = 填充档 = 鼠尾草本色 #94a982 + 深墨字；次按钮 = secondary-container）', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-palette', 'terra'); localStorage.setItem('sgx-theme-mode', 'light'); } catch (e) {} });
    await mockAccount(page, { status: { ok: true, password: true, passkey: true, ready: true, session: null } });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-login-go')).toBeVisible();
    expect(await roleOf(page, '--sgx-primary')).toBe('#566a44');
    expect(await roleOf(page, '--sgx-primary-fill')).toBe('#94a982');
    expect(await page.locator('#acct-login-go').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(148, 169, 130)');
    expect(await page.locator('#acct-login-go').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(28, 33, 23)');
    expect(await roleOf(page, '--sgx-btn-secondary-bg')).toBe(await roleOf(page, '--sgx-secondary-container'));
  });

  test('自定义 #rrggbb：设置页按种子算出整套角色并缓存，之后页面首屏直接用缓存；点预设回到预设', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem('seeded')) { localStorage.setItem('sgx-accent', '#ff6b9d'); localStorage.setItem('sgx-theme-mode', 'light'); sessionStorage.setItem('seeded', '1'); }
      } catch (e) {}
    });
    await page.goto('/settings/theme/', { waitUntil: 'domcontentloaded' });
    /* 设计稿校验种子：#ff6b9d → 最近预设（PR-G 起 indigo，前景 1 霓虹粉），浅色主色压到 #ba2863（2026-10-21 容器阶梯加深后要在更深的 container-high 上仍 ≥4.6:1，比原来的 #bb2a65 深一点） */
    await expect.poll(() => roleOf(page, '--sgx-primary')).toBe('#ba2863');
    const cache = await page.evaluate(() => localStorage.getItem('sgx-accent-css'));
    expect(cache && cache.indexOf('v7|#ff6b9d\n')).toBe(0);
    await mockAccount(page, { status: { ok: true, password: true, passkey: true, ready: true, session: null } });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('style#sgx-accent-roles')).toHaveCount(1);
    expect(await roleOf(page, '--sgx-primary')).toBe('#ba2863');
    /* 主按钮 = 填充档：种子本色 #ff6b9d + 自动挑的深墨字（2026-10-23 PR-G 修订） */
    expect(await page.locator('#acct-login-go').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 107, 157)');
    /* 深色：同一种子的深色角色 */
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    expect(await roleOf(page, '--sgx-primary')).not.toBe('#ba2863');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    /* 回设置页点「恢复默认」：清掉自定义色，回到默认 dustyblue（浅色主色 = 前景 1 芥末按对比度压深） */
    await page.goto('/settings/theme/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#palette-reset')).toHaveAttribute('aria-disabled', 'false');
    await page.locator('#palette-reset').click();
    await expect(page.locator('#palette-reset')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('style#sgx-accent-roles')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('sgx-accent'))).toBeNull();
    expect(await roleOf(page, '--sgx-primary')).toBe('#7e6000');
  });
});

test.describe('设备子页（2026-10-22）', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  const DEVS = () => [
    { sid: 'aaaaaaaaaaaaaaaa', current: true, name: 'Galaxy S23 Ultra', model: 'SM-S918B', platform: 'Android', browser: 'Samsung Internet', country: 'CN', by: 'password', lastSeen: Date.now() },
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
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-dev-sub')).toHaveText('Galaxy S23 Ultra');
    await page.locator('#acct-dev-row').click();
    await page.waitForURL(/\/account\/devices\/$/);
    await expect(page.locator('#acct-devices')).toBeVisible();
    await expect(page.locator('#acct-dev-this')).toContainText('Galaxy S23 Ultra');
    await expect(page.locator('#acct-dev-this')).toContainText('当前在线');
    /* PR4：此设备卡 = 设备行 + 登录方式 + 退出账号；卡下面是保持登录的说明 */
    expect(await page.locator('#acct-dev-this-card > *').evaluateAll((els) => els.map((e) => e.id))).toEqual(['acct-dev-this', 'acct-dev-by-row', 'acct-logout']);
    await expect(page.locator('#acct-dev-by-row')).toContainText('登录方式');
    await expect(page.locator('#acct-by')).toHaveText('已用账号密码登录');
    await expect(page.locator('#acct-dev-this-card #acct-logout')).toHaveText('退出账号');
    await expect(page.locator('#acct-keep-note')).toHaveText('不点退出，这个浏览器会一直保持登录。');
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

  test('PR4 此设备卡：登录方式（设备记录没有 by 时读 GET /api/account）；退出账号 → POST logout → 回账号页登录区', async ({ page }) => {
    let loggedIn = true;
    const calls = await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: true, ready: true, session: loggedIn ? { ...RECENT(), by: 'passkey' } : null }),
      handlers: {
        list: [200, { ok: true, keys: [] }],
        devices: [200, { ok: true, devices: [{ sid: 'aaaaaaaaaaaaaaaa', current: true, name: 'iPhone', platform: 'iOS', browser: 'Safari', lastSeen: Date.now() }] }],
        logout: () => { loggedIn = false; return [200, { ok: true }]; },
      },
    });
    await page.goto('/account/devices/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-devices')).toBeVisible();
    await expect(page.locator('#acct-by')).toHaveText('已用账号通行密钥登录');
    await page.locator('#acct-logout').click();
    await page.waitForURL(/\/account\/$/);
    await expect(page.locator('#acct-login')).toBeVisible();
    expect(calls.some((c) => c.action === 'logout')).toBe(true);
  });

  test('PR4 此设备卡（英文）：Sign-in method / Sign out / 保持登录说明', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: false, ready: true, session: RECENT() }),
      handlers: { devices: [200, { ok: true, devices: [{ sid: 'aaaaaaaaaaaaaaaa', current: true, name: 'Windows', platform: 'Windows', browser: 'Chrome', by: 'root', lastSeen: Date.now() }] }] },
    });
    await page.goto('/en/account/devices/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-dev-by-row')).toContainText('Sign-in method');
    await expect(page.locator('#acct-by')).toHaveText('Signed in with root credential');
    await expect(page.locator('#acct-logout')).toHaveText('Sign out');
    await expect(page.locator('#acct-keep-note')).toHaveText('You stay signed in on this browser until you sign out.');
  });

  test('设备子页：没有账号会话（401）→ 跳账号页 ?return=子页', async ({ page }) => {
    await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: null },
      handlers: { devices: [401, { ok: false, error: 'account' }] },
    });
    await page.goto('/account/devices/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/account\/\?return=%2Faccount%2Fdevices%2F$/);
    await expect(page.locator('#acct-login')).toBeVisible();
  });
});

test.describe('账号 → 临时钥匙（2026-10-23，取代 Turnstile 访客进入）', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });

  /** mock /api/lock-temp：keys 是服务端的「有效钥匙」列表 */
  async function mockTemp(page, init) {
    const st = { keys: init || [], calls: [] };
    await page.route('**/api/lock-temp', async (route) => {
      const b = JSON.parse(route.request().postData() || '{}');
      st.calls.push(b);
      let res = [400, { ok: false, error: 'action' }];
      if (b.action === 'list') res = [200, { ok: true, keys: st.keys }];
      if (b.action === 'create') {
        const key = { id: 'k' + String(st.keys.length + 1).padStart(15, '0'), name: b.name || '', createdAt: Date.now(),
          expiresAt: Date.now() + (b.hours ? b.hours * 3600e3 : b.days * 86400e3) };
        st.keys = [key, ...st.keys];
        res = [200, { ok: true, key, code: 'ABCD-EFGH-JKMN' }];
      }
      if (b.action === 'revoke') { st.keys = st.keys.filter((k) => k.id !== b.id); res = [200, { ok: true }]; }
      await route.fulfill({ status: res[0], contentType: 'application/json', body: JSON.stringify(res[1]) });
    });
    return st;
  }

  test('总览有「临时钥匙」一行 → 子页；新建（名字 + 7 天）→ 只显示一次临时码，可复制；列表显示名字和剩余时间', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: false, ready: true, session: RECENT() }),
      handlers: { list: [200, { ok: true, keys: [] }] },
    });
    const st = await mockTemp(page);
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-tk-row')).toContainText('临时钥匙');
    await page.locator('#acct-tk-row').click();
    await page.waitForURL(/\/account\/temp-keys\/$/);
    await expect(page.locator('#acct-tk')).toBeVisible();
    await expect(page.locator('#acct-tk-empty')).toBeVisible();
    await page.locator('#acct-tk-new').click();
    const dlg = page.locator('#tk-dlg');
    await expect(dlg).toBeVisible();
    await expect(page.locator('#tk-dur')).toHaveValue('h24');
    /* 下拉：1–24 小时 + 3 / 7 / 15 / 30 天，一共 28 项 */
    expect(await page.locator('#tk-dur option').count()).toBe(28);
    await page.fill('#tk-name', '小明');
    await page.selectOption('#tk-dur', 'd7');
    await page.click('#tk-go');
    await expect(page.locator('#tk-code')).toHaveText('ABCD-EFGH-JKMN');
    await expect(page.locator('#tk-done-sub')).toHaveText('小明 · 有效期 7 天，到期自动失效');
    await expect(page.locator('#tk-form')).toBeHidden();
    expect(st.calls.find((c) => c.action === 'create')).toEqual({ action: 'create', name: '小明', days: 7 });
    await page.click('#tk-copy');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ABCD-EFGH-JKMN');
    await page.click('#tk-dlg [data-dlg-close]');
    const rows = page.locator('#acct-tk-list .acct-dev-item');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('小明');
    await expect(rows.first()).toContainText(/剩余 [67] 天/);
    /* 再开一次：回到表单，上次的码不留 */
    await page.locator('#acct-tk-new').click();
    await expect(page.locator('#tk-form')).toBeVisible();
    await expect(page.locator('#tk-done')).toBeHidden();
    await expect(page.locator('#tk-name')).toHaveValue('');
  });

  test('作废两步确认；没名字显示「未命名」；小时级显示剩余小时分钟', async ({ page }) => {
    const st = await mockTemp(page, [
      { id: 'a000000000000001', name: '', createdAt: Date.now(), expiresAt: Date.now() + 2 * 3600e3 + 5 * 60e3 },
    ]);
    await page.goto('/account/temp-keys/', { waitUntil: 'domcontentloaded' });
    const row = page.locator('#acct-tk-list .acct-dev-item').first();
    await expect(row).toContainText('未命名');
    await expect(row).toContainText(/剩余 2 小时 [56] 分钟/);
    const btn = row.locator('button');
    await btn.click();
    await expect(btn).toHaveText('再点一次作废');
    expect(st.calls.some((c) => c.action === 'revoke')).toBe(false);
    await btn.click();
    await expect(page.locator('#acct-tk-empty')).toBeVisible();
    expect(st.calls.find((c) => c.action === 'revoke').id).toBe('a000000000000001');
  });

  test('已满 20 把：弹层里提示，不关弹层', async ({ page }) => {
    await page.route('**/api/lock-temp', async (route) => {
      const b = JSON.parse(route.request().postData() || '{}');
      if (b.action === 'list') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"keys":[]}' });
      return route.fulfill({ status: 409, contentType: 'application/json', body: '{"ok":false,"error":"full"}' });
    });
    await page.goto('/account/temp-keys/', { waitUntil: 'domcontentloaded' });
    await page.locator('#acct-tk-new').click();
    await page.click('#tk-go');
    await expect(page.locator('#tk-err')).toHaveText('最多同时 20 把，先作废几把');
    await expect(page.locator('#tk-dlg')).toBeVisible();
  });

  test('没有账号会话（401 account）→ 跳账号页 ?return=子页', async ({ page }) => {
    await mockAccount(page, {
      status: { ok: true, password: true, passkey: false, ready: true, session: null },
      handlers: {},
    });
    await page.route('**/api/lock-temp', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"account"}' }));
    await page.goto('/account/temp-keys/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/account\/\?return=%2Faccount%2Ftemp-keys%2F$/);
  });
});

test.describe('账号 → 临时钥匙页 › 分享短链（2026-10-24，/api/share = styrigx-share）', () => {
  test.beforeEach(async ({ page }) => {
    await zh(page);
    await page.route('**/api/lock-temp', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"keys":[]}' }));
  });

  /** mock /api/share：links 是服务端列表；create 按请求生成一条 */
  async function mockShare(page, init) {
    const st = { links: init || [], calls: [] };
    await page.route('**/api/share', async (route) => {
      const b = JSON.parse(route.request().postData() || '{}');
      st.calls.push(b);
      let res = [400, { ok: false, error: 'action' }];
      if (b.action === 'list') res = [200, { ok: true, links: st.links }];
      if (b.action === 'create') {
        const now = Date.now();
        const exp = now + (b.hours ? b.hours * 3600e3 : b.days * 86400e3);
        const link = { id: 's' + String(st.links.length + 1).padStart(15, '0'), name: b.name || '', to: b.to, session: b.session, createdAt: now, expiresAt: exp,
          revokedAt: 0, status: 'active', opens: 0, lastOpenAt: 0, openFor: b.session ? Math.min(b.session, (exp - now) / 1000) : 0, sessionLeft: 0,
          path: '/s/AbCdEfGhIjKlMnOpQrStUv' };
        st.links = [link, ...st.links];
        res = [200, { ok: true, link }];
      }
      if (b.action === 'revoke') {
        st.links = st.links.map((l) => (l.id === b.id ? Object.assign({}, l, { status: 'revoked', revokedAt: Date.now(), path: undefined }) : l));
        res = [200, { ok: true }];
      }
      await route.fulfill({ status: res[0], contentType: 'application/json', body: JSON.stringify(res[1]) });
    });
    return st;
  }

  test('入口在临时钥匙页第二行；生成带会话短链（名字 + 6 小时 + /blog/ + 1 小时会话）→ 弹层显示 https://…/s/<码>，可复制；列表写清类型 / 目标 / 到期 / 会话', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const st = await mockShare(page);
    await page.goto('/account/temp-keys/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-sl-empty')).toBeVisible();
    await expect(page.locator('#acct-sl-new')).toContainText('新建分享短链');
    await page.locator('#acct-sl-new').click();
    await expect(page.locator('#sl-dlg')).toBeVisible();
    await expect(page.locator('#sl-sess-sw')).toHaveAttribute('aria-checked', 'true');
    await page.fill('#sl-name', '小明');
    await page.selectOption('#sl-dur', 'h6');
    /* 会话档位比有效期长的禁用（6 小时 → 12 小时及以上不能选） */
    await expect(page.locator('#sl-sess option[value="43200"]')).toBeDisabled();
    await expect(page.locator('#sl-sess option[value="10800"]')).toBeEnabled();
    await page.fill('#sl-to', '/blog/');
    await page.selectOption('#sl-sess', '3600');
    await page.click('#sl-go');
    await expect(page.locator('#sl-done')).toBeVisible();
    expect(st.calls.find((c) => c.action === 'create')).toEqual({ action: 'create', name: '小明', to: '/blog/', session: 3600, hours: 6 });
    const origin = new URL(page.url()).origin;
    await expect(page.locator('#sl-url')).toHaveText(origin + '/s/AbCdEfGhIjKlMnOpQrStUv');
    await expect(page.locator('#sl-done-sub')).toContainText('带临时会话');
    await page.click('#sl-copy');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(origin + '/s/AbCdEfGhIjKlMnOpQrStUv');
    await page.click('#sl-dlg [data-dlg-close]');
    const row = page.locator('#acct-sl-list .sl-item').first();
    await expect(row).toContainText('小明');
    await expect(row.locator('.sl-badge.is-sess')).toHaveText('带会话');
    await expect(row).toContainText('打开 /blog/');
    await expect(row).toContainText(/到期 · 剩余 [56] 小时/);
    await expect(row).toContainText('点开后可看 1 小时 · 还没人点开');
    await expect(row.locator('.sl-copy')).toBeVisible();
  });

  test('关掉「带临时会话」= 普通短链（session 0）；列表标「普通」，没有会话那一行', async ({ page }) => {
    const st = await mockShare(page);
    await page.goto('/account/temp-keys/', { waitUntil: 'domcontentloaded' });
    await page.locator('#acct-sl-new').click();
    await page.click('#sl-sess-row');
    await expect(page.locator('#sl-sess-sw')).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#sl-sess-box')).toBeHidden();
    await page.click('#sl-go');
    await expect(page.locator('#sl-done')).toBeVisible();
    expect(st.calls.find((c) => c.action === 'create')).toEqual({ action: 'create', name: '', to: '/', session: 0, hours: 24 });
    await page.click('#sl-dlg [data-dlg-close]');
    const row = page.locator('#acct-sl-list .sl-item').first();
    await expect(row.locator('.sl-badge').first()).toHaveText('普通');
    await expect(row.locator('.sl-meta')).toHaveCount(2);
    await expect(row).toContainText('打开 首页 /');
  });

  test('目标不是站内路径：弹层报错，不发请求', async ({ page }) => {
    const st = await mockShare(page);
    await page.goto('/account/temp-keys/', { waitUntil: 'domcontentloaded' });
    await page.locator('#acct-sl-new').click();
    for (const bad of ['https://evil.example/', '//evil.example', 'evil.example', '/a b']) {
      await page.fill('#sl-to', bad);
      await page.click('#sl-go');
      await expect(page.locator('#sl-err')).toHaveText('只能填站内路径，以 / 开头（如 /blog/）');
    }
    expect(st.calls.some((c) => c.action === 'create')).toBe(false);
  });

  test('列表：已作废 / 已过期标状态、没有复制和作废；有效的作废两步确认 → 变成「已作废」', async ({ page }) => {
    const now = Date.now();
    const st = await mockShare(page, [
      { id: 's000000000000001', name: 'A', to: '/x/', session: 1800, createdAt: now, expiresAt: now + 3600e3, revokedAt: 0, status: 'active',
        opens: 1, lastOpenAt: now - 10 * 60e3, openFor: 1800, sessionLeft: 1200, path: '/s/AAAAAAAAAAAAAAAAAAAAAA' },
      { id: 's000000000000002', name: 'B', to: '/', session: 0, createdAt: now - 1, expiresAt: now - 1000, revokedAt: 0, status: 'expired', opens: 0, lastOpenAt: 0, openFor: 0, sessionLeft: 0 },
      { id: 's000000000000003', name: 'C', to: '/', session: 3600, createdAt: now - 2, expiresAt: now + 3600e3, revokedAt: now - 60e3, status: 'revoked', opens: 0, lastOpenAt: 0, openFor: 0, sessionLeft: 0 },
    ]);
    await page.goto('/account/temp-keys/', { waitUntil: 'domcontentloaded' });
    const rows = page.locator('#acct-sl-list .sl-item');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('最近一次发出的会话剩余 20 分钟');
    await expect(rows.nth(1).locator('.sl-badge.is-dead')).toHaveText('已过期');
    await expect(rows.nth(1).locator('button')).toHaveCount(0);
    await expect(rows.nth(1)).toContainText('已于');
    await expect(rows.nth(2).locator('.sl-badge.is-dead')).toHaveText('已作废');
    await expect(rows.nth(2).locator('button')).toHaveCount(0);
    const del = rows.nth(0).locator('.lockmgr-pkdel');
    await del.click();
    await expect(del).toHaveText('再点一次作废');
    expect(st.calls.some((c) => c.action === 'revoke')).toBe(false);
    await del.click();
    await expect(rows.nth(0).locator('.sl-badge.is-dead')).toHaveText('已作废');
    expect(st.calls.find((c) => c.action === 'revoke').id).toBe('s000000000000001');
  });

  test('已满 20 条：弹层里提示，不关弹层', async ({ page }) => {
    await page.route('**/api/share', async (route) => {
      const b = JSON.parse(route.request().postData() || '{}');
      if (b.action === 'list') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"links":[]}' });
      return route.fulfill({ status: 409, contentType: 'application/json', body: '{"ok":false,"error":"full"}' });
    });
    await page.goto('/account/temp-keys/', { waitUntil: 'domcontentloaded' });
    await page.locator('#acct-sl-new').click();
    await page.click('#sl-go');
    await expect(page.locator('#sl-err')).toHaveText('最多同时 20 条，先作废几条');
    await expect(page.locator('#sl-dlg')).toBeVisible();
  });
});

test.describe('云同步（2026-10-24 PR4：总览一行 → 子页 /account/sync/）', () => {
  test.beforeEach(async ({ page }) => { await zh(page); });
  const SYNCED = ['sgx-theme-mode', 'sgx-palette', 'sgx-accent', 'sgx-tz1-auto', 'sgx-tz1', 'sgx-tz2', 'sgx-hour12', 'sgx-gl-clockstyle',
    'sgx-weather-show', 'sgx-temp-unit', 'sgx-weather-loc', 'sgx-weather-city', 'sgx-search-engine', 'sgx-gl-keys', 'sgx-well-tip', 'sgx-files-view', 'sgx-files-home'];

  test('总览「云同步」一行是可进入的行（链接 + 箭头，不再是开关）；副标题照旧显示状态', async ({ page }) => {
    await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: false, ready: true, session: RECENT() }),
      handlers: { list: [200, { ok: true, keys: [] }] },
    });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    const row = page.locator('#acct-sync-row');
    await expect(row).toHaveAttribute('href', '/account/sync/');
    await expect(row.locator('.switch')).toHaveCount(0);
    await expect(page.locator('#acct-sync-sub')).toHaveText('已开启，设置在登录的设备间同步');
    await row.click();
    await page.waitForURL(/\/account\/sync\/$/);
    await expect(page.locator('.sgx-tb-title')).toHaveText('云同步');
  });

  test('子页：总开关默认开，点一下关（sgx-cloud-sync=0，列表变淡、总览副标题跟着变），再点打开', async ({ page }) => {
    await mockAccount(page, { status: () => ({ ok: true, password: true, passkey: false, ready: true, session: RECENT() }) });
    await page.goto('/account/sync/', { waitUntil: 'domcontentloaded' });
    const sw = page.locator('#acct-sync-sw');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#acct-sync-sub')).toHaveText('已开启，设置在登录的设备间同步');
    await page.locator('#acct-sync-row').click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#acct-sync-sub')).toHaveText('已关闭，设置只存在此设备');
    await expect(page.locator('#acct-sync-items')).toHaveClass(/\bis-off\b/);
    expect(await page.evaluate(() => localStorage.getItem('sgx-cloud-sync'))).toBe('0');
    await page.keyboard.press('Tab');
    await page.locator('#acct-sync-row').press('Enter');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#acct-sync-items')).not.toHaveClass(/\bis-off\b/);
    expect(await page.evaluate(() => localStorage.getItem('sgx-cloud-sync'))).toBe(null);
  });

  test('子页列出实际同步的每一项（分组卡片），带本机当前值；不列语言 / 布局', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('sgx-theme-mode', 'dark');
      localStorage.setItem('sgx-palette', 'lake');
      localStorage.setItem('sgx-accent', '#3d7bd9');
      localStorage.setItem('sgx-hour12', '12');
      localStorage.setItem('sgx-weather-show', '0');
      localStorage.setItem('sgx-weather-city', JSON.stringify({ name: 'Shanghai', lat: 31.2, lon: 121.5 }));
      localStorage.setItem('sgx-gl-keys', '1');
    });
    await mockAccount(page, { status: () => ({ ok: true, password: true, passkey: false, ready: true, session: RECENT() }) });
    await page.goto('/account/sync/', { waitUntil: 'domcontentloaded' });
    const keys = await page.locator('#acct-sync-items [data-sync-key]').evaluateAll((els) => els.map((e) => e.getAttribute('data-sync-key')));
    expect([...keys].sort()).toEqual([...SYNCED].sort());
    expect(keys).not.toContain('sgx-lang');
    expect(keys).not.toContain('sgx-layout');
    await expect(page.locator('#acct-sync-items h3')).toHaveText(['外观', '日期和时间', '天气', '其他']);
    await expect(page.locator('#acct-sync-items section')).toHaveCount(4);
    const val = (k) => page.locator(`[data-sync-key="${k}"] [data-sync-val]`);
    await expect(page.locator('[data-sync-key="sgx-theme-mode"]')).toContainText('主题模式');
    await expect(val('sgx-theme-mode')).toHaveText('深色');
    await expect(val('sgx-palette')).toHaveText('湖蓝');
    await expect(val('sgx-accent')).toHaveText('#3D7BD9');
    await expect(page.locator('[data-sync-key="sgx-accent"] [data-sync-swatch]')).toBeVisible();
    await expect(val('sgx-hour12')).toHaveText('12 小时制');
    await expect(val('sgx-tz1-auto')).toHaveText('开');
    await expect(val('sgx-weather-show')).toHaveText('关');
    await expect(val('sgx-weather-city')).toHaveText('Shanghai');
    await expect(val('sgx-weather-loc')).toHaveText('自动（IP 定位）');
    await expect(val('sgx-gl-keys')).toHaveText('开');
    await expect(val('sgx-files-view')).toHaveText('默认');
    await expect(page.locator('main')).toContainText('语言和布局跟随每台设备各自的设置，不同步。');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('英文子页：Cloud sync / Appearance … / On · Off', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); localStorage.setItem('sgx-cloud-sync', '0'); } catch (e) {} });
    await mockAccount(page, { status: () => ({ ok: true, password: true, passkey: false, ready: true, session: RECENT() }) });
    await page.goto('/en/account/sync/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-tb-title')).toHaveText('Cloud sync');
    await expect(page.locator('#acct-sync-sub')).toHaveText('Off. Settings stay on this device');
    await expect(page.locator('#acct-sync-items h3')).toHaveText(['Appearance', 'Date & time', 'Weather', 'More']);
    await expect(page.locator('[data-sync-key="sgx-theme-mode"] [data-sync-val]')).toHaveText('Follow system');
    await expect(page.locator('[data-sync-key="sgx-weather-show"] [data-sync-val]')).toHaveText('On');
    await expect(page.locator('[data-sync-key="sgx-accent"] [data-sync-val]')).toHaveText('Not set');
  });

  test('子页：没有账号会话 → 跳账号页 ?return=子页', async ({ page }) => {
    await mockAccount(page, { status: { ok: true, password: true, passkey: false, ready: true, session: null } });
    await page.goto('/account/sync/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/account\/\?return=%2Faccount%2Fsync%2F$/);
    await expect(page.locator('#acct-login')).toBeVisible();
  });
});

test.describe('账号页是独立页 /account/（2026-10-22 从 /settings/account/ 挪出，旧地址直接删掉）', () => {
  test('旧地址 /settings/account/… 全部 404，不跳转', async ({ page }) => {
    for (const p of ['/settings/account/', '/settings/account/profile/', '/settings/account/security/', '/settings/account/reset/', '/settings/account/devices/',
      '/en/settings/account/', '/en/settings/account/devices/']) {
      const res = await page.request.get(p, { maxRedirects: 0 });
      expect(res.status(), p).toBe(404);
    }
  });

  test('账号页不借设置页的样式类（set-layout / set-row / set-ic / set-gh / sec-note）', async ({ page }) => {
    await zh(page);
    await mockAccount(page, {
      status: () => ({ ok: true, password: true, passkey: false, ready: true, session: RECENT() }),
      handlers: { list: [200, { ok: true, keys: [] }], devices: [200, { ok: true, devices: [] }] },
    });
    for (const p of ['/account/', '/account/security/', '/account/reset/', '/account/devices/', '/account/temp-keys/', '/account/sync/', '/account/status/']) {
      await page.goto(p, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('main .acct-layout')).toHaveCount(1);
      await expect(page.locator('main .set-layout, main .set-row, main .set-ic, main .set-gh, main .sec-note')).toHaveCount(0);
    }
  });
});

test.describe('云同步拉取节流（2026-10-24）', () => {
  /** 像线上 L1 那样给 HTML 页面注入站长角色；/api/prefs 计数 */
  async function ownerWithPrefs(page) {
    await zh(page);
    await page.route(/^http:\/\/localhost:\d+\/[^?]*\/?$/, async (route) => {
      const req = route.request();
      if (req.resourceType() !== 'document') return route.fallback();
      const res = await route.fetch();
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('text/html')) return route.fulfill({ response: res });
      const body = (await res.text()).replace(/<html([^>]*)>/i, '<html$1 data-sgx-session="valid" data-sgx-role="owner" data-sgx-account="in">');
      await route.fulfill({ response: res, body: body });
    });
    const prefs = { get: 0, post: 0 };
    await page.route('**/api/prefs', async (route) => {
      if (route.request().method() === 'GET') prefs.get++;
      else prefs.post++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: {}, updatedAt: 0 }) });
    });
    await mockAccount(page, { status: { ok: true, session: { by: 'password', device: 'Test' }, ready: true } });
    return prefs;
  }

  test('普通页面 5 分钟内只拉一次；进云同步页强制再拉', async ({ page }) => {
    const prefs = await ownerWithPrefs(page);
    await page.goto('/', { waitUntil: 'load' });
    await expect.poll(() => prefs.get).toBe(1);
    /* 拉取成功写下时刻后再换页（还没处理完响应就离开，这次不算成功，下一页会再拉） */
    await page.waitForFunction(() => !!localStorage.getItem('sgx-sync-pull'));
    await page.goto('/settings/', { waitUntil: 'load' });
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(400);
    expect(prefs.get).toBe(1);
    const stamp = await page.evaluate(() => JSON.parse(localStorage.getItem('sgx-sync-pull') || '{}'));
    expect(typeof stamp.owner).toBe('number');
    await page.goto('/account/sync/', { waitUntil: 'load' });
    await expect.poll(() => prefs.get).toBe(2);
  });

  test('时刻超过 5 分钟 → 普通页面再拉', async ({ page }) => {
    const prefs = await ownerWithPrefs(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-sync-pull', JSON.stringify({ owner: Date.now() - 6 * 60 * 1000 })); } catch (e) {}
    });
    await page.goto('/', { waitUntil: 'load' });
    await expect.poll(() => prefs.get).toBe(1);
  });
});
