/**
 * 安全页状态卡片文案（锁屏凭证；原 account/dialog-kb.spec.js 的「security status card wording」两条，2026-11-08 按功能拆文件）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');

test.use({ viewport: { width: 412, height: 915 } });

async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

async function mockJson(pg, pattern, status, body) {
  await pg.route(pattern, async (route) => {
    await route.fulfill({ status: status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test.describe('security status card wording (批次 A 验收修复 #8)', () => {
  test('missing unlock password shows 解锁密码 wording (PR2 锁屏凭证门)', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    /* PR2：安全页卡片数据源是 GET /api/lock-credentials（锁屏凭证）；账号凭证在账号页 */
    await mockJson(pg, '**/api/lock-credentials', 200, { ok: true, password: false, passkey: true });
    await pg.goto('/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('#sec-status-title')).toContainText('建议操作', { timeout: 15000 });
    await expect(pg.locator('#sec-status-sub')).toHaveText('未设置解锁密码');
  });

  test('missing passkey copy names lock passkeys（未注册锁屏通行密钥）', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    await mockJson(pg, '**/api/lock-credentials', 200, { ok: true, password: true, passkey: false });
    await pg.goto('/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('#sec-status-title')).toContainText('建议操作', { timeout: 15000 });
    await expect(pg.locator('#sec-status-sub')).toHaveText('未注册锁屏通行密钥');
  });
});
