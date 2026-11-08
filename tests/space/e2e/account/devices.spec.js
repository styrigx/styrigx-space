/**
 * 账号终端 › 设备（devices.js）：此设备 / 其他设备，单台退出两步（devices/revoke），退出其他所有设备要 reauth。
 *
 * 静态构建 + /api/account 替身（helpers/account-term.cjs），无需真实后端。2026-11-08 账号 UI 改版：没有 /account/ 整页了，账号在头像下拉 #sgx-acct 的账号终端（shell/account/*）。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { SESSION, REAUTH, STATUS, mockAccount, openTerm, log, termIn, ps, typeLine, mode, layer } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

/** 设备页（D1–D9）的替身数据 */
const DEVICES = () => [
  { deviceId: 'd-me', name: 'Galaxy S23 Ultra', browser: 'Samsung Internet', current: true, by: 'password', lastSeen: Date.now() },
  { deviceId: 'd-2', name: 'Galaxy Tab S9', browser: 'Chrome', current: false, lastSeen: Date.now() - 3 * 3600000 },
];

test.describe('设备', () => {
  test('此设备 / 其他设备；单台退出两步 devices/revoke；退出其他所有设备要 reauth', async ({ page }) => {
    let devs = DEVICES();
    let ticket = null;
    const calls = await mockAccount(page, {
      status: () => STATUS({ session: SESSION(), reauth: ticket }),
      handlers: {
        'devices/list': () => [200, { ok: true, devices: devs }],
        'devices/revoke': (b) => { devs = devs.filter((x) => x.deviceId !== b.deviceId); return [200, { ok: true }]; },
        'reauth/password': () => { ticket = REAUTH(); return [200, { ok: true }]; },
        'devices/revoke-all': [200, { ok: true }],
      },
    });
    await T.goPage(page);
    const d = await openTerm(page);
    await typeLine(page, 'cd devices');
    await layer(page, 'devices');
    await expect(d.locator('.sgx-at-hv')).toHaveText('2 个会话');
    await expect(d.locator('[data-at-view]')).toContainText('Galaxy S23 Ultra');
    await expect(d.locator('[data-at-view]')).toContainText('现在在线 · Samsung Internet');
    await expect(d.locator('[data-at-view]')).toContainText('3 小时前活动 · Chrome');
    await expect(d.locator('[data-at-view]')).toContainText('账号密码');
    await expect(d.locator('[data-at-act="revoke-all"]')).toContainText('需 reauth');

    await d.locator('[data-at-act="revoke-all"]').click();
    await d.locator('[data-at-act="revoke-all"]').click();
    await expect(log(page)).toContainText('退出其他所有设备要再验证');
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(log(page)).toContainText('已退出其他所有设备');
    expect(calls.some((c) => c.action === 'devices/revoke-all')).toBe(true);

    const one = d.locator('[data-at-act="dev:d-2"]');
    await one.click();
    await expect(d.locator('[data-at-act="dev:d-2"]')).toContainText('再按一次');
    await d.locator('[data-at-act="dev:d-2"]').click();
    await expect(log(page)).toContainText('已退出该设备');
    expect(calls.find((c) => c.action === 'devices/revoke')).toEqual({ action: 'devices/revoke', deviceId: 'd-2' });
    await expect(d.locator('[data-at-view]')).toContainText('没有其他设备登录着');
  });
});
