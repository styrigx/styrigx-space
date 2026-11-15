/**
 * 账号 › 自己的通行密钥（cmd/keys.js，v6）：passkey [ls] / passkey add / passkey rm <n>，后端 POST /api/identity passkey-*（user 档，
 * 按服务端会话 uid 管栈顶那个用户自己的；定稿 v5.2 §八「普通用户用 passwd、passkey 改自己的凭据」）。
 * - passkey rm <n>：[y/N]（identity passkey-delete { n }，提示去 Samsung Pass 手动删）；没有的编号 → 先列出来
 * - passkey add：系统窗口 → 注册（identity passkey-add 带回 challenge 的 user.id；v6 没有改名接口，不问名字）；等系统窗口时 ^C / esc 收起
 * - R-34（稿 v3.11 第 8 节）：add、rm 先验证——「1 密码 / 2 通行密钥」（同 su），证明放 proof 随请求发；rm 删最后一把提示一句
 * v6 P4（定稿 §十三 P4）起旧的账号钥匙（/api/account/keys、sudo root reauth 票、账号 passwd）删了；改密码是身份层 passwd（单测覆盖）。
 *
 * 静态构建 + /api/identity 替身（helpers/account-term.cjs），无需真实后端。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { mockAccount, openTerm, log, ps, typeLine, mode } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

/** passkey-list 的 passkeys（服务端编号 n） */
const KEYS = () => [
  { n: 1, name: 'S23 Ultra', provider: 'samsung-pass', createdAt: Date.UTC(2026, 9, 21), lastUsedAt: Date.UTC(2026, 10, 7) },
  { n: 2, name: '', provider: 'google-password-manager', createdAt: Date.UTC(2026, 9, 22), lastUsedAt: 0 },
];
/** 先验证（R-34）：「1 密码 / 2 通行密钥」选 1，再输密码 @param {any} page @param {string} pw */
async function proveWithPassword(page, pw) {
  await expect(log(page)).toContainText('通行密钥');
  await typeLine(page, '1');
  await expect(ps(page)).toHaveText('当前密码：');
  await typeLine(page, pw);
}

const CHALLENGE = [200, { ok: true, challenge: 'Y2hhbA', rpId: 'localhost', user: { id: 'dQ', name: 'styrigx', displayName: 'styrigx' } }];

test.describe('自己的通行密钥（v6）', () => {
  test('passkey rm <n>：[y/N]，n 不动；y → identity passkey-delete { n }，提示去 Samsung Pass 手动删；没有的编号 → 先列出来', async ({ page }) => {
    let keys = KEYS();
    const calls = await mockAccount(page, {
      user: T.V6_USER('styrigx'),
      handlers: {
        'identity/passkey-list': () => [200, { ok: true, passkeys: keys }],
        'identity/passkey-delete': (b) => { keys = keys.filter((k) => k.n !== b.n); return [200, { ok: true }]; },
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('styrigx@space:~$');
    await typeLine(page, 'passkey rm 2');
    await expect(log(page)).toContainText('删除 Google 密码管理器？ [y/N]');
    await typeLine(page, 'n');
    await mode(page, 'cmd');
    expect(calls.some((c) => c.action === 'identity/passkey-delete')).toBe(false);
    await typeLine(page, 'passkey rm 2');
    await typeLine(page, 'y');
    await proveWithPassword(page, 'sty-pass-01');
    await expect(log(page)).toContainText('Samsung Pass 里手动删掉');
    expect(calls.find((c) => c.action === 'identity/passkey-delete')).toEqual({ action: 'identity/passkey-delete', n: 2, as: 1000, proof: { password: 'sty-pass-01' } });
    await expect(log(page)).not.toContainText('最后一把');
    await mode(page, 'cmd');
    await typeLine(page, 'clear');
    await typeLine(page, 'passkey ls');
    await expect(log(page).locator('.sgx-at-p')).toHaveText(['[1]']);
    await typeLine(page, 'passkey rm 5');
    await expect(log(page)).toContainText('没有这把通行密钥');
    await expect(log(page)).toContainText('先列出来：passkey');
    /* 删最后一把：允许，提示一句 */
    await typeLine(page, 'passkey rm 1');
    await typeLine(page, 'y');
    await proveWithPassword(page, 'sty-pass-01');
    await expect(log(page)).toContainText('这是最后一把通行密钥');
    expect(calls.some((c) => /^(keys|reauth|session)\//.test(c.action))).toBe(false);
  });

  test('R-34 passkey rm：验证没过 → 「认证失败」，不当成没登录、不删', async ({ page }) => {
    await mockAccount(page, {
      user: T.V6_USER('styrigx'),
      handlers: {
        'identity/passkey-list': () => [200, { ok: true, passkeys: KEYS() }],
        'identity/passkey-delete': [401, { ok: false, error: 'auth' }],
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await typeLine(page, 'passkey rm 2');
    await typeLine(page, 'y');
    await proveWithPassword(page, 'wrong-pass');
    await expect(log(page)).toContainText('认证失败');
    await expect(log(page)).not.toContainText('没有登录');
    await mode(page, 'cmd');
  });

  test('passkey add：注册（带回 challenge 的 user.id），不问名字，回命令行', async ({ page }) => {
    await T.fakePasskey(page);
    const calls = await mockAccount(page, {
      handlers: { 'identity/passkey-add-challenge': CHALLENGE, 'identity/passkey-add': [200, { ok: true }] },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('root@space:~#');
    await typeLine(page, 'passkey add');
    await proveWithPassword(page, 'root-pass-01');
    await expect(log(page)).toContainText('已注册');
    await mode(page, 'cmd');
    const add = calls.filter((c) => c.action === 'identity/passkey-add');
    expect(add).toHaveLength(1);
    expect(add[0].handle).toBe('dQ');
    expect(add[0].proof).toEqual({ password: 'root-pass-01' });
  });

  test('passkey add 等系统窗口时 ^C（Ctrl+C / esc 都行，2026-11-09）：收起系统窗口（abort），回命令行，不提交 passkey-add、不报错', async ({ page }) => {
    await T.fakePasskey(page, { hang: true });
    const calls = await mockAccount(page, {
      handlers: { 'identity/passkey-add-challenge': CHALLENGE, 'identity/passkey-add': [200, { ok: true }] },
    });
    await T.goPage(page);
    const d = await openTerm(page);
    await typeLine(page, 'passkey add');
    await proveWithPassword(page, 'root-pass-01');
    await mode(page, 'busy');
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__pkWaiting)).toBe(1);
    await page.keyboard.press('Control+c');
    await mode(page, 'cmd');
    await expect(log(page).locator('.sgx-at-l').last()).toHaveText('^C');
    expect(await page.evaluate(() => /** @type {any} */ (window).__pkAborted)).toBe(1);
    await page.waitForTimeout(300);
    await expect(log(page)).not.toContainText('已取消');
    await expect(log(page).locator('.sgx-at-l--er')).toHaveCount(0);
    await mode(page, 'cmd');
    await typeLine(page, 'passkey add');
    await proveWithPassword(page, 'root-pass-01');
    await mode(page, 'busy');
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__pkWaiting)).toBe(2);
    await page.keyboard.press('Escape');
    await mode(page, 'cmd');
    await expect(d).toHaveAttribute('open', '');
    expect(await page.evaluate(() => /** @type {any} */ (window).__pkAborted)).toBe(2);
    expect(calls.filter((c) => c.action === 'identity/passkey-add')).toHaveLength(0);
  });
});
