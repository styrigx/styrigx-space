/**
 * 账号接口的门（预览站：真实网关 + 账号 Worker，组合入口 preview-worker.js）。
 *
 * v6 P4（定稿 v5.3 §十三 P4 行）：锁侧复验（lock-reauth）、旧账号会话（GET /api/account、/api/account/session / keys / reset）随后端删旧删除，
 * 只测这些接口的用例一并删掉；剩下「伪造身份头进不了账号接口」这一条（账号 Worker 只认 v6 会话）。
 * 运行方式同 passkey.spec.js（SGX_TEST_SUITE=passkey）。
 */
const { test, expect } = require('@playwright/test');
const h = require('../helpers/preview-helpers.cjs');

const { BASE, ORIGIN } = h;

test.describe('账号接口的门 e2e（预览站）', () => {
  h.requirePreview(test);

  test('伪造身份头 / 旧会话 cookie：无 v6 会话带 X-Styrigx-Space-Session: 1 仍 401', async ({ request }) => {
    const forged = { Origin: ORIGIN, 'X-Styrigx-Space-Session': '1', 'X-Styrigx-Space-By': 'password', Cookie: 'sgx-account-session=a.b.c' };
    /* 正式域名上网关的门先拒（无会话 /api/* 401）；预览不拦 /api/*，网关剥掉外来的 x-styrigx-* 后转发，账号 Worker 只认 v6 会话，同样 401 */
    for (const path of ['/api/prefs', '/api/account/devices']) {
      const r = path === '/api/prefs'
        ? await request.get(BASE + path, { headers: forged, maxRedirects: 0 })
        : await request.post(BASE + path, { headers: forged, data: { action: 'list' }, maxRedirects: 0 });
      expect(r.status(), path).toBe(401);
    }
  });
});
