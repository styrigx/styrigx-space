/**
 * 账号终端 › sudo root reset（reset.js）：恢复密钥（[sudo] recovery key:）→ reset 票（不登录）→ 改密码 → 三选一（enter 默认 [2] others）→ reset/finish；
 * 旧地址 #acct=reset 直接进。
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
    expect(calls.find((c) => c.action === 'reset/password-set')).toEqual({ action: 'reset/password-set', password: 'newpassword1' });
    expect(calls.some((c) => c.action.startsWith('keys/'))).toBe(false);
    expect(calls.find((c) => c.action === 'reset/finish')).toEqual({ action: 'reset/finish', signOut: 'others' });
    expect(calls.some((c) => c.action === 'session/password')).toBe(false);
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
