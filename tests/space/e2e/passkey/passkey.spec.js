/**
 * 预览站（真实网关 + 账号 Worker，组合入口 preview-worker.js）上的会话边界 E2E。
 *
 * v6 P4（定稿 v5.3 §十三 P4 行）：锁屏凭证（lock-password / lock-passkey / lock-credentials / lock-reauth / lock-reset / space-auth）、
 * 进站会话、退出所有设备（lock-all-devices）随后端删旧删除，只测这些接口的用例一并删掉；剩下这一条只验「旧进站会话 cookie 不算会话」。
 * 通行密钥（WebAuthn）的验证逻辑与依赖方红线在单测里：tests/workers/account/rp.test.mjs、v6-identity-api.test.mjs。
 *
 * 运行：SGX_TEST_SUITE=passkey SGX_TEST_BASE=https://<preview> npx playwright test --config=tests/config/playwright.config.js
 * 本地没配 SGX_TEST_BASE 时跳过；CI（CI=true）里缺了直接失败。
 */
const { SEL, gotoLockTerm, lockCmd } = require('../helpers/lock-term.cjs');
const { test, expect } = require('@playwright/test');
const h = require('../helpers/preview-helpers.cjs');

const { BASE, ORIGIN } = h;

test.describe('会话边界 e2e（预览站）', () => {
  h.requirePreview(test);

  test('旧进站会话 cookie（sgx-space-session=1）不算会话：接口 401，终端仍是访客（nobody）', async ({ page }) => {
    /* 预览站 SGX_ENV=preview：网关不拦页面、不注入会话标记（只有正式域名才拦），这里只验接口和前端终端身份 */
    await page.context().addCookies([
      { name: 'sgx-space-session', value: '1', url: ORIGIN + '/', httpOnly: true, secure: ORIGIN.startsWith('https:'), sameSite: 'Lax' },
    ]);
    const pr = await h.apiGet(page, '/api/prefs');
    expect(pr.status).toBe(401);
    await gotoLockTerm(page, BASE + '/wild/?entry=1&test-no-local-bypass=1');
    await expect(page.locator(SEL.ps)).toHaveText('nobody@space:~/wild$');
    await lockCmd(page, 'lock');
    await expect(page.locator(SEL.out)).toContainText('not signed in · su <user> first', { timeout: 15000 });
  });
});
