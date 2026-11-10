/**
 * 账号 › 账号安全（cmd/keys.js：account password / account passkey）。S9 起都在全站终端 #sgx-term 的账号层里跑（账号卡片只展示）。
 * - passwd：最短 8 位 / 两次不一致 / 成功 keys/password-set
 * - passkey rm <n>：[y/N]（keys/passkey-delete，提示去 Samsung Pass 手动删）；没有的编号 → 先列出来
 * - passkey add：注册 → 终端里命名（keys/passkey-rename），skip 不改名；等系统窗口时 ^C / esc 收起
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

test.describe('账号安全（keys，有 reauth 票）', () => {
  test('passwd：最短 8 位、两次不一致、成功 keys/password-set', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: STATUS({ session: SESSION(), reauth: REAUTH() }),
      handlers: { 'keys/password-set': [200, { ok: true }] },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    await typeLine(page, 'passwd');
    await mode(page, 'newpw');
    await expect(ps(page)).toHaveText('New password:');
    await typeLine(page, 'short');
    await expect(log(page)).toContainText('BAD PASSWORD: 最短 8 位');
    await mode(page, 'cmd');
    await typeLine(page, 'passwd');
    await typeLine(page, 'longenough1');
    await mode(page, 'newpw2');
    await expect(ps(page)).toHaveText('Retype new password:');
    await typeLine(page, 'longenough2');
    await expect(log(page)).toContainText('Sorry, passwords do not match.');
    await typeLine(page, 'passwd');
    await typeLine(page, 'longenough1');
    await typeLine(page, 'longenough1');
    await expect(log(page)).toContainText('passwd: 账号密码已更新');
    expect(calls.filter((c) => c.action === 'keys/password-set')).toEqual([{ action: 'keys/password-set', password: 'longenough1' }]);
  });

  test('passkey rm <n>：[y/N]，n 不动；y → keys/passkey-delete，提示去 Samsung Pass 手动删；没有的编号 → 先列出来', async ({ page }) => {
    let keys = KEYS();
    const calls = await mockAccount(page, {
      status: STATUS({ session: SESSION(), reauth: REAUTH() }),
      handlers: {
        'keys/passkey-list': () => [200, { ok: true, keys }],
        'keys/passkey-delete': (b) => { keys = keys.filter((k) => k.credId !== b.credId); return [200, { ok: true }]; },
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    await typeLine(page, 'passkey rm 2');
    await expect(log(page)).toContainText('删除 Google 密码管理器？ [y/N]');
    await typeLine(page, 'n');
    await mode(page, 'cmd');
    expect(calls.some((c) => c.action === 'keys/passkey-delete')).toBe(false);
    await typeLine(page, 'passkey rm 2');
    await typeLine(page, 'y');
    await expect(log(page)).toContainText('Samsung Pass 里手动删掉');
    expect(calls.find((c) => c.action === 'keys/passkey-delete')).toEqual({ action: 'keys/passkey-delete', credId: 'k2' });
    await mode(page, 'cmd');
    await typeLine(page, 'clear');
    await typeLine(page, 'passkey');
    await expect(log(page).locator('.sgx-at-p')).toHaveText(['[1]']);
    await typeLine(page, 'passkey rm 5');
    await expect(log(page)).toContainText('没有这把通行密钥');
    await expect(log(page)).toContainText('先列出来：passkey');
  });

  test('passkey add：注册 → 终端里命名，skip 不改名', async ({ page }) => {
    await T.fakePasskey(page);
    const calls = await mockAccount(page, {
      status: STATUS({ session: SESSION(), reauth: REAUTH(), passkey: false }),
      handlers: {
        'keys/passkey-add-challenge': [200, { ok: true, challenge: 'Y2hhbA', cid: 'c2', rpId: 'localhost', user: { id: 'dQ', name: 'AccountPasskey', displayName: 'Styrigx' } }],
        'keys/passkey-add': [200, { ok: true, credId: 'k9' }],
        'keys/passkey-rename': [200, { ok: true }],
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    await typeLine(page, 'passkey add');
    await expect(log(page)).toContainText('已注册');
    await mode(page, 'pkname');
    await expect(log(page)).toContainText('为这把通行密钥命名 [');
    await typeLine(page, 'skip');
    await mode(page, 'cmd');
    expect(calls.filter((c) => c.action === 'keys/passkey-add')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'keys/passkey-rename')).toHaveLength(0);
    /* 再加一把，这次命名 */
    await typeLine(page, 'passkey add');
    await mode(page, 'pkname');
    await typeLine(page, 'My Phone');
    await expect(log(page)).toContainText('已重命名');
    expect(calls.find((c) => c.action === 'keys/passkey-rename')).toEqual({ action: 'keys/passkey-rename', credId: 'k9', name: 'My Phone' });
  });

  test('passkey add 等系统窗口时 ^C（Ctrl+C / esc 都行，2026-11-09）：收起系统窗口（abort），回命令行，不提交 keys/passkey-add、不报错', async ({ page }) => {
    await T.fakePasskey(page, { hang: true });
    const calls = await mockAccount(page, {
      status: STATUS({ session: SESSION(), reauth: REAUTH(), passkey: false }),
      handlers: {
        'keys/passkey-add-challenge': [200, { ok: true, challenge: 'Y2hhbA', cid: 'c2', rpId: 'localhost', user: { id: 'dQ', name: 'AccountPasskey', displayName: 'Styrigx' } }],
        'keys/passkey-add': [200, { ok: true, credId: 'k9' }],
      },
    });
    await T.goPage(page);
    const d = await openTerm(page);
    await expect(ps(page)).toHaveText('root@account:~/wild#');
    await typeLine(page, 'passkey add');
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
    /* esc 一样 */
    await typeLine(page, 'passkey add');
    await mode(page, 'busy');
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__pkWaiting)).toBe(2);
    await page.keyboard.press('Escape');
    await mode(page, 'cmd');
    await expect(d).toHaveAttribute('open', '');
    expect(await page.evaluate(() => /** @type {any} */ (window).__pkAborted)).toBe(2);
    expect(calls.filter((c) => c.action === 'keys/passkey-add')).toHaveLength(0);
  });
});
