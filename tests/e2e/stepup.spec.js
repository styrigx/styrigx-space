/**
 * stepup 二次验证 E2E（Playwright CDP WebAuthn 虚拟认证器）。
 *
 * 覆盖：
 * - visitor（无会话）发起 stepup challenge 被拒（401）
 * - login challenge 不能用于 stepup verify（403 challenge）
 * - stepup challenge 单次使用，重放被拒（403 challenge）
 * - 完整流程：owner 会话 → stepup challenge → Passkey 验证（UV=1）
 *   → sgx-stepup cookie 下发 → status valid=true
 * - UV=0 的 stepup verify 被拒（uv-required 专属错误码）
 *
 * 运行：SGX_TEST_OWNER_KEY=<预览测试 OWNER_KEY> SGX_TEST_BASE=https://<preview> \
 *   SGX_TEST_SUITE=passkey npx playwright test --config=playwright.config.js stepup.spec.js
 * 未设 SGX_TEST_OWNER_KEY 时跳过（CI 需 Gray 配置该 secret）。
 * 注意：完整流程需要预览站配置 SGX_STEPUP_PRIVATE/SGX_STEPUP_PUBLIC，否则 verify 返回 no-stepup-key。
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.SGX_TEST_BASE || '';
const OWNER_KEY = process.env.SGX_TEST_OWNER_KEY || '';
const HAS_KEY = !!OWNER_KEY;

test.describe('stepup e2e', () => {
  test.skip(!HAS_KEY || !BASE, '需要 SGX_TEST_BASE 与 SGX_TEST_OWNER_KEY');

  /** @param {import('@playwright/test').Page} page */
  async function addVirtualAuth(page, userVerified) {
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
    if (userVerified) {
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
    }
    return { cdp, authenticatorId };
  }

  /** @param {import('@playwright/test').Page} page */
  async function gateWithKey(page) {
    await page.goto(BASE + '/settings/security/lock/');
    const dlg = page.locator('#lockgate-dlg');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await page.click('#lockgate-key');
    await page.fill('#lockgate-input', OWNER_KEY);
    await page.click('#lockgate-go');
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
  }

  /**
   * 拿 owner 会话 cookie：设测试密码 → verify → 从 Set-Cookie 提取。
   * @param {import('@playwright/test').Page} page
   * @param {any} request
   */
  async function ownerSessionCookie(page, request) {
    const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));
    const pw = 'e2e-stepup-' + Date.now();
    let r = await request.post(BASE + '/api/owner-password', {
      data: { action: 'set', token, password: pw },
    });
    if ((await r.json()).error === 'exists') {
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'change', token, password: pw },
      });
    }
    expect((await r.json()).ok).toBe(true);
    r = await request.post(BASE + '/api/owner-password', {
      data: { action: 'verify', password: pw },
    });
    expect((await r.json()).ok).toBe(true);
    const sc = r.headers()['set-cookie'] || '';
    const m = sc.match(/sgx-verified=([^;]+)/);
    expect(m).toBeTruthy();
    /* 清理测试密码 */
    await request.post(BASE + '/api/owner-password', {
      data: { action: 'remove', token },
    });
    return 'sgx-verified=' + m[1];
  }

  test('无会话发起 stepup challenge → 401', async ({ request }) => {
    const r = await request.post(BASE + '/api/stepup', {
      data: { action: 'challenge' },
    });
    /* middleware L1 未验证的 /api/* 返回 401（/api/stepup 不在白名单） */
    expect(r.status()).toBe(401);
  });

  test('login challenge 不能用于 stepup verify', async ({ page, request }) => {
    await gateWithKey(page);
    const cookie = await ownerSessionCookie(page, request);
    const headers = { Cookie: cookie };

    /* 取一个 login 用的 challenge */
    const chal = await (await request.post(BASE + '/api/owner-passkey', {
      data: { action: 'challenge', type: 'auth' },
      headers,
    })).json();
    /* 可能没有已注册 passkey → 先跳过（完整流程测试会注册） */
    if (!chal.ok) test.skip(true, '无已注册 passkey，跳过');

    /* 用 login 的 cid 调 stepup verify → 必须 403 challenge（用途隔离） */
    const r = await request.post(BASE + '/api/stepup', {
      data: { action: 'verify', cid: chal.cid, credential: { rawId: 'x' } },
      headers,
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).error).toBe('challenge');
  });

  test('stepup challenge 单次使用，重放被拒', async ({ page, request }) => {
    await gateWithKey(page);
    const cookie = await ownerSessionCookie(page, request);
    const headers = { Cookie: cookie };

    const chal = await (await request.post(BASE + '/api/stepup', {
      data: { action: 'challenge' },
      headers,
    })).json();
    if (!chal.ok) test.skip(true, '无已注册 passkey 或未配 STEPUP，跳过');

    /* 第一次：credential 非法 → verify 失败，但 challenge 已消费 */
    let r = await request.post(BASE + '/api/stepup', {
      data: { action: 'verify', cid: chal.cid, credential: { rawId: 'nope' } },
      headers,
    });
    expect(r.status()).toBe(403);

    /* 第二次同一 cid → challenge 错误（重放） */
    r = await request.post(BASE + '/api/stepup', {
      data: { action: 'verify', cid: chal.cid, credential: { rawId: 'nope' } },
      headers,
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).error).toBe('challenge');
  });

  test('完整流程：stepup 验证通过 → sgx-stepup cookie → status 有效', async ({ page, request }) => {
    const { cdp, authenticatorId } = await addVirtualAuth(page, true);
    try {
      await gateWithKey(page);
      /* 注册一把 passkey（UV=1） */
      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem').first()).toBeVisible({ timeout: 20000 });

      const cookie = await ownerSessionCookie(page, request);
      const headers = { Cookie: cookie };

      /* stepup challenge */
      const chal = await (await request.post(BASE + '/api/stepup', {
        data: { action: 'challenge' },
        headers,
      })).json();
      expect(chal.ok).toBe(true);
      expect(chal.cid).toBeTruthy();

      /* 浏览器内生成断言 */
      const cred = await page.evaluate(async (challenge, rpId, allowCreds) => {
        function b64urlToBuf(s) {
          s = s.replace(/-/g, '+').replace(/_/g, '/');
          const bin = atob(s);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return u8.buffer;
        }
        function bufToB64url(buf) {
          const u8 = new Uint8Array(buf);
          let s = '';
          for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
          return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }
        const c = await navigator.credentials.get({
          publicKey: {
            challenge: b64urlToBuf(challenge),
            rpId: rpId,
            allowCredentials: allowCreds.map(id => ({ id: b64urlToBuf(id), type: 'public-key' })),
            userVerification: 'required',
            timeout: 15000,
          },
        });
        return {
          id: c.id,
          rawId: bufToB64url(c.rawId),
          type: c.type,
          response: {
            clientDataJSON: bufToB64url(c.response.clientDataJSON),
            authenticatorData: bufToB64url(c.response.authenticatorData),
            signature: bufToB64url(c.response.signature),
            userHandle: c.response.userHandle ? bufToB64url(c.response.userHandle) : null,
          },
        };
      }, chal.challenge, chal.rpId, chal.allowCredentials.map(c => c.id));

      /* stepup verify */
      const r = await request.post(BASE + '/api/stepup', {
        data: { action: 'verify', cid: chal.cid, credential: cred },
        headers,
      });
      const j = await r.json();
      /* 未配 SGX_STEPUP_PRIVATE 时返回 no-stepup-key（500），属环境问题而非逻辑问题 */
      if (j.error === 'no-stepup-key') test.skip(true, '预览站未配 SGX_STEPUP_PRIVATE，跳过');
      expect(r.status()).toBe(200);
      expect(j.ok).toBe(true);

      /* sgx-stepup cookie 属性检查 */
      const sc = r.headers()['set-cookie'] || '';
      expect(sc).toContain('sgx-stepup=');
      expect(sc).toContain('Domain=.styrigx.com');
      expect(sc).toContain('Path=/');
      expect(sc).toContain('HttpOnly');
      expect(sc).toContain('Secure');
      expect(sc).toContain('SameSite=Strict');
      expect(sc).toContain('Max-Age=600');
      const m = sc.match(/sgx-stepup=([^;]+)/);
      expect(m).toBeTruthy();
      const stepupCookie = 'sgx-stepup=' + m[1];
      /* cookie 值是 5 段式 owner.epoch.iat.exp.sig */
      expect(m[1].split('.').length).toBe(5);

      /* status：有效 */
      const st = await (await request.post(BASE + '/api/stepup', {
        data: { action: 'status' },
        headers: { Cookie: cookie + '; ' + stepupCookie },
      })).json();
      expect(st.ok).toBe(true);
      expect(st.valid).toBe(true);

      /* 清理：删掉测试 passkey */
      const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));
      const list = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'list', token },
      })).json();
      for (const k of (list.keys || [])) {
        await request.post(BASE + '/api/owner-passkey', {
          data: { action: 'delete', token, credId: k.credId },
        });
      }
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });

  test('UV=0 的 stepup verify 被拒（uv-required）', async ({ page, request }) => {
    const { cdp, authenticatorId } = await addVirtualAuth(page, false);
    try {
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
      await gateWithKey(page);
      /* 先用 UV=1 注册一把（注册需要 UV） */
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem').first()).toBeVisible({ timeout: 20000 });
      /* 再把 UV 关掉，做 stepup 验证 */
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });

      const cookie = await ownerSessionCookie(page, request);
      const headers = { Cookie: cookie };

      const chal = await (await request.post(BASE + '/api/stepup', {
        data: { action: 'challenge' },
        headers,
      })).json();
      if (!chal.ok) test.skip(true, '无已注册 passkey 或未配 STEPUP，跳过');

      const cred = await page.evaluate(async (challenge, rpId, allowCreds) => {
        function b64urlToBuf(s) {
          s = s.replace(/-/g, '+').replace(/_/g, '/');
          const bin = atob(s);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return u8.buffer;
        }
        function bufToB64url(buf) {
          const u8 = new Uint8Array(buf);
          let s = '';
          for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
          return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }
        /* 不指定 userVerification，让认证器按 isUserVerified=false 生成（UV=0） */
        const c = await navigator.credentials.get({
          publicKey: {
            challenge: b64urlToBuf(challenge),
            rpId: rpId,
            allowCredentials: allowCreds.map(id => ({ id: b64urlToBuf(id), type: 'public-key' })),
            timeout: 15000,
          },
        });
        return {
          id: c.id,
          rawId: bufToB64url(c.rawId),
          type: c.type,
          response: {
            clientDataJSON: bufToB64url(c.response.clientDataJSON),
            authenticatorData: bufToB64url(c.response.authenticatorData),
            signature: bufToB64url(c.response.signature),
            userHandle: c.response.userHandle ? bufToB64url(c.response.userHandle) : null,
          },
        };
      }, chal.challenge, chal.rpId, chal.allowCredentials.map(c => c.id));

      const r = await request.post(BASE + '/api/stepup', {
        data: { action: 'verify', cid: chal.cid, credential: cred },
        headers,
      });
      const j = await r.json();
      if (j.error === 'no-stepup-key') test.skip(true, '预览站未配 SGX_STEPUP_PRIVATE，跳过');
      /* 必须是 UV 专属错误码 */
      expect(r.status()).toBe(403);
      expect(j.error).toBe('uv-required');

      /* 清理 */
      const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));
      const list = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'list', token },
      })).json();
      for (const k of (list.keys || [])) {
        await request.post(BASE + '/api/owner-passkey', {
          data: { action: 'delete', token, credId: k.credId },
        });
      }
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });
});
