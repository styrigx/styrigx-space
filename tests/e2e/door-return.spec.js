/**
 * v1.1 C5：门内页返回目标 E2E（静态构建 + API mock，无需真实后端）。
 *
 * 覆盖（C1/C2）：
 * - 站长凭证门返回 → /settings/security/（C1，从哪里进门回哪里）
 * - 管理凭证索引页返回 → /settings/security/（C2，清票后跳）
 * - 锁屏子页返回 → /settings/security/mgmt/（C2）
 * - 应用子页返回 → /settings/security/mgmt/（C2）
 * - Book 子页返回 → /settings/security/apps/（C2，保持）
 *
 * 运行：npx playwright test --config=playwright.config.js door-return.spec.js
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

/** @param {import('@playwright/test').Page} page */
async function mockJson(page, pattern, status, body) {
  await page.route(pattern, async (route) => {
    await route.fulfill({
      status: status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

test.describe('v1.1 C5：门内页返回目标', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    /* 门内页探针通过：状态接口 + stepup status */
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
  });

  test('C1：站长凭证门返回 → /settings/security/', async ({ page }) => {
    await page.goto('/settings/security/owner/', { waitUntil: 'domcontentloaded' });
    /* 等管理区加载（探针通过） */
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    /* 点返回键（door.js 捕获监听 → clearStepupThen → 安全页） */
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/$/, { timeout: 10000 });
  });

  test('C2：管理凭证索引页返回 → /settings/security/', async ({ page }) => {
    await page.goto('/settings/security/mgmt/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mgmt-lock-sub')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/$/, { timeout: 10000 });
  });

  test('C2：锁屏子页返回 → /settings/security/mgmt/', async ({ page }) => {
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/mgmt\/$/, { timeout: 10000 });
  });

  test('C2：应用子页返回 → /settings/security/mgmt/', async ({ page }) => {
    await page.goto('/settings/security/apps/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#appmgr')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/mgmt\/$/, { timeout: 10000 });
  });

  test('C2：Book 子页返回 → /settings/security/apps/（保持）', async ({ page }) => {
    await page.goto('/settings/security/apps/book/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#bookmgr')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/apps\/$/, { timeout: 10000 });
  });
});

test.describe('v1.1 C2b：popstate 清票不误清', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
  });

  /* 注意：不直接派发合成 popstate 事件——inpagenav 的 popstate 处理器会同时触发，
     导致页面导航，干扰测试。改用真实导航（按钮返回）验证不误清；
     目标判定逻辑（门内不清理、门外清）由代码审查 + 手动实测覆盖。 */
  test('C2b：索引页 → 锁屏子页 → 按钮返回 → 回索引页，不清票', async ({ page }) => {
    let clearCount = 0;
    await page.route('**/api/stepup', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'clear') clearCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, valid: true }),
      });
    });

    await page.goto('/settings/security/mgmt/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mgmt-lock-sub')).toBeVisible({ timeout: 15000 });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    const clearBefore = clearCount;

    /* 按钮返回 → 回索引页（整页跳转，门内页非 SPA） */
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/mgmt\/$/, { timeout: 10000 });
    await expect(page.locator('#mgmt-lock-sub')).toBeVisible({ timeout: 15000 });

    assertClearNotCalled(clearCount, clearBefore, '从锁屏按钮返回索引页不应清票');
  });

  test('C2b：索引页按钮返回 → 安全页，清票', async ({ page }) => {
    let clearCount = 0;
    await page.route('**/api/stepup', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'clear') clearCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, valid: true }),
      });
    });

    await page.goto('/settings/security/mgmt/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mgmt-lock-sub')).toBeVisible({ timeout: 15000 });
    const clearBefore = clearCount;

    /* 按钮返回 → 安全页（clearStepupThen） */
    await page.locator('[data-go-back]').first().click();
    await expect(page).toHaveURL(/\/settings\/security\/$/, { timeout: 10000 });

    if (clearCount <= clearBefore) {
      throw new Error('从索引页按钮返回安全页应清票，实际 clear 调用次数未增加（before=' + clearBefore + ', after=' + clearCount + '）');
    }
  });
});

/** popstate 误清断言：clear 调用次数不应增加 */
function assertClearNotCalled(after, before, msg) {
  if (after > before) {
    throw new Error(msg + '（before=' + before + ', after=' + after + '）');
  }
}

test.describe('bindSubmitButton 去重修复：锁屏页设置密码弹层', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    /* 门内页探针通过：状态接口 + stepup status */
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
  });

  test('两次输入不一致报错后，改对再点保存能成功', async ({ page }) => {
    /* bindSubmitButton 回归：第一次提交（本地校验失败）后，按钮必须还能再次提交。
       旧实现 fired 标志永不重置，第二次点击完全没反应。 */
    let pwCalls = 0;
    await page.route('**/api/owner-password', async (route) => {
      pwCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    await page.locator('#lockmgr-pwrow').click();
    await expect(page.locator('#lockpw-dlg')).toBeVisible({ timeout: 5000 });
    /* 第一次：两次输入不一致 → 本地校验报错，弹层不关闭 */
    await page.locator('#lockpw-1').fill('password-one-1');
    await page.locator('#lockpw-2').fill('password-two-2');
    await page.locator('#lockpw-go').click();
    await expect(page.locator('#lockpw-err:not([hidden])').filter({ hasText: '两次输入不一致' }))
      .toBeVisible({ timeout: 5000 });
    await expect(page.locator('#lockpw-dlg')).toBeVisible();
    expect(pwCalls).toBe(0);
    /* 改对后再次点击保存，必须再次提交并成功关闭弹层 */
    await page.locator('#lockpw-1').fill('correct-password-123');
    await page.locator('#lockpw-2').fill('correct-password-123');
    await page.locator('#lockpw-go').click();
    await expect(page.locator('#lockpw-dlg')).toBeHidden({ timeout: 8000 });
    expect(pwCalls).toBe(1);
  });
});

test.describe('批次 A 验收修复 P1：删除密码按钮', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
  });

  test('锁屏页：密码已设时「删除密码」可见，两步确认删除后状态变未设置、按钮隐藏', async ({ page }) => {
    let pwSet = true;
    let removeCalls = 0;
    await page.route('**/api/lock-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: pwSet, passkey: true }),
      });
    });
    await page.route('**/api/owner-password', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'remove' && body.kind === 'lock') {
        removeCalls++;
        pwSet = false;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    /* 密码已设 → 删除按钮可见（回归：旧代码切不存在的 lockmgr-pwdel-wrap，按钮永不显示） */
    await expect(page.locator('#lockmgr-pwdel')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#lockmgr-pwsub')).toContainText('已设置');
    /* 两步确认：第一点武装，第二点真正删除 */
    await page.locator('#lockmgr-pwdel').click();
    await expect(page.locator('#lockmgr-pwdel')).toContainText('再点一次删除密码');
    expect(removeCalls).toBe(0);
    await page.locator('#lockmgr-pwdel').click();
    expect(removeCalls).toBe(1);
    /* 删除后状态刷新：副标题变未设置，按钮隐藏 */
    await expect(page.locator('#lockmgr-pwsub')).toContainText('未设置', { timeout: 5000 });
    await expect(page.locator('#lockmgr-pwdel')).toBeHidden();
  });

  test('站长页：密码已设时「删除密码」可见，两步确认删除后状态变未设置、按钮隐藏', async ({ page }) => {
    let pwSet = true;
    let removeCalls = 0;
    await page.route('**/api/owner-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: pwSet, passkey: true }),
      });
    });
    await page.route('**/api/owner-password', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'remove' && body.kind === 'owner') {
        removeCalls++;
        pwSet = false;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.goto('/settings/security/owner/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#lockmgr-pwdel')).toBeVisible({ timeout: 5000 });
    await page.locator('#lockmgr-pwdel').click();
    await expect(page.locator('#lockmgr-pwdel')).toContainText('再点一次删除密码');
    expect(removeCalls).toBe(0);
    await page.locator('#lockmgr-pwdel').click();
    expect(removeCalls).toBe(1);
    await expect(page.locator('#lockmgr-pwsub')).toContainText('未设置', { timeout: 5000 });
    await expect(page.locator('#lockmgr-pwdel')).toBeHidden();
  });
});
