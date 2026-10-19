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
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
  });

  /* C1（站长凭证门返回）已随站长凭证升级为账号移除：账号页是普通子页，不在门内。 */

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
    await expect.poll(() => removeCalls).toBe(1);
    /* 删除后状态刷新：副标题变未设置，按钮隐藏 */
    await expect(page.locator('#lockmgr-pwsub')).toContainText('未设置', { timeout: 5000 });
    await expect(page.locator('#lockmgr-pwdel')).toBeHidden();
  });

  /* 站长页删除密码：账号体系后账号密码只能设置/修改/重置（账号页），无删除入口。 */
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

  /* 账号页设账号密码与解锁密码相同 →「不能与解锁密码相同」：见 account.spec.js */

  test('锁屏页设解锁密码与账号密码相同 → 「不能与账号密码相同」，不带错误码小字', async ({ page }) => {
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
    await expect(err).toHaveText('不能与账号密码相同');
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

  test('探针 session 失败 → 无 JS 错误，弹会话失效框，不点不跳；点「去锁屏」才重载', async ({ page }) => {
    await mockJson(page, '**/api/lock-status', 401, { ok: false, error: 'session' });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    /* A-1：不再 toast + 自动跳，改弹 One UI 单按钮框 */
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(dlg).toContainText('会话已失效');
    await expect(dlg.locator('button.sgx-verify-skip')).toHaveText('去锁屏');
    /* v1.1 §二.2：弹框出现时倒计时胶囊隐藏 */
    await expect(page.locator('#sgx-door-countdown')).toHaveCount(0);
    /* 不点不跳 */
    await expect(page).toHaveURL(/\/settings\/security\/lock\//);
    expect(pageErrors).toEqual([]);
    /* 点按钮 → 重载（静态构建无中间件：探针仍失败，弹框再次出现，证明点了才动作） */
    await dlg.locator('button.sgx-verify-skip').click();
    await expect(page.locator('dialog.sgx-center-dlg')).toBeVisible({ timeout: 10000 });
    expect(pageErrors).toEqual([]);
  });

  test('探针 scope + owner-configured → 弹验证过期框，点「重新验证」才跳', async ({ page }) => {
    await mockJson(page, '**/api/lock-status', 403, { ok: false, error: 'scope', reason: 'owner-configured' });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(dlg).toContainText('账号凭证已设置，请先登录账号再进入');
    await expect(dlg.locator('button.sgx-verify-skip')).toHaveText('重新验证');
    /* 不点不跳 */
    await expect(page).toHaveURL(/\/settings\/security\/lock\//);
    /* 账号体系：「重新验证」→ 安全页 ?verify=mgmt&return=<门内页> → 自动 POST /api/stepup enter。
       原断言停在 /settings/security/ 只是 replaceState 和自动进门之间的瞬间状态（CI 上抓不到，竞态）；
       这里让 enter 返回 account-stale，确定性地断言最终落到账号登录页并带回原门内页。 */
    await page.route('**/api/stepup', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'enter') {
        await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'account-stale' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, valid: true }) });
    });
    await dlg.locator('button.sgx-verify-skip').click();
    await expect(page).toHaveURL(/\/settings\/account\/\?door=1&return=%2Fsettings%2Fsecurity%2Flock%2F$/, { timeout: 10000 });
    expect(pageErrors).toEqual([]);
  });

  test('探针网络失败 → 无 JS 错误，toast 网络提示，不自动跳，不弹过期框', async ({ page }) => {
    await page.route('**/api/lock-status', (route) => route.abort('failed'));
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    /* A 现有提示：gateNetErr「网络错误」，不报会话过期 */
    await expect(page.locator('.sgx-toast')).toContainText('网络错误', { timeout: 5000 });
    /* 不自动跳，不弹过期框 */
    await expect(page).toHaveURL(/\/settings\/security\/lock\//);
    await expect(page.locator('dialog.sgx-center-dlg')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('A-1 门内 3 分钟 + 剩余时间胶囊 + 到期弹框', () => {
  let pageErrors;
  let challengeCalls;
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    challengeCalls = 0;
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    page.on('request', (req) => {
      try {
        const pd = req.postData() || '';
        if (pd.includes('"action":"challenge"')) challengeCalls++;
      } catch (e) {}
    });
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'keys' });
    /* 账号体系：原站长凭证门已升级为账号页，门内页用锁屏页（同一套门内组件 app-gate.js）测 */
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
  });

  /** 相对亮度（WCAG） */
  function luminance(rgb) {
    const m = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return 0;
    const f = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
  }

  test('进门后胶囊在大标题下方、左对齐，文案「验证剩余 2:5x」；顶栏内无倒计时', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    const capsule = page.locator('#sgx-door-countdown');
    await expect(capsule).toBeVisible({ timeout: 15000 });
    await expect(capsule).toHaveText(/验证剩余 2:5\d/);
    /* 不在全站顶栏（nav）内；正确位置是门内页大标题 header 内、标题正下方 */
    await expect(page.locator('nav #sgx-door-countdown')).toHaveCount(0);
    await expect(page.locator('header.subpage-head #sgx-door-countdown')).toHaveCount(1);
    /* 大标题下方、与标题左对齐（胶囊左边缘 ≈ 内容容器左边缘） */
    const titleBox = await page.locator('.subpage-title').boundingBox();
    const capBox = await capsule.boundingBox();
    const layoutBox = await page.locator('.set-layout').boundingBox();
    expect(capBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 5);
    /* 左对齐：胶囊在内容区左区（header 20px 内边距 + 布局 16px，约 36；居中会在 500+） */
    expect(capBox.x - layoutBox.x).toBeGreaterThanOrEqual(0);
    expect(capBox.x - layoutBox.x).toBeLessThanOrEqual(48);
    expect(pageErrors).toEqual([]);
  });

  test('胶囊字号不小于正文；浅色对比度 ≥ 4.5:1', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    const capsule = page.locator('#sgx-door-countdown');
    await expect(capsule).toBeVisible({ timeout: 15000 });
    const metrics = await capsule.evaluate((el) => {
      const cs = getComputedStyle(el);
      const body = getComputedStyle(document.body);
      return { fontSize: parseFloat(cs.fontSize), bodyFontSize: parseFloat(body.fontSize), color: cs.color, bg: cs.backgroundColor };
    });
    expect(metrics.fontSize).toBeGreaterThanOrEqual(metrics.bodyFontSize);
    const l1 = luminance(metrics.color);
    const l2 = luminance(metrics.bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(pageErrors).toEqual([]);
  });

  test('胶囊深色对比度 ≥ 4.5:1', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-theme-mode', 'dark'); } catch (e) {}
    });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    const capsule = page.locator('#sgx-door-countdown');
    await expect(capsule).toBeVisible({ timeout: 15000 });
    const colors = await capsule.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, bg: cs.backgroundColor };
    });
    const l1 = luminance(colors.color);
    const l2 = luminance(colors.bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(pageErrors).toEqual([]);
  });

  test('剩余 ≤ 30 秒只变警示色、不改文案；到 0 停在「已过期」，URL 不变，不弹框', async ({ page }) => {
    /* 先给 25 秒：应为警示色，文案仍是「验证剩余 0:2x」 */
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 25000 });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    const capsule = page.locator('#sgx-door-countdown');
    await expect(capsule).toBeVisible({ timeout: 15000 });
    await expect(capsule).toHaveClass(/sgx-countdown-warn/);
    await expect(capsule).toHaveText(/验证剩余 0:[0-2]\d/);
    await expect(capsule).not.toHaveText(/即将过期/);
    /* 到 0：停在「已过期」，URL 不变，不弹框 */
    await expect(capsule).toHaveText('已过期', { timeout: 30000 });
    await expect(page).toHaveURL(/\/settings\/security\/lock\//);
    await expect(page.locator('dialog.sgx-center-dlg')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('v1.1 §二.1 补充：胶囊出现时卡片已不透明、帮助文字不与卡片重叠', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    const capsule = page.locator('#sgx-door-countdown');
    await expect(capsule).toBeVisible({ timeout: 15000 });
    /* 胶囊出现时，卡片入场动画已结束（不透明度=1），不是半透明淡入中 */
    const opacities = await page.locator('.animate-fade-up').evaluateAll((els) =>
      els.map((el) => parseFloat(getComputedStyle(el).opacity))
    );
    expect(opacities.length).toBeGreaterThan(0);
    opacities.forEach((o) => expect(o).toBe(1));
    /* 帮助文字（sec-note，含「用于进入管理凭证」与「构建 dev」）不与卡片（widget）重叠 */
    const overlap = await page.evaluate(() => {
      const notes = Array.from(document.querySelectorAll('p.sec-note'));
      const cards = Array.from(document.querySelectorAll('section.widget'));
      for (const n of notes) {
        const nb = n.getBoundingClientRect();
        for (const c of cards) {
          const cb = c.getBoundingClientRect();
          if (nb.left < cb.right && nb.right > cb.left && nb.top < cb.bottom && nb.bottom > cb.top) return true;
        }
      }
      return false;
    });
    expect(overlap).toBe(false);
    expect(pageErrors).toEqual([]);
  });

  test('门内 403 stepup-required → 弹框，不点不跳；点按钮才重新验证（账号登录过旧→账号登录页）；无 challenge 请求', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.route('**/api/owner-password', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'stepup-required', reason: 'expired' }),
      });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    /* 两步确认删除：第 1 点武装，第 2 点真正调接口 → 403 → 弹框 */
    await page.locator('#lockmgr-pwdel').click();
    await page.locator('#lockmgr-pwdel').click();
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(dlg).toContainText('验证后回到这一页继续');
    await expect(dlg.locator('button.sgx-verify-skip')).toHaveText('重新验证');
    /* v1.1 §二.2：弹框出现时倒计时胶囊隐藏 */
    await expect(page.locator('#sgx-door-countdown')).toHaveCount(0);
    /* 不点不跳 */
    await expect(page).toHaveURL(/\/settings\/security\/lock\//);
    /* 票据失效后无 doStepup / challenge 请求 */
    expect(challengeCalls).toBe(0);
    /* 账号体系：「重新验证」→ 安全页 ?verify=mgmt&return=<门内页> → 自动 POST /api/stepup enter；
       账号登录已过 10 分钟（account-stale）→ 去账号登录页并带回原门内页（不再停在安全页弹验证框） */
    await page.route('**/api/stepup', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'enter') {
        await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'account-stale' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, valid: true, expiresAt: Date.now() + 175000 }) });
    });
    await dlg.locator('button.sgx-verify-skip').click();
    await expect(page).toHaveURL(/\/settings\/account\/\?door=1&return=%2Fsettings%2Fsecurity%2Flock%2F$/, { timeout: 10000 });
    expect(pageErrors).toEqual([]);
  });

  test('门内 401 session → 弹会话失效框，不点不跳；点「去锁屏」重载后倒计时重启', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.route('**/api/owner-password', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'session' }),
      });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    await page.locator('#lockmgr-pwdel').click();
    await page.locator('#lockmgr-pwdel').click();
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(dlg).toContainText('会话已失效');
    await expect(dlg).toContainText('请回到锁屏重新解锁');
    await expect(dlg.locator('button.sgx-verify-skip')).toHaveText('去锁屏');
    /* v1.1 §二.2：弹框出现时倒计时胶囊隐藏 */
    await expect(page.locator('#sgx-door-countdown')).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings\/security\/lock\//);
    /* 点按钮 → 重载（静态构建无中间件：探针仍通过，弹框消失、倒计时重启） */
    await dlg.locator('button.sgx-verify-skip').click();
    await expect(page.locator('dialog.sgx-center-dlg')).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    expect(pageErrors).toEqual([]);
  });

  test('两个请求同时失败 → 只有一个弹框；遮罩、Escape 关不掉；弹框后倒计时胶囊隐藏', async ({ page }) => {
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: false });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    /* 锁屏页：本页类 + 应用类列表同时 403 */
    await page.route('**/api/owner-passkey', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'stepup-required', reason: 'expired' }),
      });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await expect(page.locator('dialog.sgx-center-dlg')).toHaveCount(1);
    /* 遮罩点击关不掉（点对话框外的视口角落，命中 ::backdrop） */
    await page.mouse.click(10, 10);
    await expect(dlg).toBeVisible();
    /* Escape 关不掉 */
    await page.keyboard.press('Escape');
    await expect(dlg).toBeVisible();
    /* v1.1 §二.2：弹框后倒计时胶囊隐藏（与弹框文案不再矛盾） */
    await expect(page.locator('#sgx-door-countdown')).toHaveCount(0);
    expect(challengeCalls).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test('v1.1 §二.5：会话失效弹框打开时焦点在按钮上、无外框；键盘 Tab 后 :focus-visible 显示外框', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.route('**/api/owner-password', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'session' }),
      });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    await page.locator('#lockmgr-pwdel').click();
    await page.locator('#lockmgr-pwdel').click();
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    const btn = dlg.locator('button.sgx-verify-skip');
    await expect(btn).toHaveText('去锁屏');
    /* 打开时焦点在按钮上 */
    await expect(btn).toBeFocused();
    /* 编程聚焦：不显示外框（outline-style 为 none；Chrome 即使 style 为 none 也会报一个非 0 的 outline-width，故断言 style） */
    expect(await btn.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
    /* 键盘操作后 :focus-visible 显示外框：按 Tab 切到键盘模态，再编程聚焦（此时 :focus-visible 匹配） */
    await page.keyboard.press('Tab');
    await btn.evaluate((el) => el.focus());
    await expect(btn).toBeFocused();
    expect(await btn.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    expect(await btn.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe('2px');
    expect(pageErrors).toEqual([]);
  });

  test('v1.1 §二.5：到期弹框打开时焦点在按钮上、无外框', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.route('**/api/owner-password', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'stepup-required', reason: 'expired' }),
      });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    await page.locator('#lockmgr-pwdel').click();
    await page.locator('#lockmgr-pwdel').click();
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    const btn = dlg.locator('button.sgx-verify-skip');
    await expect(btn).toHaveText('重新验证');
    await expect(btn).toBeFocused();
    expect(await btn.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
    expect(pageErrors).toEqual([]);
  });

  test('v1.1 §二.1：胶囊在首次数据加载完成后再显示（状态接口延迟时胶囊不先出现）', async ({ page }) => {
    /* 探针通过（stepup 有效），门才能开 */
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    /* 第 1 次 lock-status（探针）立即返回；之后（refreshStatus）延迟 1500ms，模拟慢网络 */
    let lockStatusCount = 0;
    await page.route('**/api/lock-status', async (route) => {
      lockStatusCount += 1;
      if (lockStatusCount > 1) await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: true, passkey: true }),
      });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    /* 门已开（管理区可见），但首次数据还没回来 → 胶囊不应出现 */
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#sgx-door-countdown')).toHaveCount(0);
    /* 数据回来后胶囊才出现 */
    await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 10000 });
    expect(pageErrors).toEqual([]);
  });

  test('管理凭证索引页探针成功后也显示倒计时', async ({ page }) => {
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.goto('/settings/security/mgmt/', { waitUntil: 'domcontentloaded' });
    const capsule = page.locator('#sgx-door-countdown');
    await expect(capsule).toBeVisible({ timeout: 15000 });
    await expect(capsule).toHaveText(/验证剩余 2:5\d/);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('A-2 最后一把锁屏钥匙与 ownerkey 联动', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
  });

  async function gotoLockPage(page, { lockPw, lockKeys, deleteStatus = 200, deleteBody = { ok: true } }) {
    let deleteCalls = 0;
    let removeCalls = 0;
    await page.route('**/api/lock-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: lockPw, passkey: lockKeys.length > 0 }),
      });
    });
    await page.route('**/api/owner-passkey', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'delete') {
        deleteCalls++;
        await route.fulfill({ status: deleteStatus, contentType: 'application/json', body: JSON.stringify(deleteBody) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, keys: lockKeys, scope: 'keys' }),
      });
    });
    await page.route('**/api/owner-password', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'remove' && body.kind === 'lock') removeCalls++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    return { getDeleteCalls: () => deleteCalls, getRemoveCalls: () => removeCalls };
  }

  test('有 ownerkey 时删最后一把 lock 钥匙：先弹确认，点删除后成功', async ({ page }) => {
    const lockKeys = [{ credId: 'lock-key-001', name: 'test', class: 'lock', createdAt: 1, lastUsedAt: 0 }];
    const { getDeleteCalls } = await gotoLockPage(page, { lockPw: false, lockKeys });
    await expect(page.locator('.lockmgr-pkdel')).toBeVisible({ timeout: 5000 });
    /* v1.1 §二.4：删最后一把跳过「再点一次」，点「删除」直接弹确认框（只一次确认） */
    await page.locator('.lockmgr-pkdel').click();
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(page.locator('dialog.sgx-center-dlg')).toHaveCount(1);
    /* 无 armed 中间态：按钮文案仍是「删除」，没变成「再点一次删除」 */
    await expect(page.locator('.lockmgr-pkdel')).toHaveText('删除');
    await expect(dlg).toContainText('删除后锁屏只能通过重置锁屏重新设置');
    expect(getDeleteCalls()).toBe(0);
    /* 点删除 → 调删除接口 → 成功提示 */
    await dlg.locator('button', { hasText: '删除' }).click();
    await expect.poll(() => getDeleteCalls()).toBe(1);
    await expect(page.locator('.sgx-toast')).toContainText('已删除', { timeout: 5000 });
  });

  test('无 ownerkey 时删最后一把 lock 钥匙：确认后服务端 403，提示先设置解锁密码', async ({ page }) => {
    const lockKeys = [{ credId: 'lock-key-001', name: 'test', class: 'lock', createdAt: 1, lastUsedAt: 0 }];
    await gotoLockPage(page, { lockPw: false, lockKeys, deleteStatus: 403, deleteBody: { ok: false, error: 'last-key' } });
    await expect(page.locator('.lockmgr-pkdel')).toBeVisible({ timeout: 5000 });
    /* v1.1 §二.4：点「删除」直接弹确认框 */
    await page.locator('.lockmgr-pkdel').click();
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await dlg.locator('button', { hasText: '删除' }).click();
    await expect(page.locator('.sgx-toast')).toContainText('这是最后一把解锁钥匙，请先设置解锁密码', { timeout: 5000 });
  });

  test('有 ownerkey 时删最后一把 lock 密码：先弹确认，点删除后成功', async ({ page }) => {
    const { getRemoveCalls } = await gotoLockPage(page, { lockPw: true, lockKeys: [] });
    await expect(page.locator('#lockmgr-pwdel')).toBeVisible({ timeout: 5000 });
    /* v1.1 §二.4：点「删除密码」直接弹确认框，无 armed 中间态 */
    await page.locator('#lockmgr-pwdel').click();
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#lockmgr-pwdel')).toHaveText('删除密码');
    await expect(dlg).toContainText('删除后锁屏只能通过重置锁屏重新设置');
    expect(getRemoveCalls()).toBe(0);
    await dlg.locator('button', { hasText: '删除' }).click();
    await expect.poll(() => getRemoveCalls()).toBe(1);
    await expect(page.locator('.sgx-toast')).toContainText('密码已删除', { timeout: 5000 });
  });

  test('点取消不删除', async ({ page }) => {
    const lockKeys = [{ credId: 'lock-key-001', name: 'test', class: 'lock', createdAt: 1, lastUsedAt: 0 }];
    const { getDeleteCalls } = await gotoLockPage(page, { lockPw: false, lockKeys });
    await expect(page.locator('.lockmgr-pkdel')).toBeVisible({ timeout: 5000 });
    /* v1.1 §二.4：点「删除」直接弹确认框 */
    await page.locator('.lockmgr-pkdel').click();
    const dlg = page.locator('dialog.sgx-center-dlg');
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await dlg.locator('button', { hasText: '取消' }).click();
    await expect(dlg).toBeHidden();
    expect(getDeleteCalls()).toBe(0);
  });

  test('非最后一把删除保持两步武装（A 现状不变）', async ({ page }) => {
    const lockKeys = [
      { credId: 'lock-key-001', name: 'test1', class: 'lock', createdAt: 1, lastUsedAt: 0 },
      { credId: 'lock-key-002', name: 'test2', class: 'lock', createdAt: 2, lastUsedAt: 0 },
    ];
    const { getDeleteCalls } = await gotoLockPage(page, { lockPw: false, lockKeys });
    const firstDel = page.locator('.lockmgr-pkdel').first();
    await expect(firstDel).toBeVisible({ timeout: 5000 });
    /* 第 1 点武装：文案变「再点一次删除」，不弹框 */
    await firstDel.click();
    await expect(firstDel).toHaveText('再点一次删除');
    await expect(page.locator('dialog.sgx-center-dlg')).toHaveCount(0);
    /* 第 2 点才真正调删除接口 */
    await firstDel.click();
    await expect.poll(() => getDeleteCalls()).toBe(1);
  });
});
