/**
 * 账号 › 触屏（手机视口，isMobile + hasTouch；S9 起在全站终端 #sgx-term 的账号层里）：每个输入状态都有点得到的出口，回来的命令行是活的、有焦点（Gray 22:12 / 22:13 / 22:15）。
 * - 输入不显示的那几行（[sudo] password for root: / [sudo] recovery key: / New password: / Retype）、选项（pick）、等通行密钥：提示行末尾能点的 ^C（= C.interrupt）
 * - reset 层的命令行：最底一行「‹ 返回」= 离开 reset（没选登出方式 = [3] 不登出），回 styrigx@space / root@account
 * - 3 次输错结束这一轮：输入行重新聚焦，敲命令能跑（之前 busy 把输入行藏起来、焦点掉到 body，触屏上命令行像死了）
 * - 手机输入法 enter 时 keydown 带 isComposing：keyup 补提交
 * - sudo root 选项说明只列给了的方式；账号密码没设多一行；通行密钥取消 → 重新列选项；选项里没有的编号 → 「没有这个选项」接着选
 *
 * 静态构建 + /api/account 替身（helpers/account-term.cjs）。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { SESSION, REAUTH, STATUS, mockAccount, openTerm, log, termIn, ps, picks, hint, typeLine, mode } = T;

test.use({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true });
test.beforeEach(async ({ page }) => { await T.zh(page); });

/** 提示行里的 ^C 按钮 @param {import('@playwright/test').Page} page */
const cc = (page) => page.locator('#sgx-term [data-term-hint] [data-term-cc]');
/** reset 层命令行的出口：全站终端最底一行触屏「‹ 返回」（同 reset@space；= 离开 reset） @param {import('@playwright/test').Page} page */
const back = (page) => page.locator('#sgx-term [data-kh-back]');
/** 命令行是活的：有焦点，敲 pwd 能出一行（S9：man 是全屏阅读页，这里用 pwd） @param {import('@playwright/test').Page} page */
async function liveCmd(page, prompt) {
  await mode(page, 'cmd');
  await expect(ps(page)).toHaveText(prompt);
  await expect(termIn(page)).toBeFocused();
  const n = await log(page).locator('> *').count();
  await typeLine(page, 'pwd');
  await expect.poll(() => log(page).locator('> *').count()).toBeGreaterThan(n + 1);
}
/** 未登录：打开终端敲 sudo root @param {import('@playwright/test').Page} page */
async function sudoRoot(page) {
  await openTerm(page);
  await typeLine(page, 'sudo root');
  await mode(page, 'pick');
}

test('触屏是 pointer:coarse（^C 只在触屏显示）', async ({ page }) => {
  await mockAccount(page, { status: STATUS() });
  await T.goPage(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
});

test.describe('sudo root（未登录）', () => {
  test('只设了通行密钥：说明只列 passkey + 账号密码未设置一行；没有的编号 → 没有这个选项；取消 → 重新列；^C → 活的 styrigx@space', async ({ page }) => {
    await T.fakePasskey(page, { cancel: true });
    const calls = await mockAccount(page, {
      status: STATUS({ configured: { passkey: true, password: false } }),
      handlers: { 'session/passkey-challenge': [200, { ok: true, challenge: 'Y2hhbA', cid: 'c1' }] },
    });
    await T.goPage(page);
    await sudoRoot(page);
    await expect(picks(page)).toHaveText(['[1] passkey']);
    await expect(log(page)).toContainText('# passkey = 账号通行密钥');
    await expect(log(page)).not.toContainText('password = 账号密码');
    await expect(log(page)).toContainText('# 账号密码未设置 · 登录后 passwd 设置，或 sudo root reset');
    /* 没有的编号：说一声，接着选（不当命令跑） */
    await typeLine(page, '2');
    await expect(log(page)).toContainText('没有这个选项');
    await expect(log(page)).not.toContainText('command not found: 2');
    await mode(page, 'pick');
    /* 通行密钥取消：重新列选项（同一轮） */
    await picks(page).last().tap();
    await expect(log(page)).toContainText('已取消');
    await mode(page, 'pick');
    await expect(picks(page)).toHaveCount(2);
    expect(calls.filter((c) => c.action === 'session/passkey')).toHaveLength(0);
    /* 选项也有 ^C */
    await expect(cc(page)).toBeVisible();
    await cc(page).tap();
    await expect(log(page)).toContainText('^C');
    await liveCmd(page, 'styrigx@space:~/wild#');
  });

  test('密码：提示行「输入不显示 · 可直接粘贴 · ^C」；3 次输错结束这一轮 → 命令行重新聚焦、能跑；^C 退出密码行', async ({ page }) => {
    await mockAccount(page, { status: STATUS(), handlers: { 'session/password': [401, { ok: false, error: 'wrong' }] } });
    await T.goPage(page);
    await sudoRoot(page);
    await termIn(page).press('2');
    await mode(page, 'pw');
    await expect(hint(page)).toHaveText('# 输入不显示 · 可直接粘贴 · ^C');
    await expect(cc(page)).toBeVisible();
    for (let i = 0; i < 3; i++) {
      await mode(page, 'pw');
      await typeLine(page, 'bad-' + i);
    }
    await expect(log(page)).toContainText('sudo: 3 incorrect password attempts');
    await liveCmd(page, 'styrigx@space:~/wild#');
    /* 再来一轮，点 ^C 退出密码行 */
    await typeLine(page, 'sudo root');
    await mode(page, 'pick');
    await termIn(page).press('2');
    await mode(page, 'pw');
    await cc(page).tap();
    await liveCmd(page, 'styrigx@space:~/wild#');
  });

  test('等通行密钥时也有 ^C：点了回命令行，之后系统窗口回来的断言不再提交', async ({ page }) => {
    const calls = await mockAccount(page, { status: STATUS(), handlers: { 'session/passkey-challenge': [200, { ok: true, challenge: 'Y2hhbA', cid: 'c1' }] } });
    await T.goPage(page);
    await page.evaluate(() => {
      window.PublicKeyCredential = window.PublicKeyCredential || function () {};
      navigator.credentials.get = () => new Promise((res) => { window.__sgxResolveGet = res; });
    });
    await sudoRoot(page);
    await termIn(page).press('1');
    await mode(page, 'busy');
    await expect(cc(page)).toBeVisible();
    await cc(page).tap();
    await liveCmd(page, 'styrigx@space:~/wild#');
    await expect.poll(() => page.evaluate(() => typeof window.__sgxResolveGet === 'function')).toBe(true);
    const buf = (s) => `new TextEncoder().encode(${JSON.stringify(s)}).buffer`;
    await page.evaluate(`window.__sgxResolveGet({ id: 'Y3JlZA', rawId: ${buf('c')}, type: 'public-key', response: { clientDataJSON: ${buf('{}')}, authenticatorData: ${buf('a')}, signature: ${buf('s')}, userHandle: ${buf('u')} }, getClientExtensionResults: () => ({}) })`);
    await page.waitForTimeout(300);
    expect(calls.filter((c) => c.action === 'session/passkey')).toHaveLength(0);
    await mode(page, 'cmd');
  });

  test('手机输入法：enter 的 keydown 带 isComposing 也能提交（keyup 补）', async ({ page }) => {
    await mockAccount(page, { status: STATUS() });
    await T.goPage(page);
    await sudoRoot(page);
    await cc(page).tap();
    await mode(page, 'cmd');
    await termIn(page).fill('pwd');
    await termIn(page).evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await expect(log(page)).toContainText('styrigx@space:~/wild# pwd');
    /* 正常 enter 不会提交两次 */
    await typeLine(page, 'clear');
    await expect(log(page).locator('> *')).toHaveCount(0);
    await typeLine(page, 'pwd');
    await expect(log(page)).toContainText('styrigx@space:~/wild# pwd');
    await expect(log(page).getByText('styrigx@space:~/wild# pwd')).toHaveCount(1);
  });
});

test.describe('sudo root reauth（已登录）', () => {
  test('选项 / 密码行 ^C → 活的 root@account', async ({ page }) => {
    await mockAccount(page, { status: STATUS({ session: SESSION() }) });
    await T.goPage(page);
    await openTerm(page);
    await termIn(page).tap();
    await typeLine(page, 'sudo root reauth');
    await mode(page, 'pick');
    await expect(cc(page)).toBeVisible();
    await cc(page).tap();
    await liveCmd(page, 'root@account:~/wild#');
    await typeLine(page, 'sudo root reauth');
    await mode(page, 'pick');
    await termIn(page).press('2');
    await mode(page, 'pw');
    await cc(page).tap();
    await liveCmd(page, 'root@account:~/wild#');
  });
});

test.describe('sudo root reset', () => {
  test('未登录：恢复密钥行 ^C；reset 层「‹ 返回」离开 reset → styrigx@space', async ({ page }) => {
    let reset = null;
    await mockAccount(page, {
      status: () => STATUS({ session: null, reset }),
      handlers: { 'reset/recovery-key': () => { reset = { by: 'recovery-key', expiresAt: Date.now() + 175000 }; return [200, { ok: true }]; } },
    });
    await T.goPage(page);
    await openTerm(page);
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await expect(cc(page)).toBeVisible();
    await cc(page).tap();
    await liveCmd(page, 'styrigx@space:~/wild#');
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await typeLine(page, 'RK-good');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('reset@account:~#');
    await expect(back(page)).toBeVisible();
    reset = null;
    await back(page).tap();
    await liveCmd(page, 'styrigx@space:~/wild#');
  });

  test('已登录：恢复密钥行 ^C；reset 里 passwd 新密码行 ^C；三选一 ^C；reset 层「‹ 返回」（没选 = 不登出）→ root@account', async ({ page }) => {
    let reset = null;
    const calls = await mockAccount(page, {
      status: () => STATUS({ session: SESSION(), reset }),
      handlers: {
        'reset/recovery-key': () => { reset = { by: 'recovery-key', expiresAt: Date.now() + 175000 }; return [200, { ok: true }]; },
        'reset/password-set': [200, { ok: true, changed: true }],
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await termIn(page).tap();
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await cc(page).tap();
    await liveCmd(page, 'root@account:~/wild#');
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await typeLine(page, 'RK-good');
    await expect(ps(page)).toHaveText('reset@account:~#');
    /* passwd：新密码行 ^C → 还在 reset */
    await typeLine(page, 'passwd');
    await mode(page, 'newpw');
    await cc(page).tap();
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('reset@account:~#');
    await expect(termIn(page)).toBeFocused();
    /* 改完 → 三选一，^C 关掉三选一，还在 reset */
    await typeLine(page, 'passwd');
    await typeLine(page, 'newpassword1');
    await mode(page, 'newpw2');
    await cc(page).tap();
    await mode(page, 'cmd');
    await typeLine(page, 'passwd');
    await typeLine(page, 'newpassword1');
    await typeLine(page, 'newpassword1');
    await mode(page, 'pick');
    await expect(log(page)).toContainText('其他设备上的登录怎么处理？');
    await cc(page).tap();
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('reset@account:~#');
    /* reset 层「‹ 返回」：离开 reset，没选 = 其他设备保持登录 */
    reset = null;
    await expect(back(page)).toBeVisible();
    await back(page).tap();
    await expect(log(page)).toContainText('还没选，其他设备会保持登录');
    await liveCmd(page, 'root@account:~/wild#');
    expect(calls.some((c) => c.action === 'reset/finish')).toBe(false);
  });

  test('已登录：三选一点 [2] 结束 reset → root@account', async ({ page }) => {
    let reset = null;
    await mockAccount(page, {
      status: () => STATUS({ session: SESSION(), reset }),
      handlers: {
        'reset/recovery-key': () => { reset = { by: 'recovery-key', expiresAt: Date.now() + 175000 }; return [200, { ok: true }]; },
        'reset/password-set': [200, { ok: true, changed: true }],
        'reset/finish': () => { reset = null; return [200, { ok: true, signedOut: 1 }]; },
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await termIn(page).tap();
    await typeLine(page, 'sudo root reset');
    await typeLine(page, 'RK-good');
    await typeLine(page, 'passwd');
    await typeLine(page, 'newpassword1');
    await typeLine(page, 'newpassword1');
    await mode(page, 'pick');
    await log(page).locator('[data-term-pick="2"]').last().tap();
    await expect(log(page)).toContainText('已登出 1 台设备 · 重置完成');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('root@account:~/wild#');
  });
});

test.describe('passwd（已登录，reauth 有效）', () => {
  test('新密码 / 再输一次 ^C → 活的 root@account', async ({ page }) => {
    await mockAccount(page, { status: STATUS({ session: SESSION(), reauth: REAUTH() }) });
    await T.goPage(page);
    await openTerm(page);
    await termIn(page).tap();
    await typeLine(page, 'passwd');
    await mode(page, 'newpw');
    await expect(hint(page)).toContainText('^C');
    await cc(page).tap();
    await liveCmd(page, 'root@account:~/wild#');
    await typeLine(page, 'passwd');
    await typeLine(page, 'newpassword1');
    await mode(page, 'newpw2');
    await cc(page).tap();
    await liveCmd(page, 'root@account:~/wild#');
  });
});
