/**
 * 站点安全下拉 #sgx-sec（重设计 PR-5 sec-v1；原 topbar/acct-sec-pop.spec.js 盾牌那一组，2026-11-08 按功能拆文件）。
 * 盾牌仍是链接（href / 读屏名不变，修饰键点照旧按链接走），普通点击开下拉；立即锁屏只在 NAVIGATE（Gray 2026-11-08 04:06）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

async function go(page, path, opts = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  /* 中文页：先存语言偏好，免得按浏览器语言跳回英文页（同 topbar-spec.spec.js） */
  if (path.indexOf('/zh/') === 0) await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  if (opts.route) await opts.route(page);
  if (opts.account !== undefined) {
    await page.route('**/api/account**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.account) }));
  }
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}
const settled = (page, id) => page.waitForFunction((i) => document.getElementById(i).getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || (a.effect && a.effect.getTiming().iterations === Infinity)), id);
/* 页面时钟被 freezeTime 冻住：接口替身里的时间按页面的 Date.now() 算 */
const pageNow = (page) => page.evaluate(() => Date.now());

const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

test.describe('站点安全下拉 #sgx-sec（sec-v1，按设计稿）', () => {
  test('有 3 分钟验证票：头部倒计时、通行密钥个数、锁屏钥匙 LockKey、临时钥匙、锁屏会话剩余、锁定所有设备（没有立即锁屏）；和账号下拉互斥', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/');
    const now = await pageNow(page);
    await page.route('**/api/lock-session-check', (r) => r.fulfill(json({ ok: true, exp: now + (11 * 60 + 20) * 60000 + 30000 })));
    await page.route('**/api/lock-reauth', (r) => r.fulfill(json({ ok: true, valid: true, expiresAt: now + 161000 })));
    await page.route('**/api/lock-passkey', (r) => r.fulfill(json({ ok: true, keys: [{ credId: 'a' }, { credId: 'b' }] })));
    await page.locator('.sgx-tb-shield').click();
    const s = page.locator('#sgx-sec');
    await expect(s).toHaveAttribute('data-state', 'open');
    await expect(s).toHaveAttribute('data-sec-state', 'open');
    await expect(s.locator('[data-sec-head]')).toHaveText(/^0[0-2]:\d\d$/);
    await expect(s.locator('[data-sec-v="pk"]')).toHaveText('2 个');
    await expect(s.locator('[data-sec-v="sess"]')).toHaveText(/^剩 11h 2\dm$/);
    expect(await s.locator('[data-sec-open] a.sgx-pop-row').evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
      .toEqual(['/zh/security/lock/', '/zh/security/lock/', '/zh/security/tempkeys/', '/zh/security/', '/zh/security/lock/#lockmgr-sessions']);
    await expect(s).toContainText('LockKey');
    /* 立即锁屏不在盾牌里（Gray 2026-11-08 04:06），只在 NAVIGATE 底部 lock */
    await expect(s.locator('[data-sec="lock"]')).toHaveCount(0);
    await expect(s).not.toContainText('立即锁屏');
    await expect(s.locator('[data-sec-locked]')).toBeHidden();
    await settled(page, 'sgx-sec');
    await page.locator('.sgx-tb-av').click();
    await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
    await expect(s).toBeHidden();
    await expect(page.locator('#sgx-acct[open], #sgx-sec[open], #sgx-qp[open], #sgx-nav[open], #sgx-ai[open]')).toHaveCount(1);
  });

  test('没有验证票：$ SECURITY locked + 终端式「sudo security · [1] passkey [2] lockkey」去锁屏凭证页的门，按 1 也行', async ({ page }) => {
    await go(page, '/zh/wild/');
    await page.route('**/api/lock-reauth', (r) => r.fulfill(json({ ok: true, valid: false })));
    await page.locator('.sgx-tb-shield').click();
    const s = page.locator('#sgx-sec');
    await expect(s).toHaveAttribute('data-sec-state', 'locked');
    await expect(s.locator('[data-sec-head]')).toHaveText('locked');
    await expect(s.locator('[data-sec-locked]')).toContainText('sudo security');
    await expect(s.locator('.sgx-pop-opt[data-key="2"]')).toContainText('lockkey');
    await expect(s.locator('[data-sec-open]')).toBeHidden();
    await settled(page, 'sgx-sec');
    /* Ctrl+C = 返回（同 esc） */
    await page.keyboard.press('Control+c');
    await expect(s).toBeHidden();
    await page.locator('.sgx-tb-shield').click();
    await expect(s).toHaveAttribute('data-sec-state', 'locked');
    await settled(page, 'sgx-sec');
    await page.keyboard.press('1');
    await page.waitForURL(/\/zh\/security\/lock\/$/);
  });

  test('Ctrl 点盾牌不开下拉（照旧按链接走）', async ({ page, context }) => {
    await go(page, '/wild/');
    const pop = context.waitForEvent('page');
    await page.locator('.sgx-tb-shield').click({ modifiers: ['Control'] });
    const np = await pop;
    await np.waitForLoadState('domcontentloaded');
    expect(new URL(np.url()).pathname).toBe('/security/');
    await expect(page.locator('#sgx-sec')).toBeHidden();
  });
});

