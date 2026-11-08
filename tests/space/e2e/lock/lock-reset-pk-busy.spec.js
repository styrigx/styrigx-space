/**
 * D1：重置登录第 2 步（锁屏 reset 命令 → 进站凭证 → needLock → 选锁屏凭证）通行密钥 busy 态与取消不误报（e2e，mock WebAuthn）。
 * 账号拆分 PR3：第 2 步验的是锁屏凭证（lockProof），网关不再读账号凭证。
 * lock-v10 命令解锁（2026-11-08）：锁屏上没有弹层，这一步也在终端里：列出 [1] password / [2] passkey，输入编号。
 *
 * 量化验收：
 * - 选 passkey：终端「等待通行密钥…」，输入行收起（busy），不能再提交 → 只发 1 次 /api/lock-reset challenge。
 * - 取消（NotAllowedError）：终端「✗ 已取消验证，可重新选择」（不是 permission denied），回到选择这一步，URL 未变，不报「验证失败」。
 * - 成功：进入 /security/lock/。
 * - 英文：'Cancelled, you can select again'。
 *
 * 运行（生产构建，锁屏启用；静态构建 + API mock，无需真实后端）：
 *   hugo --minify
 *   SGX_TEST_SUITE=lock npx playwright test --config=playwright.config.js lock-reset-pk-busy.spec.js
 *
 * 注意：等具体元素，不用 waitForTimeout/networkidle。
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('../helpers/helpers');
const { gotoLockTerm, lockCmd, lockMode, badLine } = require('../helpers/lock-term.cjs');

const CHALLENGE_B64 = 'dGVzdC1jaGFsbGVuZ2U';

/** @param {import('@playwright/test').Page} page @param {'zh'|'en'} lang */
async function setLang(page, lang) {
  await page.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

/** @param {import('@playwright/test').Page} page */
async function mockLockConfig(page) {
  await page.route('**/api/lock-entry', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, passkey: true, password: true }),
    });
  });
}

/**
 * /api/lock-reset mock：verify(根密钥) → needLock；challenge → 计数；
 * verify(带 lockProof) → ok。
 * @param {import('@playwright/test').Page} page
 * @param {{challenge:number}} counters
 */
async function mockLockreset(page, counters) {
  await page.route('**/api/lock-reset', async (route) => {
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (e) {}
    if (body.action === 'challenge') {
      counters.challenge += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true, challenge: CHALLENGE_B64, cid: 'c1', rpId: 'localhost', allowCredentials: [],
        }),
      });
      return;
    }
    if (body.action === 'verify' && body.lockProof) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    if (body.action === 'verify') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, needLock: true, passkey: true, password: true }),
      });
      return;
    }
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false }),
    });
  });
}

/* WebAuthn 桩：get 挂起，由测试通过 window.__pkGate resolve/reject */
/** @param {import('@playwright/test').Page} page */
async function stubWebauthnPending(page) {
  await page.evaluate(() => {
    window.__pkGate = null;
    try {
      navigator.credentials.get = function () {
        return new Promise(function (resolve, reject) {
          window.__pkGate = { resolve: resolve, reject: reject };
        });
      };
    } catch (e) {}
  });
}

/* 等 WebAuthn 桩被调用（challenge 取回后 get 挂起，window.__pkGate 就绪） */
/** @param {import('@playwright/test').Page} page */
async function awaitPkGate(page) {
  await page.waitForFunction(() => !!window.__pkGate, null, { timeout: 8000 });
}

/* 走到重置 (2/2)：锁屏 → reset → 进站凭证 → 选锁屏凭证 */
/** @param {import('@playwright/test').Page} page */
async function gotoResetStep2(page) {
  await gotoLockTerm(page, '/?lock=1');
  await lockCmd(page, 'reset');
  await lockMode(page, 'rkey');
  await lockCmd(page, 'test-spacekey');
  await lockMode(page, 'rpick');
  await expect(page.locator('#sgx-lock-log')).toContainText('[2] passkey');
}

test.describe('reset (2/2) passkey busy', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await setLang(page, 'zh');
    await mockLockConfig(page);
  });

  test('选 passkey：终端等待 + 输入行收起，不能重复提交，只发 1 次 challenge', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    await lockCmd(page, '2');
    await lockMode(page, 'busy');
    await expect(page.locator('#sgx-lock-log')).toContainText('等待通行密钥…');
    await expect(page.locator('#sgx-lock-cmd')).toBeHidden();
    await expect(page.locator('#sgx-lock-cmd')).toBeDisabled();
    await awaitPkGate(page);
    /* 再按回车（合成事件）也不会再发 */
    await page.evaluate(() => {
      document.getElementById('sgx-lock-cmd').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => counters.challenge, { timeout: 2000 }).toBe(1);
    await lockMode(page, 'busy');
    await expect(page.locator('#sgx-method-sheet, .sgx-verify-dlg')).toHaveCount(0);
  });

  test('取消系统验证：提示可重新选择，回到选择这一步，留在本页', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    /* B1-2：用假时钟走 cancelled 分支（≥2s），不真等 */
    await page.clock.install();
    await lockCmd(page, 'passkey');
    await lockMode(page, 'busy');
    await awaitPkGate(page);
    await page.clock.fastForward(2100);
    await page.evaluate(() => {
      window.__pkGate.reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    });
    await expect(badLine(page)).toHaveText('✗ 已取消验证，可重新选择');
    await lockMode(page, 'rpick');
    await expect(page.locator('#sgx-lock-log')).not.toContainText('验证失败');
    expect(page.url()).toContain('?lock=1');
  });

  test('无匹配钥匙（立即失败）：提示 nokey 文案，回到选择这一步', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    await lockCmd(page, '2');
    await awaitPkGate(page);
    /* 立即 reject（不快进时钟），走 nokey 分支 */
    await page.evaluate(() => {
      window.__pkGate.reject(Object.assign(new Error('no key'), { name: 'NotAllowedError' }));
    });
    await expect(badLine(page)).toHaveText('✗ 这台设备上没有这把钥匙');
    const text = await badLine(page).textContent();
    expect(text).not.toContain('pkNoKey');
    await lockMode(page, 'rpick');
  });

  test('通行密钥验证成功：进入 /security/lock/', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    await lockCmd(page, '2');
    await awaitPkGate(page);
    await page.evaluate(() => {
      const buf = (s) => Uint8Array.from(s.split('').map((c) => c.charCodeAt(0))).buffer;
      window.__pkGate.resolve({
        rawId: buf('fake-raw-id'),
        response: {
          authenticatorData: buf('fake-auth-data'),
          clientDataJSON: buf('fake-client-data'),
          signature: buf('fake-signature'),
          userHandle: null,
        },
      });
    });
    await page.waitForURL('**/security/lock/**', { timeout: 10000 });
  });

  test('其他失败（InvalidStateError）：permission denied · 这台设备上没有这把钥匙，留在本页', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    await lockCmd(page, '2');
    await awaitPkGate(page);
    await page.evaluate(() => {
      window.__pkGate.reject(Object.assign(new Error('failed'), { name: 'InvalidStateError' }));
    });
    await expect(badLine(page)).toHaveText('✗ permission denied · 这台设备上没有这把钥匙');
    await lockMode(page, 'rpick');
    expect(page.url()).toContain('?lock=1');
  });

  test('通用失败（SecurityError）：「通行密钥验证失败」，留在本页', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    await lockCmd(page, '2');
    await awaitPkGate(page);
    await page.evaluate(() => {
      window.__pkGate.reject(Object.assign(new Error('security'), { name: 'SecurityError' }));
    });
    await expect(badLine(page)).toHaveText('✗ permission denied · 通行密钥验证失败');
    await lockMode(page, 'rpick');
    expect(page.url()).toContain('?lock=1');
  });
});

test.describe('reset (2/2) passkey busy (en)', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await setLang(page, 'en');
    await mockLockConfig(page);
  });

  test('英文等待文案与取消提示', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    await page.clock.install();
    await lockCmd(page, '2');
    await expect(page.locator('#sgx-lock-log')).toContainText('waiting for passkey…');
    await awaitPkGate(page);
    await page.clock.fastForward(2100);
    await page.evaluate(() => {
      window.__pkGate.reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    });
    await expect(badLine(page)).toHaveText('✗ Cancelled, you can select again');
    await lockMode(page, 'rpick');
    await expect(page.locator('#sgx-lock-log')).toContainText('Reset sign-in');
  });
});
