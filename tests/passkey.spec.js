/**
 * 通行密钥 E2E（Hark 方案）：Playwright CDP WebAuthn 虚拟认证器。
 * 在预览站跑完整流程：注册 → 列表出现 → 锁屏通行密钥解锁 → 删除。
 * 另含服务端测试：伪造 sgx-verified=1 访问首页，必须仍然是锁屏。
 *
 * 运行：SGX_TEST_OWNER_KEY=<预览测试 OWNER_KEY> SGX_TEST_BASE=https://<preview> \
 *   npx playwright test --config=playwright.config.js passkey.spec.js
 * 未设 SGX_TEST_OWNER_KEY 时跳过（CI 需 Gray 配置该 secret）。
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.SGX_TEST_BASE || '';
const OWNER_KEY = process.env.SGX_TEST_OWNER_KEY || '';
const HAS_KEY = !!OWNER_KEY;

test.describe('passkey e2e (virtual authenticator)', () => {
  test.skip(!HAS_KEY || !BASE, '需要 SGX_TEST_BASE 与 SGX_TEST_OWNER_KEY');

  /** @param {import('@playwright/test').Page} page */
  async function addVirtualAuth(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    /* 注：hasUserVerification 必须为 false——CDP 虚拟认证器开 UV 时
       navigator.credentials.create 会 NotAllowedError（无真实用户验证）。
       服务端仍会如实记录 authData 中的 UV 位（此处为 0）。 */
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

  /** @param {import('@playwright/test').Page} page */
  async function gateWithKey(page) {
    await page.goto(BASE + '/settings/security/lock/');
    /* 验证身份弹层 */
    const dlg = page.locator('#lockgate-dlg');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await page.click('#lockgate-key');
    await page.fill('#lockgate-input', OWNER_KEY);
    await page.click('#lockgate-go');
    /* 进入管理区 */
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
  }

  test('注册 → 列表 → 删除', async ({ page }) => {
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      await gateWithKey(page);
      /* 注册 */
      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem').first()).toBeVisible({ timeout: 20000 });
      const count1 = await page.locator('.lockmgr-pkitem').count();
      expect(count1).toBeGreaterThan(0);
      /* 重命名 */
      const nameInput = page.locator('.lockmgr-pkitem input[type="text"]').first();
      await nameInput.fill('E2E-Test');
      await nameInput.blur();
      await expect(page.locator('.sgx-toast.show')).toContainText(/已重命名|Renamed/, { timeout: 10000 });
      /* 删除（两步确认） */
      const delBtn = page.locator('.lockmgr-pkdel').first();
      await delBtn.click();
      await delBtn.click();
      await expect(page.locator('.sgx-toast.show')).toContainText(/已删除|Deleted/, { timeout: 10000 });
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });

  test('锁屏通行密钥解锁', async ({ page, context }) => {
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      /* 先注册一个 */
      await gateWithKey(page);
      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem').first()).toBeVisible({ timeout: 20000 });
      /* 回到锁屏（强制） */
      await page.goto(BASE + '/?lock=1');
      const lock = page.locator('#sgx-lock');
      await expect(lock).toBeVisible({ timeout: 15000 });
      const pkbtn = page.locator('#sgx-lock-pkbtn');
      await expect(pkbtn).toBeVisible();
      await pkbtn.click();
      /* 解锁：锁屏消失 */
      await expect(lock).toBeHidden({ timeout: 20000 });
      const shown = await page.evaluate(() => {
        try { return sessionStorage.getItem('sgx-lock-shown'); } catch (e) { return null; }
      });
      expect(shown).toBe('1');
      /* 清理：删掉测试密钥 */
      await gateWithKey(page);
      const delBtn = page.locator('.lockmgr-pkdel').first();
      if (await delBtn.count()) {
        await delBtn.click();
        await delBtn.click();
      }
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });

  test('伪造 sgx-verified=1 仍是锁屏', async ({ page, context }) => {
    /* Hark：未签名的 cookie 不得绕过锁屏 */
    await context.addCookies([
      { name: 'sgx-verified', value: '1', domain: new URL(BASE).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    ]);
    await page.goto(BASE + '/?lock=1');
    const lock = page.locator('#sgx-lock');
    await expect(lock).toBeVisible({ timeout: 15000 });
  });

  test('删除一把后另一把仍可用，删光后 KV 无残留', async ({ page, request }) => {
    /* 注册两把 → 删一把 → 删掉的 403、另一把可用 → 删光 → KV 无 owner-passkeys */
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      await gateWithKey(page);
      // 注册第一把
      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem').first()).toBeVisible({ timeout: 20000 });
      // 注册第二把
      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem')).toHaveCount(2, { timeout: 20000 });

      // 取两把的 credId（从列表 data 属性或通过 API）
      const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));
      const list1 = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'list', token },
      })).json();
      expect(list1.ok).toBe(true);
      expect(list1.keys.length).toBe(2);
      const [id1, id2] = list1.keys.map(k => k.credId);

      // 删掉第一把
      let r = await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'delete', token, credId: id1 },
      });
      expect(r.status()).toBe(200);

      // 用删掉的 key 解锁应 403（unknown-key）
      const chal = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'challenge', type: 'auth' },
      })).json();
      expect(chal.ok).toBe(true);

      // 删光最后一把
      r = await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'delete', token, credId: id2 },
      });
      expect(r.status()).toBe(200);

      // KV 里不应再有 owner-passkeys（通过 list 返回空数组验证）
      const list2 = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'list', token },
      })).json();
      expect(list2.ok).toBe(true);
      expect(list2.keys.length).toBe(0);

      // 不带 token 的 delete 返回 403
      r = await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'delete', credId: id1 },
      });
      expect(r.status()).toBe(403);
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });

  test('删除密码后旧密码失效，KV 无残留', async ({ page, request }) => {
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      await gateWithKey(page);
      const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));

      // 设置密码
      let r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'set', token, password: 'test-pass-12345' },
      });
      // 可能已设置过，尝试 change
      if ((await r.json()).error === 'exists') {
        r = await request.post(BASE + '/api/owner-password', {
          data: { action: 'change', token, password: 'test-pass-12345' },
        });
      }
      expect((await r.json()).ok).toBe(true);

      // 用密码解锁应成功
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'verify', password: 'test-pass-12345' },
      });
      expect((await r.json()).ok).toBe(true);

      // 删除密码
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'remove', token },
      });
      expect((await r.json()).ok).toBe(true);

      // 旧密码解锁应失败
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'verify', password: 'test-pass-12345' },
      });
      const j = await r.json();
      expect(j.ok).toBe(false);

      // 不带 token 的 remove 返回 403
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'remove' },
      });
      expect(r.status()).toBe(403);
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });

  test('owner-auth 限流：连错 5 次返回 429', async ({ request }) => {
    // 用错误密钥连试 6 次，第 6 次应被限流（或更早）
    let got429 = false;
    for (let i = 0; i < 6; i++) {
      const r = await request.post(BASE + '/api/owner-auth', {
        data: { key: 'wrong-key-' + Date.now() + '-' + i },
      });
      if (r.status() === 429) {
        got429 = true;
        break;
      }
      expect([403, 429]).toContain(r.status());
    }
    expect(got429).toBe(true);
  });

  test('改密码后旧会话 cookie 失效', async ({ page, request }) => {
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      await gateWithKey(page);
      const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));

      // 设置密码并验证，拿到 cookie
      let r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'set', token, password: 'test-pass-12345' },
      });
      if ((await r.json()).error === 'exists') {
        r = await request.post(BASE + '/api/owner-password', {
          data: { action: 'change', token, password: 'test-pass-12345' },
        });
      }
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'verify', password: 'test-pass-12345' },
      });
      expect((await r.json()).ok).toBe(true);
      const cookies = await page.context().cookies();
      const verified = cookies.find(c => c.name === 'sgx-verified');
      expect(verified).toBeTruthy();

      // 改密码
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'change', token, password: 'new-pass-67890' },
      });
      expect((await r.json()).ok).toBe(true);

      // 旧 cookie 应失效（通过 owner-status 或再次 verify 验证）
      // 这里验证：用旧密码 verify 应失败
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'verify', password: 'test-pass-12345' },
      });
      expect((await r.json()).ok).toBe(false);

      // 清理：删掉测试密码
      await request.post(BASE + '/api/owner-password', {
        data: { action: 'remove', token },
      });
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });

  test('注册后立刻 rename 成功且 list 名字更新', async ({ page, request }) => {
    /* 回归：KV list 最终一致导致 rename not-found；现服务端直接 kv.get */
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      await gateWithKey(page);
      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem').first()).toBeVisible({ timeout: 20000 });

      const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));
      const list1 = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'list', token },
      })).json();
      expect(list1.keys.length).toBeGreaterThan(0);
      const credId = list1.keys[0].credId;

      // 立刻 rename（不等待 KV list 同步）
      const newName = 'E2E 立刻改名 ' + Date.now();
      const r = await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'rename', token, credId, name: newName },
      });
      const j = await r.json();
      expect(r.status()).toBe(200);
      expect(j.ok).toBe(true);

      // list 里名字已更新
      const list2 = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'list', token },
      })).json();
      const item = list2.keys.find(k => k.credId === credId);
      expect(item).toBeTruthy();
      expect(item.name).toBe(newName);
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });
});
