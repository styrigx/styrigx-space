/**
 * 应用授权 E2E（P3-1 第 3 件；静态构建 + API mock，服务端行为另见 tests/workers/account/account-entrypoints.test.mjs）。
 *
 * 覆盖：
 * - 授权卡页 /account/apps/：5 张卡（应用名、作用域说明、授权时间、授权时设备；设备已删 →「已退出的设备」）；
 *   搜索框按名称过滤；过滤条件「全部 / 已授权 / 已取消授权」带数量；
 *   取消奇趣授权 → grant-revoke（不要复验）→ 卡片变灰、按钮换「重新授权」、「已取消授权」里能看到它；
 *   重新授权 → grant-add 回 401 reauth → 底部弹层验证账号（reauth:true）→ 再 grant-add → 恢复；
 *   没有账号会话（401 account）→ 回账号页登录，登录后回本页；账号总览「设备」「账号安全」同卡有「应用授权」一行
 * - 同意流程（/account/?return=/curio/…）：未登录未授权 → 登录（带 reauth:true）→ 先 grant-list（种子）→ 同意卡片 → 授权（grant-add）→ 回原页面；
 *   已授权 → 登录完直接回原页面，不停在账号卡上；拒绝 → 回原页面且不写记录；已经登录着跳来 → 直接回去；
 *   回原页面按网关 /api/lock-session-check?return= 的 next
 * - 云同步：/api/prefs 403 scope → 账号总览「云同步」一行显示「设置同步未获账号授权，只存本机」
 *
 * 运行：npx playwright test --config=tests/config/playwright.config.js account-apps.spec.js
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('../helpers/helpers');
const fx = require('../../../fixtures/app-grants.cjs');

const SESSION = () => ({ by: 'passkey', authAt: Date.now() - 1000, expiresAt: Date.now() + 3600000 });

/**
 * /api/account 有状态 mock：GET 回账号状态；grant-list / grant-revoke / grant-add 按 grants 改；
 * grant-add 没有「复验票」（reauth=false）→ 401 reauth；login-password / login-passkey 带 reauth:true 时给票。
 * @param {import('@playwright/test').Page} page
 * @param {{session?: boolean, off?: Record<string, boolean>, reauth?: boolean, listStatus?: number}} [o]
 */
async function mockGrants(page, o = {}) {
  const st = { session: o.session !== false, reauth: !!o.reauth, grants: fx.grants(o.off || {}) };
  const calls = [];
  await page.route('**/api/account', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: true, passkey: false, ready: true, configured: true, session: st.session ? SESSION() : null, reauth: null, reset: null }) });
    }
    let b = {};
    try { b = JSON.parse(req.postData() || '{}'); } catch (e) {}
    calls.push(b);
    const reply = (s, j) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(j) });
    if (b.action === 'login-password') {
      st.session = true;
      if (b.reauth === true) st.reauth = true;
      return reply(200, { ok: true });
    }
    if (b.action && b.action.indexOf('grant-') === 0) {
      if (!st.session) return reply(401, { ok: false, error: 'account', reason: 'no-cookie' });
      if (o.listStatus && b.action === 'grant-list') return reply(o.listStatus, { ok: false, error: 'server' });
      const g = st.grants.find((x) => x.app === b.app);
      if (b.action === 'grant-revoke' && g) Object.assign(g, { granted: false, grantedAt: 0, by: '', device: null });
      if (b.action === 'grant-add' && g) {
        if (!st.reauth) return reply(401, { ok: false, error: 'reauth' });
        Object.assign(g, { granted: true, grantedAt: fx.AT, by: 'password', device: { name: 'Galaxy S25 Ultra', gone: false } });
      }
      return reply(200, { ok: true, grants: st.grants });
    }
    if (b.action === 'passkey-list') return reply(200, { ok: true, keys: [] });
    return reply(400, { ok: false, error: 'action' });
  });
  return { st, calls };
}

/** 网关回跳：/api/lock-session-check?return= → next（同站路径原样）；应用页给一个空壳 */
async function mockReturn(page) {
  const asked = [];
  await page.route('**/api/lock-session-check**', (route) => {
    const ret = new URL(route.request().url()).searchParams.get('return') || '';
    asked.push(ret);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, by: 'password', exp: Date.now() + 3600000, next: ret.charAt(0) === '/' ? ret : '/' }) });
  });
  await page.route(/\/(curio|daymark)\/(\?.*|#.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>app</title><p id="app-page">app</p>' }));
  return asked;
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
});

const cards = (page) => page.locator('#acct-apps-list .acct-app-card');
const chip = (page, f) => page.locator(`[data-ga-filter="${f}"]`);

test.describe('授权卡页 /account/apps/', () => {
  test('5 张卡：应用名、作用域说明、授权时间、授权时设备（设备已删 → 已退出的设备）；过滤条件带数量', async ({ page }) => {
    const { calls } = await mockGrants(page);
    await page.goto('/account/apps/', { waitUntil: 'domcontentloaded' });
    await expect(cards(page)).toHaveCount(5);
    expect(calls[0]).toEqual({ action: 'grant-list' });
    await expect(page.locator('.acct-apps-intro')).toHaveText('核查账号授权给各应用的权限。');
    await expect(page.locator('#acct-apps-q')).toHaveAttribute('placeholder', '按名称搜索');
    await expect(cards(page).locator('.acct-app-name')).toHaveText(['奇趣', '日刻', '设置同步', '数字健康', '头像']);
    const curio = page.locator('.acct-app-card[data-app="curio"]');
    await expect(curio).toContainText('添加、修改、删除奇趣里的收藏、设备和游戏（含照片）');
    await expect(curio).toContainText('批量导入书签另要验证账号');
    await expect(curio).toContainText('授权时间');
    await expect(curio).toContainText('2026年11月5日');
    await expect(curio).toContainText('Galaxy S25 Ultra');
    await expect(page.locator('.acct-app-card[data-app="avatar"]')).toContainText('已退出的设备');
    await expect(cards(page).locator('.acct-app-revoke')).toHaveCount(5);
    await expect(chip(page, 'all')).toHaveText('全部 5');
    await expect(chip(page, 'on')).toHaveText('已授权 5');
    await expect(chip(page, 'off')).toHaveText('已取消授权 0');
    await expect(chip(page, 'all')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveTitle(/应用授权/);
  });

  test('搜索框按名称过滤（中英名都比）；没有命中 → 提示', async ({ page }) => {
    await mockGrants(page);
    await page.goto('/account/apps/', { waitUntil: 'domcontentloaded' });
    await expect(cards(page)).toHaveCount(5);
    await page.fill('#acct-apps-q', '日刻');
    await expect(cards(page).locator('.acct-app-name')).toHaveText(['日刻']);
    await page.fill('#acct-apps-q', 'sync');
    await expect(cards(page).locator('.acct-app-name')).toHaveText(['设置同步']);
    await page.fill('#acct-apps-q', '没有这个');
    await expect(cards(page)).toHaveCount(0);
    await expect(page.locator('#acct-apps-empty')).toBeVisible();
    await page.fill('#acct-apps-q', '');
    await expect(cards(page)).toHaveCount(5);
    await expect(page.locator('#acct-apps-empty')).toBeHidden();
  });

  test('取消奇趣授权（不要复验）→ 卡片变灰、按钮换「重新授权」；「已取消授权」里能看到它', async ({ page }) => {
    const { calls } = await mockGrants(page);
    await page.goto('/account/apps/', { waitUntil: 'domcontentloaded' });
    const curio = page.locator('.acct-app-card[data-app="curio"]');
    await curio.locator('.acct-app-revoke').click();
    await expect(curio).toHaveClass(/is-off/);
    await expect(curio.locator('.acct-app-regrant')).toHaveText('重新授权');
    await expect(curio).not.toContainText('授权时间');
    expect(calls.filter((c) => c.action === 'grant-revoke')).toEqual([{ action: 'grant-revoke', app: 'curio' }]);
    await expect(page.locator('#sgx-toast, .sgx-toast').first()).toContainText('已取消奇趣的授权');
    await expect(chip(page, 'on')).toHaveText('已授权 4');
    await expect(chip(page, 'off')).toHaveText('已取消授权 1');
    await chip(page, 'off').click();
    await expect(chip(page, 'off')).toHaveAttribute('aria-pressed', 'true');
    await expect(cards(page).locator('.acct-app-name')).toHaveText(['奇趣']);
    await chip(page, 'on').click();
    await expect(cards(page)).toHaveCount(4);
  });

  test('重新授权要账号复验：grant-add 401 reauth → 弹层验证账号（reauth:true）→ 再 grant-add → 恢复', async ({ page }) => {
    const { calls } = await mockGrants(page, { off: { curio: true } });
    await page.goto('/account/apps/', { waitUntil: 'domcontentloaded' });
    const curio = page.locator('.acct-app-card[data-app="curio"]');
    await expect(curio).toHaveClass(/is-off/);
    await curio.locator('.acct-app-regrant').click();
    const box = page.locator('#acct-app-verify');
    await expect(box.locator('.sgx-credential-row')).toHaveCount(1);
    await box.locator('.sgx-credential-row').filter({ hasText: '账号密码' }).click();
    await box.locator('.sgx-credential-expand input[type="password"]').fill('pw-123456');
    await box.locator('.sgx-credential-btn-primary').click();
    await expect(curio).not.toHaveClass(/is-off/);
    await expect(curio.locator('.acct-app-revoke')).toHaveText('取消授权');
    expect(calls.find((c) => c.action === 'login-password')).toMatchObject({ password: 'pw-123456', reauth: true });
    expect(calls.filter((c) => c.action === 'grant-add').length).toBe(2);
  });

  test('没有账号会话 → 回账号页登录（?return=/account/apps/）', async ({ page }) => {
    await mockGrants(page, { session: false });
    await page.goto('/account/apps/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/account\/\?return=%2Faccount%2Fapps%2F$/);
  });

  test('账号总览：「设备」「账号安全」同卡有「应用授权」一行，进 /account/apps/', async ({ page }) => {
    await mockGrants(page);
    await page.route('**/api/ai', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, default: 'm', canChoose: true, models: [{ id: 'm', label: 'M' }] }) }));
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-main')).toBeVisible();
    const row = page.locator('#acct-apps-row');
    await expect(row).toHaveText(/应用授权/);
    await expect(row).toHaveAttribute('href', '/account/apps/');
    await expect(page.locator('#acct-dev-row').locator('xpath=..')).toContainText('应用授权');
  });

  test('英文：5 张卡、过滤条件、日期', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await mockGrants(page);
    await page.goto('/en/account/apps/', { waitUntil: 'domcontentloaded' });
    await expect(cards(page).locator('.acct-app-name')).toHaveText(['Curio', 'Daymark', 'Settings sync', 'Digital wellbeing', 'Avatar']);
    await expect(chip(page, 'off')).toHaveText('Access removed 0');
    await expect(page.locator('.acct-app-card[data-app="curio"]')).toContainText('Nov 5, 2026');
    await expect(page.locator('.acct-app-card[data-app="avatar"]')).toContainText('Signed-out device');
  });
});

test.describe('同意流程（/account/?return=/curio/…）', () => {
  /** 登录区用密码登录 @param {import('@playwright/test').Page} page */
  async function loginPw(page) {
    await page.click('#acct-login-go');
    await page.click('#acct-pw-btn');
    await page.fill('#acct-pw-input', 'pw-123456');
    await page.click('#acct-pw-go');
  }

  test('奇趣未授权：登录（reauth:true）→ 先 grant-list → 同意卡片（图标、名字、作用域说明、授权 / 拒绝）→ 授权 → 回奇趣原页面', async ({ page }) => {
    const { calls } = await mockGrants(page, { session: false, off: { curio: true } });
    const asked = await mockReturn(page);
    await page.goto('/account/?return=' + encodeURIComponent('/curio/#devices'), { waitUntil: 'domcontentloaded' });
    await loginPw(page);
    const card = page.locator('#acct-consent');
    await expect(card).toBeVisible();
    await expect(page.locator('#acct-consent-title')).toHaveText('允许奇趣使用你的账号？');
    await expect(page.locator('#acct-consent-scopes li')).toHaveText(['添加、修改、删除奇趣里的收藏、设备和游戏（含照片）', '批量导入书签另要验证账号']);
    await expect(page.locator('#acct-consent-ic .acct-ic')).toHaveCount(1);
    await expect(page.locator('#acct-consent-allow')).toHaveText('授权');
    await expect(page.locator('#acct-consent-deny')).toHaveText('拒绝');
    await expect(page.locator('#acct-main')).toBeHidden();
    const actions = calls.map((c) => c.action);
    expect(actions.indexOf('grant-list')).toBeGreaterThan(actions.indexOf('login-password'));
    expect(calls.find((c) => c.action === 'login-password')).toMatchObject({ reauth: true });
    await page.click('#acct-consent-allow');
    await expect(page.locator('#app-page')).toBeVisible();
    expect(new URL(page.url()).pathname + new URL(page.url()).hash).toBe('/curio/#devices');
    expect(calls.filter((c) => c.action === 'grant-add')).toEqual([{ action: 'grant-add', app: 'curio' }]);
    expect(asked).toEqual(['/curio/#devices']);
  });

  test('已授权：登录完直接回原页面，不停在账号卡上、不弹同意卡片', async ({ page }) => {
    const { calls } = await mockGrants(page, { session: false });
    await mockReturn(page);
    await page.goto('/account/?return=' + encodeURIComponent('/daymark/'), { waitUntil: 'domcontentloaded' });
    await loginPw(page);
    await expect(page.locator('#app-page')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/daymark/');
    expect(calls.map((c) => c.action)).toEqual(['login-password', 'grant-list']);
  });

  test('拒绝：回原页面，不写授权记录', async ({ page }) => {
    const { calls, st } = await mockGrants(page, { session: false, off: { curio: true } });
    await mockReturn(page);
    await page.goto('/account/?return=' + encodeURIComponent('/curio/'), { waitUntil: 'domcontentloaded' });
    await loginPw(page);
    await expect(page.locator('#acct-consent')).toBeVisible();
    await page.click('#acct-consent-deny');
    await expect(page.locator('#app-page')).toBeVisible();
    expect(calls.some((c) => c.action === 'grant-add')).toBe(false);
    expect(st.grants.find((g) => g.app === 'curio').granted).toBe(false);
  });

  test('已经登录着从应用页跳来：直接回去，不做授权检查', async ({ page }) => {
    const { calls } = await mockGrants(page, { session: true, off: { curio: true } });
    await mockReturn(page);
    await page.goto('/account/?return=' + encodeURIComponent('/curio/'), { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app-page')).toBeVisible();
    expect(calls.some((c) => c.action === 'grant-list')).toBe(false);
  });

  test('?return= 不是应用页（别的站）→ 不走同意流程，登录后留在账号总览', async ({ page }) => {
    const { calls } = await mockGrants(page, { session: false });
    await page.route('**/api/ai', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, default: 'm', canChoose: true, models: [{ id: 'm', label: 'M' }] }) }));
    await page.goto('/account/?return=' + encodeURIComponent('https://evil.example/curio/'), { waitUntil: 'domcontentloaded' });
    await loginPw(page);
    await expect(page.locator('#acct-main')).toBeVisible();
    expect(calls.find((c) => c.action === 'login-password').reauth).toBeUndefined();
    expect(calls.some((c) => c.action === 'grant-list')).toBe(false);
  });
});

test('云同步：/api/prefs 403 scope（设置同步的授权被取消）→ 账号总览「云同步」显示只存本机', async ({ page }) => {
  await mockGrants(page);
  await page.route('**/api/ai', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, default: 'm', canChoose: true, models: [{ id: 'm', label: 'M' }] }) }));
  await page.route('**/api/prefs', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'scope', scope: 'prefs.sync' }) }));
  /* 测试构建是静态服务器：锁屏已解锁靠改写 HTML 注入（同 account.spec.js 云同步各条） */
  await page.route('**/account/', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/<html([^>]*)>/i, '<html$1 data-sgx-lock-session="valid">');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await page.goto('/account/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#acct-main')).toBeVisible();
  await expect(page.locator('#acct-sync-sub')).toHaveText('设置同步未获账号授权，只存本机');
});
