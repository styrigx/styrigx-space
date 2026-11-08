/**
 * 账号终端 › sudo root（session.js：登录会话 + exit）。
 * - 未登录（GET session=null）：$ ACCOUNT login，自动 `sudo root`，[1] passkey [2] password 只列已设置的（读不到状态两个都列）；一种都没设 → 提示 sudo root reset；signing=false → 配置提示
 * - 密码登录：`[sudo] password for root:` 不回显（O10：type=password、current-password、没有小眼睛，隐藏用户名框给密码管理器）；输错 Sorry, try again.，3 次结束这一轮；
 *   429 → too many attempts；自动填充（不触发 input）直接回车照样提交（原 B1-12 守护）；成功 → POST session/password，✓ 已登录，主页；关下拉重新载入
 * - 通行密钥：选了立即 busy，只发一次 session/passkey-challenge；取消 → 「已取消」；成功 → session/passkey
 * - 已登录主页：help / clear / 未知命令 / Ctrl+C、cd 各层、esc 逐层退、exit（POST logout）
 *
 * 静态构建 + /api/account 替身（helpers/account-term.cjs），无需真实后端。2026-11-08 账号 UI 改版：没有 /account/ 整页了，账号在头像下拉 #sgx-acct 的账号终端（shell/account/*）。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { SESSION, REAUTH, STATUS, mockAccount, openTerm, log, termIn, ps, typeLine, mode, layer } = T;
/** 设备层的替身数据（同 devices.spec.js） */
const DEVICES = () => [
  { deviceId: 'd-me', name: 'Galaxy S23 Ultra', browser: 'Samsung Internet', current: true, by: 'password', lastSeen: Date.now() },
];

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

test.describe('未登录：sudo root', () => {
  test('打开即 sudo root：$ ACCOUNT login，[1] passkey [2] password，提示符 >；页脚说明只收账号钥匙', async ({ page }) => {
    await mockAccount(page, { status: STATUS() });
    await T.goPage(page);
    const d = await openTerm(page);
    await expect(d).toHaveAttribute('data-acct-state', 'guest');
    await layer(page, 'guest');
    await expect(d.locator('[data-at-head]')).toContainText('ACCOUNT');
    await expect(d.locator('[data-at-head]')).toContainText('login');
    await expect(log(page)).toContainText('login@account:~$ sudo root');
    await expect(log(page)).toContainText('账号未登录 · 选择验证方式');
    await expect(d.locator('[data-at-pick]')).toHaveText(['[1] passkey', '[2] password']);
    await mode(page, 'pick');
    await expect(ps(page)).toHaveText('>');
    await expect(log(page)).toContainText('无法登录？输入 sudo root reset');
    await expect(d.locator('[data-at-ft]')).toContainText('不收恢复密钥');
    /* 没有旧账号页的东西 */
    await expect(page.locator('#acct-login, #acct-main, #sgx-acct .sgx-pop-opt')).toHaveCount(0);
  });

  test('只设了密码：只列 [1] password；一种都没设 → 提示 sudo root reset；signing=false → 配置提示', async ({ page }) => {
    let st = STATUS({ configured: { password: true, passkey: false } });
    await mockAccount(page, { status: () => st });
    await T.goPage(page);
    const d = await openTerm(page);
    await expect(d.locator('[data-at-pick]')).toHaveText(['[1] password']);
    /* esc：先退出当前命令（^C），再按一次才关 */
    await page.keyboard.press('Escape');
    await mode(page, 'cmd');
    await expect(log(page)).toContainText('^C');
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();

    st = STATUS({ configured: { password: false, passkey: false } });
    await openTerm(page);
    await expect(log(page)).toContainText('账号还没有设置登录方式 · 输入 sudo root reset 用恢复密钥设置');
    await expect(d.locator('[data-at-pick]')).toHaveCount(0);
    await mode(page, 'cmd');
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();

    st = STATUS({ signing: false });
    await openTerm(page);
    await expect(log(page)).toContainText('服务器缺少账号密钥配置');
  });

  test('读不到状态（接口 503）：两个方式都列', async ({ page }) => {
    await page.route('**/api/account**', (r) => r.fulfill({ status: 503, body: 'x' }));
    await T.goPage(page);
    const d = await openTerm(page);
    await expect(d.locator('[data-at-pick]')).toHaveText(['[1] passkey', '[2] password']);
  });

  test('只有进站会话（session=null）不算账号登录：data-sgx-account-session=out', async ({ page }) => {
    await mockAccount(page, { status: STATUS({ session: null }) });
    await T.goPage(page);
    await openTerm(page);
    await expect(page.locator('html')).toHaveAttribute('data-sgx-account-session', 'out');
    await expect(page.locator('#sgx-acct .sgx-pop-me')).toHaveCount(0);
  });
});

test.describe('密码登录', () => {
  test('按 2 → [sudo] password for root:（type=password、不回显）；输错 Sorry, try again.，3 次结束这一轮', async ({ page }) => {
    const calls = await mockAccount(page, { status: STATUS(), handlers: { 'session/password': [401, { ok: false, error: 'wrong' }] } });
    await T.goPage(page);
    await openTerm(page);
    await mode(page, 'pick');
    await termIn(page).press('2');
    await mode(page, 'pw');
    await expect(ps(page)).toHaveText('[sudo] password for root:');
    await expect(termIn(page)).toHaveAttribute('type', 'password');
    await expect(page.locator('#sgx-acct [data-at-hint]')).toContainText('输入不显示');
    for (let i = 0; i < 2; i++) {
      await typeLine(page, 'nope-' + i);
      await expect(log(page).locator('.sgx-at-l--er')).toHaveCount(i + 1);
      await mode(page, 'pw');
    }
    await expect(log(page)).toContainText('Sorry, try again.');
    await typeLine(page, 'nope-2');
    await expect(log(page)).toContainText('sudo: 3 incorrect password attempts');
    await mode(page, 'cmd');
    expect(calls.filter((c) => c.action === 'session/password').map((c) => c.password)).toEqual(['nope-0', 'nope-1', 'nope-2']);
    /* 不回显：输出区里没有输入的密码 */
    await expect(log(page)).not.toContainText('nope-');
  });

  test('429 → sudo: too many attempts', async ({ page }) => {
    await mockAccount(page, { status: STATUS(), handlers: { 'session/password': [429, { ok: false, error: 'cooldown' }] } });
    await T.goPage(page);
    await openTerm(page);
    await termIn(page).press('2');
    await typeLine(page, 'whatever1');
    await expect(log(page)).toContainText('sudo: too many attempts · try again in 15 min');
    await mode(page, 'cmd');
  });

  test('成功：POST session/password（带设备提示）→ ✓ 已登录 → 主页四行 + 退出；关下拉重新载入', async ({ page }) => {
    let signedIn = false;
    const calls = await mockAccount(page, {
      status: () => STATUS({ session: signedIn ? SESSION() : null }),
      handlers: { 'session/password': (b) => { if (b.password !== 'correct-horse') return [401, { ok: false, error: 'wrong' }]; signedIn = true; return [200, { ok: true }]; } },
    });
    await T.goPage(page);
    const d = await openTerm(page);
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(log(page)).toContainText('已登录 · Sloan Gray · 密码');
    await expect(d).toHaveAttribute('data-acct-state', 'in');
    await layer(page, 'home');
    await expect(ps(page)).toHaveText('root@account:~#');
    const lp = calls.find((c) => c.action === 'session/password');
    expect(lp.password).toBe('correct-horse');
    expect(lp.reauth).toBeUndefined();
    await expect(d.locator('.sgx-pop-list').first().locator('.sgx-pop-k')).toHaveText(['个人资料', '设备', '账号安全', '应用授权']);
    await expect(d.locator('[data-at-act="exit"]')).toContainText('退出登录');
    await expect(d.locator('.sgx-pop-state')).toContainText('已登录');
    /* 登录了：关下拉重新载入（云同步 / 资料跟着换） */
    const nav = page.waitForEvent('framenavigated');
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await nav;
  });
});

test.describe('通行密钥登录', () => {
  test('取消系统窗口 → 「已取消」，只发一次 session/passkey-challenge，回命令行', async ({ page }) => {
    await T.fakePasskey(page, { cancel: true });
    const calls = await mockAccount(page, { status: STATUS(), handlers: { 'session/passkey-challenge': [200, { ok: true, challenge: 'Y2hhbA', cid: 'c1' }] } });
    await T.goPage(page);
    await openTerm(page);
    await termIn(page).press('1');
    await expect(log(page)).toContainText('已取消');
    await mode(page, 'cmd');
    expect(calls.filter((c) => c.action === 'session/passkey-challenge')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'session/passkey')).toHaveLength(0);
  });

  test('成功：session/passkey-challenge → session/passkey（cid + credential）→ 已登录 · 通行密钥', async ({ page }) => {
    await T.fakePasskey(page);
    let signedIn = false;
    const calls = await mockAccount(page, {
      status: () => STATUS({ session: signedIn ? SESSION('passkey') : null }),
      handlers: {
        'session/passkey-challenge': [200, { ok: true, challenge: 'Y2hhbA', cid: 'c1' }],
        'session/passkey': () => { signedIn = true; return [200, { ok: true }]; },
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await page.locator('#sgx-acct [data-at-pick="1"]').click();
    await expect(log(page)).toContainText('已登录 · Sloan Gray · 通行密钥');
    const lp = calls.find((c) => c.action === 'session/passkey');
    expect(lp.cid).toBe('c1');
    expect(lp.credential && lp.credential.rawId).toBeTruthy();
    await layer(page, 'home');
  });
});

test.describe('已登录：主页 / 命令', () => {
  test('help / clear / 未知命令 / Ctrl+C；sudo root 已登录 → 提示用 reauth', async ({ page }) => {
    await mockAccount(page, { status: STATUS({ session: SESSION() }) });
    await T.goPage(page);
    await openTerm(page);
    await layer(page, 'home');
    await expect(log(page)).toContainText('输入 help 查看账号命令');
    await typeLine(page, 'help');
    await expect(log(page)).toContainText('sudo root reauth');
    await expect(log(page)).toContainText('sudo root reset');
    await expect(log(page)).toContainText('恢复密钥只给 reset 用');
    await typeLine(page, 'clear');
    await expect(log(page).locator('.sgx-at-l')).toHaveCount(0);
    await typeLine(page, 'foo bar');
    await expect(log(page)).toContainText('command not found: foo');
    await typeLine(page, 'sudo root');
    await expect(log(page)).toContainText('已登录（root）· 要再验证请用 sudo root reauth');
    await termIn(page).press('Control+c');
    await expect(log(page)).toContainText('^C');
  });

  test('cd security / cd ..：进出各层；‹ 返回；esc 先回上一层、最外层才关', async ({ page }) => {
    await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: { 'devices/list': [200, { ok: true, devices: DEVICES() }] } });
    await T.goPage(page);
    const d = await openTerm(page);
    await layer(page, 'home');
    await typeLine(page, 'cd devices');
    await layer(page, 'devices');
    await expect(d.locator('.sgx-at-h')).toHaveText('设备');
    await d.locator('[data-at-back]').click();
    await layer(page, 'home');
    await d.locator('[data-at-act="devices"]').click();
    await layer(page, 'devices');
    await page.keyboard.press('Escape');
    await layer(page, 'home');
    await expect(d).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
  });

  test('exit：POST /api/account/session { action: end } → 关下拉', async ({ page }) => {
    const calls = await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: { 'session/end': [200, { ok: true }] } });
    await T.goPage(page);
    const d = await openTerm(page);
    await layer(page, 'home');
    await d.locator('[data-at-act="exit"]').click();
    await expect(d).toBeHidden();
    expect(calls.some((c) => c.action === 'session/end')).toBe(true);
  });
});

test.describe('密码输入行（O10）/ 自动填充（原 B1-12 守护）', () => {
  test('自动填充后直接回车，照样提交（账号终端：sudo root → password）', async ({ page }) => {
    let posted = null;
    await page.route('**/api/account**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, signing: true, configured: { password: true, passkey: true }, session: null }) });
        return;
      }
      posted = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'wrong' }) });
    });
    await T.goPage(page);
    await T.openTerm(page);
    await T.termIn(page).press('2');
    await T.mode(page, 'pw');

    /* 模拟浏览器自动填充：直接设 value，不触发 input 事件 */
    await page.evaluate(() => {
      const el = document.querySelector('#sgx-acct [data-at-in]');
      if (el) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, 'autofilled-password-123');
      }
    });

    await T.termIn(page).press('Enter');
    await expect.poll(() => posted && posted.password).toBe('autofilled-password-123');
    await expect(T.log(page)).toContainText('Sorry, try again.');
  });
});

test.describe('密码输入行（O10）', () => {
  test('[sudo] password for root:：type=password、current-password，没有小眼睛；隐藏用户名框给密码管理器', async ({ page: pg }) => {
        await T.mockAccount(pg, { status: T.STATUS() });
    await T.goPage(pg);
    await T.openTerm(pg);
    await T.termIn(pg).press('2');
    await T.mode(pg, 'pw');
    const input = T.termIn(pg);
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveAttribute('autocomplete', 'current-password');
    await expect(input).toBeFocused();
    await expect(input).toHaveAccessibleName('密码');
    await expect(pg.locator('#sgx-acct [aria-pressed], #sgx-acct [data-eye], #sgx-acct .sgx-pw-eye')).toHaveCount(0);
    const pmu = pg.locator('#sgx-acct [data-at-pmu]');
    await expect(pmu).toHaveAttribute('autocomplete', 'username');
    await expect(pmu).toHaveAttribute('aria-hidden', 'true');
    expect(await pmu.inputValue()).not.toBe('');
  });
});

test.describe('通行密钥按钮反馈', () => {
  test('选了立即 busy（正在唤起通行密钥…），challenge 只发一次；取消 → 已取消，回命令行', async ({ page: pg }) => {
        let challengeCalls = 0;
    await pg.route('**/api/account**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, signing: true, configured: { password: true, passkey: true }, session: null }) });
        return;
      }
      const body = (route.request().postData() || '').toString();
      if (route.request().url().endsWith('/api/account/session') && body.includes('"passkey-challenge"')) challengeCalls++;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, challenge: 'AA', cid: 'c1', rpId: 'localhost' }) });
    });
    await T.goPage(pg);
    /* credentials.get 挂起（等测试手动取消） */
    await pg.evaluate(() => {
      window.__sgxRejectGet = null;
      navigator.credentials.get = () => new Promise((_, reject) => { window.__sgxRejectGet = reject; });
    });
    await T.openTerm(pg);
    await T.termIn(pg).press('1');
    await T.mode(pg, 'busy');
    await expect(T.log(pg)).toContainText('正在唤起通行密钥…');
    await expect(pg.locator('#sgx-acct [data-at-form]')).toBeHidden();
    await expect.poll(() => challengeCalls).toBe(1);
    /* busy 中再点 [1]：不再发 challenge */
    await pg.locator('#sgx-acct [data-at-pick="1"]').first().evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(challengeCalls).toBe(1);
    await expect.poll(() => pg.evaluate(() => typeof window.__sgxRejectGet === 'function')).toBe(true);
    await pg.evaluate(() => { window.__sgxRejectGet(new DOMException('User cancelled', 'NotAllowedError')); });
    await expect(T.log(pg)).toContainText('已取消');
    await T.mode(pg, 'cmd');
    await expect(pg.locator('#sgx-acct .sgx-at-l--er')).toHaveCount(0);
    expect(challengeCalls).toBe(1);
  });
});


/* #327 偏离修复（2026-11-08）：首帧登录态按登录标记 cookie sgx-account-signed-in（非 HttpOnly、值 1、不含秘密；账号 Worker 随 session 签发 / 清除），
   GET /api/account 回来后校正（没 session 清掉标记；有 session 没标记补上）。鉴权仍只认 HttpOnly 的 sgx-account-session。 */
test.describe('首帧登录态（登录标记 cookie）', () => {
  /** GET /api/account 先挡住，放行后才回 @param {any} page */
  async function holdStatus(page) {
    let release = () => {};
    const gate = new Promise((r) => { release = r; });
    await page.route(/\/api\/account\/?(\?.*)?$/, async (route) => {
      if (route.request().method() === 'GET') await gate;
      await route.fallback();
    });
    return () => release();
  }
  const marker = (page) => page.context().cookies().then((cs) => cs.find((c) => c.name === 'sgx-account-signed-in'));

  test('有标记：接口还没回就画 root 提示符；接口说没 session → 校正成 guest 并清掉标记', async ({ page }) => {
    await mockAccount(page, { status: STATUS({ session: null }) });
    const release = await holdStatus(page);
    await page.context().addCookies([{ name: 'sgx-account-signed-in', value: '1', url: 'http://localhost:8931' }]);
    await T.goPage(page);
    const d = await openTerm(page);
    await expect(d).toHaveAttribute('data-acct-state', 'in');
    release();
    await expect(d).toHaveAttribute('data-acct-state', 'guest');
    await expect.poll(() => marker(page)).toBeUndefined();
  });

  test('没标记：首帧 guest；接口说有 session → 校正成 root，并补上标记', async ({ page }) => {
    await mockAccount(page, { status: STATUS({ session: SESSION() }) });
    const release = await holdStatus(page);
    await T.goPage(page);
    const d = await openTerm(page);
    await expect(d).toHaveAttribute('data-acct-state', 'guest');
    release();
    await expect(d).toHaveAttribute('data-acct-state', 'in');
    await expect(ps(page)).toHaveText('root@account:~#');
    await expect.poll(async () => (await marker(page) || {}).value).toBe('1');
    expect((await marker(page)).httpOnly).toBe(false);
  });
});

/* #327 偏离修复：只做再验证的入口（[data-acct-open="reauth"]，奇趣导入书签）也遵守「关下拉 reauth 即失效」 */
test.describe('只做再验证（data-acct-open="reauth"）', () => {
  /** 已登录、reauth/password 签票；页面上放一个入口 @param {any} page */
  async function setup(page) {
    let ticket = null;
    const calls = await mockAccount(page, {
      status: () => STATUS({ session: SESSION(), reauth: ticket }),
      handlers: { 'reauth/password': () => { ticket = REAUTH(); return [200, { ok: true }]; }, 'reauth/end': () => { ticket = null; return [200, { ok: true }]; } },
    });
    await T.goPage(page);
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.id = 'reauth-only'; a.href = '#acct=reauth'; a.setAttribute('data-acct-open', 'reauth'); a.textContent = 'verify';
      document.body.appendChild(a);
    });
    return calls;
  }

  test('没有页面接手：验过关面板，立刻 POST /reauth { end }', async ({ page }) => {
    const calls = await setup(page);
    await page.locator('#reauth-only').click();
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-state', 'open');
    await expect(log(page)).toContainText('sudo root reauth');
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(d).toBeHidden();
    await expect.poll(() => calls.filter((c) => c.action === 'reauth/end').length).toBe(1);
  });

  test('页面接手（sgx-account-reauthed + waitUntil）：在 reauth 里做完那件事，做完才 POST /reauth { end }', async ({ page }) => {
    const calls = await setup(page);
    await page.evaluate(() => {
      /** @type {any} */ (window).__pageWork = { started: false, finish: null };
      document.addEventListener('sgx-account-reauthed', (e) => {
        const w = /** @type {any} */ (window).__pageWork;
        w.started = true;
        /** @type {any} */ (e).detail.waitUntil(new Promise((r) => { w.finish = r; }));
      });
    });
    await page.locator('#reauth-only').click();
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(page.locator('#sgx-acct')).toBeHidden();
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__pageWork.started)).toBe(true);
    await page.waitForTimeout(300);
    expect(calls.filter((c) => c.action === 'reauth/end')).toHaveLength(0);
    await page.evaluate(() => /** @type {any} */ (window).__pageWork.finish());
    await expect.poll(() => calls.filter((c) => c.action === 'reauth/end').length).toBe(1);
  });
});
