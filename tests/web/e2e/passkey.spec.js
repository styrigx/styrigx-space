/**
 * 锁屏凭证 E2E：预览站上的真实网关（passkey-e2e.styrigx-space.pages.dev）+ CDP WebAuthn 虚拟认证器。
 *
 * 覆盖：锁屏凭证页添加 / 命名通行密钥（真实页面）、锁屏通行密钥解锁（真实页面）、伪造会话 cookie、
 * 通行密钥删除 / 重命名 / UV=0 拒绝、锁屏密码删除 / 修改后旧会话失效、重置开关单次有效、
 * LockResetTicket 的权限边界、会话 cookie 属性、退出所有设备推进纪元、根凭证单 IP 限速。
 *
 * 预览站 SGX_ENV=preview：网关只在正式域名上拦页面、注入会话标记，预览上页面不拦；
 * 所以这里只断言接口和前端行为，页面级的门由 edge-flow.spec.js（本地代理正式域名）覆盖。
 *
 * 会话、票据、预览 D1 的处理都在 preview-helpers.cjs（为什么要手动写回 cookie 见那里的文件头）。
 * 预览站状态跨运行保留，用例互相依赖同一份 D1：这一组只用 1 个 worker 顺序跑（playwright.config.js）。
 * 以前在 KV 时写后读最长约 60 秒才一致（现在 D1 强一致）：写完马上要读的地方仍先轮询到服务端看见新值（h.KV_SETTLE，见 preview-helpers.cjs
 * 文件头「写后读」），所以写状态的用例单条超时放到 h.KV_TEST_TIMEOUT（名字沿用）。
 *
 * 运行：SGX_TEST_SUITE=passkey SGX_TEST_BASE=https://<preview> SGX_TEST_ROOT_KEY=<预览测试 RootKey> \
 *   [SGX_TEST_CF_TOKEN=… SGX_TEST_CF_ACCOUNT=… SGX_TEST_PREVIEW_D1_ID=…] \
 *   npx playwright test --config=tests/config/playwright.config.js
 * 本地没配 SGX_TEST_BASE / SGX_TEST_ROOT_KEY 时跳过；CI（CI=true）里缺了直接失败。
 */
const { test, expect } = require('@playwright/test');
const h = require('./preview-helpers.cjs');

const { BASE, ORIGIN, ROOT_KEY, SESSION, REAUTH } = h;

test.describe('锁屏凭证 e2e（预览站）', () => {
  h.requirePreview(test);
  /* 这一组几乎每条都写状态（注册 / 删除推进纪元），写后读的等待最长 75 秒 */
  test.describe.configure({ timeout: h.KV_TEST_TIMEOUT });

  test('锁屏凭证页：添加通行密钥 → 命名 → 列表里出现', async ({ page }) => {
    await h.adminSession(page, test);
    await h.lockReauth(page);
    const va = await h.addVirtualAuth(page, { uv: true });
    const name = 'E2E-UI-' + Date.now();
    try {
      await page.goto(BASE + '/settings/security/lock/');
      await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('#lockmgr-pkadd')).toBeVisible({ timeout: 15000 });
      await page.click('#lockmgr-pkadd');
      /* 注册成功后弹命名弹层 */
      await expect(page.locator('#lockpkname-dlg')).toBeVisible({ timeout: 20000 });
      await page.fill('#lockpkname-input', name);
      await page.click('#lockpkname-save');
      await expect(page.locator('#lockpkname-dlg')).toBeHidden({ timeout: 10000 });
      /* 页面命名后就地刷新列表（原来就等 15 秒）；列表以前经 KV 索引读（现在在 D1，强一致），就地刷新可能拿到旧列表：
         15 秒内只看就地刷新的结果，之后每次重载页面再看（写后读，再多等最长 h.KV_SETTLE.timeout） */
      const t0 = Date.now();
      await expect.poll(async () => {
        if (Date.now() - t0 > 15000) {
          await page.reload();
          await expect(page.locator('#lockmgr-pkadd')).toBeVisible({ timeout: 15000 });
        }
        return page.locator('.lockmgr-pkitem input[type="text"]')
          .evaluateAll((els) => els.map((e) => /** @type {HTMLInputElement} */ (e).value));
      }, { timeout: 15000 + h.KV_SETTLE.timeout, intervals: [500, 1000, 2000, 5000] }).toContain(name);
      const keys = await h.listPasskeys(page);
      expect(keys.map((k) => k.name)).toContain(name);
    } finally {
      await h.deleteAllPasskeys(page);
      await va.remove();
    }
  });

  test('锁屏：通行密钥解锁，Set-Cookie 带 Domain=.styrigx.com 等属性', async ({ page }) => {
    await h.adminSession(page, test);
    await h.lockReauth(page);
    const va = await h.addVirtualAuth(page, { uv: true });
    try {
      const reg = await h.registerPasskey(page, { name: 'E2E-unlock' });
      expect(reg.json && reg.json.ok, JSON.stringify(reg.json)).toBe(true);
      /* 锁屏只在 GET /api/lock-entry 说 passkey:true 时才放「通行密钥」选项（lock.js）；
         它读通行密钥（D1，强一致；以前是 KV 索引，刚注册完边缘可能还是旧的）：等它看见再去锁屏 */
      await h.waitLockEntryPasskey(page, true);

      /* 去掉会话，回到锁屏 */
      await page.context().clearCookies({ name: SESSION });
      await page.goto(BASE + '/?lock=1');
      const lock = page.locator('#sgx-lock');
      await expect(lock).toBeVisible({ timeout: 15000 });
      await page.click('#sgx-lock-avatar');
      await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('#sgx-mopt-pk'), '锁屏方式面板里有通行密钥选项').toBeVisible({ timeout: 5000 });

      /* 读 auth 接口的原始响应头：预览域名存不下 Domain=.styrigx.com 的 cookie，只能看头 */
      const authResp = page.waitForResponse((r) => {
        if (!r.url().includes('/api/lock-passkey') || r.request().method() !== 'POST') return false;
        try { return JSON.parse(r.request().postData() || '{}').action === 'auth'; } catch (e) { return false; }
      }, { timeout: 30000 });
      await page.click('#sgx-mopt-pk');
      const resp = await authResp;
      expect(resp.status()).toBe(200);
      expect((await resp.json()).ok).toBe(true);
      const sc = (await resp.headerValue('set-cookie')) || '';
      expect(sc).toContain(SESSION + '=');
      expect(sc).toContain('Domain=.styrigx.com');
      expect(sc).toContain('Path=/');
      expect(sc).toContain('HttpOnly');
      expect(sc).toContain('Secure');
      expect(sc).toContain('SameSite=Lax');
      expect(sc).toContain('Max-Age=43200');
    } finally {
      await h.adminSession(page, test);
      await h.lockReauth(page);
      await h.deleteAllPasskeys(page);
      await va.remove();
    }
  });

  test('伪造 sgx-lock-session=1 不算会话，首页仍是锁屏', async ({ page }) => {
    /* 预览站 SGX_ENV=preview：网关不拦页面、不注入会话标记（只有正式域名才拦），这里只验接口和前端锁屏 */
    await page.context().addCookies([
      { name: SESSION, value: '1', url: ORIGIN + '/', httpOnly: true, secure: ORIGIN.startsWith('https:'), sameSite: 'Lax' },
    ]);
    const sc = await h.apiGet(page, '/api/lock-session-check');
    expect(sc.status).toBe(401);
    const cred = await h.apiGet(page, '/api/lock-credentials');
    expect(cred.status).toBe(401);
    await page.goto(BASE + '/?lock=1');
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
  });

  test('两把通行密钥删一把：删掉的那把 unknown-key，另一把仍能解锁', async ({ page }) => {
    await h.adminSession(page, test);
    await h.lockReauth(page);
    const va = await h.addVirtualAuth(page, { uv: true });
    try {
      const a = await h.registerPasskey(page, { name: 'E2E-A' });
      const b = await h.registerPasskey(page, { name: 'E2E-B' });
      expect(a.json && a.json.ok, JSON.stringify(a.json)).toBe(true);
      expect(b.json && b.json.ok, JSON.stringify(b.json)).toBe(true);
      /* 列表：写后读，轮询到两把都在（D1 后第一次就满足） */
      await expect.poll(async () => (await h.listPasskeys(page)).map((k) => k.credId), h.KV_SETTLE)
        .toEqual(expect.arrayContaining([a.json.credId, b.json.credId]));

      const del = await h.api(page, '/api/lock-passkey', { action: 'delete', credId: a.json.credId });
      expect(del.status, JSON.stringify(del.json)).toBe(200);
      /* 删除推进纪元（会话已在 api() 里等到新纪元可见）并改索引：等列表里没有 A 再验 A 的断言（只读） */
      await expect.poll(async () => (await h.listPasskeys(page)).map((k) => k.credId), h.KV_SETTLE)
        .not.toContain(a.json.credId);

      const gone = await h.assertPasskey(page, a.json.credId);
      expect(gone.status).toBe(403);
      expect(gone.json.error).toBe('unknown-key');

      const ok = await h.assertPasskey(page, b.json.credId);
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(ok.json.ok).toBe(true);

      /* 没有 LockReauthTicket 的 delete 被拒（有会话 → 403 reauth） */
      await page.context().clearCookies({ name: REAUTH });
      const noTicket = await h.api(page, '/api/lock-passkey', { action: 'delete', credId: b.json.credId });
      expect(noTicket.status).toBe(403);
      expect(noTicket.json.error).toBe('reauth');
    } finally {
      await h.adminSession(page, test);
      await h.lockReauth(page);
      await h.deleteAllPasskeys(page);
      await va.remove();
    }
  });

  test('删除锁屏密码后旧密码失效；没有 LockReauthTicket 不能删', async ({ page }) => {
    const pw = await h.adminSession(page, test);
    await h.lockReauth(page);
    const va = await h.addVirtualAuth(page, { uv: true });
    try {
      /* 先有一把通行密钥，删密码就不是删最后一把钥匙 */
      const reg = await h.registerPasskey(page, { name: 'E2E-keep' });
      expect(reg.json && reg.json.ok, JSON.stringify(reg.json)).toBe(true);
      /* remove 的「最后一把钥匙」检查要数通行密钥：写后读，等列表里有这把再删密码（只读） */
      await expect.poll(async () => (await h.listPasskeys(page)).map((k) => k.credId), h.KV_SETTLE)
        .toContain(reg.json.credId);

      await page.context().clearCookies({ name: REAUTH });
      let r = await h.api(page, '/api/lock-password', { action: 'remove' });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('reauth');

      await h.lockReauth(page);
      r = await h.api(page, '/api/lock-password', { action: 'remove' });
      expect(r.json && r.json.ok, JSON.stringify(r.json)).toBe(true);
      h.rememberPassword('');
      /* 写后读：等 lock-password 的删除可见（只读的 lock-credentials）再验旧密码；
         直接 verify 若读到旧哈希会成功，还会白写失败计数 */
      await expect.poll(async () => {
        const st = await h.apiGet(page, '/api/lock-credentials');
        return st.json && st.json.ok ? st.json.password : 'status ' + st.status;
      }, h.KV_SETTLE).toBe(false);

      r = await h.api(page, '/api/lock-password', { action: 'verify', password: pw });
      expect(r.json.ok).toBe(false);
    } finally {
      /* 恢复：会话已按新纪元写回 context，再进一次门把密码设回去 */
      await h.lockReauth(page);
      const pw2 = 'e2e-pw-' + h.rand();
      const r = await h.api(page, '/api/lock-password', { action: 'set', password: pw2 });
      if (r.json && r.json.ok) h.rememberPassword(pw2);
      await h.deleteAllPasskeys(page);
      await va.remove();
    }
  });

  test('改锁屏密码后旧会话 cookie 和旧密码都失效', async ({ page, request }) => {
    const oldPw = await h.adminSession(page, test);
    const oldSession = await h.currentCookie(page, SESSION);
    expect(oldSession).toBeTruthy();
    await h.lockReauth(page);
    const newPw = 'e2e-pw-' + h.rand();
    const r = await h.api(page, '/api/lock-password', { action: 'change', password: newPw });
    expect(r.json && r.json.ok, JSON.stringify(r.json)).toBe(true);
    h.rememberPassword(newPw);

    /* request fixture 没有 context 的 cookie：只带指定的那一个 */
    const check = (v) => request.get(BASE + '/api/lock-session-check', { headers: { Cookie: SESSION + '=' + v } });
    /* 新会话按新纪元重签；h.api 已轮询到它可见（settleSession），旧会话这时必须已失效：严格断言，不轮询 */
    expect((await check(oldSession)).status()).toBe(401);
    const newSession = await h.currentCookie(page, SESSION);
    expect(newSession).not.toBe(oldSession);
    /* 新会话：lock-epoch 写后读（D1 后立即一致；以前在 KV 最长约 60 秒、不同边缘节点各自缓存），轮询到 200 */
    await expect.poll(async () => (await check(newSession)).status(), h.KV_SETTLE).toBe(200);

    const v = await h.api(page, '/api/lock-password', { action: 'verify', password: oldPw });
    expect(v.json.ok).toBe(false);
  });

  test('注册后立刻 rename 成功，list 里名字已更新', async ({ page }) => {
    await h.adminSession(page, test);
    await h.lockReauth(page);
    const va = await h.addVirtualAuth(page, { uv: true });
    try {
      const reg = await h.registerPasskey(page);
      expect(reg.json && reg.json.ok, JSON.stringify(reg.json)).toBe(true);
      const credId = reg.json.credId;
      const newName = 'E2E 立刻改名 ' + Date.now();
      const r = await h.api(page, '/api/lock-passkey', { action: 'rename', credId, name: newName });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.ok).toBe(true);
      /* rename 按 credId 直接读记录，所以「注册后立刻」改名不受索引影响；列表经索引 + 记录读，写后读轮询到新名字 */
      await expect.poll(async () => {
        const item = (await h.listPasskeys(page)).find((k) => k.credId === credId);
        return item && item.name;
      }, h.KV_SETTLE).toBe(newName);
    } finally {
      await h.deleteAllPasskeys(page);
      await va.remove();
    }
  });

  test('lock-credentials.passkey：注册后立即为 true，删光后为 false', async ({ page }) => {
    await h.adminSession(page, test);
    await h.lockReauth(page);
    const va = await h.addVirtualAuth(page, { uv: true });
    try {
      /* lock-credentials：每次写完轮询到新状态（写后读，只读） */
      const creds = async () => {
        const st = await h.apiGet(page, '/api/lock-credentials');
        expect(st.json && st.json.ok, JSON.stringify(st.json)).toBe(true);
        return st.json;
      };
      await h.deleteAllPasskeys(page);
      await expect.poll(async () => (await creds()).passkey, h.KV_SETTLE).toBe(false);

      const reg = await h.registerPasskey(page);
      expect(reg.json && reg.json.ok, JSON.stringify(reg.json)).toBe(true);
      await expect.poll(async () => (await creds()).passkey, h.KV_SETTLE).toBe(true);

      await h.deleteAllPasskeys(page);
      await expect.poll(async () => (await creds()).passkey, h.KV_SETTLE).toBe(false);
      expect((await creds()).password).toBe(true);
    } finally {
      await h.deleteAllPasskeys(page);
      await va.remove();
    }
  });

  test('UV=0 的注册被服务端拒绝（uv-required），列表不变', async ({ page }) => {
    await h.adminSession(page, test);
    await h.lockReauth(page);
    const va = await h.addVirtualAuth(page, { uv: false });
    try {
      const before = (await h.listPasskeys(page)).length;
      const r = await h.registerPasskey(page, { uv: false });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('uv-required');
      expect((await h.listPasskeys(page)).length).toBe(before);
    } finally {
      await va.remove();
    }
  });

  test('重置开关：计时内签一次 LockResetTicket，同一个值第二次不再签', async ({ page }) => {
    h.requireCf(test);
    /* 在 D1 插一行新开关（不在 finally 里删：签过一次就标了已用，永不再生效），见 preview-helpers.cjs resetTicketViaSwitch */
    await h.armResetSwitch();
    let first = null;
    await expect.poll(async () => {
      const r = await h.api(page, '/api/lock-reset', { action: 'verify', rootKey: ROOT_KEY });
      if (r.status === 200 && r.json && r.json.ok && !r.json.needAccount) { first = r; return 'ticket'; }
      return r.status + ' ' + JSON.stringify(r.json);
    }, { timeout: 90000, intervals: [3000, 10000, 15000, 20000] }).toBe('ticket');
    expect(h.setCookieLine(first.resp, 'sgx-lock-reset')).toContain('sgx-lock-reset=');

    /* 已用过：账号已配置 → 200 needAccount；账号未配置 → 401 auth。两种都不签票 */
    const again = await h.api(page, '/api/lock-reset', { action: 'verify', rootKey: ROOT_KEY });
    expect(h.setCookieLine(again.resp, 'sgx-lock-reset')).toBe('');
    if (again.status === 200) expect(again.json.needAccount).toBe(true);
    else expect(again.status).toBe(401);
  });

  test('LockResetTicket：能读锁屏凭证状态，但不是会话', async ({ page }) => {
    /* 预览站不注入页面会话标记（见上），落地页的 data-sgx-lock-session 只能在正式域名上看；这里验票本身的权限边界 */
    await h.lockResetTicket(page, test);
    const st = await h.api(page, '/api/lock-reauth', { action: 'status' });
    expect(st.json && st.json.ok, JSON.stringify(st.json)).toBe(true);
    expect(st.json.valid).toBe(true);
    expect(st.json.ticket).toBe('lock-reset');
    const cred = await h.apiGet(page, '/api/lock-credentials');
    expect(cred.status).toBe(200);
    const sess = await h.apiGet(page, '/api/lock-session-check');
    expect(sess.status).toBe(401);
    /* 重置票不能删锁屏密码（remove 只认 LockReauthTicket + 会话） */
    const rm = await h.api(page, '/api/lock-password', { action: 'remove' });
    expect(rm.status).toBe(401);
  });
});

test.describe('会话安全 e2e（预览站）', () => {
  h.requirePreview(test);

  test('密码解锁的 Set-Cookie：Domain=.styrigx.com、12 小时、六段票值', async ({ page }) => {
    const pw = await h.adminSession(page, test);
    const r = await h.api(page, '/api/lock-password', { action: 'verify', password: pw });
    expect(r.json.ok).toBe(true);
    const sc = h.setCookieLine(r.resp, SESSION);
    expect(sc).toContain('Domain=.styrigx.com');
    expect(sc).toContain('Path=/');
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('Secure');
    expect(sc).toContain('SameSite=Lax');
    expect(sc).toContain('Max-Age=43200');
    /* LockSessionTicket：by.role.epoch.exp.tempkeyId.sig（admin 的 tempkeyId 为空） */
    expect(h.cookieValue(sc).split('.').length).toBe(6);
  });

  test('退出所有设备：纪元 +1，旧会话 cookie 失效', async ({ page, request }) => {
    test.setTimeout(h.KV_TEST_TIMEOUT); /* adminSession 的重置路径仍可能轮询重置开关 */
    const pw = await h.adminSession(page, test);
    let r = await h.api(page, '/api/lock-password', { action: 'verify', password: pw });
    const sc1 = h.setCookieLine(r.resp, SESSION);
    const e0 = h.cookieEpoch(sc1);
    const old = h.cookieValue(sc1);

    await h.lockReauth(page);
    r = await h.api(page, '/api/lock-all-devices', {});
    expect(r.json && r.json.ok, JSON.stringify(r.json)).toBe(true);
    const clear = h.setCookieLine(r.resp, SESSION);
    expect(clear).toContain(SESSION + '=;');
    expect(clear).toContain('Domain=.styrigx.com');
    expect(clear).toContain('Max-Age=0');

    /* lock-epoch 在 D1（强一致）：推进后下一个请求旧会话就必须失效，一次性严格断言
       （在 KV 时要轮询最长约 60 秒，见 2026-10-27 之前的版本） */
    expect((await request.get(BASE + '/api/lock-session-check', { headers: { Cookie: SESSION + '=' + old } })).status()).toBe(401);

    r = await h.api(page, '/api/lock-password', { action: 'verify', password: pw });
    expect(r.json.ok).toBe(true);
    expect(h.cookieEpoch(h.setCookieLine(r.resp, SESSION))).toBe(e0 + 1);
  });
});

/* 放在最后：连错会把本机 IP 锁 15 分钟（码对也 429）。结束后清掉预览 D1 里的单 IP 计数。 */
test.describe('根凭证限速 e2e（预览站）', () => {
  h.requirePreview(test);

  test('root-auth 连错 5 次后 429', async ({ request }) => {
    h.requireCf(test);
    const statuses = [];
    try {
      for (let i = 0; i < 6; i++) {
        const r = await request.post(BASE + '/api/root-auth', {
          headers: { Origin: ORIGIN },
          data: { key: 'wrong-key-' + h.rand(), purpose: 'lock-reset' },
        });
        statuses.push(r.status());
        if (r.status() === 429) break;
      }
      expect(statuses.slice(0, -1).every((s) => s === 401), statuses.join(',')).toBe(true);
      expect(statuses[statuses.length - 1], statuses.join(',')).toBe(429);
    } finally {
      await h.clearRootLimits();
    }
  });
});
