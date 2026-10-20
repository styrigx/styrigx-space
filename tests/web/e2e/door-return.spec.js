/**
 * 锁屏凭证页（门内）行为 E2E（静态构建 + API mock，无需真实后端）。
 *
 * 门在锁屏凭证页本身：进页 POST /api/lock-door status，valid → 门内；这里的用例默认门票有效，
 * 测门内组件（密码弹层、删除、到期框、倒计时胶囊、最后一把钥匙）。门口本身见 door-verify.spec.js。
 * （管理凭证索引页、stepup 已删除，原 C2b「索引页 ↔ 锁屏子页」用例随之删除。）
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

test.describe('bindSubmitButton 去重修复：锁屏页设置密码弹层', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    /* 门内页探针通过：门票状态（/api/lock-door） */
    await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true });
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
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true });
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
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true });
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

test.describe('锁屏凭证页进门探针（/api/lock-door status）失败', () => {
  let pageErrors;
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
  });

  test('探针 session 失败 → 无 JS 错误，弹会话失效框，不点不跳；点「去锁屏」才重载', async ({ page }) => {
    await mockJson(page, '**/api/lock-door', 401, { ok: false, error: 'session' });
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

  test('探针网络失败 → 无 JS 错误，toast 网络提示，不自动跳，不弹过期框', async ({ page }) => {
    await page.route('**/api/lock-door', (route) => route.abort('failed'));
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
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, door: 'lock', expiresAt: Date.now() + 175000, password: true, passkey: true });
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

  test('进门后胶囊在正文最前面（顶栏下方）、左对齐，文案「验证剩余 2:5x」；顶栏内无倒计时', async ({ page }) => {
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    const capsule = page.locator('#sgx-door-countdown');
    await expect(capsule).toBeVisible({ timeout: 15000 });
    await expect(capsule).toHaveText(/验证剩余 2:5\d/);
    /* 不在全站顶栏内；2026-10-20 通版顶栏起没有大标题区，胶囊是正文（.set-layout）的第一个元素 */
    await expect(page.locator('#site-nav #sgx-door-countdown')).toHaveCount(0);
    await expect(page.locator('.set-layout > #sgx-door-countdown:first-child')).toHaveCount(1);
    /* 在顶栏下方（不被浮动顶栏盖住）、左对齐（胶囊左边缘 ≈ 内容容器左边缘） */
    const barBox = await page.locator('.sgx-topbar').boundingBox();
    const capBox = await capsule.boundingBox();
    const layoutBox = await page.locator('.set-layout').boundingBox();
    expect(capBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);
    /* 左对齐：胶囊在内容区左区（布局 16px 内边距；居中会在 500+） */
    expect(capBox.x - layoutBox.x).toBeGreaterThanOrEqual(0);
    expect(capBox.x - layoutBox.x).toBeLessThanOrEqual(48);
    expect(pageErrors).toEqual([]);
  });

  test('胶囊字号不小于正文；浅色对比度 ≥ 4.5:1', async ({ page }) => {
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
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
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
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
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, expiresAt: Date.now() + 25000 });
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
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.goto('/settings/security/lock/', { waitUntil: 'domcontentloaded' });
    const capsule = page.locator('#sgx-door-countdown');
    await expect(capsule).toBeVisible({ timeout: 15000 });
    /* 胶囊出现时，卡片入场动画已结束（不透明度=1），不是半透明淡入中 */
    /* 只看门内可见的卡片（门口的验证行在门内时是 hidden，不参与入场动画） */
    const opacities = await page.locator('#lockmgr .animate-fade-up').evaluateAll((els) =>
      els.filter((el) => el.offsetParent !== null).map((el) => parseFloat(getComputedStyle(el).opacity))
    );
    expect(opacities.length).toBeGreaterThan(0);
    opacities.forEach((o) => expect(o).toBe(1));
    /* 帮助文字（sec-note，含门内说明与「构建 dev」）不与卡片（widget）重叠 */
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

  test('门内 403 door → 弹框，不点不跳；点「重新验证」清票回到本页门口；无 challenge 请求', async ({ page }) => {
    let clears = 0;
    let valid = true;
    await page.route('**/api/lock-door', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'clear') {
        clears++;
        valid = false;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }
      const j = { ok: true, valid: valid, password: true, passkey: true };
      if (valid) j.expiresAt = Date.now() + 175000;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
    });
    await page.route('**/api/owner-password', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'door', reason: 'expired' }),
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
    /* 门票失效后不发起任何 WebAuthn challenge */
    expect(challengeCalls).toBe(0);
    /* 「重新验证」→ 清票 → 回到本页，门口出现（锁屏通行密钥 / 解锁密码 / 根凭证） */
    await dlg.locator('button.sgx-verify-skip').click();
    await expect(page.locator('#lock-door')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/settings\/security\/lock\/$/);
    await expect(page.locator('#lock-door-methods .sgx-door-row')).toHaveCount(3);
    expect(clears).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });

  test('门内 401 session → 弹会话失效框，不点不跳；点「去锁屏」重载后倒计时重启', async ({ page }) => {
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
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
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    /* 锁屏页：本页类 + 应用类列表同时 403 */
    await page.route('**/api/owner-passkey', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'door', reason: 'expired' }),
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
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
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
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    await page.route('**/api/owner-password', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'door', reason: 'expired' }),
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
    /* 探针通过（门票有效），门才能开 */
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
    /* 探针是 /api/lock-door；lock-status 只有门内 refreshStatus 读，延迟 1500ms 模拟慢网络 */
    await page.route('**/api/lock-status', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
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

});

test.describe('A-2 最后一把锁屏钥匙与 accountkey 联动', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/lock-door', 200, { ok: true, valid: true, expiresAt: Date.now() + 175000 });
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

  test('有 accountkey 时删最后一把 lock 钥匙：先弹确认，点删除后成功', async ({ page }) => {
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

  test('无 accountkey 时删最后一把 lock 钥匙：确认后服务端 403，提示先设置解锁密码', async ({ page }) => {
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

  test('有 accountkey 时删最后一把 lock 密码：先弹确认，点删除后成功', async ({ page }) => {
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
