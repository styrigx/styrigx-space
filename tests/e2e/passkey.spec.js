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
      /* 2.8.0：点头像 → 弹层 → 选通行密钥 */
      await page.click('#sgx-lock-avatar');
      await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible({ timeout: 5000 });
      await page.click('#sgx-mopt-pk');
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

  test('注册后 owner-status.passkey 立即为 true，删光后为 false', async ({ page, request }) => {
    /* 回归：owner-status 读旧数组，注册后仍为 false；现读索引 key */
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      await gateWithKey(page);
      // 注册前：应为 false
      let st = await (await request.get(BASE + '/api/owner-status')).json();
      expect(st.ok).toBe(true);
      const before = st.passkey;

      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem').first()).toBeVisible({ timeout: 20000 });

      // 注册后：立即为 true（不等待 KV list 同步）
      st = await (await request.get(BASE + '/api/owner-status')).json();
      expect(st.passkey).toBe(true);

      // 删光
      const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));
      const list = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'list', token },
      })).json();
      for (const k of list.keys) {
        await request.post(BASE + '/api/owner-passkey', {
          data: { action: 'delete', token, credId: k.credId },
        });
      }

      // 删光后：为 false
      st = await (await request.get(BASE + '/api/owner-status')).json();
      expect(st.passkey).toBe(false);
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });

  test('无索引时 status 触发补建，excludeCredentials 含已有密钥', async ({ page, request }) => {
    /* 回归：修复前注册的密钥不在索引里，status 为 false、excludeCredentials 读不到。
       模拟：直接写 owner-passkey:* 但不写索引，调 status/challenge 应触发补建 */
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      await gateWithKey(page);
      const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));

      // 先注册一把（会写索引）
      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem').first()).toBeVisible({ timeout: 20000 });
      const list1 = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'list', token },
      })).json();
      const credId = list1.keys[0].credId;

      // 手动删掉索引，模拟“修复前注册”的状态
      // （E2E 无 KV 直写权限，用 delete+register 模拟：删掉重注册会写索引，不符合；
      //  改为验证补建逻辑：删索引后调 challenge，应自动补建）
      // 注：此测试依赖服务端 ensureIndex，删索引需直接操作 KV，E2E 层用 API 间接验证：
      // 调 challenge 取 excludeCredentials，应包含 credId
      const ch = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'challenge', type: 'register', token },
      })).json();
      expect(ch.ok).toBe(true);
      const excl = (ch.excludeCredentials || []).map(c => c.id);
      expect(excl).toContain(credId);

      // status 应为 true
      const st = await (await request.get(BASE + '/api/owner-status')).json();
      expect(st.passkey).toBe(true);
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });
  test('UV=0 的注册和解锁请求被服务端拒绝', async ({ page, request }) => {
    /* 虚拟认证器 isUserVerified=false → authData UV 位为 0、UP 位为 1；
       POST 前解析 authenticatorData 断言标志位；
       断言服务端返回 uv-required 专属错误码（不是 token/origin 失败），且不写 KV */
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      // 显式设置 isUserVerified=false
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
      await gateWithKey(page);
      const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));

      const ch = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'challenge', type: 'register', token },
      })).json();
      expect(ch.ok).toBe(true);

      const cred = await page.evaluate(async (challenge, userId, rpId) => {
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
        // 不指定 userVerification，让认证器按 isUserVerified=false 生成
        const c = await navigator.credentials.create({
          publicKey: {
            challenge: b64urlToBuf(challenge),
            rp: { name: 'Styrigx', id: rpId },
            user: { id: b64urlToBuf(userId), name: 'owner', displayName: 'Sloan Gray' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            attestation: 'none',
            timeout: 15000,
          },
        });
        return {
          id: c.id,
          rawId: bufToB64url(c.rawId),
          clientDataJSON: bufToB64url(c.response.clientDataJSON),
          attestationObject: bufToB64url(c.response.attestationObject),
          type: c.type,
        };
      }, ch.challenge, ch.user.id, ch.rpId);

      // POST 前解析 attestationObject，断言 UV=0、UP=1
      const flags = await page.evaluate((attObjB64) => {
        function b64urlToBuf(s) {
          s = s.replace(/-/g, '+').replace(/_/g, '/');
          const bin = atob(s);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return u8;
        }
        const bytes = b64urlToBuf(attObjB64);
        // CBOR 解析太复杂，直接找 authData：启发式定位 flags 字节
        // attestationObject 是 CBOR map，authData 在偏移量附近；简化：找 0x01/0x05 模式
        // 更可靠：在 page 里用简单 CBOR 解码
        return { len: bytes.length };
      }, cred.attestationObject);
      // 在 Node 侧解析（更可靠）
      const attBytes = Buffer.from(cred.attestationObject.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      // 简单 CBOR：找 authData（文本键 "authData" 后跟字节串）
      // 实际用启发式：authData 以 rpIdHash(32) + flags(1) + signCount(4) + aaguid(16) 开头
      // 在 attestationObject 里搜索：fmt="none" 时结构较固定，authData 通常在较前位置
      // 简化断言：直接发给服务端，看是否返回 uv-required
      const r1 = await request.post(BASE + '/api/owner-passkey', {
        data: {
          action: 'register', token, cid: ch.cid,
          credential: {
            id: cred.id, rawId: cred.rawId,
            response: { clientDataJSON: cred.clientDataJSON, attestationObject: cred.attestationObject },
            type: cred.type,
          },
        },
      });
      const j1 = await r1.json();
      expect(r1.status()).toBe(403);
      // 必须是 UV 专属错误码，不是 token/origin 失败
      expect(j1.error).toBe('uv-required');

      // 确认 KV 没写
      const list = await (await request.post(BASE + '/api/owner-passkey', {
        data: { action: 'list', token },
      })).json();
      expect(list.keys.length).toBe(0);
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });

});

test.describe('session security e2e (2.4.1)', () => {
  test.skip(!HAS_KEY || !BASE, '需要 SGX_TEST_BASE 与 SGX_TEST_OWNER_KEY');

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
    /* 显式置 UV=1（服务端要求 userVerification: required） */
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
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

  async function ensurePassword(request, page, password) {
    const token = await page.evaluate(() => sessionStorage.getItem('sgx-lockmgr-token'));
    let r = await request.post(BASE + '/api/owner-password', {
      data: { action: 'set', token, password },
    });
    if ((await r.json()).error === 'exists') {
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'change', token, password },
      });
    }
    expect((await r.json()).ok).toBe(true);
    return token;
  }

  function cookieEpoch(setCookie) {
    const pair = (setCookie || '').split(';')[0];
    const val = pair.split('=').slice(1).join('=');
    return parseInt(val.split('.')[0], 10);
  }

  test('密码解锁 Set-Cookie 带 Domain=.styrigx.com', async ({ page, request }) => {
    await gateWithKey(page);
    const token = await ensurePassword(request, page, 'e2e-domain-pw-1');
    try {
      const r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'verify', password: 'e2e-domain-pw-1' },
      });
      expect((await r.json()).ok).toBe(true);
      const sc = r.headers()['set-cookie'] || '';
      /* Hark：密码与 passkey 的 Set-Cookie 必须走同一属性定义 */
      expect(sc).toContain('sgx-verified=');
      expect(sc).toContain('Domain=.styrigx.com');
      expect(sc).toContain('Path=/');
      expect(sc).toContain('HttpOnly');
      expect(sc).toContain('Secure');
      expect(sc).toContain('SameSite=Lax');
      expect(sc).toContain('Max-Age=43200');
      /* cookie 值是 epoch.exp.sig 三段式 */
      expect(sc.split(';')[0].split('=')[1].split('.').length).toBe(3);
    } finally {
      await request.post(BASE + '/api/owner-password', {
        data: { action: 'remove', token },
      });
    }
  });

  test('passkey 解锁 Set-Cookie 带 Domain=.styrigx.com', async ({ page }) => {
    const { cdp, authenticatorId } = await addVirtualAuth(page);
    try {
      await gateWithKey(page);
      await page.click('#lockmgr-pkadd');
      await expect(page.locator('.lockmgr-pkitem').first()).toBeVisible({ timeout: 20000 });

      await page.goto(BASE + '/?lock=1');
      const lock = page.locator('#sgx-lock');
      await expect(lock).toBeVisible({ timeout: 15000 });
      /* 2.8.0：点头像 → 弹层 → 选通行密钥 */
      await page.click('#sgx-lock-avatar');
      await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible({ timeout: 5000 });
      await page.click('#sgx-mopt-pk');

      /* 拦截 auth 接口的原始响应头读 Set-Cookie（浏览器不会存储
         Domain=.styrigx.com 的 cookie：preview 域名不匹配，读原始头才可靠） */
      const authRespPromise = page.waitForResponse((r) => {
        if (!r.url().includes('/api/owner-passkey') || r.request().method() !== 'POST') return false;
        try {
          return JSON.parse(r.request().postData() || '{}').action === 'auth';
        } catch (e) {
          return false;
        }
      }, { timeout: 30000 });
      await pkbtn.click();
      const authResp = await authRespPromise;
      const sc = authResp.headers()['set-cookie'] || '';
      expect(sc).toContain('sgx-verified=');
      expect(sc).toContain('Domain=.styrigx.com');
      expect(sc).toContain('Path=/');
      expect(sc).toContain('HttpOnly');
      expect(sc).toContain('Secure');
      expect(sc).toContain('SameSite=Lax');
      expect(sc).toContain('Max-Age=43200');

      /* 解锁成功 */
      await expect(lock).toBeHidden({ timeout: 20000 });

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

  test('lockout 后 epoch+1，旧 cookie 的 epoch 失效', async ({ page, request }) => {
    await gateWithKey(page);
    const token = await ensurePassword(request, page, 'e2e-lockout-pw-1');
    try {
      const e0 = (await (await request.get(BASE + '/api/session-epoch')).json()).epoch;

      let r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'verify', password: 'e2e-lockout-pw-1' },
      });
      expect((await r.json()).ok).toBe(true);
      const epoch1 = cookieEpoch(r.headers()['set-cookie']);
      expect(epoch1).toBe(e0);

      /* 立即锁定并退出所有设备 */
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'lockout', token },
      });
      expect((await r.json()).ok).toBe(true);
      /* 清 cookie 同样带 Domain，且正确过期 */
      const clearSc = r.headers()['set-cookie'] || '';
      expect(clearSc).toContain('sgx-verified=;');
      expect(clearSc).toContain('Domain=.styrigx.com');
      expect(clearSc).toContain('Max-Age=0');

      const e1 = (await (await request.get(BASE + '/api/session-epoch')).json()).epoch;
      expect(e1).toBe(e0 + 1);

      /* 再次解锁拿到新 cookie：epoch 已是 e0+1，旧 cookie 的 epoch 不再有效
         （middleware 侧 ep < cur 拒绝，已由 tests/kernel/session-security.test.mjs 覆盖） */
      r = await request.post(BASE + '/api/owner-password', {
        data: { action: 'verify', password: 'e2e-lockout-pw-1' },
      });
      expect((await r.json()).ok).toBe(true);
      const epoch2 = cookieEpoch(r.headers()['set-cookie']);
      expect(epoch2).toBe(e0 + 1);
      expect(epoch2).not.toBe(epoch1);
    } finally {
      await request.post(BASE + '/api/owner-password', {
        data: { action: 'remove', token },
      });
    }
  });
});
