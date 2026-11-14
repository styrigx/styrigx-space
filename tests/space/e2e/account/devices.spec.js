/**
 * 账号 › 设备（cmd/devices.js）：v6 起「设备」= 自己的 v6 会话（路由表 POST /api/account/devices = user 档，Gray 2026-11-11）。
 * device 列表（[n] 身份路径 · 开始时间，本会话标「当前」；行的写法同身份层 who），device rm <n> [y/N]（devices/revoke { n }），
 * device rm --all [y/N]（devices/revoke-all，v6 不要复验）。访客 → 先 su <用户>。
 * v6 P4（定稿 v5.2 §十三 P4）起旧账号会话（sudo root）与 reauth 删了。
 *
 * 静态构建 + /api/identity、/api/account 替身（helpers/account-term.cjs），无需真实后端。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { mockAccount, openTerm, log, ps, typeLine, mode } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

const SINCE = Date.UTC(2026, 10, 11, 8, 30);
/** 自己的 v6 会话（同 workers/account/src/api/account/devices.js v6Devices list） */
const DEVICES = () => [
  { n: 1, path: 'styrigx', since: SINCE, expiresAt: SINCE + 30 * 86400000, current: true },
  { n: 2, path: 'styrigx', since: SINCE - 86400000, expiresAt: SINCE + 29 * 86400000, current: false },
];

test.describe('设备（v6 会话）', () => {
  test('站长（P4-3，定稿 v5.5 §五、§七）：device 列表直读；device rm 属 root 档 → 提示先 su root（同 main 的 needRoot6），不发 revoke', async ({ page }) => {
    const calls = await mockAccount(page, {
      user: T.V6_USER('styrigx'),
      handlers: { 'devices/list': () => [200, { ok: true, devices: DEVICES() }] },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('styrigx@space:~$');
    await typeLine(page, 'device');
    await expect(log(page)).toContainText('[1] styrigx 当前 · 2026-11-11 08:30');
    await mode(page, 'cmd');
    await typeLine(page, 'device rm 2');
    await expect(log(page)).toContainText('当前用户没有这个权限 · 先 su root');
    expect(calls.some((c) => /^devices\/revoke/.test(c.action))).toBe(false);
  });

  test('root：device 列表；device rm 1（此会话）→ 提示用 exit；device rm 2 [y/N] → devices/revoke { n }；device rm --all [y/N] 不要复验', async ({ page }) => {
    let devs = DEVICES();
    const calls = await mockAccount(page, {
      user: T.V6_USER('root'),
      handlers: {
        'devices/list': () => [200, { ok: true, devices: devs }],
        'devices/revoke': (b) => { devs = devs.filter((x) => x.n !== b.n); return [200, { ok: true }]; },
        'devices/revoke-all': [200, { ok: true }],
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText(/^root@space/);
    await typeLine(page, 'device');
    await expect(log(page)).toContainText('[1] styrigx 当前 · 2026-11-11 08:30');
    await expect(log(page)).toContainText('[2] styrigx · 2026-11-10 08:30');

    await mode(page, 'cmd');
    await typeLine(page, 'device rm 1');
    await expect(log(page)).toContainText('不能在这里退出此设备，请用 exit');
    await typeLine(page, 'device rm 9');
    await expect(log(page)).toContainText('没有这台设备');

    await typeLine(page, 'device rm --all');
    await expect(log(page)).toContainText('退出其他所有设备？ [y/N]');
    await typeLine(page, 'y');
    await expect(log(page)).toContainText('已退出其他所有设备');
    expect(calls.some((c) => c.action === 'devices/revoke-all')).toBe(true);
    expect(calls.some((c) => /^reauth\//.test(c.action))).toBe(false);

    await mode(page, 'cmd');
    await typeLine(page, 'device rm 2');
    await expect(log(page)).toContainText('退出 styrigx？ [y/N]');
    await typeLine(page, '');
    await mode(page, 'cmd');
    expect(calls.some((c) => c.action === 'devices/revoke')).toBe(false);
    await typeLine(page, 'device rm 2');
    await typeLine(page, 'y');
    await expect(log(page)).toContainText('已退出该设备');
    expect(calls.find((c) => c.action === 'devices/revoke')).toEqual({ action: 'devices/revoke', n: 2 });
    await mode(page, 'cmd');
    await typeLine(page, 'device');
    await expect(log(page)).toContainText('没有其他设备登录着');
  });

  test('访客：device 提示先 su <用户>，不发请求', async ({ page }) => {
    const calls = await mockAccount(page, { user: null });
    await T.goPage(page);
    await page.locator('#site-nav .sgx-tb-term').click();
    await expect(ps(page)).toHaveText('nobody@space:~$');
    await typeLine(page, 'device');
    await expect(log(page)).toContainText('su <用户>');
    expect(calls.length).toBe(0);
  });
});
