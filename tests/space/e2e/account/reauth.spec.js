/**
 * 账号终端 › sudo root reauth（reauth.js：3 分钟再验证）。
 * - 进账号安全没有 reauth 票：终端里 sudo root reauth（POST login-password reauth:true）→ 列表 + 头部 reauth · mm:ss
 * - 管理操作回 403 reauth → 「验证已过期」，回到 locked
 * 重新授权应用 / 退出其他所有设备前的 reauth 见 grants.spec.js / devices.spec.js。
 *
 * 静态构建 + /api/account 替身（helpers/account-term.cjs），无需真实后端。2026-11-08 账号 UI 改版：没有 /account/ 整页了，账号在头像下拉 #sgx-acct 的账号终端（shell/account/*）。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { SESSION, REAUTH, STATUS, mockAccount, openTerm, log, termIn, ps, typeLine, mode, layer } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

const KEYS = () => [
  { credId: 'k1', name: 'S23 Ultra', provider: 'samsung-pass', createdAt: Date.UTC(2026, 9, 21), lastUsedAt: Date.UTC(2026, 10, 7) },
  { credId: 'k2', name: '', provider: 'google-password-manager', createdAt: Date.UTC(2026, 9, 22), lastUsedAt: 0 },
];

test.describe('sudo root reauth（进账号安全前）', () => {
  test('没有 reauth 票：进来先 sudo root reauth（POST login-password reauth:true）→ 列表 + 头部 reauth · mm:ss', async ({ page }) => {
    let ticket = null;
    const calls = await mockAccount(page, {
      status: () => STATUS({ session: SESSION(), reauth: ticket }),
      handlers: {
        'login-password': (b) => { if (!b.reauth) return [400, { ok: false }]; ticket = REAUTH(); return [200, { ok: true }]; },
        'passkey-list': [200, { ok: true, keys: KEYS() }],
      },
    });
    await T.goPage(page);
    const d = await openTerm(page);
    await d.locator('[data-at-act="keys"]').click();
    await layer(page, 'keys');
    await expect(d.locator('.sgx-at-hv')).toHaveText('locked');
    await expect(log(page)).toContainText('root@account:~# sudo root reauth');
    await expect(log(page)).toContainText('进入账号安全 · 再验证一次');
    await expect(log(page)).toContainText('验证不了？输入 sudo root reset');
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(log(page)).toContainText('✓ verified');
    await expect(d.locator('.sgx-at-hv')).toHaveText(/^reauth · 0[0-2]:\d\d$/);
    expect(calls.find((c) => c.action === 'login-password').reauth).toBe(true);
    await expect(d.locator('.sgx-at-nm')).toHaveText(['S23 Ultra', 'Google 密码管理器']);
    await expect(d.locator('[data-at-act="passkey-add"]')).toContainText('添加通行密钥');
  });

  test('管理操作回 403 reauth → 「验证已过期」，回到 locked', async ({ page }) => {
    await mockAccount(page, {
      status: STATUS({ session: SESSION(), reauth: REAUTH() }),
      handlers: { 'passkey-list': [200, { ok: true, keys: KEYS() }], 'passkey-delete': [403, { ok: false, error: 'reauth' }] },
    });
    await T.goPage(page);
    const d = await openTerm(page);
    await typeLine(page, 'cd security');
    await d.locator('[data-at-act="pk:k1"]').click();
    await d.locator('[data-at-act="pk:k1"]').click();
    await expect(log(page)).toContainText('验证已过期，请重新验证');
    await expect(d.locator('.sgx-at-hv')).toHaveText('locked');
  });
});
