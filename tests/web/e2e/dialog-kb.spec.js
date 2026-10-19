/**
 * 账号登录选择行 UI 回归（原两扇门验证弹层已移除：站长凭证升级为账号，登录在账号页 /settings/account/）。
 * - 眼睛按钮：初始 eye-off，切换图标/文案/aria-pressed，焦点留在输入框
 * - 行反馈：通行密钥行立即 busy（转圈 + busy 副标题 + 禁用），取消恢复，challenge 只发一次；
 *   密码行展开选中态 + 箭头旋转，再点收起；点击轻振 10ms
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
  await pg.goto('/settings/account/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('#acct-methods .sgx-door-row')).toHaveCount(3, { timeout: 15000 });
}

test.describe('account login eye button (批次 A 验收修复 P2)', () => {
  test('password row expand: eye starts eye-off, toggles icon/label/pressed, keeps focus', async ({ page: pg }) => {
    await gotoAccount(pg);
    await pg.locator('.sgx-door-row').filter({ hasText: '账号密码' }).click();
    /* locator 不带 type：切换明/密文后仍是同一元素，否则切到 text 后旧 locator 匹配不到 */
    const input = pg.locator('.sgx-door-expand input');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('type', 'password');
    const eye = pg.locator('.sgx-door-expand .sgx-pw-eye');
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

test.describe('account login row feedback (批次 A 验收修复 P2)', () => {
  test('passkey row click: immediate busy (spinner + busy subtitle + disabled), cancel restores, challenge only once', async ({ page: pg }) => {
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
    const row = pg.locator('.sgx-door-row').filter({ hasText: '账号通行密钥' });
    await expect(row).toBeVisible();
    const origSub = await row.locator('.sgx-door-rowsub').textContent();

    /* credentials.get 挂起（等测试手动取消） */
    await pg.evaluate(() => {
      window.__sgxRejectGet = null;
      navigator.credentials.get = () => new Promise((_, reject) => { window.__sgxRejectGet = reject; });
    });
    await row.click();
    /* 立即 busy：转圈 + busy 副标题 + 行禁用 */
    await expect(row.locator('.sgx-door-spin')).toBeVisible({ timeout: 3000 });
    await expect(row).toBeDisabled();
    await expect(row.locator('.sgx-door-rowsub')).toHaveText('正在唤起通行密钥…');
    expect(challengeCalls).toBe(1);
    /* busy 中合成二次点击：challenge 不再发 */
    await row.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(challengeCalls).toBe(1);
    /* 取消系统验证：状态恢复、无错误显示、弹层仍在 */
    await pg.evaluate(() => {
      const err = new DOMException('User cancelled', 'NotAllowedError');
      window.__sgxRejectGet(err);
    });
    await expect(row).toBeEnabled({ timeout: 3000 });
    expect(await row.locator('.sgx-door-chev').evaluate((el) => el.innerHTML)).toContain('<svg');
    await expect(row.locator('.sgx-door-rowsub')).toHaveText(origSub || '');
    await expect(pg.locator('#acct-login')).toBeVisible();
    await expect(pg.locator('.sgx-door-err:visible')).toHaveCount(0);
  });

  test('password row expand: selected + chev rotated, collapse restores; click vibrates 10ms', async ({ page: pg }) => {
    await pg.addInitScript(() => {
      window.__vibCalls = [];
      navigator.vibrate = (ms) => { window.__vibCalls.push(ms); return true; };
    });
    await gotoAccount(pg);
    const row = pg.locator('.sgx-door-row').filter({ hasText: '账号密码' });
    await row.click();
    /* 展开：选中态 + 箭头旋转 + 振动 */
    await expect(row).toHaveClass(/sgx-row-selected/);
    await expect(row.locator('.sgx-door-chev')).toHaveClass(/expanded/);
    expect(await pg.evaluate(() => window.__vibCalls)).toEqual([10]);
    /* 再点收起：选中态 + 旋转清除 */
    await row.click();
    await expect(row).not.toHaveClass(/sgx-row-selected/);
    await expect(row.locator('.sgx-door-chev')).not.toHaveClass(/expanded/);
  });
});

test.describe('security status card wording (批次 A 验收修复 #8)', () => {
  test('missing account password shows 账号密码 wording, not 解锁密码', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    /* 卡片数据源是 GET /api/account（账号凭证）：密码缺失 → 账号密码文案 */
    await mockJson(pg, '**/api/account', 200, { ok: true, password: false, passkey: true, ready: true, session: null });
    await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('#sec-status-title')).toContainText('建议操作', { timeout: 15000 });
    await expect(pg.locator('#sec-status-sub')).toHaveText('未设置账号密码');
  });

  test('missing passkey copy names account passkeys（未注册账号通行密钥）', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    await mockJson(pg, '**/api/account', 200, { ok: true, password: true, passkey: false, ready: true, session: null });
    await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('#sec-status-title')).toContainText('建议操作', { timeout: 15000 });
    await expect(pg.locator('#sec-status-sub')).toHaveText('未注册账号通行密钥');
  });
});
