/**
 * 三站锁屏 / 解锁 / 回跳的端到端回归（真实网关 + 线上路由规则 + 真实域名 + 虚拟认证器）。
 * 测试台见 edge-harness.cjs。每条对应一次真实的用户报告（2026-10-21，三星浏览器录屏）：
 *
 *  R1 直接打开 blog / daymark → 主站锁屏（带 return）→ 通行密钥 / 访客都进不去、回不到子站
 *  R2 主站解锁后刷新又出现锁屏
 *  R3 切到别的标签页再切回，主站自己解锁（cookie 一直有效，锁屏是假的）
 *  R4 访客在 设置 › 安全与隐私 点「锁屏凭证」→ 整个锁屏闪一下又回到设置（应就地弹出站长验证）
 *  R5 已登录账号（站长或访客）点顶栏头像 → 账号页先画「欢迎回来」登录区约 0.5 秒再换成总览
 *  另外：立即锁定之后刷新、去子站都必须仍是锁着的；锁定后已打开的已解锁页面切回来要上锁。
 *
 * 运行：SGX_TEST_SUITE=edge npx playwright test --config=tests/config/playwright.config.js
 * （需要先 hugo --minify -s web 生产构建；需要 openssl）
 */
const { test, expect } = require('@playwright/test');
const { startEdge, LAUNCH } = require('./edge-harness.cjs');

test.use({ launchOptions: { args: LAUNCH.args }, proxy: LAUNCH.proxy, viewport: { width: 412, height: 915 },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });


const MAIN = 'https://styrigx.com';
const BLOG = 'https://blog.styrigx.com';
const DAYMARK = 'https://daymark.styrigx.com';

/** @type {Awaited<ReturnType<typeof startEdge>>} */
let edge;

test.beforeAll(async () => {
  edge = await startEdge();
});
test.afterEach(() => {
  if (process.env.EDGE_DEBUG) for (const l of edge.log) if (!/\/(css|js|fonts|fav)\//.test(l[2])) console.log('[edge]', l.join(' '));
});
test.afterAll(async () => { if (edge) await edge.close(); });

test.beforeEach(async ({ context }) => {
  if (process.env.EDGE_DEBUG) {
    context.on('console', (m) => console.log('[console]', m.text()));
    edge.log.length = 0;
  }
  await context.route((url) => !/^https:\/\/([a-z]+\.)?styrigx\.com\//.test(url.href), (route) => route.abort());
  /* 记下锁屏有没有出现过（哪怕只闪一下）：R4 要求一次都不能出现 */
  await context.addInitScript(() => {
    window.__sawLock = false;
    window.__sawLogin = false;
    window.__sawMain = false;
    const seen = () => {
      if (document.getElementById('sgx-lock')) window.__sawLock = true;
      /* 登录区：节点出现就算（不论是否 hidden）；文案出现也算 */
      if (document.getElementById('acct-login') || (document.body && /欢迎回来|Welcome back/.test(document.body.textContent || ''))) window.__sawLogin = true;
      const m = document.getElementById('acct-main');
      if (m && !m.hidden) window.__sawMain = true;
    };
    new MutationObserver(seen).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  });
});

async function addAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  /* 每个测试一把新钥匙（signCount 各自从 0 起，测试之间不互相影响） */
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: await edge.seedPasskey() });
}

async function setSession(context, role) {
  const value = await edge.mintCookie(role);
  const c = [{ name: 'sgx-verified', value, domain: '.styrigx.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }];
  /* 访客会话要配临时 LockKey 的钥匙票 */
  if (role === 'visitor') c.push({ name: 'sgx-tk', value: await edge.mintTk(), domain: '.styrigx.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
  await context.addCookies(c);
}

async function openMethods(page) {
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
  await page.click('#sgx-lock-avatar');
  await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible({ timeout: 5000 });
}

async function lockShownWithin(page, ms) {
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__sawLock === true || !!document.getElementById('sgx-lock'));
}

async function sessionRole(page) {
  return page.evaluate(() => fetch('/api/session-check', { cache: 'no-store' }).then((r) => r.ok ? r.json() : { ok: false }).then((j) => j.ok ? j.role : null));
}

test('R1 blog 直接打开 → 主站锁屏 → 通行密钥 → 回到 blog 原地址', async ({ page }) => {
  await addAuthenticator(page);
  await page.goto(BLOG + '/post/hello/');
  expect(page.url()).toContain(MAIN + '/?lock=1');
  expect(page.url()).toContain('return=' + encodeURIComponent(BLOG + '/post/hello/'));
  /* 锁屏页本身必须是网关给的（带 data-sgx-session），不能是 Pages 直出 */
  await expect(page.locator('html')).toHaveAttribute('data-sgx-session', 'locked');
  await openMethods(page);
  await page.click('#sgx-mopt-pk');
  await page.waitForURL(BLOG + '/post/hello/', { timeout: 20000 });
  await expect(page.locator('#sub-content')).toContainText('SUBSITE-CONTENT blog');
});

test('R1 daymark 直接打开 → 主站锁屏 → 访客（临时钥匙）→ 回到 daymark', async ({ page }) => {
  const code = await edge.seedTempKey();
  await page.goto(DAYMARK + '/');
  expect(page.url()).toContain(MAIN + '/?lock=1');
  await openMethods(page);
  await page.click('#sgx-mopt-visitor');
  await page.fill('#sgx-temp-input', code.toLowerCase());
  await page.click('#sgx-temp-go');
  await page.waitForURL(DAYMARK + '/', { timeout: 20000 });
  await expect(page.locator('#sub-content')).toContainText('SUBSITE-CONTENT daymark');
  expect(await page.evaluate(() => fetch('/api/session-check').then((r) => r.status))).toBe(200);
});

test('R1 子站首页带任意查询串也必须过网关（未登录 → 302 锁屏，不能直出正文）', async ({ page }) => {
  for (const u of [BLOG + '/?utm=1', DAYMARK + '/?x=1', MAIN + '/?x=1']) {
    await page.goto(u);
    expect(page.url(), u).toContain(MAIN + '/');
    await expect(page.locator('#sub-content')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-sgx-session', 'locked');
  }
});

test('R2 主站解锁（通行密钥）→ 刷新仍是解锁的', async ({ page }) => {
  await addAuthenticator(page);
  await page.goto(MAIN + '/?lock=1');
  await openMethods(page);
  await page.click('#sgx-mopt-pk');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-session', 'valid', { timeout: 20000 });
  await expect(page.locator('#sgx-lock')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-sgx-session', 'valid');
  await page.evaluate(() => { window.__sawLock = false; });
  expect(await lockShownWithin(page, 1500)).toBe(false);
});

test('R2/R3 有效会话打开 /?lock=1（立即锁定、子站踢回都会落到这里）→ 不出锁屏', async ({ page, context }) => {
  await setSession(context, 'owner');
  await page.goto(MAIN + '/?lock=1');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-session', 'valid');
  expect(await lockShownWithin(page, 1500)).toBe(false);
});

test('R3 子站踢回（why=no-cookie）但主站会话有效 → 直接回子站，不出锁屏', async ({ page, context }) => {
  await setSession(context, 'owner');
  await page.goto(MAIN + '/?lock=1&why=no-cookie&return=' + encodeURIComponent(DAYMARK + '/'));
  await page.waitForURL(DAYMARK + '/', { timeout: 15000 });
  await expect(page.locator('#sub-content')).toContainText('SUBSITE-CONTENT daymark');
});

test('R3 已解锁页面：别的标签页立即锁定后，切回来要上锁（状态只听服务端）', async ({ page, context }) => {
  await setSession(context, 'owner');
  await page.goto(MAIN + '/');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-session', 'valid');
  /* 切走再切回：会话有效 → 不出锁屏 */
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(await lockShownWithin(page, 800)).toBe(false);
  /* 另一个标签页立即锁定 */
  const other = await context.newPage();
  await other.goto(MAIN + '/settings/security/');
  await other.evaluate(() => fetch('/api/lock', { method: 'POST' }));
  await other.close();
  await page.waitForTimeout(5200); /* 自动锁检查节流 5 秒 */
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('html')).toHaveAttribute('data-sgx-session', 'locked');
});

test('立即锁定 → 刷新仍锁定；子站也锁定', async ({ page, context }) => {
  await setSession(context, 'owner');
  await page.goto(MAIN + '/settings/security/');
  await page.click('#sec-locknow');
  await page.click('#sec-locknow-confirm [data-act="ok"]');
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 10000 });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-sgx-session', 'locked');
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 10000 });
  await page.goto(BLOG + '/');
  expect(page.url()).toContain(MAIN + '/?lock=1');
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 10000 });
});

test('R4 访客点「锁屏凭证」→ 就地站长验证（不出锁屏、不跳页）；取消仍是访客；通行密钥通过 → 锁屏凭证页', async ({ page, context }) => {
  await addAuthenticator(page);
  await setSession(context, 'visitor');
  await page.goto(MAIN + '/settings/security/');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-role', 'visitor');
  const navs = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) { navs.push(f.url()); if (process.env.EDGE_DEBUG) console.log('[nav]', f.url()); } });
  await page.click('#sec-lock-cred');
  const sheet = page.locator('#sgx-upgrade-overlay');
  await expect(sheet).toBeVisible({ timeout: 5000 });
  /* 只给站长方式：通行密钥、密码；没有访客入口 */
  await expect(page.locator('#sgx-upgrade-pk')).toBeVisible();
  await expect(page.locator('#sgx-upgrade-pw')).toBeVisible();
  await expect(sheet.locator('text=访客')).toHaveCount(0);
  expect(navs).toEqual([]);
  expect(await lockShownWithin(page, 300)).toBe(false);
  /* 取消：留在原页，访客会话不丢 */
  await page.click('#sgx-upgrade-cancel');
  await expect(sheet).toHaveCount(0);
  expect(page.url()).toBe(MAIN + '/settings/security/');
  expect(await sessionRole(page)).toBe('visitor');
  /* 再点 → 通行密钥 → 站长会话 → 锁屏凭证页 */
  await page.click('#sec-lock-cred');
  await expect(sheet).toBeVisible({ timeout: 5000 });
  await page.click('#sgx-upgrade-pk');
  await page.waitForURL(MAIN + '/settings/security/lock/', { timeout: 20000 });
  expect(await sessionRole(page)).toBe('owner');
  expect(await page.evaluate(() => window.__sawLock === true)).toBe(false);
});

test('R4 访客直接打开锁屏凭证页地址 → 不出锁屏，出站长验证', async ({ page, context }) => {
  await setSession(context, 'visitor');
  await page.goto(MAIN + '/settings/security/lock/');
  await expect(page.locator('#sgx-upgrade-overlay')).toBeVisible({ timeout: 10000 });
  expect(await lockShownWithin(page, 500)).toBe(false);
  expect(await sessionRole(page)).toBe('visitor');
});

test('R5 访客（临时钥匙会话）打开账号页：302 回首页，账号页一帧都不出现', async ({ page, context }) => {
  await setSession(context, 'visitor');
  await context.addCookies([{ name: 'sgx-account', value: await edge.mintAccount(), domain: 'styrigx.com', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
  await page.goto(MAIN + '/account/');
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await page.evaluate(() => window.__sawLogin || window.__sawMain)).toBe(false);
  await expect(page.locator('html')).toHaveAttribute('data-sgx-role', 'visitor');
});

for (const role of ['owner']) {
  test(`R5 已登录账号（锁屏会话 ${role}）进账号页：登录区一帧都不出现（不下发节点），总览首帧可见`, async ({ page, context }) => {
    await setSession(context, role);
    await context.addCookies([{ name: 'sgx-account', value: await edge.mintAccount(), domain: 'styrigx.com', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    await page.goto(MAIN + '/account/', { waitUntil: 'commit' });
    await page.waitForLoadState('domcontentloaded');
    /* 解析完那一刻：登录区节点不存在、总览不是 hidden（不靠脚本） */
    expect(await page.evaluate(() => window.__sawLogin)).toBe(false);
    await expect(page.locator('#acct-main')).toBeVisible();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.__sawLogin)).toBe(false);
    await expect(page.locator('html')).toHaveAttribute('data-sgx-account', 'in');
    await expect(page.locator('#acct-main')).toBeVisible();
    await expect(page.locator('#acct-login')).toHaveCount(0);
  });
}

test('R5 对照：站长没有账号会话 → 只出登录区（欢迎回来），总览不出现', async ({ page, context }) => {
  await setSession(context, 'owner');
  await page.goto(MAIN + '/account/');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-account', 'out');
  await expect(page.locator('#acct-login')).toBeVisible();
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__sawMain)).toBe(false);
});

test('R7 账号 Worker（2026-10-24 拆出来）：头像 / 数字健康 / 云同步走 styrigx-account，页面和其他接口仍走网关', async ({ page, context }) => {
  edge.log.length = 0;
  /* 锁着：锁屏头像照常出来（公开），由账号 Worker 回 */
  await page.goto(MAIN + '/');
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
  const av = await page.evaluate(() => fetch('/avatar/96.webp', { cache: 'no-store' }).then((r) => [r.status, r.headers.get('x-sgx-runtime'), r.headers.get('etag')]));
  expect(av).toEqual([200, 'account', '"d-96"']);
  const anon = await page.evaluate(() => fetch('/api/wellbeing', { cache: 'no-store' }).then((r) => r.status));
  expect(anon).toBe(401);
  /* 站长：数字健康可读，云同步没登账号 → 401 account；接口地址不变 */
  await setSession(context, 'owner');
  await page.goto(MAIN + '/settings/wellbeing/');
  const wb = await page.evaluate(() => fetch('/api/wellbeing?d=2026-10-24', { cache: 'no-store' }).then((r) => r.json().then((j) => [r.status, j.ok])));
  expect(wb).toEqual([200, true]);
  const pr = await page.evaluate(() => fetch('/api/prefs', { cache: 'no-store' }).then((r) => r.json().then((j) => [r.status, j.error])));
  expect(pr).toEqual([401, 'account']);
  const by = (re) => edge.log.filter((l) => re.test(new URL(l[2]).pathname)).map((l) => l[0]);
  expect(new Set(by(/^\/(avatar\/|api\/(wellbeing|prefs|avatar))/))).toEqual(new Set(['account']));
  expect(new Set(by(/^\/(settings\/wellbeing\/|api\/session-check)$/))).toEqual(new Set(['worker']));
});

/* R8 顶栏三栏页内切换（2026-10-24，shell/inpage-tabs.js）：真实网关下，有效会话时另外两栏在同一文档里切换；
   取回来的不是这一栏（会话过期 → 302 锁屏）就不用它，整页导航交给网关；锁屏态根本不接管（照旧整页导航）。 */
test('R8 有效会话：主页 → 聊天 → 设置 同一文档切换，网关照常验会话；取页时会话没了 → 整页导航到锁屏', async ({ page, context }) => {
  await setSession(context, 'owner');
  await page.goto(MAIN + '/');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-session', 'valid');
  await page.evaluate(() => { window.__sameDoc = 1; });
  await page.click('.sgx-tb-tab[data-tab="chat"]');
  await expect(page.locator('.sgx-tb-tab[data-tab="chat"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#chat-root')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/chat/');
  await page.click('.sgx-tb-tab[data-tab="settings"]');
  await expect(page.locator('.sgx-tb-tab[data-tab="settings"]')).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => [window.__sameDoc, location.pathname, document.title])).toEqual([1, '/settings/', '设置 | Styrigx']);
  /* 预取的 HTML 也是经网关拿的（带会话、验过的） */
  expect(edge.log.some((l) => l[0] === 'worker' && new URL(l[2]).pathname === '/chat/')).toBe(true);

  /* 新开一页（省流量模式：不预取，点了才取）：会话在点之前没了 → 取 /chat/ 时网关 302 锁屏 → 不用它 → 整页导航 → 锁屏（带 return） */
  const p2 = await context.newPage();
  await p2.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get: () => ({ saveData: true }) });
  });
  await p2.goto(MAIN + '/');
  await expect(p2.locator('html')).toHaveAttribute('data-sgx-session', 'valid');
  await p2.evaluate(() => { window.__sameDoc = 1; });
  await p2.waitForTimeout(1200);
  await context.clearCookies();
  await p2.click('.sgx-tb-tab[data-tab="chat"]');
  await p2.waitForURL((u) => u.pathname === '/' && u.searchParams.get('return') === '/chat/', { timeout: 15000 });
  await expect(p2.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
  expect(await p2.evaluate(() => window.__sameDoc)).toBeUndefined();
  await p2.close();
});

test('R8 锁屏态不接管顶栏三栏：点标签照旧整页导航（网关 302 锁屏，带 return）', async ({ page }) => {
  await page.goto(MAIN + '/');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-session', 'locked');
  await page.evaluate(() => { window.__sameDoc = 1; });
  await page.evaluate(() => /** @type {HTMLAnchorElement} */ (document.querySelector('.sgx-tb-tab[data-tab="chat"]')).click());
  await page.waitForURL((u) => u.searchParams.get('return') === '/chat/', { timeout: 15000 });
  expect(await page.evaluate(() => window.__sameDoc)).toBeUndefined();
});

/* ---------------- R9 分享短链（2026-10-24，styrigx-share）：/s/* 经线上路由规则进短链 Worker，钥匙和会话由网关签 ---------------- */

async function setOwnerAccount(context) {
  await setSession(context, 'owner');
  await context.addCookies([{ name: 'sgx-account', value: await edge.mintAccount(), domain: 'styrigx.com', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
}

/** 站长在页面里调 /api/share（同源 fetch，带真实 cookie） */
async function shareApi(page, body) {
  return page.evaluate((b) => fetch('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) })), body);
}

/** 站长建一条短链，然后清掉所有 cookie（变成没登录的陌生人） */
async function makeLink(page, context, body) {
  await setOwnerAccount(context);
  await page.goto(MAIN + '/account/temp-keys/');
  const r = await shareApi(page, Object.assign({ action: 'create' }, body));
  expect(r.s, JSON.stringify(r.j)).toBe(200);
  await context.clearCookies();
  return r.j.link;
}

test.describe('R9 分享短链', () => {
  test.beforeEach(async () => { await edge.resetShareLimit(); });

  test('R9 站长在账号页生成带会话短链 → 陌生人点开：直接以访客进到目标页，不出锁屏；地址栏 / Referer 里没有码', async ({ page, context }) => {
    await setOwnerAccount(context);
    await page.goto(MAIN + '/account/temp-keys/');
    await page.click('#acct-sl-new');
    await expect(page.locator('#sl-dlg')).toBeVisible();
    await page.fill('#sl-name', '小明');
    await page.selectOption('#sl-dur', 'h6');
    await page.fill('#sl-to', '/settings/');
    await page.selectOption('#sl-sess', '3600');
    await page.click('#sl-go');
    await expect(page.locator('#sl-done')).toBeVisible();
    const url = (await page.locator('#sl-url').textContent()).trim();
    expect(url).toMatch(/^https:\/\/styrigx\.com\/s\/[A-Za-z0-9_-]{22}$/);
    const code = url.split('/s/')[1];
    await expect(page.locator('#acct-sl-list .sl-item')).toHaveCount(1);

    await context.clearCookies();
    edge.log.length = 0;
    const refs = [];
    page.on('request', (r) => { if (r.isNavigationRequest()) refs.push([r.url(), r.headers()['referer'] || '']); });
    await page.goto(url);
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(page.url()).toBe(MAIN + '/settings/');
    expect(await lockShownWithin(page, 600)).toBe(false);
    expect(await sessionRole(page)).toBe('visitor');
    expect(edge.log.find((l) => l[2].includes('/s/'))[0]).toBe('share');
    for (const [u, ref] of refs) {
      if (u.includes('/s/')) continue;
      expect(u).not.toContain(code);
      expect(ref).not.toContain(code);
    }
    expect(await page.evaluate(() => location.href + document.referrer)).not.toContain(code);
    /* 访客和临时钥匙访客一样：进不了账号页、管不了短链 */
    await page.goto(MAIN + '/account/temp-keys/');
    expect(new URL(page.url()).pathname).toBe('/');
    const api = await shareApi(page, { action: 'list' });
    expect(api.s).toBe(403);
  });

  test('R9 普通短链 → 没解锁的人到目标页照常出锁屏（return 是目标页）', async ({ page, context }) => {
    const link = await makeLink(page, context, { hours: 2, to: '/settings/' });
    await page.goto(MAIN + link.path);
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    const u = new URL(page.url());
    expect(u.pathname).toBe('/');
    expect(u.searchParams.get('return')).toBe('/settings/');
    expect(page.url()).not.toContain(link.path.slice(3));
    expect(await sessionRole(page)).toBe(null);
  });

  test('R9 作废 / 过期 / 不存在：同一个结果（锁屏 /?lock=1）；作废带会话的短链后，已进来的访客下一页就被锁在外面', async ({ page, context }) => {
    const live = await makeLink(page, context, { hours: 3, session: 1800 });
    await page.goto(MAIN + live.path);
    expect(await sessionRole(page)).toBe('visitor');
    /* 站长作废（另开一个页面登录站长，访客那一页的 cookie 不动） */
    const owner = await context.browser().newContext({ proxy: LAUNCH.proxy, ignoreHTTPSErrors: false });
    const op = await owner.newPage();
    await setOwnerAccount(owner);
    await op.goto(MAIN + '/account/temp-keys/');
    expect((await shareApi(op, { action: 'revoke', id: live.id })).s).toBe(200);
    const expired = (await shareApi(op, { action: 'create', hours: 1 })).j.link;
    if (edge.shareDb.raw) edge.shareDb.raw.prepare('UPDATE share_link SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id);
    else edge.shareDb._links.get(expired.id).expires_at = Date.now() - 1;
    await owner.close();

    await page.goto(MAIN + '/settings/');
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    expect(await sessionRole(page)).toBe(null);

    const finals = [];
    for (const p of [live.path, expired.path, '/s/AAAAAAAAAAAAAAAAAAAAAA', '/s/nope']) {
      await context.clearCookies();
      const resp = [];
      const h = (r) => { if (r.url().includes('/s/')) resp.push(r.status() + ' ' + (r.headers()['location'] || '') + ' ' + (r.headers()['cache-control'] || '')); };
      page.on('response', h);
      await page.goto(MAIN + p);
      page.off('response', h);
      await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
      finals.push([page.url(), resp.join('|')]);
    }
    for (const f of finals) expect(f).toEqual([MAIN + '/?lock=1', '302 https://styrigx.com/?lock=1 private, no-store']);
  });

  test('R9 开放重定向被拒：目标只能是站内相对路径', async ({ page, context }) => {
    await setOwnerAccount(context);
    await page.goto(MAIN + '/account/temp-keys/');
    for (const to of ['//evil.example', 'https://evil.example/', '/\\evil.example', 'evil.example', 'javascript:alert(1)']) {
      const r = await shareApi(page, { action: 'create', hours: 1, to });
      expect(r.s, to).toBe(400);
      expect(r.j.error, to).toBe('target');
    }
    /* 页面上填了也一样：弹层报错，不生成 */
    await page.click('#acct-sl-new');
    await page.fill('#sl-to', 'https://evil.example/');
    await page.click('#sl-go');
    await expect(page.locator('#sl-err')).toBeVisible();
    await expect(page.locator('#sl-done')).toBeHidden();
  });

  test('R9 限速：同一来源连续 10 次打不开 → 15 分钟内真短链也打不开（同一个失败结果）', async ({ page, context }) => {
    const link = await makeLink(page, context, { hours: 2, session: 1800 });
    for (let i = 0; i < 10; i++) {
      const r = await page.request.get(MAIN + '/s/' + 'B'.repeat(21) + String.fromCharCode(65 + i), { maxRedirects: 0, ignoreHTTPSErrors: true });
      expect(r.status()).toBe(302);
      expect(r.headers()['location']).toBe('https://styrigx.com/?lock=1');
    }
    const r = await page.request.get(MAIN + link.path, { maxRedirects: 0, ignoreHTTPSErrors: true });
    expect(r.status()).toBe(302);
    expect(r.headers()['location']).toBe('https://styrigx.com/?lock=1');
    expect(r.headers()['set-cookie'] || '').toBe('');
    await edge.resetShareLimit();
    const ok = await page.request.get(MAIN + link.path, { maxRedirects: 0, ignoreHTTPSErrors: true });
    expect(ok.headers()['location']).toBe('https://styrigx.com/');
    expect(ok.headers()['set-cookie'] || '').toContain('sgx-tk=');
  });
});
