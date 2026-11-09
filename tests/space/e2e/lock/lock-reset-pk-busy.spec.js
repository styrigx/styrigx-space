/**
 * 锁屏通行密钥 busy 态与取消不误报（e2e，mock WebAuthn）。进站 v3 L1（2026-11-09）：
 * 原「重置登录第 2 步选锁屏凭证」已删（恢复钥匙一把就进 reset，Gray B），这个文件改测同一类问题的两处现存入口：
 * - `sudo styrigx` → [pick] 选 passkey：终端「正在唤起通行密钥…」，输入行收起（busy），再按回车不会再发 → 只发 1 次 challenge；
 *   取消（NotAllowedError，含立即返回的 nokey）→「已取消」（不是出错色），回到选择这一步（还在这一轮，不算 permission denied）；
 *   其他失败（InvalidStateError / SecurityError）→ 出错一行，回到选择；第 3 次没成 → `sudo: 3 incorrect password attempts` 回命令行；
 *   成功 → 进站（localhost 本地回退：不问服务端）。
 * - reset 终端 `passkey add`：busy 时只发 1 次注册 challenge；取消 → 回 reset@space:~#。
 *
 * 运行（生产构建，锁屏启用；静态构建 + API mock，无需真实后端）：
 *   SGX_TEST_SUITE=lock npx playwright test --config=tests/config/playwright.config.js lock-reset-pk-busy.spec.js
 * 等具体元素，不用 waitForTimeout/networkidle。
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('../helpers/helpers');
const { gotoLockTerm, lockCmd, lockMode, badLine } = require('../helpers/lock-term.cjs');

const CHALLENGE_B64 = 'dGVzdC1jaGFsbGVuZ2U';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

/** @param {import('@playwright/test').Page} page @param {'zh'|'en'} lang */
async function setLang(page, lang) {
  await page.addInitScript((l) => { try { localStorage.setItem('sgx-lang', l); } catch (e) {} }, lang);
}

/** /api/lock-passkey：challenge 计数；auth → ok @param {import('@playwright/test').Page} page @param {{challenge:number, auth:number}} n */
async function mockPasskey(page, n) {
  await page.route('**/api/lock-passkey', async (route) => {
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (e) {}
    if (body.action === 'challenge') {
      n.challenge += 1;
      await route.fulfill(json({ ok: true, challenge: CHALLENGE_B64, cid: 'c1', rpId: 'localhost', allowCredentials: [] }));
      return;
    }
    if (body.action === 'auth') { n.auth += 1; await route.fulfill(json({ ok: true })); return; }
    await route.fulfill(json({ ok: false }, 400));
  });
}

/* WebAuthn 桩：get 挂起，由测试通过 window.__pkGate resolve/reject */
/** @param {import('@playwright/test').Page} page */
async function stubWebauthnPending(page) {
  await page.evaluate(() => {
    window.__pkGate = null;
    try {
      navigator.credentials.get = function () {
        return new Promise(function (resolve, reject) { window.__pkGate = { resolve: resolve, reject: reject }; });
      };
    } catch (e) {}
  });
}
/** @param {import('@playwright/test').Page} page */
async function awaitPkGate(page) {
  await page.waitForFunction(() => !!window.__pkGate, null, { timeout: 8000 });
}
/** @param {import('@playwright/test').Page} page @param {string} name */
async function rejectPk(page, name) {
  await page.evaluate((n) => { const g = window.__pkGate; window.__pkGate = null; g.reject(Object.assign(new Error(n), { name: n })); }, name);
}

/** 锁屏 → sudo styrigx → [pick] */
/** @param {import('@playwright/test').Page} page */
async function gotoPick(page) {
  await page.route('**/api/lock-entry', (route) => route.fulfill(json({ ok: true, passkey: true, password: true })));
  await gotoLockTerm(page);
  await lockCmd(page, 'sudo styrigx');
  await lockMode(page, 'pick');
  await expect(page.locator('#sgx-entry-log [data-term-pick="1"]').last()).toHaveText('[1] passkey');
}

test.describe('sudo styrigx → [1] passkey：busy / 取消 / 失败 / 成功', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await setLang(page, 'zh');
  });

  test('选 passkey：终端等待 + 输入行收起，不能重复提交，只发 1 次 challenge', async ({ page }) => {
    const n = { challenge: 0, auth: 0 };
    await mockPasskey(page, n);
    await gotoPick(page);
    await stubWebauthnPending(page);
    await lockCmd(page, '1');
    await lockMode(page, 'busy');
    await expect(page.locator('#sgx-entry-log')).toContainText('正在唤起通行密钥…');
    await expect(page.locator('#sgx-entry-cmd')).toBeHidden();
    await expect(page.locator('#sgx-entry-cmd')).toBeDisabled();
    await awaitPkGate(page);
    await page.evaluate(() => {
      document.getElementById('sgx-entry-cmd').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      document.getElementById('sgx-entry-form').dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await expect.poll(async () => n.challenge, { timeout: 2000 }).toBe(1);
    await lockMode(page, 'busy');
    await expect(page.locator('#sgx-method-sheet, .sgx-verify-dlg')).toHaveCount(0);
  });

  test('取消系统验证（≥2s 的 NotAllowedError）：「已取消」（不是出错色），回到选择这一步，留在本页', async ({ page }) => {
    const n = { challenge: 0, auth: 0 };
    await mockPasskey(page, n);
    await gotoPick(page);
    await stubWebauthnPending(page);
    await page.clock.install();
    await lockCmd(page, 'passkey');
    await lockMode(page, 'busy');
    await awaitPkGate(page);
    await page.clock.fastForward(2100);
    await rejectPk(page, 'NotAllowedError');
    await lockMode(page, 'pick');
    await expect(page.locator('#sgx-entry-log .sgx-entry-l--d').filter({ hasText: '已取消' })).toHaveCount(1);
    await expect(page.locator('#sgx-entry-log .sgx-entry-l--er')).toHaveCount(0);
    expect(page.url()).toContain('?entry=1');
  });

  test('无匹配钥匙（立即返回的 NotAllowedError = nokey）：同样按「已取消」，回到选择', async ({ page }) => {
    const n = { challenge: 0, auth: 0 };
    await mockPasskey(page, n);
    await gotoPick(page);
    await stubWebauthnPending(page);
    await lockCmd(page, '1');
    await awaitPkGate(page);
    await rejectPk(page, 'NotAllowedError');
    await lockMode(page, 'pick');
    await expect(page.locator('#sgx-entry-log')).toContainText('已取消');
    await expect(page.locator('#sgx-entry-log')).not.toContainText('pkNoKey');
  });

  test('其他失败（InvalidStateError / SecurityError）：出错一行「验证失败，请重试」，回到选择；第 3 次没成 → 3 incorrect attempts 回命令行', async ({ page }) => {
    const n = { challenge: 0, auth: 0 };
    await mockPasskey(page, n);
    await gotoPick(page);
    await stubWebauthnPending(page);
    await lockCmd(page, '1');
    await awaitPkGate(page);
    await rejectPk(page, 'InvalidStateError');
    await expect(badLine(page)).toHaveText('验证失败，请重试');
    await lockMode(page, 'pick');
    await lockCmd(page, '1');
    await awaitPkGate(page);
    await rejectPk(page, 'SecurityError');
    await expect(badLine(page)).toHaveText('验证失败，请重试');
    await lockMode(page, 'pick');
    await lockCmd(page, '1');
    await awaitPkGate(page);
    await rejectPk(page, 'SecurityError');
    await expect(badLine(page)).toHaveText('sudo: 3 incorrect password attempts');
    await lockMode(page, 'cmd');
    expect(page.url()).toContain('?entry=1');
  });

  test('通行密钥验证成功 → 提交 auth → 进站（本地回退不问服务端），锁屏收掉', async ({ page }) => {
    const n = { challenge: 0, auth: 0 };
    await mockPasskey(page, n);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoPick(page);
    await stubWebauthnPending(page);
    await lockCmd(page, '1');
    await awaitPkGate(page);
    await page.evaluate(() => {
      const buf = (s) => Uint8Array.from(s.split('').map((c) => c.charCodeAt(0))).buffer;
      window.__pkGate.resolve({
        id: 'ZmFrZS1yYXctaWQ', rawId: buf('fake-raw-id'), type: 'public-key',
        response: { authenticatorData: buf('fake-auth-data'), clientDataJSON: buf('fake-client-data'), signature: buf('fake-signature'), userHandle: null },
      });
    });
    await expect(page.locator('#sgx-entry')).toHaveCount(0, { timeout: 10000 });
    expect(n).toEqual({ challenge: 1, auth: 1 });
  });
});

test.describe('sudo styrigx → passkey (en)', () => {
  test('英文等待文案与取消提示', async ({ page }) => {
    await blockExternalRequests(page);
    await setLang(page, 'en');
    const n = { challenge: 0, auth: 0 };
    await mockPasskey(page, n);
    await gotoPick(page);
    await stubWebauthnPending(page);
    await page.clock.install();
    await lockCmd(page, '1');
    await expect(page.locator('#sgx-entry-log')).toContainText('waiting for passkey…');
    await awaitPkGate(page);
    await page.clock.fastForward(2100);
    await rejectPk(page, 'NotAllowedError');
    await lockMode(page, 'pick');
    await expect(page.locator('#sgx-entry-log')).toContainText('cancelled');
    await expect(page.locator('#sgx-entry-ps')).toHaveText('choose [1/2/3]:');
  });
});

test.describe('reset 终端 passkey add：busy 只发 1 次注册 challenge；取消回 reset@space', () => {
  test('passkey add → 名字（回车 = 默认）→ busy → 取消 → 回 reset@space:~#，不算改动（不出两选）', async ({ page }) => {
    await blockExternalRequests(page);
    await setLang(page, 'zh');
    let reg = 0;
    await page.route('**/api/lock-reset', (route) => route.fulfill(json({ ok: true })));
    await page.route('**/api/lock-passkey', async (route) => {
      let body = {};
      try { body = route.request().postDataJSON() || {}; } catch (e) {}
      if (body.action === 'challenge' && body.type === 'register') {
        reg++;
        await route.fulfill(json({ ok: true, challenge: CHALLENGE_B64, cid: 'r1', rp: { name: 'Styrigx', id: 'localhost' }, user: { id: 'dGVzdA', name: 'SpacePasskey', displayName: 'Styrigx' }, excludeCredentials: [] }));
        return;
      }
      await route.fulfill(json({ ok: false }, 400));
    });
    await gotoLockTerm(page);
    await lockCmd(page, 'sudo styrigx reset');
    await lockCmd(page, 'rk');
    await expect(page.locator('#sgx-entry-ps')).toHaveText('reset@space:~#');
    await page.evaluate(() => {
      window.__regGate = null;
      navigator.credentials.create = function () { return new Promise(function (resolve, reject) { window.__regGate = { resolve, reject }; }); };
    });
    await lockCmd(page, 'passkey add');
    await lockMode(page, 'pkname');
    await page.locator('#sgx-entry-cmd').press('Enter');
    await lockMode(page, 'busy');
    await page.waitForFunction(() => !!window.__regGate, null, { timeout: 8000 });
    await page.evaluate(() => document.getElementById('sgx-entry-form').dispatchEvent(new Event('submit', { cancelable: true })));
    await expect.poll(() => reg, { timeout: 2000 }).toBe(1);
    await page.evaluate(() => window.__regGate.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })));
    await lockMode(page, 'cmd');
    await expect(page.locator('#sgx-entry-ps')).toHaveText('reset@space:~#');
    await expect(page.locator('#sgx-entry-log [data-term-pick]')).toHaveCount(0);
  });
});
