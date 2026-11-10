/**
 * 盾牌 + 钥匙命令（v5 S5 终端合一：盾牌窗口 #sgx-sec 删了，钥匙那一套在全站终端里，term-design-v5「钥匙」）。
 * - 盾牌（v5 S6 顶栏 E）= 打开终端：访客预填 sudo styrigx（不替人回车）；已进站问「退出进站会话 [y/N]」（n / 回车不动，y = lock）；旧地址 #sec[=层] 只打开终端、不问；Ctrl 点盾牌照旧按链接走（/#sec）
 * - 顶栏 >_（v5 S6）= 打开终端（已进站的钥匙命令用例都从它进）
 * - 已进站：提示符 styrigx@space:~/wild#；man 列 lock / share / ask
 * - sudo -v：终端里选方式（只列 passkey / password）→ 验证（reauth:true）→ ✓
 * - lock：只锁本机、不验证 → POST /api/lock-now → 重新取这一页；失败报「锁屏失败」、留在终端
 * - lock passkey add：先问名字，回车后 1 秒内调 credentials.create，register 带名字；create 失败报错、回命令行
 * - lock --all：[y/N]，要 reauth；y 之后 POST /api/lock-all-devices，本机也重新取这一页
 * 测试构建（锁屏禁用、没有网关）：/api/lock-* 全用 page.route 替身。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');

const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

/**
 * @param {import('@playwright/test').Page} page
 * @param {{reauth?: () => any, password?: (body: any) => [number, any], passkey?: (body: any) => [number, any], lockNow?: [number, any], hash?: string, visitor?: boolean}} [o]
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
  await page.route('**/api/lock-session-check**', (r) => (o.visitor ? r.fulfill(json({ ok: false }, 401)) : r.fulfill(json({ ok: true, by: 'password', exp: Date.now() + (11 * 60 + 20) * 60000 + 30000 }))));
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
const term = (page) => page.locator('#sgx-term');
const tIn = (page) => page.locator('#sgx-term-in');
const tOut = (page) => page.locator('#sgx-term [data-term-out]');
const mode = (page) => page.locator('#sgx-term [data-term-form]');
const ps = (page) => page.locator('#sgx-term [data-term-ps]');
/** @param {import('@playwright/test').Page} page @param {string} text */
async function type(page, text) {
  await expect(tIn(page)).toBeEditable();
  await tIn(page).fill(text);
  await tIn(page).press('Enter');
}
const REAUTH_OK = () => ({ ok: true, valid: true, ticket: 'lock-reauth', expiresAt: Date.now() + 170000, password: true, passkey: false });

test.describe('盾牌 + 钥匙命令（v5 S5：在全站终端里）', () => {
  test('已进站：顶栏 >_ 打开终端（不预填），提示符 styrigx@space:~/wild#；man 列 lock / share / ask；没有盾牌窗口了', async ({ page }) => {
    await go(page);
    await expect(page.locator('#sgx-sec')).toHaveCount(0);
    await page.locator('.sgx-tb-term').click();
    await expect(term(page)).toHaveAttribute('open', '');
    await expect(page.locator('.sgx-tb-term')).toHaveAttribute('aria-expanded', 'true');
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    await expect(tIn(page)).toHaveValue('');
    await type(page, 'man');
    await expect(tOut(page)).toContainText('手册页');
    const lines = await tOut(page).locator('.sgx-term-ln').allTextContents();
    const names = lines.filter((l) => / — /.test(l) && !/^space os/.test(l)).map((l) => l.split(' — ')[0]);
    for (const n of ['ask', 'sudo', 'lock', 'share']) expect(names).toContain(n);
    expect(names).not.toContain('find');
    expect(names).not.toContain('passwd');
  });

  test('已进站：点盾牌 = 终端问「退出进站会话 [y/N]」；n 什么都不做，y 一次 POST /api/lock-now 后重新取这一页', async ({ page }) => {
    const calls = await go(page);
    await page.locator('.sgx-tb-shield').click();
    await expect(term(page)).toHaveAttribute('open', '');
    await expect(mode(page)).toHaveAttribute('data-mode', 'pick');
    await expect(tOut(page)).toContainText('退出进站会话？ [y/N]');
    await expect(tIn(page)).toHaveValue('');
    await type(page, 'n');
    await expect(mode(page)).toHaveAttribute('data-mode', 'cmd');
    expect(calls.filter((c) => c[0] === '/api/lock-now')).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(term(page)).not.toHaveAttribute('open', '');
    await page.locator('.sgx-tb-shield').click();
    await expect(mode(page)).toHaveAttribute('data-mode', 'pick');
    const nav = page.waitForEvent('framenavigated');
    await type(page, 'y');
    await nav;
    expect(new URL(page.url()).pathname).toBe('/zh/wild/');
    expect(calls.filter((c) => c[0] === '/api/lock-now')).toHaveLength(1);
  });

  test('访客：点盾牌打开终端、预填 sudo styrigx（不替人回车）', async ({ page }) => {
    const calls = await go(page, { visitor: true });
    await page.locator('.sgx-tb-shield').click();
    await expect(term(page)).toHaveAttribute('open', '');
    await expect(tIn(page)).toHaveValue('sudo styrigx');
    await expect(ps(page)).toHaveText('nobody@space:~/wild$');
    expect(calls.filter((c) => c[0] === '/api/lock-password')).toHaveLength(0);
  });

  test('sudo -v：只列 passkey / password（没有 tempkey），选 password 输密码 → POST /api/lock-password { reauth: true } → ✓', async ({ page }) => {
    let valid = false;
    const calls = await go(page, { reauth: () => (valid ? REAUTH_OK() : { ok: true, valid: false, password: true, passkey: false }), password: () => { valid = true; return [200, { ok: true }]; } });
    await page.locator('.sgx-tb-term').click();
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    await type(page, 'sudo -v');
    await expect(mode(page)).toHaveAttribute('data-mode', 'pick');
    await expect(tOut(page)).toContainText('password');
    await expect(tOut(page)).not.toContainText('tempkey');
    await type(page, '1');
    await expect(mode(page)).toHaveAttribute('data-mode', 'pw');
    await type(page, 'hunter2');
    await expect(tOut(page)).toContainText('✓ verified');
    const pw = calls.filter((c) => c[0] === '/api/lock-password').map((c) => c[1]);
    expect(pw).toHaveLength(1);
    expect(pw[0].reauth).toBe(true);
    await expect(mode(page)).toHaveAttribute('data-mode', 'cmd');
  });

  test('lock：不验证、没有确认层，一次 POST /api/lock-now 后重新取这一页（不去锁屏）', async ({ page }) => {
    const calls = await go(page);
    await page.locator('.sgx-tb-term').click();
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    const nav = page.waitForEvent('framenavigated');
    await type(page, 'lock');
    await nav;
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/zh/wild/');
    expect(calls.filter((c) => c[0] === '/api/lock-now')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === '/api/lock-password' || c[0] === '/api/lock-passkey')).toHaveLength(0);
  });

  test('lock 失败：终端里报「锁屏失败」，不跳页', async ({ page }) => {
    await go(page, { lockNow: [500, { ok: false, error: 'server' }] });
    await page.locator('.sgx-tb-term').click();
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    await type(page, 'lock');
    await expect(tOut(page).locator('.sgx-at-l--er').last()).toHaveText('锁屏失败 · 检查网络');
    await expect(term(page)).toHaveAttribute('open', '');
    expect(new URL(page.url()).pathname).toBe('/zh/wild/');
  });

  test('旧地址 #sec=keys（/security/lock/ 301 过来）：打开终端，hash 去掉', async ({ page }) => {
    await go(page, { hash: '#sec=keys' });
    await expect(term(page)).toHaveAttribute('open', '');
    expect(new URL(page.url()).hash).toBe('');
  });

  test('lock passkey add：先问名字，回车后 1 秒内调 credentials.create，register 带名字；create 失败报错、回命令行', async ({ page }) => {
    const CH = { ok: true, challenge: 'dGVzdC1jaGFsbGVuZ2UtMzJiYnl0ZXM', cid: 'c-1', rpId: 'localhost', rp: { name: 'Styrigx' }, user: { id: 'dGVzdC11c2Vy', name: 'lock', displayName: 'Sloan Gray' }, excludeCredentials: [] };
    const calls = await go(page, {
      reauth: REAUTH_OK,
      passkey: (b) => (b.action === 'challenge' ? [200, CH] : b.action === 'register' ? [200, { ok: true, credId: 'new-1' }] : [200, { ok: true, keys: [] }]),
    });
    await page.evaluate(() => {
      window.__createAt = 0;
      navigator.credentials.create = function () {
        window.__createAt = Date.now();
        if (window.__failCreate) return Promise.reject(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
        return Promise.resolve({ id: 'new-1', rawId: new Uint8Array([1, 2, 3]).buffer, type: 'public-key', response: { clientDataJSON: new Uint8Array([4]).buffer, attestationObject: new Uint8Array([7]).buffer, getTransports: () => [] } });
      };
    });
    await page.locator('.sgx-tb-term').click();
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    await type(page, 'lock passkey add');
    await expect(mode(page)).toHaveAttribute('data-mode', 'pkname');
    await tIn(page).fill('Lab');
    const t0 = await page.evaluate(() => Date.now());
    await tIn(page).press('Enter');
    await page.waitForFunction(() => window.__createAt > 0, null, { timeout: 5000 });
    expect((await page.evaluate(() => window.__createAt)) - t0).toBeLessThan(1000);
    await expect(tOut(page)).toContainText('已注册');
    const reg = calls.filter((c) => c[0] === '/api/lock-passkey' && c[1].action === 'register').map((c) => c[1]);
    expect(reg).toHaveLength(1);
    expect(reg[0].name).toBe('Lab');
    await page.evaluate(() => { window.__failCreate = true; window.__createAt = 0; });
    await type(page, 'lock passkey add');
    await expect(mode(page)).toHaveAttribute('data-mode', 'pkname');
    await tIn(page).press('Enter');
    await page.waitForFunction(() => window.__createAt > 0);
    await expect(mode(page)).toHaveAttribute('data-mode', 'cmd');
    await expect(tOut(page).locator('.sgx-at-l--er').last()).not.toHaveText('');
  });

  test('lock --all：[y/N]（默认 n 什么都不做）；y 之后 POST /api/lock-all-devices，本机也重新取这一页', async ({ page }) => {
    const calls = await go(page, { reauth: REAUTH_OK });
    await page.route('**/api/lock-all-devices', async (r) => { calls.push(['/api/lock-all-devices', {}]); await r.fulfill(json({ ok: true })); });
    await page.locator('.sgx-tb-term').click();
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    await type(page, 'lock --all');
    await expect(mode(page)).toHaveAttribute('data-mode', 'pick');
    await type(page, 'n');
    await expect(mode(page)).toHaveAttribute('data-mode', 'cmd');
    expect(calls.filter((c) => c[0] === '/api/lock-all-devices')).toHaveLength(0);
    await type(page, 'lock --all');
    await expect(mode(page)).toHaveAttribute('data-mode', 'pick');
    const nav = page.waitForEvent('framenavigated');
    await type(page, 'y');
    await nav;
    expect(calls.filter((c) => c[0] === '/api/lock-all-devices')).toHaveLength(1);
    expect(new URL(page.url()).pathname).toBe('/zh/wild/');
  });

  test('Ctrl 点盾牌不开终端（照旧按链接走：/#sec）', async ({ page, context }) => {
    await go(page);
    const pop = context.waitForEvent('page');
    await page.locator('.sgx-tb-shield').click({ modifiers: ['Control'] });
    const np = await pop;
    await np.waitForLoadState('domcontentloaded');
    const u = new URL(np.url());
    expect(u.pathname + u.hash).toMatch(/^\/zh\/(#sec)?$/);
    await expect(term(page)).not.toHaveAttribute('open', '');
  });
  test('头像（v5 S6，Gray 17:23）：网关标了 locked（访客）= 死按钮（aria-disabled，点了不开账号窗、不跳页）；标了 valid 且服务端说已进站 = 开账号窗', async ({ page }) => {
    for (const st of ['locked', 'valid']) {
      await go(page, { visitor: st === 'locked' });
      /* 测试构建没有网关：自己给页面打上网关的标记（后注册的 route 优先），再取一次 */
      await page.route('**/zh/wild/', async (r) => {
        const res = await r.fetch();
        const body = (await res.text()).replace(/<html /, '<html data-sgx-lock-session="' + st + '" ');
        await r.fulfill({ response: res, body });
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', st);
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
      const av = page.locator('.sgx-tb-av');
      if (st === 'locked') {
        await expect(av).toHaveAttribute('aria-disabled', 'true');
        await av.click({ force: true });
        await page.waitForTimeout(300);
        await expect(page.locator('#sgx-acct')).not.toHaveAttribute('data-state', 'open');
        expect(new URL(page.url()).pathname).toBe('/zh/wild/');
      } else {
        await page.waitForFunction(() => !document.querySelector('.sgx-tb-av').hasAttribute('aria-disabled'));
        await av.click();
        await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
      }
    }
  });
});
