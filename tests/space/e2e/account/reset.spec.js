/**
 * 账号终端 › sudo root reset（reset.js）：恢复密钥（[sudo] recovery key:）→ reset 票（不登录）→ 改密码 → 三选一（enter 默认 [2] others）→ reset/finish；
 * 旧地址 #acct=reset 直接进。提示符：reset 里 reset@account:~#，结束回 login@account:~$（未登录）/ root@account:~#（已登录）。
 *
 * 静态构建 + /api/account 替身（helpers/account-term.cjs），无需真实后端。2026-11-08 账号 UI 改版：没有 /account/ 整页了，账号在头像下拉 #sgx-acct 的账号终端（shell/account/*）。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { SESSION, REAUTH, STATUS, mockAccount, openTerm, log, termIn, ps, typeLine, mode, layer } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

test.describe('sudo root reset', () => {
  test('恢复密钥：输错 Sorry；对了 → reset/recovery-key 签 reset 票（不登录）→ reset/password-set → 三选一 enter 默认 [2] → reset/finish others', async ({ page }) => {
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
    const d = await openTerm(page);
    await mode(page, 'pick');
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await expect(ps(page)).toHaveText('[sudo] recovery key:');
    await expect(termIn(page)).toHaveAttribute('type', 'password');
    await typeLine(page, 'RK-bad');
    await expect(log(page)).toContainText('Sorry, try again.');
    await typeLine(page, 'RK-good');
    await expect(log(page)).toContainText('重置票 3 分钟 · 不签账号会话');
    await layer(page, 'reset');
    await expect(d).toHaveAttribute('data-acct-state', 'guest');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('reset@account:~#');
    await expect(d.locator('[data-at-head]')).toContainText(/reset · 0[0-2]:\d\d/);
    expect(calls.filter((c) => c.action === 'reset/recovery-key').map((c) => c.key)).toEqual(['RK-bad', 'RK-good']);
    /* reset 里：账号密码一行 + 通行密钥（不能改名） */
    await expect(d.locator('.sgx-at-nm')).toHaveCount(0);
    await d.locator('[data-at-act="passwd"]').click();
    await typeLine(page, 'newpassword1');
    await typeLine(page, 'newpassword1');
    await expect(log(page)).toContainText('其他设备上的登录怎么处理？');
    await expect(log(page).locator('.sgx-at-l--opts').last().locator('[data-at-pick]')).toHaveText(['[1] 登出全部设备', '[2] 登出除本机以外的设备', '[3] 不登出']);
    await expect(log(page)).toContainText('本机现在没有登录');
    await mode(page, 'pick');
    await termIn(page).press('Enter');
    await expect(log(page)).toContainText('已登出 2 台设备 · 重置完成');
    /* reset 结束：回未登录提示符 */
    await layer(page, 'guest');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('login@account:~$');
    expect(calls.find((c) => c.action === 'reset/password-set')).toEqual({ action: 'reset/password-set', password: 'newpassword1' });
    expect(calls.some((c) => c.action.startsWith('keys/'))).toBe(false);
    expect(calls.find((c) => c.action === 'reset/finish')).toEqual({ action: 'reset/finish', signOut: 'others' });
    expect(calls.some((c) => c.action === 'session/password')).toBe(false);
  });

  test('已登录也能 sudo root reset：reset 里提示符 reset@account:~#，结束回 root@account:~#', async ({ page }) => {
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
    const d = await openTerm(page);
    await layer(page, 'home');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('root@account:~#');
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await expect(ps(page)).toHaveText('[sudo] recovery key:');
    await typeLine(page, 'RK-good');
    await layer(page, 'reset');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('reset@account:~#');
    await expect(log(page).locator('.sgx-at-l--echo').first()).toContainText('root@account:~# sudo root reset');
    await d.locator('[data-at-act="passwd"]').click();
    await typeLine(page, 'newpassword1');
    await typeLine(page, 'newpassword1');
    await mode(page, 'pick');
    await termIn(page).press('3');
    await expect(log(page)).toContainText('重置完成');
    await layer(page, 'home');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('root@account:~#');
    await expect(d).toHaveAttribute('data-acct-state', 'in');
  });

  test('reset 层底部「^C 返回」（2026-11-09）：点了离开 reset（没选登出方式 = 不登出），回 login@account；Ctrl+C 一样', async ({ page }) => {
    let reset = null;
    const calls = await mockAccount(page, {
      status: () => STATUS({ reset }),
      handlers: { 'reset/recovery-key': () => { reset = { by: 'recovery-key', expiresAt: Date.now() + 175000 }; return [200, { ok: true }]; } },
    });
    await T.goPage(page);
    const d = await openTerm(page);
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await typeLine(page, 'RK-good');
    await layer(page, 'reset');
    await mode(page, 'cmd');
    const chip = d.locator('.sgx-at-rcc button');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('^C 返回');
    await expect(chip).toHaveAttribute('aria-label', '离开 reset，返回（^C）');
    /* 在面板最底部（页脚上面，列表下面） */
    const g = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { chipTop: r('#sgx-acct .sgx-at-rcc').top, listBottom: r('#sgx-acct [data-at-view] .sgx-pop-list').bottom };
    });
    expect(g.chipTop).toBeGreaterThanOrEqual(g.listBottom - 1);
    await chip.click();
    await expect(log(page).getByText('^C', { exact: true })).toHaveCount(1);
    await layer(page, 'guest');
    await expect(ps(page)).not.toHaveText('reset@account:~#');
    await expect(d.locator('.sgx-at-rcc')).toHaveCount(0);
    expect(calls.some((c) => c.action === 'reset/finish')).toBe(false);
    /* 再进一次，用 Ctrl+C 离开 */
    reset = null;
    await mode(page, 'cmd');
    await typeLine(page, 'sudo root reset');
    await mode(page, 'rkey');
    await typeLine(page, 'RK-good');
    await layer(page, 'reset');
    await mode(page, 'cmd');
    await termIn(page).press('Control+c');
    await layer(page, 'guest');
    await expect(d.locator('.sgx-at-rcc')).toHaveCount(0);
  });

  test('旧地址 #acct=reset（/account/reset/ 301 过来）：直接进 sudo root reset', async ({ page }) => {
    await mockAccount(page, { status: STATUS() });
    await T.goPage(page, '/zh/#acct=reset');
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-state', 'open');
    await mode(page, 'rkey');
    await expect(log(page)).toContainText('sudo root reset');
    await expect(page).toHaveURL(/\/zh\/$/);
  });
});
