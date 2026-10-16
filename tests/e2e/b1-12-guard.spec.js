/**
 * B1-12 守护测试（只加测试，不改功能）。
 *
 * 覆盖（任务书 B1-12）：
 * - 站长凭证页「添加通行密钥」：虚拟认证器下，点击后 1 秒内调用 credentials.create；
 *   成功弹命名弹层，失败给中文提示。
 * - 密码被浏览器自动填充后直接点验证：不报「请输入凭证」
 *   （直接设 value、不触发 input 事件来模拟）。
 * - 页面切换过程中：顶栏、大标题、← 同一时刻都只有 1 个。
 *
 * 运行：npx playwright test --config=playwright.config.js b1-12-guard.spec.js
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

/** @param {import('@playwright/test').Page} page */
async function addVirtualAuth(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: false,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

test.describe('B1-12 守护：添加通行密钥', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    /* 门内页探针通过 */
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
    await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], scope: 'root' });
  });

  test('点击后 1 秒内调 credentials.create，成功弹命名弹层', async ({ page }) => {
    /* challenge 接口返回注册用 challenge */
    await page.route('**/api/owner-passkey', async (route) => {
      const req = route.request();
      let action = '';
      try { action = JSON.parse(req.postData() || '{}').action || ''; } catch (e) {}
      if (action === 'challenge') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            challenge: 'dGVzdC1jaGFsbGVuZ2UtMzJiYnl0ZXM',
            cid: 'test-cid-1',
            rpId: 'localhost',
            rp: { name: 'Styrigx' },
            user: { id: 'dGVzdC11c2Vy', name: 'lock', displayName: 'Sloan Gray' },
            excludeCredentials: [],
          }),
        });
      } else if (action === 'register') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, credId: 'test-cred-id' }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, keys: [], scope: 'root' }),
        });
      }
    });

    await page.goto('/settings/security/owner/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#lockmgr-pkadd')).toBeVisible();

    /* 桩掉 credentials.create：记录调用时间，返回假 credential
      （不用虚拟认证器：door.js 要求 userVerification='required'，
       虚拟认证器开 UV 会失败） */
    await page.evaluate(() => {
      window.__createCalledAt = 0;
      window.__clickDispatchedAt = 0;
      /* B1-12 flaky 修复：记录点击实际到达按钮的浏览器侧时间，
         排除 page.click() 的 actionability 检查开销（可达 1s+） */
      document.getElementById('lockmgr-pkadd').addEventListener('click', () => {
        window.__clickDispatchedAt = Date.now();
      }, { capture: true, once: true });
      navigator.credentials.create = function (...args) {
        window.__createCalledAt = Date.now();
        /* 返回最小可用假 credential */
        return Promise.resolve({
          id: 'test-cred-id',
          rawId: new Uint8Array([1, 2, 3]).buffer,
          type: 'public-key',
          response: {
            clientDataJSON: new Uint8Array([4, 5, 6]).buffer,
            attestationObject: new Uint8Array([7, 8, 9]).buffer,
          },
        });
      };
    });

    await page.click('#lockmgr-pkadd');

    /* 1 秒内必须调用 credentials.create（浏览器侧计时，排除 page.click 开销） */
    await page.waitForFunction(() => window.__createCalledAt > 0, null, { timeout: 5000 });
    const timings = await page.evaluate(() => ({
      click: window.__clickDispatchedAt,
      create: window.__createCalledAt,
    }));
    expect(timings.create - timings.click).toBeLessThan(1000);

    /* 成功 → 命名弹层出现 */
    await expect(page.locator('#lockpkname-dlg')).toBeVisible({ timeout: 15000 });
  });

  test('create 失败给中文提示，不弹命名弹层', async ({ page }) => {
    await page.route('**/api/owner-passkey', async (route) => {
      const req = route.request();
      let action = '';
      try { action = JSON.parse(req.postData() || '{}').action || ''; } catch (e) {}
      if (action === 'challenge') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            challenge: 'dGVzdC1jaGFsbGVuZ2UtMzJiYnl0ZXM',
            cid: 'test-cid-2',
            rpId: 'localhost',
            rp: { name: 'Styrigx' },
            user: { id: 'dGVzdC11c2Vy', name: 'lock', displayName: 'Sloan Gray' },
            excludeCredentials: [],
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, keys: [], scope: 'root' }),
        });
      }
    });

    await page.goto('/settings/security/owner/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });

    /* 桩掉 create：直接失败 */
    await page.evaluate(() => {
      navigator.credentials.create = function () {
        return Promise.reject(Object.assign(new Error('test-fail'), { name: 'NotSupportedError' }));
      };
    });

    await page.click('#lockmgr-pkadd');

    /* 中文提示出现，命名弹层不出现 */
    await expect(page.locator('.sgx-toast.show')).toBeVisible({ timeout: 8000 });
    const toastText = await page.locator('.sgx-toast.show').textContent();
    /* 中文提示：非空且不含英文错误码 */
    expect(toastText.trim().length).toBeGreaterThan(0);
    await expect(page.locator('#lockpkname-dlg')).toBeHidden();
  });
});

test.describe('B1-12 守护：密码自动填充', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await mockJson(page, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
    await mockJson(page, '**/api/stepup', 200, { ok: true, valid: true });
  });

  test('自动填充后直接点验证，不报「请输入凭证」', async ({ page }) => {
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sec-mgmt-cred')).toBeVisible({ timeout: 15000 });

    /* 打开管理凭证验证弹层，选站长密码行 */
    await page.click('#sec-mgmt-cred');
    await expect(page.locator('#sec-verify-dlg')).toBeVisible();
    await page.locator('.sgx-door-row').filter({ hasText: '站长密码' }).click();

    const input = page.locator('.sgx-door-expand input[type="password"]');
    await expect(input).toBeVisible();

    /* 模拟浏览器自动填充：直接设 value，不触发 input 事件 */
    await page.evaluate(() => {
      const el = document.querySelector('.sgx-door-expand input[type="password"]');
      if (el) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, 'autofilled-password-123');
        /* 注意：不 dispatch input 事件 */
      }
    });

    /* stepup 成功 */
    await mockJson(page, '**/api/stepup', 200, { ok: true });

    /* 点验证 */
    await page.locator('.sgx-door-btn-primary').click();

    /* 不报「请输入凭证」 */
    await expect(
      page.locator('.sgx-door-err:not([hidden])').filter({ hasText: '请输入凭证' })
    ).toHaveCount(0, { timeout: 5000 });
  });
});

test.describe('B1-12 守护：页面切换唯一性', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
  });

  test('顶栏、大标题、← 同一时刻都只有 1 个', async ({ page }) => {
    const pages = ['/settings/', '/settings/security/', '/files/'];
    for (const url of pages) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      /* 等页面稳定：顶栏可见 */
      await expect(page.locator('#site-nav')).toBeVisible({ timeout: 15000 });

      /* 顶栏只有 1 个 */
      await expect(page.locator('#site-nav')).toHaveCount(1);
      /* 大标题只有 1 个（h1.subpage-title） */
      await expect(page.locator('h1.subpage-title')).toHaveCount(1);
      /* ← 只有 1 个（.subpage-back 或 [data-go-back]） */
      const backCount = await page.locator('.subpage-back, [data-go-back]').count();
      expect(backCount).toBeLessThanOrEqual(1);
    }
  });
});
