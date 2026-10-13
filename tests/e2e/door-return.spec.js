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

  test('锁屏页：密码已设时「删除密码」可见，确认弹层点确认删除后状态变未设置、按钮隐藏', async ({ page }) => {
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
    /* 批次 B R1：点删除 → One UI 确认弹层（标题 + 文案），点确认才删除 */
    const dlg = page.locator('dialog.sgx-center-dlg');
    await page.locator('#lockmgr-pwdel').click();
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(dlg.locator('.sgx-verify-title')).toHaveText('删除密码');
    await expect(dlg.locator('.sgx-verify-desc')).toHaveText('确定删除这个密码？');
    expect(removeCalls).toBe(0);
    await dlg.locator('button.sgx-verify-skip').click();
    expect(removeCalls).toBe(1);
    /* 删除后状态刷新：副标题变未设置，按钮隐藏 */
    await expect(page.locator('#lockmgr-pwsub')).toContainText('未设置', { timeout: 5000 });
    await expect(page.locator('#lockmgr-pwdel')).toBeHidden();
  });

  test('锁屏页：删除密码确认弹层点取消 → 不删', async ({ page }) => {
    let removeCalls = 0;
    await page.route('**/api/lock-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: true, passkey: true }),
      });
    });
    await page.route('**/api/owner-password', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'remove' && body.kind === 'lock') removeCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr-pwdel')).toBeVisible({ timeout: 15000 });
    const dlg = page.locator('dialog.sgx-center-dlg');
    await page.locator('#lockmgr-pwdel').click();
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await dlg.locator('button.sgx-verify-ghost').click();
    await expect(dlg).toHaveCount(0);
    expect(removeCalls).toBe(0);
    await expect(page.locator('#lockmgr-pwdel')).toBeVisible();
    await expect(page.locator('#lockmgr-pwsub')).toContainText('已设置');
  });

  test('锁屏页：删最后一个锁屏凭证且 owner 已配置 → 弹 #10 确认，点确认删除', async ({ page }) => {
    let pwSet = true;
    let removeCalls = 0;
    /* 锁屏无通行密钥 → 删密码即归零 */
    await page.route('**/api/lock-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: pwSet, passkey: false }),
      });
    });
    /* owner 已配置（有站长密码）→ 允许删空 */
    await page.route('**/api/owner-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: true, passkey: false }),
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
    await expect(page.locator('#lockmgr-pwdel')).toBeVisible({ timeout: 15000 });
    const dlg = page.locator('dialog.sgx-center-dlg');
    await page.locator('#lockmgr-pwdel').click();
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(dlg.locator('.sgx-verify-desc')).toHaveText('删除后锁屏只能通过重置锁屏重新设置');
    expect(removeCalls).toBe(0);
    await dlg.locator('button.sgx-verify-skip').click();
    expect(removeCalls).toBe(1);
    await expect(page.locator('#lockmgr-pwsub')).toContainText('未设置', { timeout: 5000 });
  });

  test('锁屏页：删最后一个锁屏凭证且 owner 未配置 → toast 提示，不删', async ({ page }) => {
    let removeCalls = 0;
    await page.route('**/api/lock-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: true, passkey: false }),
      });
    });
    /* owner 未配置 → 禁止删空 */
    await page.route('**/api/owner-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: false, passkey: false }),
      });
    });
    await page.route('**/api/owner-password', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'remove' && body.kind === 'lock') removeCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr-pwdel')).toBeVisible({ timeout: 15000 });
    await page.locator('#lockmgr-pwdel').click();
    await expect(page.locator('.sgx-toast')).toContainText('这是最后一把解锁钥匙，请先设置解锁密码', { timeout: 5000 });
    await expect(page.locator('dialog.sgx-center-dlg')).toHaveCount(0);
    expect(removeCalls).toBe(0);
    await expect(page.locator('#lockmgr-pwdel')).toBeVisible();
  });

  test('站长页：密码已设时「删除密码」可见，确认弹层点确认删除后状态变未设置、按钮隐藏', async ({ page }) => {
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
    /* 批次 B R1：点删除 → One UI 确认弹层，点确认才删除 */
    const dlg = page.locator('dialog.sgx-center-dlg');
    await page.locator('#lockmgr-pwdel').click();
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(dlg.locator('.sgx-verify-title')).toHaveText('删除密码');
    await expect(dlg.locator('.sgx-verify-desc')).toHaveText('确定删除这个密码？');
    expect(removeCalls).toBe(0);
    await dlg.locator('button.sgx-verify-skip').click();
    expect(removeCalls).toBe(1);
    await expect(page.locator('#lockmgr-pwsub')).toContainText('未设置', { timeout: 5000 });
    await expect(page.locator('#lockmgr-pwdel')).toBeHidden();
  });

  test('站长页：删除密码确认弹层点取消 → 不删', async ({ page }) => {
    let removeCalls = 0;
    await page.route('**/api/owner-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: true, passkey: true }),
      });
    });
    await page.route('**/api/owner-password', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'remove' && body.kind === 'owner') removeCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.goto('/settings/security/owner/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr-pwdel')).toBeVisible({ timeout: 15000 });
    const dlg = page.locator('dialog.sgx-center-dlg');
    await page.locator('#lockmgr-pwdel').click();
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await dlg.locator('button.sgx-verify-ghost').click();
    await expect(dlg).toHaveCount(0);
    expect(removeCalls).toBe(0);
    await expect(page.locator('#lockmgr-pwdel')).toBeVisible();
  });
});

test.describe('批次 A 验收修复 P1：双向相同密码错误文案', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
  });

  test('站长页设站长密码与解锁密码相同 → 「不能与解锁密码相同」，不带错误码小字', async ({ page }) => {
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await page.route('**/api/owner-password', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'same-as-lock' }),
      });
    });
    await page.goto('/settings/security/owner/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    await page.locator('#lockmgr-pwrow').click();
    await expect(page.locator('#lockpw-dlg')).toBeVisible({ timeout: 5000 });
    await page.locator('#lockpw-1').fill('00000000');
    await page.locator('#lockpw-2').fill('00000000');
    await page.locator('#lockpw-go').click();
    const err = page.locator('#lockpw-err:not([hidden])');
    await expect(err).toBeVisible({ timeout: 5000 });
    await expect(err).toHaveText('不能与解锁密码相同');
  });

  test('锁屏页设解锁密码与站长密码相同 → 「不能与站长密码相同」，不带错误码小字', async ({ page }) => {
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
    await page.route('**/api/owner-password', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'same-as-owner' }),
      });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    await page.locator('#lockmgr-pwrow').click();
    await expect(page.locator('#lockpw-dlg')).toBeVisible({ timeout: 5000 });
    await page.locator('#lockpw-1').fill('00000000');
    await page.locator('#lockpw-2').fill('00000000');
    await page.locator('#lockpw-go').click();
    const err = page.locator('#lockpw-err:not([hidden])');
    await expect(err).toBeVisible({ timeout: 5000 });
    await expect(err).toHaveText('不能与站长密码相同');
  });
});

test.describe('批次 A 验收修复 #7：锁屏页探针失败走 needVerify（lockgate 死代码已删）', () => {
  let pageErrors;
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
  });

  test('探针 session 失败 → 无 JS 错误，弹会话失效框，点「去锁屏」重载，不点不跳', async ({ page }) => {
    await mockJson(page, '**/api/lock-status', 401, { ok: false, error: 'session' });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    /* 批次 B #13：needVerify 改弹共用提示框，不再 toast + 自动跳转 */
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(dlg.locator('.sgx-verify-title')).toHaveText('会话已失效');
    await expect(dlg.locator('.sgx-verify-desc')).toHaveText('当前会话已失效，请重新解锁后继续。');
    await expect(dlg.locator('button.sgx-verify-skip')).toHaveText('去锁屏');
    /* 不点按钮 → 不跳转 */
    await expect(page).toHaveURL(/\/settings\/security\/lock\//);
    /* 点按钮 → 重载（探针仍 401 → 弹框再次出现） */
    await Promise.all([
      page.waitForEvent('load'),
      dlg.locator('button.sgx-verify-skip').click(),
    ]);
    await expect(page.locator('dialog.sgx-center-dlg')).toBeVisible({ timeout: 5000 });
    expect(pageErrors).toEqual([]);
  });

  test('探针 scope + owner-configured → 弹明确提示框，点按钮后才跳回安全页', async ({ page }) => {
    await mockJson(page, '**/api/lock-status', 403, { ok: false, error: 'scope', reason: 'owner-configured' });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(dlg.locator('.sgx-verify-title')).toHaveText('验证已过期');
    await expect(dlg.locator('.sgx-verify-desc')).toHaveText('站长凭证已设置，请用站长凭证重新验证');
    await expect(dlg.locator('button.sgx-verify-skip')).toHaveText('返回安全与隐私');
    /* 不点按钮 → 不跳转 */
    await expect(page).toHaveURL(/\/settings\/security\/lock\//);
    /* 点按钮 → 清票后跳回安全页 */
    await dlg.locator('button.sgx-verify-skip').click();
    await expect(page).toHaveURL(/\/settings\/security\/$/, { timeout: 10000 });
    expect(pageErrors).toEqual([]);
  });

  test('探针网络失败 → 无 JS 错误，弹网络文案框，点按钮后才跳回安全页', async ({ page }) => {
    await page.route('**/api/lock-status', (route) => route.abort('failed'));
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    /* 批次 B #36：网络失败走网络文案，不按验证过期处理 */
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(dlg.locator('.sgx-verify-title')).toHaveText('网络连接失败');
    await expect(dlg.locator('.sgx-verify-desc')).toHaveText('网络连接失败，请重试');
    await expect(dlg.locator('button.sgx-verify-skip')).toHaveText('返回安全与隐私');
    /* 不点按钮 → 不跳转 */
    await expect(page).toHaveURL(/\/settings\/security\/lock\//);
    /* 点按钮 → 跳回安全页 */
    await dlg.locator('button.sgx-verify-skip').click();
    await expect(page).toHaveURL(/\/settings\/security\/$/, { timeout: 10000 });
    expect(pageErrors).toEqual([]);
  });
});

/* 批次 B #8/#13：安全页状态卡固定占位——卡出现前后「站长凭证」行位置不变。
   状态接口用闸门延迟放行：先测占位态行位置，放行后等卡填入真实文案，再测一次。 */
test.describe('批次 B #8/#13：安全页状态卡占位不跳动', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
  });

  test('卡出现前后「站长凭证」行位置不变', async ({ page }) => {
    let release;
    const gate = new Promise((res) => { release = res; });
    for (const pattern of ['**/api/owner-status', '**/api/lock-status']) {
      await page.route(pattern, async (route) => {
        await gate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, password: true, passkey: true }),
        });
      });
    }
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    /* 等字体加载完成 + 入场动画跑完再测位置，避免字体切换 / transform 导致漂移 */
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => Promise.all(
      Array.from(document.querySelectorAll('.animate-fade-up')).flatMap((el) => el.getAnimations().map((a) => a.finished))
    ));
    /* 静态服务不注入 data-sgx-role，显式设为 owner 否则 CSS 隐藏卡片 */
    await page.evaluate(() => {
      try { document.documentElement.dataset.sgxRole = 'owner'; } catch (e) {}
    });
    /* 占位态：两张卡可见，占位文案「正在读取…」 */
    await expect(page.locator('#sec-status-owner')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#sec-status-lock')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#sec-status-owner-title')).toHaveText('正在读取…');
    const row = page.locator('#sec-owner-cred');
    await expect(row).toBeVisible();
    const yBefore = await row.evaluate((el) => el.getBoundingClientRect().top);
    /* 放行状态接口，等卡填入真实文案（证明经历了占位→填入的过渡） */
    release();
    await expect(page.locator('#sec-status-owner-title')).toHaveText('站长凭证已设置', { timeout: 5000 });
    await expect(page.locator('#sec-status-lock-title')).toHaveText('锁屏已设置', { timeout: 5000 });
    const yAfter = await row.evaluate((el) => el.getBoundingClientRect().top);
    expect(yAfter).toBe(yBefore);
  });
});
