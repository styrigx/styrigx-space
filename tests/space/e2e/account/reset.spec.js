/**
 * 账号 › sudo root reset（reset.js）：恢复密钥（[sudo] recovery key:）→ reset 票（不登录）→ passwd → 三选一（enter 默认 [2] others）→ reset/finish；
 * 旧地址 #acct=reset 直接进。S9 起都在全站终端 #sgx-term 的账号层里跑（账号卡片只展示）。
 * 提示符：reset 里 reset@account:~#，结束回 styrigx@space（未登录）/ root@account（已登录）。
 *
 * 静态构建 + /api/account 替身（helpers/account-term.cjs），无需真实后端。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { SESSION, STATUS, mockAccount, openTerm, log, termIn, ps, picks, typeLine, mode } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

test.describe('sudo root reset', () => {
  test('恢复密钥：输错 Sorry；对了 → reset/recovery-key 签 reset 票（不登录）→ passwd（reset/password-set）→ 三选一 enter 默认 [2] → reset/finish others', async ({ page }) => {
    let reset = null;
    const calls = await mockAccount(page, {
      status: () => STATUS({ session: null, reset }),
      handlers: {
        'reset/recovery-key': (b) => { if (b.key !== 'RK-good') return [401, { ok: false, error: 'auth' }]; reset = { by: 'recovery-key', expiresAt: Date.now() + 175000 }; return [200, { ok: true }]; },
        'reset/password-set': [200, { ok: true, changed: true }],
        'reset/finish': [200, { ok: true, signedOut: 2 }],
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await expect(ps(page)).toHaveText('[sudo] recovery key:');
    await expect(termIn(page)).toHaveAttribute('type', 'password');
    await typeLine(page, 'RK-bad');
    await expect(log(page)).toContainText('Sorry, try again.');
    await typeLine(page, 'RK-good');
    await expect(log(page)).toContainText('重置票 3 分钟 · 不签账号会话');
    await expect(log(page)).toContainText('reset 里能用：passwd · passkey [add | rm <n>] · exit');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('reset@account:~#');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-account-session', 'out');
    expect(calls.filter((c) => c.action === 'reset/recovery-key').map((c) => c.key)).toEqual(['RK-bad', 'RK-good']);
    /* reset 里只给 passwd / passkey：device 不行 */
    await typeLine(page, 'device');
    await expect(log(page)).toContainText('sudo root');
    expect(calls.some((c) => c.action === 'devices/list')).toBe(false);
    await typeLine(page, 'passwd');
    await typeLine(page, 'newpassword1');
    await typeLine(page, 'newpassword1');
    await expect(log(page)).toContainText('其他设备上的登录怎么处理？');
    await expect(picks(page)).toHaveText(['[1] 登出全部设备', '[2] 登出除本机以外的设备', '[3] 不登出']);
    await expect(log(page)).toContainText('本机现在没有登录');
    await mode(page, 'pick');
    await termIn(page).press('Enter');
    await expect(log(page)).toContainText('已登出 2 台设备 · 重置完成');
    /* reset 结束：回未登录提示符，提示 sudo root 登录 */
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    await expect(log(page)).toContainText('现在用 sudo root 登录');
    expect(calls.find((c) => c.action === 'reset/password-set')).toEqual({ action: 'reset/password-set', password: 'newpassword1' });
    expect(calls.some((c) => c.action.startsWith('keys/'))).toBe(false);
    expect(calls.find((c) => c.action === 'reset/finish')).toEqual({ action: 'reset/finish', signOut: 'others' });
    expect(calls.some((c) => c.action === 'session/password')).toBe(false);
  });

  test('已登录也能 sudo root reset：reset 里提示符 reset@account:~#，[3] 不登出，结束回 root@account', async ({ page }) => {
    let reset = null;
    await mockAccount(page, {
      status: () => STATUS({ session: SESSION(), reset }),
      handlers: {
        'reset/recovery-key': () => { reset = { by: 'recovery-key', expiresAt: Date.now() + 175000 }; return [200, { ok: true }]; },
        'reset/password-set': [200, { ok: true, changed: true }],
        'reset/finish': () => { reset = null; return [200, { ok: true, signedOut: 0 }]; },
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await typeLine(page, 'RK-good');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('reset@account:~#');
    await expect(log(page)).toContainText('root@account:~/wild# sudo root reset');
    await typeLine(page, 'passwd');
    await typeLine(page, 'newpassword1');
    await typeLine(page, 'newpassword1');
    await mode(page, 'pick');
    await termIn(page).press('3');
    await expect(log(page)).toContainText('其他设备保持登录 · 重置完成');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-account-session', 'in');
  });

  test('离开 reset：Ctrl+C / exit（没选登出方式 = 不登出），回原来的提示符，不发 reset/finish', async ({ page }) => {
    let reset = null;
    const calls = await mockAccount(page, {
      status: () => STATUS({ reset }),
      handlers: { 'reset/recovery-key': () => { reset = { by: 'recovery-key', expiresAt: Date.now() + 175000 }; return [200, { ok: true }]; } },
    });
    await T.goPage(page);
    await openTerm(page);
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await typeLine(page, 'RK-good');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('reset@account:~#');
    await termIn(page).press('Control+c');
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    expect(calls.some((c) => c.action === 'reset/finish')).toBe(false);
    /* 再进一次，用 exit 离开（终端不收起） */
    reset = null;
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await typeLine(page, 'RK-good');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('reset@account:~#');
    await typeLine(page, 'exit');
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
    expect(calls.some((c) => c.action === 'reset/finish')).toBe(false);
  });

  test('旧地址 #acct=reset（/account/reset/ 301 过来）：打开全站终端直接进 sudo root reset，不开账号卡片', async ({ page }) => {
    await mockAccount(page, { status: STATUS() });
    await T.goPage(page, '/zh/#acct=reset');
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
    await mode(page, 'rkey');
    await expect(log(page)).toContainText('sudo root reset');
    await expect(page.locator('#sgx-acct')).toBeHidden();
    await expect(page).toHaveURL(/\/zh\/$/);
  });
});
