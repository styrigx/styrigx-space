/**
 * 三站锁屏 / 解锁 / 回跳的端到端回归（真实网关 + 线上路由规则 + 真实域名 + 虚拟认证器）。
 * 测试台见 edge-harness.cjs。每条对应一次真实的用户报告（2026-10-21，三星浏览器录屏）：
 * v5 S3（整站放开）：页面对没进站的人也照常给（网关只注入 data-sgx-lock-session="locked"，不 302 锁屏）；
 *  v5 S5（终端合一）：锁屏界面删了，旧锁屏地址 /?entry（旧 ?lock）= 打开终端、预填 sudo styrigx；在终端里 sudo styrigx → passkey，
 *  进站后按 return 回原页。下面「锁屏出现」= 终端输入行被预填了 sudo styrigx（访客入口），「锁屏不出现」= 一次都没预填。
 *
 *  R1 直接打开 blog / daymark → 主站锁屏（带 return）→ 通行密钥 / 分享链接（v5 S1 起取代临时钥匙）都进不去、回不到子站
 *  R2 主站解锁后刷新又出现锁屏
 *  R3 切到别的标签页再切回，主站自己解锁（cookie 一直有效，锁屏是假的）
 *  R4 （P2-3 改写；v5 S5 盾牌并进终端）分享链接进门的人点盾牌 → 终端 nobody@space:~#，钥匙命令先拦一句（不能 reauth / 改凭据）；进站入口不闪
 *  R5 已登录账号点顶栏头像 → 账号页先画「欢迎回来」登录区约 0.5 秒再换成总览；分享链接进门的人打开账号页看到登录页
 *     （2026-11-08 账号 UI 改版：/account/ 301 → 首页 #acct，改验账号终端：已登录直接主页、不出登录选项）
 *  P2-3：带 v1（6 段）cookie 打开任意页 → 访客态（v5 S3 前是 302 锁屏）、不报错、不循环 → 锁屏解锁后回到原页，过程中不清 cookie；
 *        子站分享：新建要锁屏密码 / 通行密钥进的门（分享链接进来的 403 link，v5 S1），列表要 reauth（L1，Q3）。
 *  v5 S1：临时钥匙删除（前端入口 S5 删了）；分享链接带的会话 by=link。
 *  另外：立即锁定之后刷新、去子站都必须仍是锁着的；锁定后已打开的已解锁页面切回来要上锁。
 *
 * 运行：SGX_TEST_SUITE=edge npx playwright test --config=tests/config/playwright.config.js
 * （需要先 hugo --minify -s space/web 生产构建；需要 openssl）
 */
const { test, expect } = require('@playwright/test');
const { startEdge, LAUNCH } = require('../helpers/edge-harness.cjs');
const { addVirtualAuth } = require('../helpers/preview-helpers.cjs');

test.use({ launchOptions: { args: LAUNCH.args }, proxy: LAUNCH.proxy, viewport: { width: 412, height: 915 },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  timezoneId: 'Asia/Shanghai', locale: 'en-US' });
/* P4-3 PR-4c：英文默认、中文 /zh/。网关的锁屏地址是默认语言的 /?lock=1，这里用英文浏览器，地址就是网关给的那个，不经首帧语言跳转；
   中文浏览器（跳到 /zh/?lock=1、再回跳）那条路在文件末尾「中文浏览器」一组单独测 */


const MAIN = 'https://styrigx.com';
/* 合并 PR3：子站在主域名的 /blog/ /daymark/ 下（旧图志域名的 301 已于 P4-3 PR-1 删除） */
const BLOG = 'https://styrigx.com/blog';
const DAYMARK = 'https://styrigx.com/daymark';

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
  /* 记下进站入口有没有出现过（哪怕只闪一下）：v5 S5 起 = 终端输入行被预填 sudo styrigx（输入框的值不触发 MutationObserver，轮询看）；R4 要求一次都不能出现 */
  await context.addInitScript(() => {
    window.__sawLock = false;
    window.__sawLogin = false;
    window.__sawMain = false;
    const seen = () => {
      if (sudoPrefilled()) window.__sawLock = true;
      /* 登录区：节点出现就算（不论是否 hidden）；文案出现也算 */
      /* 只看可见文字：<script> 里的页面字符串表（#sgx-i18n-core 有锁屏的「欢迎回来」，语言包化 2026-11-07）不算 */
      const visibleText = () => {
        if (!document.body) return '';
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentNode && /^(SCRIPT|STYLE|TEMPLATE)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
        let out = '';
        while (w.nextNode()) out += w.currentNode.nodeValue;
        return out;
      };
      /* 2026-11-08 账号终端：登录 = sudo root 的选方式（[data-at-pick]）或旧登录区；主页 = 终端 home 层 */
      if (document.getElementById('acct-login') || document.querySelector('#sgx-acct [data-at-pick]') || /欢迎回来|Welcome back/.test(visibleText())) window.__sawLogin = true;
      const m = document.getElementById('acct-main');
      if ((m && !m.hidden) || document.querySelector('#sgx-acct .sgx-at[data-at-layer="home"]')) window.__sawMain = true;
    };
    const sudoPrefilled = () => Array.prototype.some.call(document.querySelectorAll('[data-term-in]'), (el) => el.value === 'sudo styrigx');
    new MutationObserver(seen).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-at-layer'] });
    setInterval(() => { if (sudoPrefilled()) window.__sawLock = true; }, 50);
  });
});

async function addAuthenticator(page) {
  const { cdp, authenticatorId } = await addVirtualAuth(page, { uv: true });
  /* 每个测试一把新钥匙（signCount 各自从 0 起，测试之间不互相影响） */
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: await edge.seedPasskey() });
}

async function setSession(context, by) {
  const value = await edge.mintCookie(by);
  /* 分享链接进门的会话（by=link）票里带 linkId：mintCookie('link') 用测试库预置的那条有效分享链接 */
  const c = [{ name: 'sgx-space-session', value, domain: '.styrigx.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }];
  await context.addCookies(c);
}

/** 当前页的全站终端（v5 S5）：主页是首屏那个 #home-term，其他页是顶栏打开的窗口 #sgx-term */
const termIn = (page) => page.locator('#home-term-in, #sgx-term[open] #sgx-term-in').first();
const termOut = (page) => page.locator('#home-term [data-term-out], #sgx-term[open] [data-term-out]').first();
const termPs = (page) => page.locator('#home-term [data-term-ps], #sgx-term[open] [data-term-ps]').first();
const termMode = (page) => page.locator('#home-term [data-term-form], #sgx-term[open] [data-term-form]').first();

/* v5 S5：旧锁屏地址 = 打开终端、预填 sudo styrigx（不替人回车），等输入行可用 */
async function openMethods(page) {
  await expect(termIn(page)).toHaveValue('sudo styrigx', { timeout: 15000 });
  await expect(termIn(page)).toBeEditable({ timeout: 15000 });
  await expect(page.locator('#sgx-entry')).toHaveCount(0);
}

/** 终端里进站：sudo styrigx → [pick] passkey（虚拟认证器） */
async function unlockPasskey(page) {
  const inp = termIn(page);
  await inp.fill('sudo styrigx');
  await inp.press('Enter');
  await expect(termMode(page)).toHaveAttribute('data-mode', 'pick', { timeout: 15000 });
  await inp.fill('passkey');
  await inp.press('Enter');
}

/** 盾牌（v5 S5：= 打开终端）：点顶栏盾牌，等终端窗口打开 */
async function openShield(page) {
  await page.locator('.sgx-tb-shield').click();
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '', { timeout: 10000 });
}
/** @param {import('@playwright/test').Page} page @param {string} text */
async function termCmd(page, text) {
  const inp = termIn(page);
  await expect(inp).toBeEditable({ timeout: 10000 });
  await inp.fill(text);
  await inp.press('Enter');
}

async function lockShownWithin(page, ms) {
  // TODO(C8): 「ms 内进站入口一次都没出现」是静默窗口：终端身份异步向真实网关确认（自动锁检查还有 5 秒节流），
  // 「确认完、不预填」在页面上没有可观察的状态；要确定性就得在生产代码里加完成标记。保留原等待。
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__sawLock === true || Array.prototype.some.call(document.querySelectorAll('[data-term-in]'), (el) => el.value === 'sudo styrigx'));
}

/** 当前锁屏会话的进门方式（/api/lock-session-check 的 by；没进门 = null） */
async function sessionBy(page) {
  return page.evaluate(() => fetch('/api/lock-session-check', { cache: 'no-store' }).then((r) => r.ok ? r.json() : { ok: false }).then((j) => j.ok ? j.by : null));
}

/** 塞一张锁侧复验票（sgx-space-reauth，host-only、SameSite=Strict，同网关下发的属性） */
async function setReauth(context) {
  await context.addCookies([{ name: 'sgx-space-reauth', value: await edge.mintReauth(), url: MAIN + '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
}

test('R1 blog 直接打开（v5 S3：公开，网关注入 locked）→ 旧锁屏地址（?entry=1&return=原页）= 终端预填 sudo styrigx → 通行密钥 → 回到 blog 原地址', async ({ page }) => {
  await addAuthenticator(page);
  await page.goto(BLOG + '/post/hello/');
  expect(page.url()).toBe(BLOG + '/post/hello/');
  /* 页面必须是网关给的（带 data-sgx-lock-session），不能是 Pages 直出 */
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
  await expect(page.locator('#sub-content')).toContainText('SUBSITE-CONTENT blog');
  await page.goto(MAIN + '/?entry=1&return=' + encodeURIComponent(BLOG + '/post/hello/'));
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
  await openMethods(page);
  await unlockPasskey(page);
  await page.waitForURL(BLOG + '/post/hello/', { timeout: 20000 });
  await expect(page.locator('#sub-content')).toContainText('SUBSITE-CONTENT blog');
});

test('R1 daymark 直接打开（公开）；点开带会话的分享链接（v5 S1：by=link）→ 不出锁屏、直接到 daymark，已进站', async ({ page }) => {
  const link = await edge.seedShareLink({ to: '/daymark/', sessionSec: 3600 });
  await page.goto(DAYMARK + '/');
  expect(page.url()).toBe(DAYMARK + '/');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
  await page.goto(MAIN + link.path);
  await page.waitForURL(DAYMARK + '/', { timeout: 20000 });
  await expect(page.locator('#sub-content')).toContainText('SUBSITE-CONTENT daymark');
  /* 合并 PR3：子站和主站同源，/api/lock-session-check 由主站路由回答（有效 200 {ok:true}） */
  const check = await page.evaluate(() => fetch('/api/lock-session-check').then(async (r) => ({ status: r.status, body: await r.json() })));
  expect(check.status).toBe(200);
  expect(check.body.ok).toBe(true);
  expect(check.body.by).toBe('link');
  await edge.shareDb.prepare('DELETE FROM share_link WHERE id = ?1').bind(link.id).run();
});

test('R1 子站首页带任意查询串也过网关（v5 S3：公开页照常给，带网关注入的 locked 标记、不 302、不出锁屏）', async ({ page }) => {
  for (const u of [BLOG + '/?utm=1', DAYMARK + '/?x=1']) {
    await page.goto(u);
    expect(page.url(), u).toBe(u);
    await expect(page.locator('#sub-content')).toHaveCount(1);
    await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
  }
  await page.goto(MAIN + '/?x=1');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
  expect(await lockShownWithin(page, 800)).toBe(false);
});

test('R2 主站解锁（通行密钥）→ 刷新仍是解锁的', async ({ page }) => {
  await addAuthenticator(page);
  await page.goto(MAIN + '/?lock=1');
  await openMethods(page);
  await unlockPasskey(page);
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'valid', { timeout: 20000 });
  await expect(page.locator('#sgx-entry')).toHaveCount(0, { timeout: 10000 });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'valid');
  await page.evaluate(() => { window.__sawLock = false; });
  expect(await lockShownWithin(page, 1500)).toBe(false);
});

test('R2/R3 有效会话打开 /?lock=1（旧书签 / 立即锁定落到 ?entry 的同一条）→ 不出锁屏', async ({ page, context }) => {
  await setSession(context, 'password');
  await page.goto(MAIN + '/?lock=1');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'valid');
  expect(await lockShownWithin(page, 1500)).toBe(false);
});

test('R3 主站会话有效打开 /?entry=1&return=子站（访客 sudo styrigx 的地址，在别的标签页已进站）→ 网关 302 回子站，不出锁屏', async ({ page, context }) => {
  await setSession(context, 'password');
  await page.goto(MAIN + '/?entry=1&return=' + encodeURIComponent(DAYMARK + '/'));
  await page.waitForURL(DAYMARK + '/', { timeout: 15000 });
  await expect(page.locator('#sub-content')).toContainText('SUBSITE-CONTENT daymark');
});

test('R3 已解锁页面：别的标签页立即锁定后，切回来要上锁（状态只听服务端）', async ({ page, context }) => {
  await setSession(context, 'password');
  await page.goto(MAIN + '/');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'valid');
  /* 切走再切回：会话有效 → 不出锁屏 */
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(await lockShownWithin(page, 800)).toBe(false);
  /* 另一个标签页立即锁定 */
  const other = await context.newPage();
  await other.goto(MAIN + '/wild/');
  await other.evaluate(() => fetch('/api/lock-now', { method: 'POST' }));
  await other.close();
  // TODO(C8): 等的是 lock-guard.js checkSessionForAutoLock 的 5 秒节流（按页面 Date.now() 算）过去。这个用例连真实网关，
  // 中途装 page.clock 会连锁屏 UI 的计时器一起换掉，风险大；生产代码没有可读的节流时刻。保留原等待。
  await page.waitForTimeout(5200); /* 自动锁检查节流 5 秒 */
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  /* v5 S3：401 → 重载，服务端画访客态（不画锁屏） */
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked', { timeout: 10000 });
  await expect(page.locator('#sgx-entry')).toHaveCount(0);
});

test('立即锁定（终端 lock，一敲就锁、没有确认层）→ 同一页重新取（访客态）→ 刷新仍锁定；子站是访客态（v5 S3：公开，标记 locked）', async ({ page, context }) => {
  await setSession(context, 'password');
  await page.goto(MAIN + '/wild/');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'valid');
  await openShield(page);
  await expect(termPs(page)).toHaveText('styrigx@space:~/wild#', { timeout: 10000 });
  await termCmd(page, 'lock');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked', { timeout: 10000 });
  expect(new URL(page.url()).pathname).toBe('/wild/');
  expect(await sessionBy(page)).toBe(null);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
  await openShield(page);
  await expect(termIn(page)).toHaveValue('sudo styrigx', { timeout: 10000 });
  await page.goto(BLOG + '/');
  expect(page.url()).toBe(BLOG + '/');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
  expect(await sessionBy(page)).toBe(null);
});

test('R4 分享链接进门的人点盾牌 → 终端 nobody@space:~/wild#；sudo -v / lock passkey 先拦一句（不能 reauth / 改凭据）；进站入口不闪', async ({ page, context }) => {
  await setSession(context, 'link');
  await page.goto(MAIN + '/wild/');
  expect(await page.locator('html').getAttribute('data-sgx-role')).toBe(null); // old-name guard
  await openShield(page);
  await expect(termPs(page)).toHaveText('nobody@space:~/wild#', { timeout: 10000 });
  for (const c of ['sudo -v', 'lock passkey']) {
    await termCmd(page, c);
    await expect(termOut(page).locator('.sgx-term-err').last()).toHaveText('a share-link session can’t do this · enter with your own key', { timeout: 10000 });
  }
  await expect(termOut(page).locator('[data-term-pick]')).toHaveCount(0);
  expect(await lockShownWithin(page, 300)).toBe(false);
  await expect(page.locator('#sgx-upgrade-overlay')).toHaveCount(0);
  expect(await sessionBy(page)).toBe('link');
  /* 旧地址 /security/lock/ → 301 /#sec=keys：打开终端（主页上是首屏那个），hash 去掉，同样不预填 */
  await page.goto(MAIN + '/security/lock/');
  await expect(page.locator('#home-term [data-term-ps]')).toHaveText('nobody@space:~#', { timeout: 10000 });
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).hash).toBe('');
  expect(await lockShownWithin(page, 300)).toBe(false);
});

test('R5 分享链接进门的人打开旧账号页 /account/：301 → /#acct，账号终端以未登录打开（sudo root），不 302 锁屏', async ({ page, context }) => {
  await setSession(context, 'link');
  await page.goto(MAIN + '/account/');
  /* 2026-11-08 账号 UI 改版：没有 /account/ 整页了（_redirects 301 → 首页 #acct），hash 打开后被去掉 */
  await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open', { timeout: 15000 });
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('#sgx-acct')).toHaveAttribute('data-acct-state', 'guest');
  await expect(page.locator('#sgx-acct [data-at-log]')).toContainText('sudo root');
  /* 测试台的账号库是空的（没设 account password / passkey）：sudo root 不列选项，提示用 sudo root reset 设第一把（session.js A12 / A13）；
     列选项的那一支由默认组 session.spec.js（mock 状态）覆盖 */
  await expect(page.locator('#sgx-acct [data-at-log]')).toContainText('sudo root reset');
  await expect(page.locator('#sgx-acct [data-at-pick]')).toHaveCount(0);
  expect(await sessionBy(page)).toBe('link');
});

test('P2-3 带 v1 cookie 打开旷野子页 /wild/ 和子站内页 → 访客态（v5 S3：200、标记 locked、不跳、不循环）；接口 401 → 锁屏（带 return）通行密钥解锁后回到原页，过程中不清 cookie', async ({ page, context }) => {
  await addAuthenticator(page);
  /* v1 票（6 段 by.role.epoch.exp.tempkeyId.sig）：v2 只认 5 段 → bad-format，和没 cookie 一样 */
  const v1 = 'password.admin.0.' + (Date.now() + 3600e3) + '..AAAA'; // v1 fixture
  const putV1 = () => context.addCookies([{ name: 'sgx-space-session', value: v1, domain: '.styrigx.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  await putV1();
  const clears = [];
  page.on('response', (r) => { if (/sgx-space-session=;/.test(r.headers()['set-cookie'] || '')) clears.push(r.url()); });
  for (const [target, ret] of [[MAIN + '/wild/', '/wild/'], [BLOG + '/post/hello/', BLOG + '/post/hello/']]) {
    const navs = [];
    /* 只数真正取新文档的导航请求（含 302）：navhistory.js 插主页历史条目的 replaceState / pushState 是同文档的，不算跳 */
    const h = (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navs.push(r.url()); };
    page.on('request', h);
    const resp = await page.goto(target);
    expect(resp && resp.status()).toBe(200);
    expect(page.url()).toBe(target);
    await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
    await page.waitForTimeout(800);
    expect(navs.length, '不来回跳：' + navs.join(' → ')).toBeLessThanOrEqual(1);
    page.off('request', h);
    expect(await sessionBy(page)).toBe(null);
    expect(await page.evaluate(() => fetch('/api/status', { cache: 'no-store' }).then((r) => r.status))).toBe(401);
    await page.goto(MAIN + '/?entry=1&return=' + encodeURIComponent(ret));
    await openMethods(page);
    await unlockPasskey(page);
    await page.waitForURL(target, { timeout: 20000 });
    expect(await sessionBy(page)).toBe('passkey');
    await putV1();
  }
  expect(clears, '不靠清 cookie：新票签发时直接覆盖').toEqual([]);
});


test('P2-3 子站分享（共享外壳同一个请求）：新建要锁屏密码 / 通行密钥进的门（分享链接进来的 403 link，v5 S1）；列表没有 reauth → 401 reauth，有复验票 → 200', async ({ page, context }) => {
  /* 测试台的子站是固定页（只有正文、没有共享外壳顶栏），这里不点按钮，只在子站页里发共享外壳 share.js 发的同一个请求 */
  await edge.resetShareLimit();
  const body = { action: 'create', reuse: true, name: 'blog', to: BLOG + '/', hours: 24, session: 12 * 3600 };
  await setSession(context, 'link');
  await page.goto(BLOG + '/');
  await expect(page.locator('#sub-content')).toContainText('SUBSITE-CONTENT blog');
  const r0 = await shareApi(page, body);
  expect(r0.s, JSON.stringify(r0.j)).toBe(403);
  expect(r0.j.error).toBe('link');
  await setSession(context, 'password');
  const r1 = await shareApi(page, body);
  expect(r1.s, JSON.stringify(r1.j)).toBe(200);
  expect(r1.j.link.path).toMatch(/^\/s\/[A-Za-z0-9_-]{22}$/);
  const l1 = await shareApi(page, { action: 'list' });
  expect(l1.s, JSON.stringify(l1.j)).toBe(401);
  expect(l1.j.error).toBe('reauth');
  await setReauth(context);
  const l2 = await shareApi(page, { action: 'list' });
  expect(l2.s, JSON.stringify(l2.j)).toBe(200);
  /* 测试台的短链库跨用例共享（作废的也留在列表里）：作废后把这一行删掉，后面的用例不受影响 */
  expect((await shareApi(page, { action: 'revoke', id: r1.j.link.id })).s).toBe(200);
  await edge.shareDb.prepare('DELETE FROM share_link WHERE id = ?1').bind(r1.j.link.id).run();
});

for (const role of ['password', 'link']) {
  test(`R5 已登录账号（进站会话 ${role}）打开旧账号页 /account/：301 → /#acct，账号终端直接是登录后的主页，没出过 sudo root 选方式`, async ({ page, context }) => {
    await setSession(context, role);
    await context.addCookies([{ name: 'sgx-account-session', value: await edge.mintAccount(), domain: 'styrigx.com', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    await page.goto(MAIN + '/account/');
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-state', 'open', { timeout: 15000 });
    await expect(d).toHaveAttribute('data-acct-state', 'in');
    await expect(d.locator('.sgx-at')).toHaveAttribute('data-at-layer', 'home');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-account-session', 'in');
    /* 首帧：网关只在旧 /account/ 页注入账号登录态，首页没有，终端等 GET /api/account 再画（PR 正文「偏离」1）；
       但等的那一下不能出登录选项（sudo root / [1] passkey） */
    expect(await page.evaluate(() => window.__sawLogin)).toBe(false);
    await expect(d.locator('[data-at-act="keys"]')).toBeVisible();
  });
}

test('R5 对照：进门但没有账号会话 → 账号终端是未登录的 sudo root（空账号库 → 提示 sudo root reset），主页（四行）不出现', async ({ page, context }) => {
  await setSession(context, 'password');
  await page.goto(MAIN + '/account/');
  const d = page.locator('#sgx-acct');
  await expect(d).toHaveAttribute('data-state', 'open', { timeout: 15000 });
  await expect(d).toHaveAttribute('data-acct-state', 'guest');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-account-session', 'out');
  /* 测试台账号库为空 → sudo root 走「还没有登录方式 · 输入 sudo root reset」那一支（同上一条 R5） */
  await expect(d.locator('[data-at-log]')).toContainText('sudo root reset');
  expect(await page.evaluate(() => window.__sawMain)).toBe(false);
});

test('R7 账号 Worker（账号拆分 PR3 起没有公开路由）：头像 / 数字健康 / 云同步经网关转发到 styrigx-account，页面和其他接口仍走网关', async ({ page, context }) => {
  edge.log.length = 0;
  /* 锁着（旧锁屏地址 = 终端预填 sudo styrigx）：头像照常出来（公开），网关转发、由账号 Worker 回（X-SGX-Runtime 保留 account） */
  await page.goto(MAIN + '/?entry=1');
  await openMethods(page);
  const av = await page.evaluate(() => fetch('/avatar/96.webp', { cache: 'no-store' }).then((r) => [r.status, r.headers.get('x-sgx-runtime'), r.headers.get('etag')]));
  expect(av).toEqual([200, 'account', '"d-96"']);
  /* 没会话：数字健康合计公开（v5 S3 访问表 public，转发给账号 Worker）；云同步不在表里 → 网关的门先拒，不转发 */
  const anon = await page.evaluate(() => fetch('/api/wellbeing?d=2026-10-24', { cache: 'no-store' }).then((r) => [r.status, r.headers.get('x-sgx-runtime')]));
  expect(anon).toEqual([200, 'account']);
  const anonPrefs = await page.evaluate(() => fetch('/api/prefs', { cache: 'no-store' }).then((r) => [r.status, r.headers.get('x-sgx-runtime')]));
  expect(anonPrefs).toEqual([401, 'worker']);
  /* 伪造身份头也一样：网关先剥掉外来的 x-styrigx-*，门照样按 cookie 判 */
  const forged = await page.evaluate(() => fetch('/api/prefs', { cache: 'no-store', headers: { 'X-Styrigx-Space-Level': 'password' } }).then((r) => [r.status, r.headers.get('x-sgx-runtime')]));
  expect(forged).toEqual([401, 'worker']);
  /* 进门：数字健康可读，云同步没登账号 → 401 account；接口地址不变 */
  await setSession(context, 'password');
  await page.goto(MAIN + '/wild/'); /* 对齐 PR-B：数字健康并进旷野 /wild/#screen-time */
  const wb = await page.evaluate(() => fetch('/api/wellbeing?d=2026-10-24', { cache: 'no-store' }).then((r) => r.json().then((j) => [r.status, j.ok, r.headers.get('x-sgx-runtime')])));
  expect(wb).toEqual([200, true, 'account']);
  const pr = await page.evaluate(() => fetch('/api/prefs', { cache: 'no-store' }).then((r) => r.json().then((j) => [r.status, j.error])));
  expect(pr).toEqual([401, 'account']);
  const by = (re) => edge.log.filter((l) => re.test(new URL(l[2]).pathname)).map((l) => l[0]);
  /* 浏览器的请求都进网关（路由 styrigx.com/*）；账号的接口再经服务绑定转一跳（log 'account'）；没有一条走账号 Worker 自己的路由 */
  expect(new Set(by(/^\/(avatar\/|api\/(wellbeing|prefs|avatar))/))).toEqual(new Set(['worker', 'account']));
  expect(by(/^\/(avatar\/|api\/(wellbeing|prefs|avatar))/).filter((x) => x === 'account').length).toBeGreaterThanOrEqual(3);
  expect(new Set(by(/^\/(wild\/|api\/session-check)$/))).toEqual(new Set(['worker']));
});

/* R8（顶栏标签页内切换）随 P4-3 PR-4b 删除：主站只剩旷野一个顶级页，shell/inpage-tabs.js 删了，没有页内切换可测。 */

/* ---------------- R9 分享短链（2026-10-24；进站 v3 L2 起并入 styrigx-space-core）：/s/* 经线上路由规则进站点核心 Worker，钥匙和会话也在同一个 Worker 里签 ---------------- */

/** 短链管理（进站 v3 L1：盾牌 → 分享链接）：新建只要进站会话，列表 / 作废要锁侧复验；不要账号会话 */
async function setManager(context) {
  await setSession(context, 'password');
  await setReauth(context);
}

/** 在页面里调 /api/share（同源 fetch，带真实 cookie） */
async function shareApi(page, body) {
  return page.evaluate((b) => fetch('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) })), body);
}

/** 进门 + 复验后建一条短链，然后清掉所有 cookie（变成没进门的陌生人） */
async function makeLink(page, context, body) {
  await setManager(context);
  await page.goto(MAIN + '/wild/');
  const r = await shareApi(page, Object.assign({ action: 'create' }, body));
  expect(r.s, JSON.stringify(r.j)).toBe(200);
  await context.clearCookies();
  return r.j.link;
}

test.describe('R9 分享短链', () => {
  test.beforeEach(async () => { await edge.resetShareLimit(); });

  test('R9 生成带会话短链（锁屏密码进门）→ 陌生人点开：直接以链接会话（by=link）进到目标页，不出锁屏；地址栏 / Referer 里没有码', async ({ page, context }) => {
    await setSession(context, 'password');
    await page.goto(MAIN + '/wild/');
    const made = await shareApi(page, { action: 'create', name: '小明', hours: 6, to: '/wild/', session: 3600 });
    expect(made.s, JSON.stringify(made.j)).toBe(200);
    const url = MAIN + made.j.link.path;
    expect(url).toMatch(/^https:\/\/styrigx\.com\/s\/[A-Za-z0-9_-]{22}$/);
    const code = url.split('/s/')[1];

    await context.clearCookies();
    edge.log.length = 0;
    const refs = [];
    page.on('request', (r) => { if (r.isNavigationRequest()) refs.push([r.url(), r.headers()['referer'] || '']); });
    await page.goto(url);
    /* C8：networkidle → 等落到目标地址 + load */
    await page.waitForURL(MAIN + '/wild/', { timeout: 15000 });
    await page.waitForLoadState('load');
    expect(page.url()).toBe(MAIN + '/wild/');
    expect(await lockShownWithin(page, 600)).toBe(false);
    expect(await sessionBy(page)).toBe('link');
    expect(edge.log.find((l) => l[2].includes('/s/'))[0]).toBe('share');
    for (const [u, ref] of refs) {
      if (u.includes('/s/')) continue;
      expect(u).not.toContain(code);
      expect(ref).not.toContain(code);
    }
    expect(await page.evaluate(() => location.href + document.referrer)).not.toContain(code);
    /* 短链进门的人（v5 S1，by=link）：不能发链接、不能看 / 作废 → 403 link */
    const cr = await shareApi(page, { action: 'create', hours: 1 });
    expect(cr.s, JSON.stringify(cr.j)).toBe(403);
    expect(cr.j.error).toBe('link');
    const ls = await shareApi(page, { action: 'list' });
    expect(ls.s).toBe(403);
    expect(ls.j.error).toBe('link');
  });

  test('R9 普通短链 → 没解锁的人到目标页（v5 S3：访客态，不出锁屏）', async ({ page, context }) => {
    const link = await makeLink(page, context, { hours: 2, to: '/wild/' });
    await page.goto(MAIN + link.path);
    await page.waitForURL(MAIN + '/wild/', { timeout: 15000 });
    await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
    expect(await lockShownWithin(page, 600)).toBe(false);
    expect(page.url()).not.toContain(link.path.slice(3));
    expect(await sessionBy(page)).toBe(null);
  });

  test('R9 作废 / 过期 / 不存在：同一个结果（旧锁屏地址 /?entry=1 → 终端预填 sudo styrigx）；作废带会话的短链后，已进来的人下一页就被锁在外面', async ({ page, context }) => {
    const live = await makeLink(page, context, { hours: 3, session: 1800 });
    await page.goto(MAIN + live.path);
    expect(await sessionBy(page)).toBe('link');
    /* 另开一个页面进门 + 复验后作废（短链进门的那一页 cookie 不动） */
    const mgrCtx = await context.browser().newContext({ proxy: LAUNCH.proxy, ignoreHTTPSErrors: false });
    const op = await mgrCtx.newPage();
    await setManager(mgrCtx);
    await op.goto(MAIN + '/wild/');
    expect((await shareApi(op, { action: 'revoke', id: live.id })).s).toBe(200);
    const expired = (await shareApi(op, { action: 'create', hours: 1 })).j.link;
    if (edge.shareDb.raw) edge.shareDb.raw.prepare('UPDATE share_link SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id);
    else edge.shareDb._links.get(expired.id).expires_at = Date.now() - 1;
    await mgrCtx.close();

    await page.goto(MAIN + '/wild/');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
    expect(await sessionBy(page)).toBe(null);

    const finals = [];
    for (const p of [live.path, expired.path, '/s/AAAAAAAAAAAAAAAAAAAAAA', '/s/nope']) {
      await context.clearCookies();
      const resp = [];
      const h = (r) => { if (r.url().includes('/s/')) resp.push(r.status() + ' ' + (r.headers()['location'] || '') + ' ' + (r.headers()['cache-control'] || '')); };
      page.on('response', h);
      await page.goto(MAIN + p);
      page.off('response', h);
      await openMethods(page);
      finals.push([page.url(), resp.join('|')]);
    }
    for (const f of finals) expect(f).toEqual([MAIN + '/?entry=1', '302 https://styrigx.com/?entry=1 private, no-store']);
  });

  test('R9 开放重定向被拒：目标只能是站内相对路径', async ({ page, context }) => {
    await setManager(context);
    await page.goto(MAIN + '/wild/');
    for (const to of ['//evil.example', 'https://evil.example/', '/\\evil.example', 'evil.example', 'javascript:alert(1)']) {
      const r = await shareApi(page, { action: 'create', hours: 1, to });
      expect(r.s, to).toBe(400);
      expect(r.j.error, to).toBe('target');
    }
  });

  test('R9 限速：同一来源连续 10 次打不开 → 15 分钟内真短链也打不开（同一个失败结果）', async ({ page, context }) => {
    const link = await makeLink(page, context, { hours: 2, session: 1800 });
    for (let i = 0; i < 10; i++) {
      const r = await page.request.get(MAIN + '/s/' + 'B'.repeat(21) + String.fromCharCode(65 + i), { maxRedirects: 0, ignoreHTTPSErrors: true });
      expect(r.status()).toBe(302);
      expect(r.headers()['location']).toBe('https://styrigx.com/?entry=1');
    }
    const r = await page.request.get(MAIN + link.path, { maxRedirects: 0, ignoreHTTPSErrors: true });
    expect(r.status()).toBe(302);
    expect(r.headers()['location']).toBe('https://styrigx.com/?entry=1');
    expect(r.headers()['set-cookie'] || '').toBe('');
    await edge.resetShareLimit();
    const ok = await page.request.get(MAIN + link.path, { maxRedirects: 0, ignoreHTTPSErrors: true });
    expect(ok.headers()['location']).toBe('https://styrigx.com/');
    expect(ok.headers()['set-cookie'] || '').toMatch(/sgx-space-session=link\.\d+\./);
  });
});

/* P4-3 PR-4c：中文浏览器。默认语言的锁屏地址 /?entry=1，首帧语言跳转再换成 /zh/?entry=1（查询串原样带着）；
   中文地址也要过网关（页面带 data-sgx-lock-session），终端里进站后照样回到原地址 */
test.describe('中文浏览器（首帧语言跳转到 /zh/）', () => {
  test.use({ locale: 'zh-CN' });

  test('R1 /?entry=1&return=blog → /zh/?entry=1（return 原样）→ 通行密钥 → 回到 blog 原地址', async ({ page }) => {
    await addAuthenticator(page);
    await page.goto(MAIN + '/?entry=1&return=' + encodeURIComponent(BLOG + '/post/hello/'));
    await page.waitForURL((u) => u.pathname === '/zh/' && u.searchParams.get('entry') === '1', { timeout: 15000 });
    expect(new URL(page.url()).searchParams.get('return')).toBe(BLOG + '/post/hello/');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
    await openMethods(page);
    await unlockPasskey(page);
    await page.waitForURL(BLOG + '/post/hello/', { timeout: 20000 });
    await expect(page.locator('#sub-content')).toContainText('SUBSITE-CONTENT blog');
  });

  test('R4 分享链接进门的人在 /zh/wild/ 点盾牌 → 终端 nobody@space:~/wild#，sudo -v 先拦一句（中文），进站入口不闪', async ({ page, context }) => {
    await setSession(context, 'link');
    await page.goto(MAIN + '/zh/wild/');
    await openShield(page);
    await expect(termPs(page)).toHaveText('nobody@space:~/wild#', { timeout: 10000 });
    await termCmd(page, 'sudo -v');
    await expect(termOut(page).locator('.sgx-term-err').last()).toHaveText('分享链接进来的会话不能这样做 · 用自己的钥匙进站', { timeout: 10000 });
    expect(await lockShownWithin(page, 300)).toBe(false);
    expect(await sessionBy(page)).toBe('link');
  });
});
