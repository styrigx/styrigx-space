/**
 * 两扇门验证弹层 UI 回归：One UI 列表行 + 取消 + 标题靠左 + 键盘避让。
 * （#68 重做：#64 的实心大按钮已换成 One UI 列表行，旧断言作废。）
 * - 验证方式为列表行（.sgx-door-row：圆形图标底 + 标题/说明 + 右侧 >），不用大实心按钮
 * - 标题靠左，内容左对齐
 * - 默认底部只有居中的「取消」文字按钮；密码/根凭证展开后底部变「取消 / 验证」两个等宽文字按钮
 * - 移动端视口：输入框聚焦后键盘弹出，弹层整体上移不被遮挡
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

async function gotoSecurity(pg) {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  /* 站长凭证已配置（密码+通行密钥），管理凭证弹层显示两个行 */
  await mockJson(pg, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
  await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
}

test.describe('door dialog UI', () => {
  test('owner dialog: list rows, cancel, left-aligned title', async ({ page: pg }) => {
    await gotoSecurity(pg);
    await pg.locator('#sec-owner-cred').click();
    const dlg = pg.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();

    /* 标题靠左，文案为「进入站长凭证」 */
    await expect(pg.locator('#sec-verify-title')).toContainText('进入站长凭证');
    const titleAlign = await pg.locator('#sec-verify-title').evaluate((el) => getComputedStyle(el).textAlign);
    expect(titleAlign).toBe('left');

    /* 验证方式是列表行：单行「根凭证」，含图标底 + 标题/说明 + 右侧 > */
    const rows = pg.locator('.sgx-door-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('根凭证');
    await expect(rows.first().locator('.sgx-door-ic')).toBeVisible();
    await expect(rows.first().locator('.sgx-door-mid')).toBeVisible();
    await expect(rows.first().locator('.sgx-door-chev')).toBeVisible();

    /* 默认底部只有「取消」文字按钮 */
    const cancel = pg.locator('#sec-verify-foot .sgx-door-cancel');
    await expect(cancel).toBeVisible();
    await expect(cancel).toContainText('取消');
    await expect(pg.locator('#sec-verify-foot .sgx-door-actions')).toHaveCount(0);

    /* 根凭证行展开：多行输入框 + 底部变「取消 / 验证」两个等宽文字按钮 */
    await rows.first().click();
    await expect(pg.locator('.sgx-door-expand textarea')).toBeVisible();
    const actions = pg.locator('#sec-verify-foot .sgx-door-actions .sgx-door-textbtn');
    await expect(actions).toHaveCount(2);
    await expect(actions.nth(0)).toContainText('取消');
    await expect(actions.nth(1)).toContainText('验证');
  });

  test('mgmt dialog: visitor shows single root row with list styles', async ({ page: pg }) => {
    await gotoSecurity(pg);
    /* 访客假入口：data-sgx-role=visitor 时只显示单个「根凭证」行 */
    await pg.evaluate(() => {
      document.documentElement.dataset.sgxRole = 'visitor';
    });
    await pg.locator('#sec-mgmt-cred').click();
    const dlg = pg.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();

    await expect(pg.locator('#sec-verify-title')).toContainText('进入管理凭证');
    const rows = pg.locator('.sgx-door-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('根凭证');
    /* 列表行样式与真入口一致 */
    await expect(rows.first().locator('.sgx-door-ic')).toBeVisible();
    await expect(rows.first().locator('.sgx-door-chev')).toBeVisible();
    await expect(pg.locator('#sec-verify-foot .sgx-door-cancel')).toBeVisible();
  });

  test('mgmt dialog: password row expands inline, dialog stays in viewport', async ({ page: pg }) => {
    await gotoSecurity(pg);
    await pg.locator('#sec-mgmt-cred').click();
    const dlg = pg.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();

    /* 两个行：站长通行密钥 + 站长密码 */
    const rows = pg.locator('.sgx-door-row');
    await expect(rows).toHaveCount(2);

    /* 点密码行：弹层内展开输入框，不跳页，自动聚焦 */
    await rows.filter({ hasText: '站长密码' }).click();
    const input = pg.locator('.sgx-door-expand input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    /* 底部变为「取消 / 验证」两个等宽文字按钮 */
    const actions = pg.locator('#sec-verify-foot .sgx-door-actions .sgx-door-textbtn');
    await expect(actions).toHaveCount(2);

    /* 展开态弹层整体仍在视口内（键盘避让的视觉态由 visual 基线覆盖） */
    const box = await pg.locator('.sgx-door-card').boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(915);
  });
});
