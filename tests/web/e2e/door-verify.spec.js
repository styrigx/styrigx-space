/**
 * 锁屏凭证的门 E2E（静态构建 + API mock，无需真实后端）。
 *
 * stepup / 管理凭证 / 应用凭证已删除：安全与隐私只留「锁屏凭证」一个入口，门在锁屏凭证页本身——
 * 每次进页验一次锁屏凭证（锁屏通行密钥 / 解锁密码，设了哪个显示哪个）或根凭证（一直在），
 * 换 3 分钟锁屏门票（POST /api/lock-door status 读状态；owner-password verify / owner-passkey auth 带 door:true、
 * root-auth 签票），页内倒计时；离开本页 → POST /api/lock-door clear。
 *
 * 覆盖：
 * - 安全与隐私：锁屏凭证行链到锁屏凭证页，没有「管理凭证」
 * - 门口按已设置的锁屏凭证显示入口；都没设只显示根凭证
 * - 解锁密码 / 根凭证进门 → 门内 + 倒计时；密码错误留在门口
 * - 离开本页发 clear；门内操作返回 403 door → 到期框「重新验证」→ 回到门口
 * - A-1：连续 10 次进门都成功、无 JS 错误
 * - A-3：验证行样式（圆角 16px 等）保持（账号登录与锁屏凭证的门共用同一套）
 *
 * 运行：npx playwright test --config=tests/config/playwright.config.js door-verify.spec.js
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

/** @param {import('@playwright/test').Page} page */
async function mockJson(page, pattern, status, body) {
  await page.route(pattern, async (route) => {
    await route.fulfill({ status: status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

/**
 * /api/lock-door + 三个进门接口的有状态 mock。
 * @param {import('@playwright/test').Page} page
 * @param {{password?:boolean, passkey?:boolean, valid?:boolean, lockPw?:string}} [opts]
 */
async function mockLockDoor(page, opts) {
  const o = Object.assign({ password: true, passkey: false, valid: false, lockPw: 'lock-pw-1' }, opts || {});
  const st = { valid: !!o.valid, clears: 0, statuses: 0, verifies: [], roots: 0 };
  await page.route('**/api/lock-door', async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    if (body.action === 'clear') {
      st.clears++;
      st.valid = false;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    st.statuses++;
    const j = { ok: true, valid: st.valid, password: o.password, passkey: o.passkey };
    if (st.valid) {
      j.door = 'lock';
      j.expiresAt = Date.now() + 175000;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
  });
  await page.route('**/api/owner-password', async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    if (body.action === 'verify') {
      st.verifies.push(body);
      if (body.door === true && body.password === o.lockPw) {
        st.valid = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      } else {
        await route.fulfill({ status: 403, contentType: 'application/json', body: '{"ok":false,"error":"wrong"}' });
      }
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/root-auth', async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    st.roots++;
    if (body.key === 'root-key-1' && !body.target) {
      st.valid = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    } else {
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"auth"}' });
    }
  });
  return st;
}

async function setup(page) {
  await blockExternalRequests(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  await mockJson(page, '**/api/lock-status', 200, { ok: true, password: true, passkey: false });
  await mockJson(page, '**/api/lock-config', 200, { ok: true, password: true, passkey: false });
  await mockJson(page, '**/api/account', 200, { ok: true, password: true, passkey: true, ready: true, session: null });
  await mockJson(page, '**/api/owner-passkey', 200, { ok: true, keys: [], door: 'lock' });
}

const LOCK_URL = '/settings/security/lock/';

test.describe('安全与隐私：只剩锁屏凭证入口', () => {
  test.beforeEach(async ({ page }) => { await setup(page); });

  test('锁屏凭证行链到锁屏凭证页；没有管理凭证 / 应用', async ({ page }) => {
    await mockLockDoor(page);
    await page.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    const row = page.locator('#sec-lock-cred');
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toContainText('锁屏凭证');
    await expect(page.locator('#sec-mgmt-cred')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('管理凭证');
    await expect(page.locator('#sec-lock-sub')).toHaveText('密码');
    await expect(row).toHaveAttribute('href', LOCK_URL);
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lock-door')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('锁屏凭证的门', () => {
  test.beforeEach(async ({ page }) => { await setup(page); });

  test('只设了解锁密码：门口显示解锁密码 + 根凭证；门内区不渲染', async ({ page }) => {
    await mockLockDoor(page, { password: true, passkey: false });
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lock-door')).toBeVisible({ timeout: 15000 });
    const rows = page.locator('#lock-door-methods .sgx-door-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('解锁密码');
    await expect(rows.nth(1)).toContainText('根凭证');
    await expect(page.locator('#lockmgr')).toBeHidden();
    await expect(page.locator('#sgx-door-countdown')).toHaveCount(0);
  });

  test('锁屏凭证都没设：只显示根凭证', async ({ page }) => {
    await mockLockDoor(page, { password: false, passkey: false });
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    const rows = page.locator('#lock-door-methods .sgx-door-row');
    await expect(rows).toHaveCount(1, { timeout: 15000 });
    await expect(rows.first()).toContainText('根凭证');
  });

  test('解锁密码进门（door:true）→ 门内 + 倒计时；错误密码留在门口', async ({ page }) => {
    const st = await mockLockDoor(page);
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#lock-door-methods .sgx-door-row').filter({ hasText: '解锁密码' }).click();
    const input = page.locator('#lock-door-methods .sgx-door-expand input[type="password"]');
    await input.fill('nope-nope');
    await page.locator('#lock-door-methods .sgx-door-btn-primary').click();
    await expect(page.locator('#lock-door-methods .sgx-door-expand .sgx-door-err')).toHaveText('密码错误');
    await expect(page.locator('#lockmgr')).toBeHidden();
    await input.fill('lock-pw-1');
    await page.locator('#lock-door-methods .sgx-door-btn-primary').click();
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#lock-door')).toBeHidden();
    await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#lockmgr-sessions')).toBeVisible();
    expect(st.verifies.every((b) => b.door === true)).toBe(true);
  });

  test('根凭证进门：/api/root-auth { key }（不带 target）→ 门内', async ({ page }) => {
    const st = await mockLockDoor(page);
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#lock-door-methods .sgx-door-row').filter({ hasText: '根凭证' }).click();
    await page.locator('#lock-door-methods .sgx-door-expand input[type="password"]').fill('root-key-1');
    await page.locator('#lock-door-methods .sgx-door-btn-primary').click();
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 10000 });
    expect(st.roots).toBe(1);
  });

  test('离开本页 → POST /api/lock-door clear；再进要重新验证', async ({ page }) => {
    const st = await mockLockDoor(page, { valid: true });
    /* keepalive 请求在页面卸载时发出，route 拦不稳；在 context 上听请求体 */
    const sent = [];
    page.context().on('request', (r) => {
      if (r.url().endsWith('/api/lock-door') && r.method() === 'POST') sent.push(r.postData() || '');
    });
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    /* 真实导航时的 keepalive 请求 Playwright 不一定看得到；直接派发 pagehide 验证监听器发出了 clear */
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await expect.poll(() => sent.filter((b) => b.includes('"clear"')).length, { timeout: 5000 }).toBeGreaterThan(0);
    await expect.poll(() => st.clears, { timeout: 5000 }).toBeGreaterThan(0);
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lock-door')).toBeVisible({ timeout: 15000 });
  });

  test('门内操作返回 403 door → 到期框「重新验证」→ 回到门口', async ({ page }) => {
    await mockLockDoor(page, { valid: true });
    await page.unroute('**/api/owner-passkey');
    await mockJson(page, '**/api/owner-passkey', 403, { ok: false, error: 'door', reason: 'expired' });
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    const btn = page.getByRole('button', { name: '重新验证' });
    await expect(btn).toBeVisible({ timeout: 15000 });
    await btn.click();
    await page.waitForURL('**' + LOCK_URL, { timeout: 10000 });
    await expect(page.locator('#lock-door')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('A-1 进门不能马上被判过期（10 次连续进门）', () => {
  test('解锁密码进门：连续 10 次都成功、倒计时出现、无 JS 错误', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    await setup(page);
    const st = await mockLockDoor(page);
    for (let i = 0; i < 10; i++) {
      /* 离开本页的 clear 是 keepalive，mock 不一定收得到：每轮从门外开始 */
      st.valid = false;
      await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('#lock-door-methods .sgx-door-row').filter({ hasText: '解锁密码' }).click();
      await page.locator('#lock-door-methods .sgx-door-expand input[type="password"]').fill('lock-pw-1');
      await page.locator('#lock-door-methods .sgx-door-btn-primary').click();
      await expect(page.locator('#sgx-door-countdown')).toBeVisible({ timeout: 15000 });
    }
    expect(pageErrors).toEqual([]);
  });
});

test.describe('A-3 验证行样式', () => {
  test.beforeEach(async ({ page }) => {
    /* PR3：账号登录页改成按钮，验证行样式改在锁屏凭证的门口量（解锁密码 + 根凭证两行） */
    await setup(page);
    await mockLockDoor(page);
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lock-door-methods .sgx-door-row')).toHaveCount(2, { timeout: 15000 });
  });

  test('选择框：圆角 16px、静止底色不透明、行间距 12px、无分隔线、按下态比静止态深', async ({ page }) => {
    const rows = page.locator('#lock-door-methods .sgx-door-row');
    const row = rows.first();
    expect(await row.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('16px');
    const pad = await row.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { top: cs.paddingTop, left: cs.paddingLeft };
    });
    expect(pad.top).toBe('12px');
    expect(pad.left).toBe('16px');
    expect(await row.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe('0px');
    const gap = await page.locator('#lock-door-methods').evaluate((el) => getComputedStyle(el).rowGap);
    expect(gap).toBe('12px');
    const bg = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    const gapPx = await rows.evaluateAll((els) => {
      const [r0, r1] = /** @type {HTMLElement[]} */ (els);
      if (r0.offsetParent !== r1.offsetParent) return -1;
      return r1.offsetTop - (r0.offsetTop + r0.offsetHeight);
    });
    expect(gapPx).toBe(12);
    await row.evaluate((el) => el.classList.add('sgx-row-pressed'));
    const pressed = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(pressed).not.toBe(bg);
  });
});
