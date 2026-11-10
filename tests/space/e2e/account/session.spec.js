/**
 * 账号 › sudo root（session.js：登录会话 + exit）。S9 起都在全站终端 #sgx-term 的账号层里跑（账号卡片只展示）。
 * - 未登录（GET session=null）：sudo root → [1] passkey [2] password 只列已设置的（读不到状态两个都列）；一种都没设 → 提示 sudo root reset；signing=false → 配置提示
 * - 密码登录：`[sudo] password for root:` 不回显（O10：type=password、current-password、没有小眼睛，隐藏用户名框给密码管理器）；输错 Sorry, try again.，3 次结束这一轮；
 *   429 → too many attempts；自动填充（不触发 input）直接回车照样提交（原 B1-12 守护）；成功 → POST session/password，✓ 已登录，root@account；收起终端重新载入
 * - 通行密钥：选了立即 busy，只发一次 session/passkey-challenge；取消 → 「已取消」；成功 → session/passkey
 * - 已登录：sudo root → 提示用 reauth；exit（POST session end）→ 收起终端
 * - 首帧登录标记 cookie；只做再验证的入口（[data-acct-open="reauth"]）在终端里跑
 *
 * 静态构建 + /api/account 替身（helpers/account-term.cjs），无需真实后端。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { SESSION, REAUTH, STATUS, mockAccount, openTerm, log, termIn, ps, picks, hint, typeLine, mode } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

/** 打开终端敲 sudo root @param {import('@playwright/test').Page} page */
async function sudoRoot(page) {
  const d = await openTerm(page);
  await typeLine(page, 'sudo root');
  return d;
}

test.describe('未登录：sudo root', () => {
  test('sudo root：styrigx@space:~# 下原地选方式 [1] passkey [2] password，提示符 >；不开账号卡片', async ({ page }) => {
    await mockAccount(page, { status: STATUS() });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    await typeLine(page, 'sudo root');
    await expect(log(page)).toContainText('styrigx@space:~/wild# sudo root');
    await expect(log(page)).toContainText('账号未登录 · 选择验证方式');
    await expect(picks(page)).toHaveText(['[1] passkey', '[2] password']);
    await mode(page, 'pick');
    await expect(ps(page)).toHaveText('>');
    await expect(log(page)).toContainText('无法登录？输入 sudo root reset');
    await expect(page.locator('#sgx-acct')).toBeHidden();
  });

  test('只设了密码：只列 [1] password；一种都没设 → 提示 sudo root reset；signing=false → 配置提示', async ({ page }) => {
    let st = STATUS({ configured: { password: true, passkey: false } });
    await mockAccount(page, { status: () => st });
    await T.goPage(page);
    const d = await sudoRoot(page);
    await expect(picks(page)).toHaveText(['[1] password']);
    /* esc：先退出当前命令（^C），再按一次才关 */
    await page.keyboard.press('Escape');
    await mode(page, 'cmd');
    await expect(log(page)).toContainText('^C');
    await page.keyboard.press('Escape');
    await expect(d).not.toHaveAttribute('open', '');

    st = STATUS({ configured: { password: false, passkey: false } });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sudoRoot(page);
    await expect(log(page)).toContainText('账号还没有设置登录方式 · 输入 sudo root reset 用恢复密钥设置');
    await expect(picks(page)).toHaveCount(0);
    await mode(page, 'cmd');

    st = STATUS({ signing: false });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sudoRoot(page);
    await expect(log(page)).toContainText('服务器缺少账号密钥配置');
  });

  test('读不到状态（接口 503）：两个方式都列', async ({ page }) => {
    await page.route('**/api/lock-session-check**', (r) => r.fulfill(T.json({ ok: true, by: 'password' })));
    await page.route('**/api/account**', (r) => r.fulfill({ status: 503, body: 'x' }));
    await T.goPage(page);
    await sudoRoot(page);
    await expect(picks(page)).toHaveText(['[1] passkey', '[2] password']);
  });

  test('只有进站会话（session=null）不算账号登录：data-sgx-account-session=out，提示符 styrigx@space', async ({ page }) => {
    await mockAccount(page, { status: STATUS({ session: null }) });
    await T.goPage(page);
    await openTerm(page);
    await expect(page.locator('html')).toHaveAttribute('data-sgx-account-session', 'out');
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
  });
});

test.describe('密码登录', () => {
  test('按 2 → [sudo] password for root:（type=password、不回显）；输错 Sorry, try again.，3 次结束这一轮', async ({ page }) => {
    const calls = await mockAccount(page, { status: STATUS(), handlers: { 'session/password': [401, { ok: false, error: 'wrong' }] } });
    await T.goPage(page);
    await sudoRoot(page);
    await mode(page, 'pick');
    await termIn(page).press('2');
    await mode(page, 'pw');
    await expect(ps(page)).toHaveText('[sudo] password for root:');
    await expect(termIn(page)).toHaveAttribute('type', 'password');
    await expect(hint(page)).toContainText('输入不显示');
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
    await sudoRoot(page);
    await mode(page, 'pick');
    await termIn(page).press('2');
    await typeLine(page, 'whatever1');
    await expect(log(page)).toContainText('sudo: too many attempts · try again in 15 min');
    await mode(page, 'cmd');
  });

  test('成功：POST session/password → ✓ 已登录 → root@account；收起终端重新载入', async ({ page }) => {
    let signedIn = false;
    const calls = await mockAccount(page, {
      status: () => STATUS({ session: signedIn ? SESSION() : null }),
      handlers: { 'session/password': (b) => { if (b.password !== 'correct-horse') return [401, { ok: false, error: 'wrong' }]; signedIn = true; return [200, { ok: true }]; } },
    });
    await T.goPage(page);
    const d = await sudoRoot(page);
    await mode(page, 'pick');
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(log(page)).toContainText('已登录 · Sloan Gray · 密码');
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    const lp = calls.find((c) => c.action === 'session/password');
    expect(lp.password).toBe('correct-horse');
    expect(lp.reauth).toBeUndefined();
    /* 登录了：收起终端重新载入（云同步 / 资料跟着换） */
    const nav = page.waitForEvent('framenavigated');
    await page.keyboard.press('Escape');
    await expect(d).not.toHaveAttribute('open', '');
    await nav;
  });
});

test.describe('通行密钥登录', () => {
  test('取消系统窗口 → 「已取消」，只发一次 session/passkey-challenge，重新列出选项（同一轮，Gray 22:13）', async ({ page }) => {
    await T.fakePasskey(page, { cancel: true });
    const calls = await mockAccount(page, { status: STATUS(), handlers: { 'session/passkey-challenge': [200, { ok: true, challenge: 'Y2hhbA', cid: 'c1' }] } });
    await T.goPage(page);
    await sudoRoot(page);
    await mode(page, 'pick');
    await termIn(page).press('1');
    await expect(log(page)).toContainText('已取消');
    await mode(page, 'pick');
    await expect(log(page).locator('.sgx-at-l--opts')).toHaveCount(2);
    expect(calls.filter((c) => c.action === 'session/passkey-challenge')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'session/passkey')).toHaveLength(0);
  });

  test('取消系统窗口不计入 3 次（2026-11-09）：连取消 4 次还在选方式，没有 incorrect attempts；真的输错密码 3 次才结束这一轮', async ({ page }) => {
    await T.fakePasskey(page, { cancel: true });
    const calls = await mockAccount(page, {
      status: STATUS(),
      handlers: {
        'session/passkey-challenge': [200, { ok: true, challenge: 'Y2hhbA', cid: 'c1' }],
        'session/password': [401, { ok: false, error: 'wrong' }],
      },
    });
    await T.goPage(page);
    await sudoRoot(page);
    for (let i = 0; i < 4; i++) {
      await mode(page, 'pick');
      await termIn(page).press('1');
      await expect(log(page).getByText('已取消')).toHaveCount(i + 1);
    }
    await mode(page, 'pick');
    await expect(log(page)).not.toContainText('incorrect password attempts');
    expect(calls.filter((c) => c.action === 'session/passkey-challenge')).toHaveLength(4);
    await termIn(page).press('2');
    await mode(page, 'pw');
    await typeLine(page, 'wrong-1');
    await expect(log(page)).toContainText('Sorry, try again.');
    await mode(page, 'pw');
    await typeLine(page, 'wrong-2');
    await mode(page, 'pw');
    await typeLine(page, 'wrong-3');
    await expect(log(page)).toContainText('sudo: 3 incorrect password attempts');
    await mode(page, 'cmd');
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
    await sudoRoot(page);
    await page.locator('#sgx-term [data-term-pick="1"]').click();
    await expect(log(page)).toContainText('已登录 · Sloan Gray · 通行密钥');
    const lp = calls.find((c) => c.action === 'session/passkey');
    expect(lp.cid).toBe('c1');
    expect(lp.credential && lp.credential.rawId).toBeTruthy();
    await expect(ps(page)).toHaveText('root@account:~/wild#');
  });
});

test.describe('已登录', () => {
  test('sudo root 已登录 → 提示用 reauth；Ctrl+C', async ({ page }) => {
    await mockAccount(page, { status: STATUS({ session: SESSION() }) });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    await typeLine(page, 'sudo root');
    await expect(log(page)).toContainText('已登录（root）· 要再验证请用 sudo root reauth');
    await termIn(page).press('Control+c');
    await expect(log(page)).toContainText('^C');
  });

  test('exit：POST /api/account/session { action: end } → 收起终端', async ({ page }) => {
    const calls = await mockAccount(page, { status: STATUS({ session: SESSION() }), handlers: { 'session/end': [200, { ok: true }] } });
    await T.goPage(page);
    const d = await openTerm(page);
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    await typeLine(page, 'exit');
    await expect(d).not.toHaveAttribute('open', '');
    expect(calls.some((c) => c.action === 'session/end')).toBe(true);
  });
});

test.describe('密码输入行（O10）/ 自动填充（原 B1-12 守护）', () => {
  test('自动填充后直接回车，照样提交（sudo root → password）', async ({ page }) => {
    let posted = null;
    await page.route('**/api/lock-session-check**', (r) => r.fulfill(T.json({ ok: true, by: 'password' })));
    await page.route('**/api/account**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, signing: true, configured: { password: true, passkey: true }, session: null }) });
        return;
      }
      posted = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'wrong' }) });
    });
    await T.goPage(page);
    await sudoRoot(page);
    await mode(page, 'pick');
    await termIn(page).press('2');
    await mode(page, 'pw');
    /* 模拟浏览器自动填充：直接设 value，不触发 input 事件 */
    await page.evaluate(() => {
      const el = document.querySelector('#sgx-term-in');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'autofilled-password-123');
    });
    await termIn(page).press('Enter');
    await expect.poll(() => posted && posted.password).toBe('autofilled-password-123');
    await expect(log(page)).toContainText('Sorry, try again.');
  });

  test('[sudo] password for root:：type=password、current-password，没有小眼睛；隐藏用户名框只在这时出现（S9）', async ({ page: pg }) => {
    await mockAccount(pg, { status: STATUS() });
    await T.goPage(pg);
    await sudoRoot(pg);
    const pmu = pg.locator('#sgx-term [data-term-pmu]');
    await expect(pmu).toHaveCount(0);
    await termIn(pg).press('2');
    await mode(pg, 'pw');
    const input = termIn(pg);
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveAttribute('autocomplete', 'current-password');
    await expect(input).toBeFocused();
    await expect(pg.locator('#sgx-term [aria-pressed], #sgx-term [data-eye], #sgx-term .sgx-pw-eye')).toHaveCount(0);
    await expect(pmu).toHaveAttribute('autocomplete', 'username');
    await expect(pmu).toHaveAttribute('aria-hidden', 'true');
    expect(await pmu.inputValue()).not.toBe('');
    await input.press('Control+c');
    await mode(pg, 'cmd');
    await expect(pmu).toHaveCount(0);
  });
});

test.describe('通行密钥按钮反馈', () => {
  test('选了立即 busy（正在唤起通行密钥…），challenge 只发一次；取消 → 已取消，重新列出选项', async ({ page: pg }) => {
    let challengeCalls = 0;
    await pg.route('**/api/lock-session-check**', (r) => r.fulfill(T.json({ ok: true, by: 'password' })));
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
    await pg.evaluate(() => {
      window.__sgxRejectGet = null;
      navigator.credentials.get = () => new Promise((_, reject) => { window.__sgxRejectGet = reject; });
    });
    await sudoRoot(pg);
    await termIn(pg).press('1');
    await mode(pg, 'busy');
    await expect(log(pg)).toContainText('正在唤起通行密钥…');
    await expect(pg.locator('#sgx-term [data-term-form]')).toBeHidden();
    await expect.poll(() => challengeCalls).toBe(1);
    await pg.locator('#sgx-term [data-term-pick="1"]').first().evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(challengeCalls).toBe(1);
    await expect.poll(() => pg.evaluate(() => typeof window.__sgxRejectGet === 'function')).toBe(true);
    await pg.evaluate(() => { window.__sgxRejectGet(new DOMException('User cancelled', 'NotAllowedError')); });
    await expect(log(pg)).toContainText('已取消');
    await mode(pg, 'pick');
    await expect(pg.locator('#sgx-term .sgx-at-l--er')).toHaveCount(0);
    expect(challengeCalls).toBe(1);
  });
});

/* #327 偏离修复（2026-11-08）：首帧登录态按登录标记 cookie sgx-account-signed-in（非 HttpOnly、值 1、不含秘密；账号 Worker 随 session 签发 / 清除），
   GET /api/account 回来后校正（没 session 清掉标记；有 session 没标记补上）。鉴权仍只认 HttpOnly 的 sgx-account-session。 */
test.describe('首帧登录态（登录标记 cookie，账号卡片）', () => {
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

  test('有标记：接口还没回就画已登录；接口说没 session → 校正成 guest 并清掉标记', async ({ page }) => {
    await mockAccount(page, { status: STATUS({ session: null }) });
    const release = await holdStatus(page);
    await T.goPage(page);
    const d = await T.openCard(page);
    await expect(d).toHaveAttribute('data-acct-state', 'in');
    release();
    await expect(d).toHaveAttribute('data-acct-state', 'guest');
    await expect.poll(() => marker(page)).toBeUndefined();
  });

  test('没标记：首帧 guest；接口说有 session → 校正成 in，并补上标记', async ({ page }) => {
    await page.route('**/api/lock-session-check**', (r) => r.fulfill(T.json({ ok: true, by: 'password' })));
    await page.route('**/api/account**', (r) => r.fulfill(r.request().method() === 'GET' ? T.json(STATUS({ session: SESSION() })) : T.json({ ok: true, grants: [] })));
    const release = await holdStatus(page);
    await T.goPage(page);
    const d = await T.openCard(page);
    await expect(d).toHaveAttribute('data-acct-state', 'guest');
    release();
    await expect(d).toHaveAttribute('data-acct-state', 'in');
    await expect.poll(async () => (await marker(page) || {}).value).toBe('1');
    expect((await marker(page)).httpOnly).toBe(false);
  });
});

/* #327 偏离修复：只做再验证的入口（[data-acct-open="reauth"]，奇趣导入书签）也遵守「关掉 reauth 即失效」；S9 起在终端里跑 */
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

  test('没有页面接手：验过收起终端，立刻 POST /reauth { end }', async ({ page }) => {
    const calls = await setup(page);
    await page.locator('#reauth-only').click();
    const d = page.locator('#sgx-term');
    await expect(d).toHaveAttribute('open', '');
    await expect(log(page)).toContainText('sudo root reauth');
    await mode(page, 'pick');
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(d).not.toHaveAttribute('open', '');
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
    await mode(page, 'pick');
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__pageWork.started)).toBe(true);
    await page.waitForTimeout(300);
    expect(calls.filter((c) => c.action === 'reauth/end')).toHaveLength(0);
    await page.evaluate(() => /** @type {any} */ (window).__pageWork.finish());
    await expect.poll(() => calls.filter((c) => c.action === 'reauth/end').length).toBe(1);
  });
});
