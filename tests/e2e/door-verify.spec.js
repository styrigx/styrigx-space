/**
 * 两扇门验证弹层 E2E（静态构建 + API mock，无需真实后端）。
 *
 * 覆盖（第七节验收）：
 * - 取消系统验证后弹层仍在，不提示错误
 * - 密码错误显示行内提示（不用 toast）
 * - 成功后直接进门内页面（不留在入口页）
 *
 * 运行：npx playwright test --config=playwright.config.js door-verify.spec.js
 * （默认 suite，走静态 public/ 构建；/api/* 用 page.route mock）
 *
 * Hark：等具体元素，不用 waitForTimeout/networkidle。
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

test.describe('door verify dialog', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    /* 语言钉住中文：2.7.0 起语言跟随系统，Playwright 默认 en-US 会跳 /en/，
       中文断言会失败（与 visual.spec.js 同一做法）。 */
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    /* 站长凭证已配置（密码+通行密钥）：管理凭证弹层显示两个行 */
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sec-mgmt-cred')).toBeVisible({ timeout: 15000 });
  });

  test('取消系统验证后弹层仍在，不提示错误', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, {
      ok: true, challenge: 'dGVzdC1jaGFsbGVuZ2U', cid: 'c1', rpId: 'localhost', allowCredentials: [],
    });
    await page.click('#sec-mgmt-cred');
    const dlg = page.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();
    /* 桩掉系统验证：直接拒绝 NotAllowedError（模拟用户取消） */
    await page.evaluate(() => {
      try {
        navigator.credentials.get = function () {
          return Promise.reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
        };
      } catch (e) {}
    });
    await page.locator('.sgx-door-row').filter({ hasText: '站长通行密钥' }).click();
    /* 等加载圈消失（流程结束），弹层仍在且无行内错误 */
    await expect(page.locator('.sgx-door-spin')).toHaveCount(0, { timeout: 8000 });
    await expect(dlg).toBeVisible();
    await expect(page.locator('.sgx-door-err:not([hidden])')).toHaveCount(0);
  });

  test('密码错误显示行内提示，弹层不关闭', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 401, { ok: false, error: 'auth' });
    await page.click('#sec-mgmt-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '站长密码' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('wrong-password');
    await page.locator('.sgx-door-btn-primary').click();
    await expect(page.locator('.sgx-door-err:not([hidden])').filter({ hasText: '密码不正确' }))
      .toBeVisible({ timeout: 8000 });
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
  });

  test('密码验证成功后先到管理凭证索引页（批次 A 收尾 D1）', async ({ page }) => {
    await mockJson(page, '**/api/stepup', 200, { ok: true });
    await page.click('#sec-mgmt-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '站长密码' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('correct-password');
    await page.locator('.sgx-door-btn-primary').click();
    await page.waitForURL('**/settings/security/mgmt/', { timeout: 10000 });
  });

  test('根凭证验证成功后直接进站长凭证门内页', async ({ page }) => {
    await mockJson(page, '**/api/root-auth', 200, { ok: true });
    /* #1 诊断：根凭证成功后先预检 stepup 票据，valid 才进门。
       测试环境静态构建无 data-sgx-role，显式置 owner 走有会话路径。 */
    await page.evaluate(() => { document.documentElement.dataset.sgxRole = 'owner'; });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/root-session', 200, { ok: true });
    await page.click('#sec-owner-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await expect(page.locator('.sgx-door-row').filter({ hasText: '根凭证' })).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('test-root-key');
    await page.locator('.sgx-door-btn-primary').click();
    await page.waitForURL('**/settings/security/owner/**', { timeout: 10000 });
  });

  test('根凭证成功但 stepup 预检失败时弹层不关闭并显示原因', async ({ page }) => {
    await mockJson(page, '**/api/root-auth', 200, { ok: true });
    /* 有会话路径才做 stepup 预检：测试环境显式置 owner */
    await page.evaluate(() => { document.documentElement.dataset.sgxRole = 'owner'; });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: false, reason: 'expired' });
    await page.click('#sec-owner-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('test-root-key');
    await page.locator('.sgx-door-btn-primary').click();
    /* 弹层不关闭，行内错误显示接口、状态码、reason */
    const err = page.locator('.sgx-door-err:not([hidden])');
    await expect(err.filter({ hasText: '预检未通过' })).toBeVisible({ timeout: 8000 });
    await expect(err.filter({ hasText: 'POST /api/stepup' })).toBeVisible();
    await expect(err.filter({ hasText: 'expired' })).toBeVisible();
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    /* 未跳转，仍在安全页 */
    expect(page.url()).toContain('/settings/security/');
    expect(page.url()).not.toContain('/settings/security/owner/');
  });

  test('无会话时根凭证走换会话路径，不调 stepup 预检', async ({ page }) => {
    /* 未配锁引导场景：无 owner 会话（测试环境 data-sgx-role 缺席即无会话）。
       生产 middleware 对无会话的 /api/* 直接 401，预检必失败，
       因此无会话路径不得调 /api/stepup，先走 /api/root-session 换会话。 */
    await mockJson(page, '**/api/root-auth', 200, { ok: true });
    /* 按请求体 action 分类计数：security.js:272 预检与 door.js probe 均用
       action 'status'，但无会话路径下预检不可能被调用（hasSession=false），
       出现的 'status' 必为导航后 probe 的合法票据校验，不计入、给有效 mock；
       其他 action 的 stepup 调用则为异常，计数并断言为 0。 */
    let precheckCalls = 0;
    await page.route('**/api/stepup', async (route) => {
      let action = '';
      try {
        const body = route.request().postDataJSON();
        action = (body && body.action) || '';
      } catch (e) {}
      if (action === 'status') {
        /* probe 的合法调用：有效票据，不计入 */
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, valid: true }),
        });
        return;
      }
      precheckCalls++;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false }),
      });
    });
    let rootSessionCalls = 0;
    await page.route('**/api/root-session', async (route) => {
      rootSessionCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.click('#sec-owner-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('test-root-key');
    await page.locator('.sgx-door-btn-primary').click();
    /* 换会话成功后直接进门，不应被预检拦住 */
    await page.waitForURL('**/settings/security/owner/**', { timeout: 10000 });
    /* 提交时未做 stepup 预检（非 status action 的调用为 0） */
    expect(precheckCalls).toBe(0);
    /* 走的是换会话路径：/api/root-session 恰好 1 次 */
    expect(rootSessionCalls).toBe(1);
    /* probe 拿到有效票据，跳转后不应出现「验证已过期」 */
    await expect(page.locator('text=验证已过期')).toBeHidden({ timeout: 5000 });
  });

  test('点遮罩不关闭弹层，只有 × 或取消关闭（批次 A 收尾 A1/A3）', async ({ page }) => {
    await page.click('#sec-mgmt-cred');
    const dlg = page.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();
    /* 点 dialog 元素本身（遮罩区域）→ 弹层保留 */
    await page.evaluate(() => {
      const d = document.getElementById('sec-verify-dlg');
      d.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(dlg).toBeVisible({ timeout: 5000 });
    /* 点 × 关闭 */
    await page.locator('#sec-verify-close').click();
    await expect(dlg).toBeHidden({ timeout: 5000 });
  });

  test('密码输错一次后改对再点验证能成功（bindSubmitButton 去重修复）', async ({ page }) => {
    /* bindSubmitButton 回归：第一次提交失败后，按钮必须还能再次提交。
       旧实现 fired 标志永不重置，第二次点击完全没反应。 */
    let stepupCalls = 0;
    await page.route('**/api/stepup', async (route) => {
      stepupCalls++;
      if (stepupCalls === 1) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'auth' }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      }
    });
    await page.click('#sec-mgmt-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '站长密码' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('wrong-password');
    await page.locator('.sgx-door-btn-primary').click();
    await expect(page.locator('.sgx-door-err:not([hidden])').filter({ hasText: '密码不正确' }))
      .toBeVisible({ timeout: 8000 });
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    /* 改对后再次点击验证，必须再次提交并成功进门 */
    await page.locator('.sgx-door-expand input[type="password"]').fill('correct-password');
    await page.locator('.sgx-door-btn-primary').click();
    await page.waitForURL('**/settings/security/mgmt/', { timeout: 10000 });
    expect(stepupCalls).toBe(2);
  });

  test('键盘按下验证只提交一次（批次 A 收尾：pointerup + click 去重）', async ({ page }) => {
    let authCalls = 0;
    await page.route('**/api/root-auth', async (route) => {
      authCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.evaluate(() => { document.documentElement.dataset.sgxRole = 'owner'; });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/root-session', 200, { ok: true });
    await page.click('#sec-owner-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('test-root-key');
    /* 聚焦验证按钮，按 Enter → 只提交一次（click 兜底，pointerup 未触发时不重复） */
    await page.locator('.sgx-door-btn-primary').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/settings/security/owner/**', { timeout: 10000 });
    expect(authCalls).toBe(1);
  });
});

test.describe('A-1 进门不能马上被判过期（10 次连续进门）', () => {
  let pageErrors;
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await mockJson(page, '**/api/root-auth', 200, { ok: true });
    await mockJson(page, '**/api/root-session', 200, { ok: true });
    await mockJson(page, '**/api/lock-config', 200, { ok: true, password: true, passkey: true });
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sec-owner-cred')).toBeVisible({ timeout: 10000 });
  });

  test('根凭证进站长凭证门：连续 10 次都成功（无 no-cookie 误判）', async ({ page }) => {
    for (let i = 0; i < 10; i++) {
      await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
      /* 有会话路径：根凭证成功后做 stepup 预检（B 回归点：进门时误清票 → 探针 no-cookie） */
      await page.evaluate(() => { document.documentElement.dataset.sgxRole = 'owner'; });
      await page.locator('#sec-owner-cred').click();
      await expect(page.locator('.sgx-door-methods .sgx-door-row').first()).toBeVisible({ timeout: 10000 });
      await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
      await page.locator('.sgx-door-expand input[type="password"]').fill('test-root-key');
      await page.locator('.sgx-door-btn-primary').click();
      await expect(page).toHaveURL(/\/settings\/security\/owner\//, { timeout: 10000 });
      /* 进门成功：门内容器可见 + 倒计时出现 */
      await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    }
    expect(pageErrors).toEqual([]);
  });

  test('站长密码进管理凭证门：连续 10 次都成功', async ({ page }) => {
    for (let i = 0; i < 10; i++) {
      await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
      await page.locator('#sec-mgmt-cred').click();
      await expect(page.locator('.sgx-door-methods .sgx-door-row').first()).toBeVisible({ timeout: 10000 });
      await page.locator('.sgx-door-row').filter({ hasText: '站长密码' }).click();
      await page.locator('.sgx-door-expand input[type="password"]').fill('test-owner-pw');
      await page.locator('.sgx-door-btn-primary').click();
      await expect(page).toHaveURL(/\/settings\/security\/mgmt\//, { timeout: 10000 });
      await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    }
    expect(pageErrors).toEqual([]);
  });

  test('离开门后重进需重新验证（返回后再次进门仍弹验证框）', async ({ page }) => {
    /* 第 1 次：根凭证进门（有会话路径，做 stepup 预检） */
    await page.evaluate(() => { document.documentElement.dataset.sgxRole = 'owner'; });
    await page.locator('#sec-owner-cred').click();
    await expect(page.locator('.sgx-door-methods .sgx-door-row').first()).toBeVisible({ timeout: 10000 });
    await page.locator('.sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('test-root-key');
    await page.locator('.sgx-door-btn-primary').click();
    await expect(page).toHaveURL(/\/settings\/security\/owner\//, { timeout: 10000 });
    await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    /* 点返回按钮 → 回安全页（清票） */
    await page.locator('.subpage-back').click();
    await expect(page).toHaveURL(/\/settings\/security\/$/, { timeout: 10000 });
    /* 再次进门 → 仍需验证（验证框出现，不是直接进门） */
    await page.locator('#sec-owner-cred').click();
    await expect(page.locator('.sgx-door-methods .sgx-door-row').first()).toBeVisible({ timeout: 10000 });
    expect(pageErrors).toEqual([]);
  });
});

test.describe('A-3 根凭证选择框圆角加深', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sec-mgmt-cred')).toBeVisible({ timeout: 15000 });
  });

  /* v1.0 §五：半径 16px、静止底色 var(--m-container)、按下/选中 var(--m-container-high)、
     无 border-bottom 分隔线、.sgx-door-methods 纵向 flex gap 12px、行内边距 12px 16px */
  test('选择框：圆角 16px、静止底色不透明、行间距 12px、无分隔线、按下态比静止态深', async ({ page }) => {
    await page.click('#sec-mgmt-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    const rows = page.locator('.sgx-door-row');
    await expect(rows).toHaveCount(2);
    const row = rows.first();
    /* 圆角 16px */
    const radius = await row.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(radius).toBe('16px');
    /* 行内边距 12px 16px */
    const pad = await row.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { top: cs.paddingTop, left: cs.paddingLeft };
    });
    expect(pad.top).toBe('12px');
    expect(pad.left).toBe('16px');
    /* 无分隔线 */
    const borderW = await row.evaluate((el) => getComputedStyle(el).borderBottomWidth);
    expect(borderW).toBe('0px');
    /* 静止底色 = var(--m-container)，不透明 */
    const colors = await row.evaluate((el) => {
      const cs = getComputedStyle(el);
      const probe = document.createElement('div');
      probe.style.background = 'var(--m-container)';
      document.body.appendChild(probe);
      const tokenBg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { rowBg: cs.backgroundColor, tokenBg };
    });
    expect(colors.rowBg).toBe(colors.tokenBg);
    expect(colors.rowBg).not.toMatch(/rgba\(.*,\s*0\)/);
    /* 行间距 12px（.sgx-door-methods 纵向 flex gap 12px） */
    const gap = await page.locator('.sgx-door-method').evaluateAll((els) => {
      const b0 = els[0].getBoundingClientRect();
      const b1 = els[1].getBoundingClientRect();
      return b1.top - (b0.top + b0.height);
    });
    expect(gap).toBe(12);
    /* 按下态（.sgx-row-pressed）= var(--m-container-high)，比静止态深 */
    const lum = await row.evaluate((el) => {
      const parse = (c) => {
        const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
      };
      const luminance = (rgb) => {
        const f = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
      };
      const rest = luminance(parse(getComputedStyle(el).backgroundColor));
      el.classList.add('sgx-row-pressed');
      const pressed = luminance(parse(getComputedStyle(el).backgroundColor));
      el.classList.remove('sgx-row-pressed');
      return { rest, pressed };
    });
    expect(lum.pressed).toBeLessThan(lum.rest);
  });
});
