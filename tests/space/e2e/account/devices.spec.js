/**
 * 账号 › 设备（cmd/devices.js）：device 列表（本机标「当前」），device rm <n> [y/N]（devices/revoke），device rm --all 要 reauth。
 * S9 起都在全站终端 #sgx-term 的账号层里跑（账号卡片只展示）。
 *
 * 静态构建 + /api/account 替身（helpers/account-term.cjs），无需真实后端。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { SESSION, REAUTH, STATUS, mockAccount, openTerm, log, termIn, ps, typeLine, mode } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

/** 设备（D1–D9）的替身数据 */
const DEVICES = () => [
  { deviceId: 'd-me', name: 'Galaxy S23 Ultra', browser: 'Samsung Internet', current: true, by: 'password', lastSeen: Date.now() },
  { deviceId: 'd-2', name: 'Galaxy Tab S9', browser: 'Chrome', current: false, lastSeen: Date.now() - 3 * 3600000 },
];

test.describe('设备', () => {
  test('device 列表；device rm 1（此设备）→ 提示用 exit；device rm 2 [y/N] → devices/revoke；device rm --all 要 reauth', async ({ page }) => {
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
    await openTerm(page);
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    await typeLine(page, 'device');
    await expect(log(page)).toContainText('[1] Galaxy S23 Ultra 当前 · 现在在线 · Samsung Internet');
    await expect(log(page)).toContainText('账号密码');
    await expect(log(page)).toContainText('[2] Galaxy Tab S9 · 3 小时前活动 · Chrome');

    await mode(page, 'cmd');
    await typeLine(page, 'device rm 1');
    await expect(log(page)).toContainText('不能在这里退出此设备');
    await typeLine(page, 'device rm 9');
    await expect(log(page)).toContainText('没有这台设备');

    /* 退出其他所有设备：先 reauth，再 [y/N] */
    await typeLine(page, 'device rm --all');
    await expect(log(page)).toContainText('退出其他所有设备要再验证');
    await mode(page, 'pick');
    await termIn(page).press('2');
    await typeLine(page, 'correct-horse');
    await expect(log(page)).toContainText('退出其他所有设备？ [y/N]');
    await typeLine(page, 'y');
    await expect(log(page)).toContainText('已退出其他所有设备');
    expect(calls.some((c) => c.action === 'devices/revoke-all')).toBe(true);

    /* 单台：[y/N]，默认 n 不动 */
    await mode(page, 'cmd');
    await typeLine(page, 'device rm 2');
    await expect(log(page)).toContainText('退出 Galaxy Tab S9？ [y/N]');
    await typeLine(page, '');
    await mode(page, 'cmd');
    expect(calls.some((c) => c.action === 'devices/revoke')).toBe(false);
    await typeLine(page, 'device rm 2');
    await typeLine(page, 'y');
    await expect(log(page)).toContainText('已退出该设备');
    expect(calls.find((c) => c.action === 'devices/revoke')).toEqual({ action: 'devices/revoke', deviceId: 'd-2' });
    await mode(page, 'cmd');
    await typeLine(page, 'device');
    await expect(log(page)).toContainText('没有其他设备登录着');
  });

  test('没登录账号（styrigx@space）：device 要 sudo root', async ({ page }) => {
    await mockAccount(page, { status: STATUS({ session: null }) });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    await typeLine(page, 'device');
    await expect(log(page)).toContainText('sudo root');
  });
});
