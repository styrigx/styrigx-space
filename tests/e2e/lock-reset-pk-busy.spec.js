/**
 * D1：重置锁屏 (2/2) 通行密钥行 busy 态与取消不误报（e2e，mock WebAuthn）。
 *
 * 量化验收：
 * - 点通行密钥行：副标题=「正在唤起通行密钥…」、出现 .sgx-door-spin、两行 disabled；
 *   连点两次只发 1 次 /api/lockreset challenge。
 * - 取消（NotAllowedError）：副标题/箭头恢复原样，行内显示「已取消验证，可重新选择」，
 *   留在本页（标题仍为 (2/2)，URL 未变），不报「验证失败」。
 * - 成功：进入 /settings/security/lock/。
 * - 英文：副标题 'Opening passkey…'。
 *
 * 运行（生产构建，锁屏启用；静态构建 + API mock，无需真实后端）：
 *   hugo --minify
 *   SGX_TEST_SUITE=lock npx playwright test --config=playwright.config.js lock-reset-pk-busy.spec.js
 *
 * 注意：等具体元素，不用 waitForTimeout/networkidle。
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('./helpers');

const CHALLENGE_B64 = 'dGVzdC1jaGFsbGVuZ2U';

/** @param {import('@playwright/test').Page} page @param {'zh'|'en'} lang */
async function setLang(page, lang) {
  await page.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

/** @param {import('@playwright/test').Page} page */
async function mockLockConfig(page) {
  await page.route('**/api/lock-config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, passkey: true, password: true }),
    });
  });
}

/**
 * /api/lockreset mock：verify(身份) → needOwner；challenge → 计数；
 * verify(带 ownerProof) → ok。
 * @param {import('@playwright/test').Page} page
 * @param {{challenge:number}} counters
 */
async function mockLockreset(page, counters) {
  await page.route('**/api/lockreset', async (route) => {
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
    if (body.action === 'verify' && body.ownerProof) {
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
        body: JSON.stringify({ ok: true, needOwner: true, passkey: true, password: true }),
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

/* 走到重置锁屏 (2/2)：锁屏 → 头像 → 重置 → step1 根凭证验证 → step2 */
/** @param {import('@playwright/test').Page} page */
async function gotoResetStep2(page) {
  await page.goto('/?lock=1', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
  await page.click('#sgx-lock-avatar');
  await expect(page.locator('#sgx-mopt-reset')).toBeVisible({ timeout: 8000 });
  await page.click('#sgx-mopt-reset');
  await expect(page.locator('#sgx-reset-root')).toBeVisible({ timeout: 8000 });
  await page.locator('#sgx-reset-root').fill('test-root-key');
  await page.click('#sgx-reset-go');
  await expect(page.locator('#sgx-reset-pk-row')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#sgx-reset-pw-row')).toBeVisible({ timeout: 8000 });
}

test.describe('reset (2/2) passkey busy', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await setLang(page, 'zh');
    await mockLockConfig(page);
  });

  test('点通行密钥行：busy 文案 + 转圈 + 两行 disabled，连点两次只发 1 次 challenge', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    await page.locator('#sgx-reset-pk-row').click();
    /* 副标题切 busy 文案（与 security.html passkeyBusy 同一文案） */
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-rowsub'))
      .toHaveText('正在唤起通行密钥…', { timeout: 8000 });
    /* 箭头换成转圈 */
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toBeVisible();
    /* 两行都 disabled（通行密钥行 + 站长密码行） */
    await expect(page.locator('#sgx-reset-pk-row')).toBeDisabled();
    await expect(page.locator('#sgx-reset-pw-row')).toBeDisabled();
    /* 连点第二次（合成事件）：handler 判 disabled 直接 return，不发 challenge */
    await page.evaluate(() => {
      document.getElementById('sgx-reset-pk-row')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => counters.challenge, { timeout: 2000 }).toBe(1);
    /* 仍在 busy 态 */
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toBeVisible();
  });

  test('取消系统验证：行内提示可重新选择，副标题/箭头恢复，留在本页', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    /* B1-2：用假时钟走 cancelled 分支（≥2s），不真等 */
    await page.clock.install();
    await page.locator('#sgx-reset-pk-row').click();
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toBeVisible({ timeout: 8000 });
    /* 模拟用户在系统窗口点取消 */
    await awaitPkGate(page);
    await page.clock.fastForward(2100);
    await page.evaluate(() => {
      window.__pkGate.reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    });
    /* 转圈消失，副标题/箭头恢复原样 */
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toHaveCount(0, { timeout: 8000 });
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-rowsub')).toHaveText('使用指纹或设备锁屏');
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-chev svg')).toBeVisible();
    /* 两行恢复可点 */
    await expect(page.locator('#sgx-reset-pk-row')).toBeEnabled();
    await expect(page.locator('#sgx-reset-pw-row')).toBeEnabled();
    /* 行内提示「已取消验证，可重新选择」，不报「验证失败」 */
    const rowErr = page.locator('#sgx-reset-pk-err');
    await expect(rowErr).toBeVisible();
    await expect(rowErr).toHaveText('已取消验证，可重新选择');
    await expect(page.locator('#sgx-verify-err:not([hidden])')).toHaveCount(0);
    /* 留在本页：标题仍是 (2/2)，URL 未变 */
    await expect(page.locator('#sgx-verify-title')).toHaveText('重置锁屏 (2/2)');
    expect(page.url()).toContain('?lock=1');
  });

  test('无匹配钥匙（立即失败）：行内提示 nokey 文案，留在本页', async ({ page }) => {
    /* B1-2：NotAllowedError 立即返回（<2s）走 nokey 分支，#sgx-reset-pk-err 可见且为翻译文案 */
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    await page.locator('#sgx-reset-pk-row').click();
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toBeVisible({ timeout: 8000 });
    await awaitPkGate(page);
    /* 立即 reject（不快进时钟），走 nokey 分支 */
    await page.evaluate(() => {
      window.__pkGate.reject(Object.assign(new Error('no key'), { name: 'NotAllowedError' }));
    });
    const rowErr = page.locator('#sgx-reset-pk-err');
    await expect(rowErr).toBeVisible({ timeout: 8000 });
    /* 文案是翻译后的，不是 key 名 */
    const text = await rowErr.textContent();
    expect(text).not.toBe('pkNoKey');
    expect(text.length).toBeGreaterThan(0);
    /* 留在本页 */
    await expect(page.locator('#sgx-verify-title')).toHaveText('重置锁屏 (2/2)');
  });

  test('通行密钥验证成功：进入 /settings/security/lock/', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    await page.locator('#sgx-reset-pk-row').click();
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toBeVisible({ timeout: 8000 });
    /* 模拟系统验证通过：返回假 credential（ArrayBuffer 字段，供 b64 编码） */
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
    await page.waitForURL('**/settings/security/lock/**', { timeout: 10000 });
  });

  test('其他失败：显示现有中文文案，留在本页', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    await page.locator('#sgx-reset-pk-row').click();
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toBeVisible({ timeout: 8000 });
    /* 非取消失败（如 InvalidStateError）：现有文案「通行密钥验证失败」 */
    await awaitPkGate(page);
    await page.evaluate(() => {
      window.__pkGate.reject(Object.assign(new Error('failed'), { name: 'InvalidStateError' }));
    });
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toHaveCount(0, { timeout: 8000 });
    await expect(page.locator('#sgx-verify-err:not([hidden])')).toHaveText('通行密钥验证失败');
    await expect(page.locator('#sgx-verify-title')).toHaveText('重置锁屏 (2/2)');
    expect(page.url()).toContain('?lock=1');
    /* 副标题/箭头恢复，两行可点 */
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-rowsub')).toHaveText('使用指纹或设备锁屏');
    await expect(page.locator('#sgx-reset-pk-row')).toBeEnabled();
    await expect(page.locator('#sgx-reset-pw-row')).toBeEnabled();
  });

  test('通用失败（SecurityError）：显示全局「通行密钥验证失败」，留在本页', async ({ page }) => {
    /* B1-2 选项 B：failed 走全局报错（保持 46fe723 前行为） */
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    await page.locator('#sgx-reset-pk-row').click();
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toBeVisible({ timeout: 8000 });
    await awaitPkGate(page);
    await page.evaluate(() => {
      window.__pkGate.reject(Object.assign(new Error('security'), { name: 'SecurityError' }));
    });
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toHaveCount(0, { timeout: 8000 });
    /* 全局报错，不是行内 */
    await expect(page.locator('#sgx-verify-err:not([hidden])')).toHaveText('通行密钥验证失败');
    await expect(page.locator('#sgx-reset-pk-err')).toBeHidden();
    await expect(page.locator('#sgx-verify-title')).toHaveText('重置锁屏 (2/2)');
    expect(page.url()).toContain('?lock=1');
  });
});

test.describe('reset (2/2) passkey busy (en)', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await setLang(page, 'en');
    await mockLockConfig(page);
  });

  test('英文 busy 文案与取消提示', async ({ page }) => {
    const counters = { challenge: 0 };
    await mockLockreset(page, counters);
    await gotoResetStep2(page);
    await stubWebauthnPending(page);
    /* B1-2：用假时钟走 cancelled 分支（≥2s），不真等 */
    await page.clock.install();
    await page.locator('#sgx-reset-pk-row').click();
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-rowsub'))
      .toHaveText('Opening passkey…', { timeout: 8000 });
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toBeVisible();
    await expect(page.locator('#sgx-reset-pk-row')).toBeDisabled();
    await expect(page.locator('#sgx-reset-pw-row')).toBeDisabled();
    await awaitPkGate(page);
    await page.clock.fastForward(2100);
    await page.evaluate(() => {
      window.__pkGate.reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    });
    await expect(page.locator('#sgx-reset-pk-row .sgx-door-spin')).toHaveCount(0, { timeout: 8000 });
    const rowErr = page.locator('#sgx-reset-pk-err');
    await expect(rowErr).toBeVisible();
    await expect(rowErr).toHaveText('Cancelled, you can select again');
    await expect(page.locator('#sgx-verify-title')).toHaveText('Reset lock screen (2/2)');
  });
});
