/**
 * 锁屏凭证的门 / 账号登录 challenge 的用途隔离（预览站真实网关）。
 *
 * 完整逻辑由 tests/workers/auth-gateway/lock-reauth.test.mjs、account.test.mjs 覆盖；这里只验真实部署上的边界：
 * - 无会话 lock-reauth status → 401
 * - 锁屏通行密钥的 challenge 不能拿去做账号登录（403 challenge，用途隔离）
 * - 账号登录 challenge 单次使用，重放被拒（403 challenge）
 *
 * 账号相关两条要求预览站配了账号签名钥匙（CI 每次生成一对测试钥匙）；第三条另要预览上已有账号通行密钥，
 * 没有就用 AccountResetTicket 临时注册一把，测完删掉。
 * 会话 / 票据 helper 见 preview-helpers.cjs；运行方式同 passkey.spec.js（SGX_TEST_SUITE=passkey）。
 */
const { test, expect } = require('@playwright/test');
const h = require('./preview-helpers.cjs');

const { BASE, ORIGIN, ROOT_KEY } = h;

test.describe('锁屏门 / 账号 challenge e2e（预览站）', () => {
  h.requirePreview(test);

  test('无会话 lock-reauth status → 401', async ({ request }) => {
    const r = await request.post(BASE + '/api/lock-reauth', { headers: { Origin: ORIGIN }, data: { action: 'status' } });
    expect(r.status()).toBe(401);
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
        const x = await h.api(page, '/api/root-auth', { key: ROOT_KEY, purpose: 'account-reset' });
        expect(x.json && x.json.ok, 'root-auth account-reset: ' + JSON.stringify(x.json)).toBe(true);
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
        /* 第一次配置账号层会推进锁屏纪元：会话已按新纪元写回 context */
        chal = await h.api(page, '/api/account', { action: 'login-challenge' });
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
          await h.api(page, '/api/root-auth', { key: ROOT_KEY, purpose: 'account-reset' });
          d = await h.api(page, '/api/account', { action: 'passkey-delete', credId: tempCredId });
        }
      }
      await va.remove();
    }
  });
});
