/**
 * 盾牌下拉 #sgx-sec = 进站命令行 styrigx@space:~#（进站 v3 L1，SPACE-V3 §2.2 C、Q3 定稿 08:00；shell/space/shield.js）。
 * 取代原 sec-pop.spec.js（sec-v1 下拉）和安全页三页（/security/、/security/lock/、/security/tempkeys/）的 e2e：
 * reauth-verify / reauth-return / security-status / lock-now / b1-12-guard 的添加通行密钥部分。
 *
 * - 主页：$ SECURITY；进站会话（方式 · 剩余）；进站凭证 / 临时钥匙 / 分享链接三行（没 reauth 时右边写 reauth）；立即锁屏
 * - 点要 reauth 的行：命令行回显 sudo styrigx reauth，只列 passkey / password（没有 tempkey）；通过后进那一层，头部 reauth · m:ss
 * - 立即锁屏：只锁本机、不验证、没有确认层 → POST /api/lock-now → /?entry=1；失败留在下拉里报错
 * - 旧地址 #sec=keys 打开盾牌那一层；Ctrl 点盾牌照旧按链接走（/#sec）
 * 测试构建（锁屏禁用、没有网关）：/api/lock-* 全用 page.route 替身。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');

const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

/**
 * @param {import('@playwright/test').Page} page
 * @param {{reauth?: () => any, password?: (body: any) => [number, any], passkey?: (body: any) => [number, any], lockNow?: [number, any], hash?: string}} [o]
 */
async function go(page, o = {}) {
  await blockExternalRequests(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  const calls = [];
  const rec = async (route) => {
    const req = route.request();
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    calls.push([new URL(req.url()).pathname, body]);
    return body;
  };
  await page.route('**/api/lock-session-check**', (r) => r.fulfill(json({ ok: true, by: 'password', exp: Date.now() + (11 * 60 + 20) * 60000 + 30000 })));
  await page.route('**/api/lock-reauth', async (r) => {
    const b = await rec(r);
    if (b.action === 'status') return r.fulfill(json(o.reauth ? o.reauth() : { ok: true, valid: false, password: true, passkey: false }));
    return r.fulfill(json({ ok: true }));
  });
  await page.route('**/api/lock-password', async (r) => {
    const b = await rec(r);
    const res = o.password ? o.password(b) : [200, { ok: true }];
    return r.fulfill(json(res[1], res[0]));
  });
  await page.route('**/api/lock-passkey', async (r) => {
    const b = await rec(r);
    const res = o.passkey ? o.passkey(b) : [200, { ok: true, keys: [] }];
    return r.fulfill(json(res[1], res[0]));
  });
  await page.route('**/api/lock-now', async (r) => {
    await rec(r);
    const res = o.lockNow || [200, { ok: true }];
    return r.fulfill(json(res[1], res[0]));
  });
  await page.goto('/zh/wild/' + (o.hash || ''), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
  return calls;
}
const sec = (page) => page.locator('#sgx-sec');
const shIn = (page) => page.locator('#sgx-sh-in');
const shLog = (page) => page.locator('#sgx-sec [data-sh-log]');
/** @param {import('@playwright/test').Page} page @param {string} text */
async function type(page, text) {
  await expect(shIn(page)).toBeEditable();
  await shIn(page).fill(text);
  await shIn(page).press('Enter');
}

test.describe('盾牌 #sgx-sec：styrigx@space:~#', () => {
  test('主页：$ SECURITY、进站会话、三行要 reauth、立即锁屏；提示符 styrigx@space:~#；和账号下拉互斥', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page);
    await page.locator('.sgx-tb-shield').click();
    const s = sec(page);
    await expect(s).toHaveAttribute('data-state', 'open');
    await expect(s.locator('[data-sh-head]')).toContainText('SECURITY');
    await expect(s.locator('[data-sh-ps]')).toHaveText('styrigx@space:~#');
    await expect(s.locator('.sgx-pop-row').first()).toContainText('进站会话');
    await expect(s.locator('.sgx-pop-row').first()).toContainText(/解锁密码 · 剩 11:2\d/);
    for (const a of ['keys', 'tempkeys', 'links']) await expect(s.locator(`[data-sh-act="${a}"]`)).toContainText('reauth');
    await expect(s.locator('[data-sh-act="lock"]')).toContainText('立即锁屏');
    await expect(shLog(page)).toContainText('help');
    /* 原安全页的门 / 底部复验弹层都没有了 */
    await expect(page.locator('.sgx-verify-dlg, #sec-locknow-confirm, .sgx-share-reauth')).toHaveCount(0);
    await page.locator('.sgx-tb-av').click();
    await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
    await expect(s).toBeHidden();
  });

  test('help / 未知命令；esc 关下拉', async ({ page }) => {
    await go(page);
    await page.locator('.sgx-tb-shield').click();
    await type(page, 'help');
    await expect(shLog(page)).toContainText('sudo styrigx reauth');
    await expect(shLog(page)).toContainText('lock');
    await type(page, 'sudo security');
    await expect(shLog(page).locator('.sgx-at-l--er').last()).toHaveText('command not found: sudo · try help');
    await page.keyboard.press('Escape');
    await expect(sec(page)).toBeHidden();
  });

  test('点「进站凭证」：命令行自动 sudo styrigx reauth，只列 passkey / password（没有 tempkey）；解锁密码 reauth:true 通过后进层，头部 reauth · m:ss', async ({ page }) => {
    let valid = false;
    const calls = await go(page, {
      reauth: () => (valid ? { ok: true, valid: true, ticket: 'lock-reauth', expiresAt: Date.now() + 170000, password: true, passkey: true } : { ok: true, valid: false, password: true, passkey: true }),
      password: (b) => { if (b.password === 'right-pass-1') { valid = true; return [200, { ok: true }]; } return [403, { ok: false, error: 'wrong' }]; },
      passkey: (b) => (b.action === 'list' ? [200, { ok: true, keys: [{ credId: 'c1', name: 'S23', provider: '', createdAt: Date.now() - 86400000, lastUsedAt: 0 }] }] : [400, { ok: false, error: 'action' }]),
    });
    await page.locator('.sgx-tb-shield').click();
    await sec(page).locator('[data-sh-act="keys"]').click();
    await expect(shLog(page)).toContainText('sudo styrigx reauth');
    await expect(shLog(page)).toContainText('进站凭证要再验证');
    const opts = shLog(page).locator('[data-term-pick]');
    await expect(opts).toHaveText([/passkey/, /password/]);
    await expect(shLog(page)).not.toContainText('tempkey');
    await sec(page).locator('[data-term-pick]', { hasText: 'password' }).click();
    await expect(sec(page).locator('[data-sh-form]')).toHaveAttribute('data-mode', 'pw');
    await expect(sec(page).locator('[data-sh-ps]')).toHaveText(/^\[sudo\] password for .+:$/);
    await type(page, 'wrong-pass');
    await expect(shLog(page)).toContainText('Sorry, try again.');
    await type(page, 'right-pass-1');
    await expect(sec(page).locator('[data-sh-layer="keys"], .sgx-sh[data-sh-layer="keys"]')).toHaveCount(1);
    await expect(sec(page).locator('[data-sh-cd]')).toHaveText(/^reauth · [0-3]:\d\d$/);
    await expect(sec(page)).toContainText('S23');
    await expect(sec(page)).toContainText('lock --all');
    const pw = calls.filter((c) => c[0] === '/api/lock-password').map((c) => c[1]);
    expect(pw).toEqual([{ action: 'verify', password: 'wrong-pass', reauth: true }, { action: 'verify', password: 'right-pass-1', reauth: true }]);
  });

  test('没设解锁密码也没通行密钥：reauth 直接说做不了，不进层', async ({ page }) => {
    await go(page, { reauth: () => ({ ok: true, valid: false, password: false, passkey: false }) });
    await page.locator('.sgx-tb-shield').click();
    await sec(page).locator('[data-sh-act="tempkeys"]').click();
    await expect(shLog(page).locator('.sgx-at-l--er').last()).toContainText('reauth 只认这两种');
    await expect(sec(page).locator('.sgx-sh')).toHaveAttribute('data-sh-layer', 'home');
  });

  test('立即锁屏：不验证、没有确认层，一次 POST /api/lock-now 后去 /?entry=1', async ({ page }) => {
    const calls = await go(page);
    await page.locator('.sgx-tb-shield').click();
    await sec(page).locator('[data-sh-act="lock"]').click();
    await page.waitForURL(/\/\?entry=1$/);
    expect(calls.filter((c) => c[0] === '/api/lock-now')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === '/api/lock-password' || c[0] === '/api/lock-passkey')).toHaveLength(0);
  });

  test('立即锁屏失败：留在下拉里报「锁屏失败」，不跳锁屏；lock 命令同一个', async ({ page }) => {
    await go(page, { lockNow: [500, { ok: false, error: 'server' }] });
    await page.locator('.sgx-tb-shield').click();
    await type(page, 'lock');
    await expect(shLog(page).locator('.sgx-at-l--er').last()).toHaveText('锁屏失败 · 检查网络');
    await expect(sec(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/zh/wild/');
  });

  test('旧地址 #sec=keys（/security/lock/ 301 过来）：打开盾牌进站凭证层（先 reauth），hash 去掉', async ({ page }) => {
    await go(page, { hash: '#sec=keys' });
    await expect(sec(page)).toHaveAttribute('data-state', 'open');
    await expect(shLog(page)).toContainText('sudo styrigx reauth');
    await expect(sec(page).locator('[data-sh-form]')).toHaveAttribute('data-mode', 'pick');
    expect(new URL(page.url()).hash).toBe('');
  });

  test('进站凭证层：passkey add 先在命令行问名字，回车后 1 秒内调 credentials.create，register 带名字；create 失败报错、留在层里', async ({ page }) => {
    const CH = { ok: true, challenge: 'dGVzdC1jaGFsbGVuZ2UtMzJiYnl0ZXM', cid: 'c-1', rpId: 'localhost', rp: { name: 'Styrigx' }, user: { id: 'dGVzdC11c2Vy', name: 'lock', displayName: 'Sloan Gray' }, excludeCredentials: [] };
    const calls = await go(page, {
      hash: '#sec=keys',
      reauth: () => ({ ok: true, valid: true, ticket: 'lock-reauth', expiresAt: Date.now() + 170000, password: true, passkey: false }),
      passkey: (b) => (b.action === 'challenge' ? [200, CH] : b.action === 'register' ? [200, { ok: true, credId: 'new-1' }] : [200, { ok: true, keys: [] }]),
    });
    await expect(sec(page).locator('.sgx-sh')).toHaveAttribute('data-sh-layer', 'keys');
    await page.evaluate(() => {
      window.__createAt = 0;
      navigator.credentials.create = function () {
        window.__createAt = Date.now();
        if (window.__failCreate) return Promise.reject(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
        return Promise.resolve({ id: 'new-1', rawId: new Uint8Array([1, 2, 3]).buffer, type: 'public-key', response: { clientDataJSON: new Uint8Array([4]).buffer, attestationObject: new Uint8Array([7]).buffer, getTransports: () => [] } });
      };
    });
    await sec(page).locator('[data-sh-act="passkey-add"]').click();
    await expect(sec(page).locator('[data-sh-form]')).toHaveAttribute('data-mode', 'pkname');
    await shIn(page).fill('Lab');
    const t0 = await page.evaluate(() => Date.now());
    await shIn(page).press('Enter');
    await page.waitForFunction(() => window.__createAt > 0, null, { timeout: 5000 });
    expect((await page.evaluate(() => window.__createAt)) - t0).toBeLessThan(1000);
    await expect(shLog(page)).toContainText('已注册');
    const reg = calls.filter((c) => c[0] === '/api/lock-passkey' && c[1].action === 'register').map((c) => c[1]);
    expect(reg).toHaveLength(1);
    expect(reg[0].name).toBe('Lab');
    /* create 失败：终端里报错，不卡在 busy */
    await page.evaluate(() => { window.__failCreate = true; window.__createAt = 0; });
    await type(page, 'passkey add');
    await expect(sec(page).locator('[data-sh-form]')).toHaveAttribute('data-mode', 'pkname');
    await shIn(page).press('Enter');
    await page.waitForFunction(() => window.__createAt > 0);
    await expect(sec(page).locator('[data-sh-form]')).toHaveAttribute('data-mode', 'cmd');
    await expect(shLog(page).locator('.sgx-at-l--er').last()).not.toHaveText('');
    await expect(sec(page).locator('.sgx-sh')).toHaveAttribute('data-sh-layer', 'keys');
  });

  test('进站凭证层：所有设备回锁屏（lock --all）两步，要 reauth 才在这一层；第二下 POST /api/lock-all-devices 后本机也去 /?entry=1', async ({ page }) => {
    const calls = await go(page, {
      hash: '#sec=keys',
      reauth: () => ({ ok: true, valid: true, ticket: 'lock-reauth', expiresAt: Date.now() + 170000, password: true, passkey: false }),
    });
    await page.route('**/api/lock-all-devices', async (r) => { calls.push(['/api/lock-all-devices', {}]); await r.fulfill(json({ ok: true })); });
    await expect(sec(page).locator('.sgx-sh')).toHaveAttribute('data-sh-layer', 'keys');
    const row = sec(page).locator('[data-sh-act="lock-all"]');
    await row.click();
    await expect(sec(page).locator('[data-sh-act="lock-all"][data-armed]')).toHaveCount(1);
    expect(calls.filter((c) => c[0] === '/api/lock-all-devices')).toHaveLength(0);
    await sec(page).locator('[data-sh-act="lock-all"]').click();
    await page.waitForURL(/\/\?entry=1$/);
    expect(calls.filter((c) => c[0] === '/api/lock-all-devices')).toHaveLength(1);
  });

  test('Ctrl 点盾牌不开下拉（照旧按链接走：/#sec）', async ({ page, context }) => {
    await go(page);
    const pop = context.waitForEvent('page');
    await page.locator('.sgx-tb-shield').click({ modifiers: ['Control'] });
    const np = await pop;
    await np.waitForLoadState('domcontentloaded');
    const u = new URL(np.url());
    expect(u.pathname + u.hash).toMatch(/^\/zh\/(#sec)?$/);
    await expect(sec(page)).toBeHidden();
  });
});
