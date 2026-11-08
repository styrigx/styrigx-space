/**
 * 账号终端 › 账号安全（keys.js：account password / account passkey）。
 * - passwd：最短 8 位 / 两次不一致 / 成功 keys/password-set
 * - 通行密钥：删除两步（keys/passkey-delete）、点名字改名（keys/passkey-rename）、passkey add（注册 → 终端里命名，skip 不改名）
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

test.describe('账号安全（keys，有 reauth 票）', () => {
  test('passwd：最短 8 位、两次不一致、成功 keys/password-set', async ({ page }) => {
    const calls = await mockAccount(page, {
      status: STATUS({ session: SESSION(), reauth: REAUTH() }),
      handlers: { 'keys/password-set': [200, { ok: true }] },
    });
    await T.goPage(page);
    const d = await openTerm(page);
    await typeLine(page, 'cd security');
    await layer(page, 'keys');
    await expect(d.locator('.sgx-at-hv')).toHaveText(/^reauth · /);
    await typeLine(page, 'passwd');
    await mode(page, 'newpw');
    await expect(ps(page)).toHaveText('New password:');
    await typeLine(page, 'short');
    await expect(log(page)).toContainText('BAD PASSWORD: 最短 8 位');
    await mode(page, 'cmd');
    await d.locator('[data-at-act="passwd"]').click();
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

  test('删除通行密钥两步（keys/passkey-delete）；点名字改名（keys/passkey-rename）', async ({ page }) => {
    let keys = KEYS();
    const calls = await mockAccount(page, {
      status: STATUS({ session: SESSION(), reauth: REAUTH() }),
      handlers: {
        'keys/passkey-list': () => [200, { ok: true, keys }],
        'keys/passkey-delete': (b) => { keys = keys.filter((k) => k.credId !== b.credId); return [200, { ok: true }]; },
        'keys/passkey-rename': (b) => { keys = keys.map((k) => (k.credId === b.credId ? Object.assign({}, k, { name: b.name }) : k)); return [200, { ok: true }]; },
      },
    });
    await T.goPage(page);
    const d = await openTerm(page);
    await typeLine(page, 'cd security');
    await expect(d.locator('.sgx-at-nm')).toHaveCount(2);
    const del = d.locator('[data-at-act="pk:k2"]');
    await del.click();
    await expect(del).toHaveText('再按一次删除');
    expect(calls.some((c) => c.action === 'keys/passkey-delete')).toBe(false);
    await d.locator('[data-at-act="pk:k2"]').click();
    await expect(log(page)).toContainText('Samsung Pass 里手动删掉');
    await expect(d.locator('.sgx-at-nm')).toHaveCount(1);
    expect(calls.find((c) => c.action === 'keys/passkey-delete')).toEqual({ action: 'keys/passkey-delete', credId: 'k2' });

    await d.locator('[data-at-act="rename:k1"]').click();
    await mode(page, 'pkname');
    await expect(log(page)).toContainText('为这把通行密钥命名 [S23 Ultra]:');
    await expect(termIn(page)).toHaveValue('S23 Ultra');
    await typeLine(page, 'My Phone');
    await expect(log(page)).toContainText('已重命名');
    await expect(d.locator('.sgx-at-nm')).toHaveText(['My Phone']);
    expect(calls.find((c) => c.action === 'keys/passkey-rename')).toEqual({ action: 'keys/passkey-rename', credId: 'k1', name: 'My Phone' });
  });

  test('passkey add：注册 → 终端里命名，skip 不改名', async ({ page }) => {
    await T.fakePasskey(page);
    const calls = await mockAccount(page, {
      status: STATUS({ session: SESSION(), reauth: REAUTH(), passkey: false }),
      handlers: {
        'keys/passkey-add-challenge': [200, { ok: true, challenge: 'Y2hhbA', cid: 'c2', rpId: 'localhost', user: { id: 'dQ', name: 'AccountPasskey', displayName: 'Styrigx' } }],
        'keys/passkey-add': [200, { ok: true, credId: 'k9' }],
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await typeLine(page, 'cd security');
    await layer(page, 'keys');
    await typeLine(page, 'passkey add');
    await expect(log(page)).toContainText('已注册');
    await mode(page, 'pkname');
    await typeLine(page, 'skip');
    await mode(page, 'cmd');
    expect(calls.filter((c) => c.action === 'keys/passkey-add')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'keys/passkey-rename')).toHaveLength(0);
  });
});
