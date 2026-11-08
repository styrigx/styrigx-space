/**
 * 重设计 PR-5（2026-11-08）：账号下拉 #sgx-acct（acct-v2）、站点安全下拉 #sgx-sec（sec-v1）、AI 窗口头部 ×（ai-v1）。
 * 只换外观：盾牌 / 头像仍是链接（href / 读屏名不变，修饰键点照旧按链接走），普通点击开下拉；下拉里是去账号 / 安全各页的入口，
 * 立即锁屏沿用 NAVIGATE lock 同一动作。登录态按 GET /api/account（ok + session / session=null；问不到不写）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

async function go(page, path, opts = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  /* 中文页：先存语言偏好，免得按浏览器语言跳回英文页（同 topbar-spec.spec.js） */
  if (path.indexOf('/zh/') === 0) await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  if (opts.account !== undefined) {
    await page.route('**/api/account', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.account) }));
  }
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}
const settled = (page, id) => page.waitForFunction((i) => document.getElementById(i).getAnimations({ subtree: true }).every((a) => a.playState !== 'running'), id);

test.describe('账号下拉 #sgx-acct（acct-v2）', () => {
  test('点头像开下拉（非模态、aria-expanded），六行去账号各子页、编辑去个人资料、账号总览；Esc 关、焦点回头像', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/theme/');
    const av = page.locator('.sgx-tb-av');
    await expect(av).toHaveAttribute('href', '/zh/account/');
    await expect(av).toHaveAccessibleName('账号');
    await av.click();
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-state', 'open');
    expect(await d.evaluate((el) => el.open && !el.matches(':modal'))).toBe(true);
    await expect(av).toHaveAttribute('aria-expanded', 'true');
    await expect(page).toHaveURL(/\/zh\/theme\/$/);
    expect(await d.locator('.sgx-pop-list a.sgx-pop-row').evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
      .toEqual(['/zh/account/profile/', '/zh/account/devices/', '/zh/account/security/', '/zh/account/apps/', '/zh/account/sync/', '/zh/account/']);
    await expect(d.locator('.sgx-pop-edit')).toHaveAttribute('href', '/zh/account/profile/');
    await expect(d.locator('[data-acct-name]')).toHaveText('Sloan Gray');
    /* 行高 ≥ 44（触控） */
    const hs = await d.locator('.sgx-pop-row').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    for (const h of hs) expect(h).toBeGreaterThanOrEqual(44);
    await settled(page, 'sgx-acct');
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await expect(av).toHaveAttribute('aria-expanded', 'false');
    await expect(av).toBeFocused();
  });

  test('有账号会话：头部「✓ 已登录」，列表在；没有账号会话：「账号未登录」+ 终端式登录入口（去账号页），列表收起', async ({ page }) => {
    await go(page, '/zh/theme/', { account: { ok: true, session: { id: 'x' } } });
    await page.locator('.sgx-tb-av').click();
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-acct-state', 'in');
    await expect(d.locator('[data-acct-in]')).toBeVisible();
    await expect(d.locator('[data-acct-login]')).toBeHidden();
    await expect(d.locator('.sgx-pop-list')).toBeVisible();

    const p2 = await page.context().newPage();
    await go(p2, '/zh/theme/', { account: { ok: true, session: null } });
    await p2.locator('.sgx-tb-av').click();
    const g = p2.locator('#sgx-acct');
    await expect(g).toHaveAttribute('data-acct-state', 'guest');
    await expect(g.locator('[data-acct-guest]')).toBeVisible();
    await expect(g.locator('[data-acct-login]')).toBeVisible();
    await expect(g.locator('.sgx-pop-go')).toHaveAttribute('href', '/zh/account/');
    await expect(g.locator('.sgx-pop-list')).toBeHidden();
    await g.locator('.sgx-pop-go').click();
    await p2.waitForURL(/\/zh\/account\/$/);
  });

  test('接口不通：不写登录态，列表照常', async ({ page }) => {
    await page.route('**/api/account', (r) => r.fulfill({ status: 503, body: 'x' }));
    await go(page, '/theme/');
    await page.locator('.sgx-tb-av').click();
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-state', 'open');
    await expect(d).toHaveAttribute('data-acct-state', '');
    await expect(d.locator('[data-acct-in]')).toBeHidden();
    await expect(d.locator('.sgx-pop-list')).toBeVisible();
  });

  test('本机缓存 sgx-profile 改过的姓名 / 昵称盖住默认值', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-profile', JSON.stringify({ v: 1, p: { name: 'Test Name', nickname: 'tnick' }, t: 1 })); } catch (e) {} });
    await go(page, '/theme/');
    await page.locator('.sgx-tb-av').click();
    await expect(page.locator('#sgx-acct [data-acct-name]')).toHaveText('Test Name');
    await expect(page.locator('#sgx-acct [data-acct-nick]')).toHaveText('tnick');
  });

  test('下拉里的链接：先关下拉再跳（不留历史哨兵）', async ({ page }) => {
    await go(page, '/zh/theme/');
    await page.locator('.sgx-tb-av').click();
    await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
    await page.locator('#sgx-acct a.sgx-pop-row[href="/zh/account/devices/"]').click();
    await page.waitForURL(/\/zh\/account\/devices\/$/);
  });
});

test.describe('站点安全下拉 #sgx-sec（sec-v1）', () => {
  test('点盾牌开下拉：锁屏钥匙（passkey · LockKey）、临时钥匙、站点安全、立即锁屏、锁定所有设备都在；和账号下拉互斥', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/theme/');
    await page.locator('.sgx-tb-shield').click();
    const s = page.locator('#sgx-sec');
    await expect(s).toHaveAttribute('data-state', 'open');
    expect(await s.locator('a.sgx-pop-row').evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
      .toEqual(['/zh/security/lock/', '/zh/security/tempkeys/', '/zh/security/', '/zh/security/lock/#lockmgr-sessions']);
    await expect(s).toContainText('LockKey');
    await expect(s.locator('[data-sec="lock"]')).toContainText('立即锁屏');
    await settled(page, 'sgx-sec');
    /* 互斥：开着安全下拉点头像 → 安全下拉关、账号下拉开 */
    await page.locator('.sgx-tb-av').click();
    await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
    await expect(s).toBeHidden();
    await expect(page.locator('#sgx-acct[open], #sgx-sec[open], #sgx-qp[open], #sgx-nav[open], #sgx-ai[open]')).toHaveCount(1);
  });

  test('Ctrl 点盾牌不开下拉（照旧按链接走）', async ({ page, context }) => {
    await go(page, '/theme/');
    const pop = context.waitForEvent('page');
    await page.locator('.sgx-tb-shield').click({ modifiers: ['Control'] });
    const np = await pop;
    await np.waitForLoadState('domcontentloaded');
    expect(new URL(np.url()).pathname).toBe('/security/');
    await expect(page.locator('#sgx-sec')).toBeHidden();
  });
});

test.describe('AI 窗口头部 ×（ai-v1）', () => {
  test('× 关窗，焦点回 AI 浮钮；新对话 / 历史 / 头像仍在头部', async ({ page }) => {
    await go(page, '/theme/');
    await page.locator('.sgx-tb-ai').click();
    const ai = page.locator('#sgx-ai');
    await expect(ai).toHaveAttribute('data-state', 'open');
    await expect(ai.locator('.sgx-ai-head [data-ai-clear]')).toBeVisible();
    await expect(ai.locator('.sgx-ai-head [data-ai-history]')).toBeVisible();
    await expect(ai.locator('.sgx-ai-head .sgx-ai-me')).toBeVisible();
    await settled(page, 'sgx-ai');
    await ai.locator('[data-ai-close]').click();
    await expect(ai).toBeHidden();
    await expect(page.locator('.sgx-tb-ai')).toBeFocused();
  });
});
