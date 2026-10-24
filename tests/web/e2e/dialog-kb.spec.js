/**
 * 账号登录选择行 UI 回归（原两扇门验证弹层已移除：站长凭证升级为账号，登录在账号页 /account/）。
 * - 眼睛按钮：初始 eye-off，切换图标/文案/aria-pressed，焦点留在输入框
 * - 按钮反馈（PR3 登录页）：通行密钥登录立即 busy（busy 文案 + 禁用），取消恢复，challenge 只发一次；
 *   密码登录原地展开 / 再点收起；点击轻振 10ms
 * - 安全页状态卡片文案（账号凭证）
 * （原弹层键盘避让用例随弹层删除：账号登录是页内表单，不再是底部弹层。）
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 } });

async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

async function mockJson(pg, pattern, status, body) {
  await pg.route(pattern, async (route) => {
    await route.fulfill({
      status: status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

async function gotoAccount(pg) {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await mockJson(pg, '**/api/account', 200, { ok: true, password: true, passkey: true, ready: true, session: null });
  await pg.goto('/account/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('#acct-login-go')).toBeVisible({ timeout: 15000 });
}
/* 2026-10-24：账号登录与锁屏同一套 —— 「登录」→ 方式弹层（#acct-pk-btn / #acct-pw-btn）→ 验证弹层 */
async function openSheet(pg) {
  await pg.click('#acct-login-go');
  await expect(pg.locator('#sgx-method-sheet.visible')).toBeVisible();
}

test.describe('account login eye button (批次 A 验收修复 P2)', () => {
  test('password sheet: eye starts eye-off, toggles icon/label/pressed, keeps focus', async ({ page: pg }) => {
    await gotoAccount(pg);
    await openSheet(pg);
    await pg.click('#acct-pw-btn');
    /* locator 不带 type：切换明/密文后仍是同一元素 */
    const input = pg.locator('#acct-pw-input');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('type', 'password');
    const eye = pg.locator('#acct-pw-eye');
    await expect(eye).toBeVisible();

    /* 初始：eye-off（SVG 含斜线）+ 显示密码 + aria-pressed=false */
    await expect(eye).toHaveAttribute('aria-label', '显示密码');
    await expect(eye).toHaveAttribute('aria-pressed', 'false');
    const offHtml = await eye.evaluate((el) => el.innerHTML);
    expect(offHtml).toContain('<line');

    /* 点一次：eye（无斜线）+ 隐藏密码 + aria-pressed=true + 明文 + 焦点仍在输入框 */
    await eye.click();
    await expect(eye).toHaveAttribute('aria-label', '隐藏密码');
    await expect(eye).toHaveAttribute('aria-pressed', 'true');
    const onHtml = await eye.evaluate((el) => el.innerHTML);
    expect(onHtml).not.toContain('<line');
    await expect(input).toHaveAttribute('type', 'text');
    await expect(input).toBeFocused();

    /* 再点：恢复密文态 */
    await eye.click();
    await expect(eye).toHaveAttribute('aria-label', '显示密码');
    await expect(eye).toHaveAttribute('aria-pressed', 'false');
    await expect(input).toHaveAttribute('type', 'password');
  });
});

test.describe('account login button feedback (批次 A 验收修复 P2)', () => {
  test('passkey: immediate busy state in the sheet, cancel closes quietly, challenge only once', async ({ page: pg }) => {
    await gotoAccount(pg);
    let challengeCalls = 0;
    await pg.route('**/api/account', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, password: true, passkey: true, ready: true, session: null }) });
        return;
      }
      const body = (route.request().postData() || '').toString();
      if (body.includes('"challenge"')) challengeCalls++;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, challenge: 'AA', cid: 'c1', rpId: 'localhost' }) });
    });
    /* credentials.get 挂起（等测试手动取消） */
    await pg.evaluate(() => {
      window.__sgxRejectGet = null;
      navigator.credentials.get = () => new Promise((_, reject) => { window.__sgxRejectGet = reject; });
    });
    await openSheet(pg);
    await pg.click('#acct-pk-btn');
    await expect(pg.locator('#acct-pk-busy')).toHaveText('正在唤起通行密钥…');
    await expect.poll(() => challengeCalls).toBe(1);
    /* busy 中再点「登录」→ 方式弹层 → 通行密钥：challenge 不再发 */
    await pg.locator('#acct-login-go').evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(challengeCalls).toBe(1);
    await pg.evaluate(() => {
      const err = new DOMException('User cancelled', 'NotAllowedError');
      window.__sgxRejectGet(err);
    });
    await expect(pg.locator('.sgx-verify-dlg')).toBeHidden({ timeout: 3000 });
    await expect(pg.locator('#acct-login')).toBeVisible();
    await expect(pg.locator('#acct-pk-err')).toHaveCount(0);
  });

  test('sign-in button opens the method sheet; option tap vibrates 10ms; Esc closes', async ({ page: pg }) => {
    await pg.addInitScript(() => {
      window.__vibCalls = [];
      navigator.vibrate = (ms) => { window.__vibCalls.push(ms); return true; };
    });
    await gotoAccount(pg);
    await openSheet(pg);
    expect(await pg.evaluate(() => window.__vibCalls)).toEqual([10]);
    await pg.keyboard.press('Escape');
    await expect(pg.locator('#sgx-method-sheet')).toHaveCount(0);
    await openSheet(pg);
    await pg.click('#acct-pw-btn');
    expect(await pg.evaluate(() => window.__vibCalls)).toEqual([10, 10, 10]);
    await expect(pg.locator('#acct-pw-input')).toBeFocused();
  });
});

test.describe('security status card wording (批次 A 验收修复 #8)', () => {
  test('missing unlock password shows 解锁密码 wording (PR2 锁屏凭证门)', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    /* PR2：安全页卡片数据源是 GET /api/lock-status（锁屏凭证）；账号凭证在账号页 */
    await mockJson(pg, '**/api/lock-status', 200, { ok: true, password: false, passkey: true });
    await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('#sec-status-title')).toContainText('建议操作', { timeout: 15000 });
    await expect(pg.locator('#sec-status-sub')).toHaveText('未设置解锁密码');
  });

  test('missing passkey copy names lock passkeys（未注册锁屏通行密钥）', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    await mockJson(pg, '**/api/lock-status', 200, { ok: true, password: true, passkey: false });
    await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('#sec-status-title')).toContainText('建议操作', { timeout: 15000 });
    await expect(pg.locator('#sec-status-sub')).toHaveText('未注册锁屏通行密钥');
  });
});
