/**
 * 锁屏凭证的门 E2E（静态构建 + API mock，无需真实后端）。
 *
 * stepup / 管理凭证 / 应用凭证已删除：安全与隐私只留「锁屏凭证」一个入口，门在锁屏凭证页本身——
 * 每次进页验一次锁屏凭证（锁屏通行密钥 / 解锁密码，设了哪个显示哪个）或根凭证（一直在），
 * 换 3 分钟LockReauthTicket（POST /api/lock-reauth status 读状态；lock-password verify / lock-passkey auth 带 reauth:true、
 * root-auth purpose:'lock-reauth' 签票），页内倒计时；剩余时间内刷新 / 离开再回来不用重新验证（2026-10-24）。
 *
 * 覆盖：
 * - 安全与隐私：锁屏凭证行链到锁屏凭证页，没有「管理凭证」
 * - 门口按已设置的锁屏凭证显示入口；都没设只显示根凭证
 * - 解锁密码 / 根凭证进门 → 门内 + 倒计时；密码错误留在门口
 * - 验证后刷新reauth 票仍在（倒计时按服务端剩余时间），到期回门口；管理区操作返回 403 reauth → 到期框「重新验证」→ 回到门口
 * - 通行密钥列表加载中显示占位，不出现空列表
 * - A-1：连续 10 次进门都成功、无 JS 错误
 * - A-3：验证行样式（圆角 16px 等）保持（账号登录与锁屏凭证的门共用同一套）
 *
 * 运行：npx playwright test --config=tests/config/playwright.config.js reauth-verify.spec.js
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
 * /api/lock-reauth + 三个进门接口的有状态 mock。
 * @param {import('@playwright/test').Page} page
 * @param {{password?:boolean, passkey?:boolean, valid?:boolean, lockPw?:string}} [opts]
 */
async function mockLockDoor(page, opts) {
  const o = Object.assign({ password: true, passkey: false, valid: false, lockPw: 'lock-pw-1' }, opts || {});
  const st = { valid: !!o.valid, clears: 0, statuses: 0, verifies: [], roots: 0 };
  await page.route('**/api/lock-reauth', async (route) => {
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
      j.ticket = 'lock-reauth';
      j.expiresAt = Date.now() + 175000;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
  });
  await page.route('**/api/lock-password', async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    if (body.action === 'verify') {
      st.verifies.push(body);
      if (body.reauth === true && body.password === o.lockPw) {
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
    if (body.key === 'root-key-1' && body.purpose === 'lock-reauth') {
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
  await mockJson(page, '**/api/lock-credentials', 200, { ok: true, password: true, passkey: false });
  await mockJson(page, '**/api/lock-entry', 200, { ok: true, password: true, passkey: false });
  await mockJson(page, '**/api/account', 200, { ok: true, password: true, passkey: true, ready: true, session: null });
  await mockJson(page, '**/api/lock-passkey', 200, { ok: true, keys: [] });
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
    await expect(page.locator('#lock-reauth')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('锁屏凭证的门', () => {
  test.beforeEach(async ({ page }) => { await setup(page); });

  test('只设了解锁密码：门口显示解锁密码 + 根凭证；门内区不渲染', async ({ page }) => {
    await mockLockDoor(page, { password: true, passkey: false });
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lock-reauth')).toBeVisible({ timeout: 15000 });
    const rows = page.locator('#lock-reauth-methods .sgx-credential-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('解锁密码');
    await expect(rows.nth(1)).toContainText('根凭证');
    await expect(page.locator('#lockmgr')).toBeHidden();
    await expect(page.locator('#sgx-credential-countdown')).toHaveCount(0);
  });

  test('锁屏凭证都没设：只显示根凭证', async ({ page }) => {
    await mockLockDoor(page, { password: false, passkey: false });
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    const rows = page.locator('#lock-reauth-methods .sgx-credential-row');
    await expect(rows).toHaveCount(1, { timeout: 15000 });
    await expect(rows.first()).toContainText('根凭证');
  });

  test('解锁密码再验证（reauth:true）→ 门内 + 倒计时；错误密码留在门口', async ({ page }) => {
    const st = await mockLockDoor(page);
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#lock-reauth-methods .sgx-credential-row').filter({ hasText: '解锁密码' }).click();
    const input = page.locator('#lock-reauth-methods .sgx-credential-expand input[type="password"]');
    await input.fill('nope-nope');
    await page.locator('#lock-reauth-methods .sgx-credential-btn-primary').click();
    await expect(page.locator('#lock-reauth-methods .sgx-credential-expand .sgx-credential-err')).toHaveText('密码错误');
    await expect(page.locator('#lockmgr')).toBeHidden();
    await input.fill('lock-pw-1');
    await page.locator('#lock-reauth-methods .sgx-credential-btn-primary').click();
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#lock-reauth')).toBeHidden();
    await expect(page.locator('#sgx-credential-countdown')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#lockmgr-sessions')).toBeVisible();
    expect(st.verifies.every((b) => b.reauth === true)).toBe(true);
  });

  test('根凭证进门：/api/root-auth { key }（不带 target）→ 门内', async ({ page }) => {
    const st = await mockLockDoor(page);
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#lock-reauth-methods .sgx-credential-row').filter({ hasText: '根凭证' }).click();
    await page.locator('#lock-reauth-methods .sgx-credential-expand input[type="password"]').fill('root-key-1');
    await page.locator('#lock-reauth-methods .sgx-credential-btn-primary').click();
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 10000 });
    expect(st.roots).toBe(1);
  });

  test('2026-10-24 验证后刷新：reauth 票还在（不再 pagehide 就 clear），仍在门内，倒计时按服务端剩余时间接着走；到期后刷新 → 门口', async ({ page }) => {
    const st = await mockLockDoor(page);
    /* mock 的reauth 票记住签发时刻：status 返回真实剩余时间（验证时刻 + 3 分钟） */
    let issuedAt = 0;
    await page.unroute('**/api/lock-reauth');
    await page.route('**/api/lock-reauth', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (body.action === 'clear') { st.clears++; st.valid = false; await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); return; }
      if (st.valid && !issuedAt) issuedAt = Date.now();
      const exp = issuedAt + 180000 - (st.skew || 0);
      const valid = st.valid && Date.now() < exp;
      const j = { ok: true, valid, password: true, passkey: false };
      if (valid) { j.ticket = 'lock-reauth'; j.expiresAt = exp; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
    });
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#lock-reauth-methods .sgx-credential-row').filter({ hasText: '解锁密码' }).click();
    await page.locator('#lock-reauth-methods .sgx-credential-expand input[type="password"]').fill('lock-pw-1');
    await page.locator('#lock-reauth-methods .sgx-credential-btn-primary').click();
    await expect(page.locator('#sgx-credential-countdown')).toBeVisible({ timeout: 15000 });
    /* 模拟已经过去 60 秒，再刷新 */
    st.skew = 60000;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#lock-reauth')).toBeHidden();
    await expect(page.locator('#sgx-credential-countdown')).toContainText(/2:0\d|1:5\d/);
    expect(st.clears).toBe(0);
    /* reauth 票到期（服务端说 invalid）→ 刷新回门口重新验证 */
    st.skew = 181000;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lock-reauth')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#lockmgr')).toBeHidden();
  });

  test('2026-10-24 进门后通行密钥列表回来之前显示「正在加载」，不出现只有「添加通行密钥」的空列表', async ({ page }) => {
    await mockLockDoor(page, { valid: true });
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.unroute('**/api/lock-passkey');
    await page.route('**/api/lock-passkey', async (route) => {
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, keys: [{ credId: 'c1', name: 'Galaxy S26', provider: 'Samsung Pass', class: 'lock', createdAt: 1760000000000, lastUsedAt: 0 }] }) });
    });
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lockmgr')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#lockmgr-pkloading')).toBeVisible();
    await expect(page.locator('#lockmgr-pkadd')).toBeHidden();
    await expect(page.locator('#lockmgr-pkempty')).toBeHidden();
    release();
    await expect(page.locator('.lockmgr-pkitem')).toHaveCount(1);
    await expect(page.locator('.lockmgr-pkitem')).toContainText('Samsung Pass');
    await expect(page.locator('#lockmgr-pkloading')).toHaveCount(0);
    await expect(page.locator('#lockmgr-pkadd')).toBeVisible();
  });

  test('管理区操作返回 403 reauth → 到期框「重新验证」→ 回到门口', async ({ page }) => {
    await mockLockDoor(page, { valid: true });
    await page.unroute('**/api/lock-passkey');
    await mockJson(page, '**/api/lock-passkey', 403, { ok: false, error: 'reauth', reason: 'expired' });
    await page.goto(LOCK_URL, { waitUntil: 'domcontentloaded' });
    const btn = page.getByRole('button', { name: '重新验证' });
    await expect(btn).toBeVisible({ timeout: 15000 });
    await btn.click();
    await page.waitForURL('**' + LOCK_URL, { timeout: 10000 });
    await expect(page.locator('#lock-reauth')).toBeVisible({ timeout: 15000 });
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
      await page.locator('#lock-reauth-methods .sgx-credential-row').filter({ hasText: '解锁密码' }).click();
      await page.locator('#lock-reauth-methods .sgx-credential-expand input[type="password"]').fill('lock-pw-1');
      await page.locator('#lock-reauth-methods .sgx-credential-btn-primary').click();
      await expect(page.locator('#sgx-credential-countdown')).toBeVisible({ timeout: 15000 });
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
    await expect(page.locator('#lock-reauth-methods .sgx-credential-row')).toHaveCount(2, { timeout: 15000 });
  });

  test('选择框：圆角 16px、静止底色不透明、行间距 12px、无分隔线、按下态比静止态深', async ({ page }) => {
    const rows = page.locator('#lock-reauth-methods .sgx-credential-row');
    const row = rows.first();
    expect(await row.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('16px');
    const pad = await row.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { top: cs.paddingTop, left: cs.paddingLeft };
    });
    expect(pad.top).toBe('12px');
    expect(pad.left).toBe('16px');
    expect(await row.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe('0px');
    const gap = await page.locator('#lock-reauth-methods').evaluate((el) => getComputedStyle(el).rowGap);
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
