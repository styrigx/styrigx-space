/**
 * R-34（稿 v3.11 第 8 节，Gray 2026-11-15 02:07 / 02:16 / 02:29 / 02:36）：凭据管理与救援重置站长——终端提示与回显。
 * - root passwd styrigx：服务端 403 protected → passwd 下显示「站长凭据只能本人修改或走救援」（userdel 照旧「root 和 styrigx 不能删」）
 * - root / 站长自己 passwd：先问「1 密码 / 2 通行密钥」（同 su 的 proofOf），提示用现成的「当前密码：」，证明放 proof 随 passwd 发
 * - 普通用户 passwd：不变（只问当前密码）
 * - 救援 passwd styrigx：一次性密码 + 到期时间 + 首登改密 / passkey rm / 换救援钥匙的提示；救援会话不退出
 *
 * 静态构建 + /api/identity 替身（helpers/account-term.cjs），无需真实后端。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { mockAccount, openTerm, log, ps, typeLine, mode } = T;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

const SHOT = process.env.SGX_R34_SHOTS || '';

/** @param {any} page @param {string} name */
async function shot(page, name) {
  if (SHOT) await page.locator('#sgx-term').screenshot({ path: SHOT + '/' + name + '.png' });
}

test.describe('R-34 凭据管理与救援重置站长', () => {
  test('root passwd styrigx → 「站长凭据只能本人修改或走救援」；userdel styrigx 照旧', async ({ page }) => {
    const calls = await mockAccount(page, {
      handlers: {
        'identity/passwd-user': [403, { ok: false, error: 'protected', target: 'webmaster' }],
        'identity/userdel': [403, { ok: false, error: 'protected', target: 'webmaster' }],
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('root@space:~#');
    await typeLine(page, 'passwd styrigx');
    await expect(log(page)).toContainText('站长凭据只能本人修改或走救援');
    await mode(page, 'cmd');
    await typeLine(page, 'userdel styrigx');
    await expect(log(page)).toContainText('root 和 styrigx 不能删');
    await mode(page, 'cmd');
    expect(calls.find((c) => c.action === 'identity/passwd-user')).toMatchObject({ name: 'styrigx' });
    await shot(page, '1-root-passwd-styrigx');
  });

  test('站长自己 passwd：先选密码 / 通行密钥，「当前密码：」，证明放 proof', async ({ page }) => {
    const calls = await mockAccount(page, { user: T.V6_USER('styrigx'), handlers: { 'identity/passwd': [200, { ok: true }] } });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('styrigx@space:~$');
    await typeLine(page, 'passwd');
    await expect(log(page)).toContainText('密码');
    await expect(log(page)).toContainText('通行密钥');
    await shot(page, '2-self-passwd-pick');
    await typeLine(page, '1');
    await expect(ps(page)).toHaveText('当前密码：');
    await typeLine(page, 'sty-pass-01');
    await typeLine(page, 'sty-pass-02x');
    await typeLine(page, 'sty-pass-02x');
    await expect(log(page)).toContainText('密码已改');
    await mode(page, 'cmd');
    const p = calls.find((c) => c.action === 'identity/passwd');
    expect(p).toEqual({ action: 'identity/passwd', password: 'sty-pass-02x', as: 1000, proof: { password: 'sty-pass-01' } });
    await shot(page, '3-self-passwd-done');
  });

  test('站长自己 passwd 验证没过 →「认证失败」', async ({ page }) => {
    await mockAccount(page, { user: T.V6_USER('styrigx'), handlers: { 'identity/passwd': [401, { ok: false, error: 'auth' }] } });
    await T.goPage(page);
    await openTerm(page);
    await typeLine(page, 'passwd');
    await typeLine(page, '1');
    await typeLine(page, 'wrong-pass');
    await typeLine(page, 'sty-pass-02x');
    await typeLine(page, 'sty-pass-02x');
    await expect(log(page)).toContainText('认证失败');
    await mode(page, 'cmd');
    await shot(page, '4-self-passwd-fail');
  });

  test('普通用户 passwd：不变，只问当前密码（不问验证方式）', async ({ page }) => {
    const calls = await mockAccount(page, { user: T.V6_USER('alice'), handlers: { 'identity/passwd': [200, { ok: true }] } });
    await T.goPage(page);
    await openTerm(page);
    await typeLine(page, 'passwd');
    await expect(ps(page)).toHaveText('当前密码：');
    await typeLine(page, 'alice-pass-01');
    await typeLine(page, 'alice-pass-02');
    await typeLine(page, 'alice-pass-02');
    await expect(log(page)).toContainText('密码已改');
    expect(calls.find((c) => c.action === 'identity/passwd').proof).toEqual({ password: 'alice-pass-01' });
  });

  test('救援 passwd styrigx：一次性密码 + 到期时间 + 三条提示；救援会话不退出', async ({ page }) => {
    const exp = Date.now() + 24 * 3600 * 1000;
    const rescue = { uid: 0, name: 'root', groups: [], root: true, rescue: true, via: '', path: 'root (rescue)', webmaster: false, wheel: false, sudoers: false, layerExpiresAt: Date.now() + 900000, idleMs: 0 };
    const calls = await mockAccount(page, {
      user: rescue,
      handlers: { 'identity/passwd-user': [200, { ok: true, uid: 1000, password: 'Otp-Example-0123456789', passwordExpiresAt: exp, mustChange: true }] },
    });
    await T.goPage(page);
    await openTerm(page);
    await expect(ps(page)).toHaveText('root@space:~#');
    await typeLine(page, 'passwd styrigx');
    await expect(log(page)).toContainText('一次性密码：Otp-Example-0123456789');
    await expect(log(page)).toContainText('到期：');
    await expect(log(page)).toContainText('丢失的通行密钥登录后用 passkey rm 删除');
    await expect(log(page)).toContainText('去 Cloudflare 换救援钥匙');
    await mode(page, 'cmd');
    await expect(ps(page)).toHaveText('root@space:~#');
    expect(calls.find((c) => c.action === 'identity/passwd-user')).toEqual({ action: 'identity/passwd-user', name: 'styrigx' });
    await shot(page, '5-rescue-passwd-styrigx');
  });
  test('站长 passkey rm 最后一把：[y/N] → 先验证（选通行密钥前可选密码）→ 删除并提示一句', async ({ page }) => {
    let keys = [{ n: 1, name: 'S23 Ultra', provider: 'samsung-pass', createdAt: Date.UTC(2026, 9, 21), lastUsedAt: Date.UTC(2026, 10, 7) }];
    const calls = await mockAccount(page, {
      user: T.V6_USER('styrigx'),
      handlers: {
        'identity/passkey-list': () => [200, { ok: true, passkeys: keys }],
        'identity/passkey-delete': (b) => { keys = []; return [200, { ok: true }]; },
      },
    });
    await T.goPage(page);
    await openTerm(page);
    await typeLine(page, 'passkey rm 1');
    await typeLine(page, 'y');
    await expect(log(page)).toContainText('通行密钥');
    await typeLine(page, '1');
    await expect(ps(page)).toHaveText('当前密码：');
    await typeLine(page, 'sty-pass-01');
    await expect(log(page)).toContainText('这是最后一把通行密钥');
    await mode(page, 'cmd');
    expect(calls.find((c) => c.action === 'identity/passkey-delete').proof).toEqual({ password: 'sty-pass-01' });
    await shot(page, '6-passkey-rm-last');
  });
});
