/**
 * 锁屏凭证的门 / 账号登录 challenge 的用途隔离（预览站：真实网关 + 账号 Worker，组合入口 preview-worker.js）。
 *
 * 完整逻辑由 tests/workers/auth-gateway/lock-reauth.test.mjs、tests/workers/account/ 覆盖；这里只验真实部署上的边界：
 * - 无会话 lock-reauth status → 401
 * - 锁屏通行密钥的 challenge 不能拿去做账号登录（403 challenge，用途隔离）
 * - 账号登录 challenge 单次使用，重放被拒（403 challenge）
 * - /api/account 经网关转发到账号 Worker（响应带 X-SGX-Runtime: account）；伪造的身份头进不了账号接口
 *
 * 账号相关两条要求预览站配了账号签名钥匙（CI 每次生成一对测试钥匙）；第三条另要预览上已有账号通行密钥，
 * 没有就用账号根密钥（POST /api/account { action:'root-reset' }，账号拆分 PR3 起不再走 /api/root-auth）签 AccountResetTicket
 * 临时注册一把，测完删掉。
 * 会话 / 票据 helper 见 preview-helpers.cjs；运行方式同 passkey.spec.js（SGX_TEST_SUITE=passkey）。
 */
const { test, expect } = require('@playwright/test');
const h = require('./preview-helpers.cjs');

const { BASE, ORIGIN, ACCOUNT_ROOT_KEY } = h;

test.describe('锁屏门 / 账号 challenge e2e（预览站）', () => {
  h.requirePreview(test);
  /* 注册 / 删除推进纪元，写后读的等待最长 75 秒（preview-helpers.cjs 文件头「写后读」） */
  test.describe.configure({ timeout: h.KV_TEST_TIMEOUT });

  test('无会话 lock-reauth status → 401', async ({ request }) => {
    const r = await request.post(BASE + '/api/lock-reauth', { headers: { Origin: ORIGIN }, data: { action: 'status' } });
    expect(r.status()).toBe(401);
  });

  test('伪造身份头：无会话带 X-Styrigx-Lock-Role: admin 仍 401', async ({ request }) => {
    const forged = { Origin: ORIGIN, 'X-Styrigx-Lock-Role': 'admin', 'X-Styrigx-Lock-By': 'password' };
    /* 正式域名上网关的门先拒（无会话 /api/* 401）；预览不拦 /api/*，网关剥掉外来的 x-styrigx-* 后转发，
       账号 Worker 看不到身份头同样 401（没剥掉的话 GET /api/account 会以 admin 身份回 200） */
    for (const path of ['/api/account', '/api/prefs']) {
      const r = await request.get(BASE + path, { headers: forged, maxRedirects: 0 });
      expect(r.status(), path).toBe(401);
    }
  });

  test('有 admin 会话：/api/account 经网关转发，响应来自账号 Worker', async ({ page }) => {
    await h.adminSession(page, test);
    const r = await h.apiGet(page, '/api/account');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json && r.json.ok, JSON.stringify(r.json)).toBe(true);
    expect(r.resp.headers()['x-sgx-runtime']).toBe('account');
  });

  test('锁屏通行密钥的 challenge 不能用于账号登录 login-passkey', async ({ page }) => {
    await h.adminSession(page, test);
    await h.lockReauth(page);
    const va = await h.addVirtualAuth(page, { uv: true });
    try {
      const reg = await h.registerPasskey(page, { name: 'E2E-purpose' });
      expect(reg.json && reg.json.ok, JSON.stringify(reg.json)).toBe(true);
      const chal = await h.api(page, '/api/lock-passkey', { action: 'challenge', type: 'auth' });
      expect(chal.json && chal.json.ok, JSON.stringify(chal.json)).toBe(true);
      const r = await h.api(page, '/api/account', { action: 'login-passkey', cid: chal.json.cid, credential: { rawId: 'x' } });
      expect(r.json && r.json.error, '预览站要配账号签名钥匙: ' + JSON.stringify(r.json)).not.toBe('config');
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('challenge');
    } finally {
      await h.deleteAllPasskeys(page);
      await va.remove();
    }
  });

  test('账号登录 challenge 单次使用，重放被拒', async ({ page }) => {
    await h.adminSession(page, test);
    const va = await h.addVirtualAuth(page, { uv: true });
    let tempCredId = '';
    try {
      let chal = await h.api(page, '/api/account', { action: 'login-challenge' });
      expect(chal.json && chal.json.error, '预览站要配账号签名钥匙: ' + JSON.stringify(chal.json)).not.toBe('config');
      if (!chal.json.ok && chal.json.error === 'not-set') {
        /* 预览上还没有账号通行密钥：凭 AccountResetTicket 临时注册一把 */
        const x = await h.api(page, '/api/account', { action: 'root-reset', key: ACCOUNT_ROOT_KEY });
        expect(x.json && x.json.ok, 'account root-reset: ' + JSON.stringify(x.json)).toBe(true);
        const ch = await h.api(page, '/api/account', { action: 'passkey-register-challenge' });
        expect(ch.json && ch.json.ok, JSON.stringify(ch.json)).toBe(true);
        await h.onOrigin(page);
        const credential = await page.evaluate(async (ch) => {
          const dec = (s) => {
            const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
            const u = new Uint8Array(b.length);
            for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
            return u.buffer;
          };
          const enc = (buf) => {
            const u = new Uint8Array(buf);
            let s = '';
            for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
            return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          };
          const c = /** @type {any} */ (await navigator.credentials.create({
            publicKey: {
              challenge: dec(ch.challenge),
              rp: { id: ch.rpId, name: (ch.rp && ch.rp.name) || 'Styrigx' },
              user: { id: dec(ch.user.id), name: ch.user.name, displayName: ch.user.displayName },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
              authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required' },
              attestation: 'none',
              timeout: 20000,
            },
          }));
          return {
            id: c.id,
            rawId: enc(c.rawId),
            type: c.type,
            response: { clientDataJSON: enc(c.response.clientDataJSON), attestationObject: enc(c.response.attestationObject) },
          };
        }, ch.json);
        const reg = await h.api(page, '/api/account', { action: 'passkey-register', cid: ch.json.cid, credential, name: 'E2E-account' });
        expect(reg.json && reg.json.ok, JSON.stringify(reg.json)).toBe(true);
        tempCredId = reg.json.credId;
        /* login-challenge 要数账号通行密钥（账号 Worker 的 D1_ACCOUNT_AUTH，强一致）：仍按写后读轮询，not-set 时再问（not-set 不写库） */
        await expect.poll(async () => {
          chal = await h.api(page, '/api/account', { action: 'login-challenge' });
          return chal.json && chal.json.ok ? 'ok' : JSON.stringify(chal.json);
        }, h.KV_SETTLE).toBe('ok');
      }
      expect(chal.json && chal.json.ok, JSON.stringify(chal.json)).toBe(true);
      let r = await h.api(page, '/api/account', { action: 'login-passkey', cid: chal.json.cid, credential: { rawId: 'nope' } });
      expect(r.status).toBe(403);
      r = await h.api(page, '/api/account', { action: 'login-passkey', cid: chal.json.cid, credential: { rawId: 'nope' } });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('challenge');
    } finally {
      if (tempCredId) {
        /* AccountResetTicket 3 分钟内还有效；过期就重新签一张再删 */
        let d = await h.api(page, '/api/account', { action: 'passkey-delete', credId: tempCredId });
        if (!(d.json && d.json.ok)) {
          await h.adminSession(page, test);
          await h.api(page, '/api/account', { action: 'root-reset', key: ACCOUNT_ROOT_KEY });
          d = await h.api(page, '/api/account', { action: 'passkey-delete', credId: tempCredId });
        }
      }
      await va.remove();
    }
  });
});
