/**
 * 三站锁屏 / 解锁 / 回跳的端到端回归（真实网关 + 线上路由规则 + 真实域名 + 虚拟认证器）。
 * 测试台见 edge-harness.cjs。每条对应一次真实的用户报告（2026-10-21，三星浏览器录屏）：
 * v5 S3（整站放开）：页面对没进站的人也照常给（网关只注入 data-sgx-lock-session="locked"，不 302 锁屏）；
 *  v5 S5（终端合一）：锁屏界面删了，旧锁屏地址 /?entry（旧 ?lock）= 打开终端、预填 su ；在终端里 sudo styrigx → passkey，
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
 * v6 P4（定稿 v5.3 §十三）：前端的旧进站（sudo styrigx → 通行密钥）、立即锁定、分享链接会话的盾牌 / 账号卡片、旧账号会话那几条随前端删除拿掉；
 *  后端删旧（PR3）：分享短链（R1 分享、P2-3 子站分享、R9 整组）、进站后 /?entry&return 回跳（R3）只测已删功能，删掉；
 *  R3 自动回锁、R7 账号转发改用 v6 会话（sgx-session，edge.mintV6）重写，别的标签页「立即锁定」= v6 lock（POST /api/identity）。
 *
 * 运行：SGX_TEST_SUITE=edge npx playwright test --config=tests/config/playwright.config.js
 * （需要先 hugo --minify -s space/web 生产构建；需要 openssl）
 */
const { test, expect } = require('@playwright/test');
const { startEdge, LAUNCH } = require('../helpers/edge-harness.cjs');

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
  /* 记下进站入口有没有出现过（哪怕只闪一下）：v5 S5 起 = 终端输入行被预填 su （输入框的值不触发 MutationObserver，轮询看）；R4 要求一次都不能出现 */
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
      /* 登录 = sudo root 的选方式（S9 起在全站终端 [data-term-pick]；之前在账号下拉 [data-at-pick]）或旧登录区；主页 = 账号卡片 home */
      if (document.getElementById('acct-login') || document.querySelector('#sgx-acct [data-at-pick], #sgx-term [data-term-pick]') || /欢迎回来|Welcome back/.test(visibleText())) window.__sawLogin = true;
      const m = document.getElementById('acct-main');
      if ((m && !m.hidden) || document.querySelector('#sgx-acct .sgx-at[data-at-layer="home"]')) window.__sawMain = true;
    };
    const sudoPrefilled = () => Array.prototype.some.call(document.querySelectorAll('[data-term-in]'), (el) => el.value === 'su ');
    new MutationObserver(seen).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-at-layer'] });
    setInterval(() => { if (sudoPrefilled()) window.__sawLock = true; }, 50);
  });
});

/** 塞一个 v6 会话 cookie（sgx-session，同账号 Worker 下发的属性：host-only、HttpOnly、Secure、SameSite=Lax） */
async function setV6(context) {
  await context.addCookies([{ name: 'sgx-session', value: await edge.mintV6(), url: MAIN + '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
}

/** 当前页的全站终端（v5 S5；v5 S7 起主页也是顶栏打开的窗口 #sgx-term，#home-term 选择器留着无害） */
const termIn = (page) => page.locator('#home-term-in, #sgx-term[open] #sgx-term-in').first();

/* v5 S5：旧锁屏地址 = 打开终端、预填 su （不替人回车），等输入行可用 */
async function openMethods(page) {
  await expect(termIn(page)).toHaveValue('su ', { timeout: 15000 });
  await expect(termIn(page)).toBeEditable({ timeout: 15000 });
  await expect(page.locator('#sgx-entry')).toHaveCount(0);
}

async function lockShownWithin(page, ms) {
  // TODO(C8): 「ms 内进站入口一次都没出现」是静默窗口：终端身份异步向真实网关确认（自动锁检查还有 5 秒节流），
  // 「确认完、不预填」在页面上没有可观察的状态；要确定性就得在生产代码里加完成标记。保留原等待。
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__sawLock === true || Array.prototype.some.call(document.querySelectorAll('[data-term-in]'), (el) => el.value === 'su '));
}

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

test('R3 已解锁页面（v6 会话）：别的标签页 lock 后，切回来要上锁（状态只听服务端）', async ({ page, context }) => {
  await setV6(context);
  await page.goto(MAIN + '/');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'valid');
  /* 切走再切回：会话有效 → 不出锁屏 */
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(await lockShownWithin(page, 800)).toBe(false);
  /* 另一个标签页 lock（v6：删服务端会话行） */
  const other = await context.newPage();
  await other.goto(MAIN + '/status/');
  const lk = await other.evaluate(() => fetch('/api/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'lock' }) }).then((r) => r.status));
  expect(lk).toBe(200);
  await other.close();
  // TODO(C8): 等的是 lock-guard.js checkSessionForAutoLock 的 5 秒节流（按页面 Date.now() 算）过去。这个用例连真实网关，
  // 中途装 page.clock 会连锁屏 UI 的计时器一起换掉，风险大；生产代码没有可读的节流时刻。保留原等待。
  await page.waitForTimeout(5200); /* 自动锁检查节流 5 秒 */
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  /* v5 S3：401 → 重载，服务端画访客态（不画锁屏） */
  await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked', { timeout: 10000 });
  await expect(page.locator('#sgx-entry')).toHaveCount(0);
});


test('R7 账号 Worker（账号拆分 PR3 起没有公开路由）：头像 / 名片 / 云同步经网关转发到 styrigx-account（数字健康 v6 P4 删除），页面和其他接口仍走网关', async ({ page, context }) => {
  edge.log.length = 0;
  /* 锁着（旧锁屏地址 = 终端预填 su ）：头像照常出来（公开），网关转发、由账号 Worker 回（X-SGX-Runtime 保留 account） */
  await page.goto(MAIN + '/?entry=1');
  await openMethods(page);
  const av = await page.evaluate(() => fetch('/avatar/96.webp', { cache: 'no-store' }).then((r) => [r.status, r.headers.get('x-sgx-runtime'), r.headers.get('etag')]));
  expect(av).toEqual([200, 'account', '"d-96"']);
  /* 没会话：名片 GET 公开（访问表 public，转发给账号 Worker）；云同步不在表里 → 网关的门先拒，不转发；
     数字健康 /api/wellbeing v6 P4 删除（定稿 v5.5 §四），同未列入的 /api/* → 网关 401 */
  const anon = await page.evaluate(() => fetch('/api/profile', { cache: 'no-store' }).then((r) => [r.status, r.headers.get('x-sgx-runtime')]));
  expect(anon).toEqual([200, 'account']);
  const anonWb = await page.evaluate(() => fetch('/api/wellbeing?d=2026-10-24', { cache: 'no-store' }).then((r) => [r.status, r.headers.get('x-sgx-runtime')]));
  expect(anonWb).toEqual([401, 'worker']);
  const anonPrefs = await page.evaluate(() => fetch('/api/prefs', { cache: 'no-store' }).then((r) => [r.status, r.headers.get('x-sgx-runtime')]));
  expect(anonPrefs).toEqual([401, 'worker']);
  /* 伪造身份头也一样：网关先剥掉外来的 x-styrigx-*，门照样按 cookie 判 */
  const forged = await page.evaluate(() => fetch('/api/prefs', { cache: 'no-store', headers: { 'X-Styrigx-Space-Level': 'password' } }).then((r) => [r.status, r.headers.get('x-sgx-runtime')]));
  expect(forged).toEqual([401, 'worker']);
  /* v6 会话：云同步 200；接口地址不变 */
  await setV6(context);
  await page.goto(MAIN + '/status/');
  const pr = await page.evaluate(() => fetch('/api/prefs', { cache: 'no-store' }).then((r) => r.json().then((j) => [r.status, j.ok, r.headers.get('x-sgx-runtime')])));
  expect(pr).toEqual([200, true, 'account']);
  const by = (re) => edge.log.filter((l) => re.test(new URL(l[2]).pathname)).map((l) => l[0]);
  /* 浏览器的请求都进网关（路由 styrigx.com/*）；账号的接口再经服务绑定转一跳（log 'account'）；没有一条走账号 Worker 自己的路由 */
  expect(new Set(by(/^\/(avatar\/|api\/(profile|prefs|avatar))/))).toEqual(new Set(['worker', 'account']));
  expect(by(/^\/(avatar\/|api\/(profile|prefs|avatar))/).filter((x) => x === 'account').length).toBeGreaterThanOrEqual(3);
  expect(new Set(by(/^\/(status\/|api\/session-check)$/))).toEqual(new Set(['worker']));
});

/* R8（顶栏标签页内切换）随 P4-3 PR-4b 删除：主站只剩旷野一个顶级页，shell/inpage-tabs.js 删了，没有页内切换可测。 */
