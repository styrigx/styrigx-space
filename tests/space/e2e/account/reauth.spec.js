/**
 * 账号 › sudo root reauth（reauth.js：3 分钟再验证）。S9 起都在全站终端 #sgx-term 的账号层里跑（账号卡片只展示）。
 * - 账号安全没有 reauth 票：敲 passkey → 原地 sudo root reauth（POST /api/account/reauth { action: password }）→ 列表
 * - 有票时管理操作回 403 reauth → 「验证已过期」；再敲一次又先 sudo root reauth
 * 重新授权应用 / 退出其他所有设备前的 reauth 见 grants.spec.js / devices.spec.js。
 *
 * 静态构建 + /api/account 替身（helpers/account-term.cjs），无需真实后端。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { SESSION, REAUTH, STATUS, mockAccount, openTerm, log, termIn, ps, typeLine, mode } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

const KEYS = () => [
  { credId: 'k1', name: 'S23 Ultra', provider: 'samsung-pass', createdAt: Date.UTC(2026, 9, 21), lastUsedAt: Date.UTC(2026, 10, 7) },
  { credId: 'k2', name: '', provider: 'google-password-manager', createdAt: Date.UTC(2026, 9, 22), lastUsedAt: 0 },
];

test.describe('sudo root reauth（账号安全前）', () => {
  test('没有 reauth 票：passkey → 先 sudo root reauth（POST /api/account/reauth { action: password }）→ 列出通行密钥', async ({ page }) => {
    let ticket = null;
    const calls = await mockAccount(page, {
      status: () => STATUS({ session: SESSION(), reauth: ticket }),
      handlers: {
        'reauth/password': () => { ticket = REAUTH(); return [200, { ok: true }]; },
        'keys/passkey-list': [200, { ok: true, keys: KEYS() }],
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    await typeLine(page, 'passkey');
    await expect(log(page)).toContainText('进入账号安全 · 再验证一次');
    await expect(log(page)).toContainText('验证不了？输入 sudo root reset');
    await mode(page, 'pick');
    await termIn(page).press('2');
    await mode(page, 'pw');
    await typeLine(page, 'correct-horse');
    await expect(log(page)).toContainText('✓ verified');
    await expect(log(page)).toContainText('reauth 3 分钟 · 离开即失效');
    await expect(log(page)).toContainText('[1] S23 Ultra · Samsung Pass · 创建 10-21 · 上次使用 11-07');
    await expect(log(page)).toContainText('[2] Google 密码管理器 · Google 密码管理器 · 创建 10-22 · 未使用');
    expect(calls.filter((c) => c.action === 'reauth/password')).toHaveLength(1);
    expect(calls.some((c) => c.action === 'session/password')).toBe(false);
    /* 票还在：再列一次不再问 */
    await mode(page, 'cmd');
    await typeLine(page, 'clear');
    await typeLine(page, 'passkey');
    await expect(log(page)).toContainText('[1] S23 Ultra');
    expect(calls.filter((c) => c.action === 'reauth/password')).toHaveLength(1);
  });

  test('管理操作回 403 reauth → 「验证已过期」；再来一次先 sudo root reauth', async ({ page }) => {
    await mockAccount(page, {
      status: STATUS({ session: SESSION(), reauth: REAUTH() }),
      handlers: { 'keys/passkey-list': [200, { ok: true, keys: KEYS() }], 'keys/passkey-delete': [403, { ok: false, error: 'reauth' }] },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    await typeLine(page, 'passkey rm 1');
    await expect(log(page)).toContainText('删除 S23 Ultra？ [y/N]');
    await typeLine(page, 'y');
    await expect(log(page)).toContainText('验证已过期，请重新验证');
    await mode(page, 'cmd');
    await typeLine(page, 'passkey');
    await expect(log(page)).toContainText('进入账号安全 · 再验证一次');
    await mode(page, 'pick');
  });
});
