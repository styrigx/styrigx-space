/**
 * 主站顶栏三栏页内切换（2026-10-24，shell/inpage-tabs.js + entries/entry-tabs.js）验收。测试构建（锁屏禁用），手机 412×915。
 * - 进来以后切栏不整页导航：同一个 document（window 上的标记还在、没有新的文档请求），地址 / 标题 / aria-current / <meta> / body 标记正确；
 * - 前进后退（popstate）换栏；直接打开每个地址（中英）、刷新都直出那一栏；左右滑也是同一文档；
 * - 切过去以后各栏功能可用（聊天发一条、设置换调色板、主页时钟走）；设置首页 → 设置子页照旧整页导航，返回正常；
 * - 反复切换：window / document 上的监听数不增长；云同步 GET 只发一次；滚动位置按栏记；
 * - 取不到能用的页面（服务器出错）→ 整页导航；连点只落在最后一栏；
 * - 视觉：页内切过去的那一栏和直接打开的同一栏逐像素一致。
 * 运行：npx playwright test --config=tests/config/playwright.config.js inpage-tabs.spec.js
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

/** 记主文档请求（整页导航才会有） */
function trackDocs(page) {
  const docs = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document' && r.frame() === page.mainFrame()) docs.push(new URL(r.url()).pathname);
  });
  return docs;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{lang?: string, owner?: boolean, prefs?: () => any}} [o]
 */
async function setup(page, o = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript((l) => { try { localStorage.setItem('sgx-lang', l); } catch (e) {} }, o.lang || 'zh');
  await page.route('**/api/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' }));
  if (o.owner) {
    /* 网关给站长的页面在 <html> 上注入 data-sgx-session="valid" data-sgx-role="owner"：三栏的 HTML（整页和后台取的）都改 */
    await page.route((u) => /^\/(en\/)?(chat\/|settings\/)?$/.test(u.pathname), async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace(/<html(\s|>)/i, '<html data-sgx-session="valid" data-sgx-role="owner"$1');
      await route.fulfill({ response: res, body: html });
    });
  }
}

/** 页面上打一个标记：整页导航后就没了 */
const mark = (page) => page.evaluate(() => { /** @type {any} */ (window).__sameDoc = 1; });
const sameDoc = (page) => page.evaluate(() => /** @type {any} */ (window).__sameDoc === 1);
/** 等预取完（另外两栏都在缓存里）：没有直接的钩子，等网络空闲 */
const settle = (page) => page.waitForLoadState('networkidle');

/** @param {import('@playwright/test').Page} page @param {string} id */
async function expectTab(page, id, title, path) {
  await expect(page.locator('.sgx-tb-tab[aria-current="page"]')).toHaveCount(1);
  await expect(page.locator(`.sgx-tb-tab[data-tab="${id}"]`)).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveTitle(title);
  expect(new URL(page.url()).pathname).toBe(path);
}

test('同一文档里切三栏：地址 / 标题 / aria-current / meta / body 标记都对，没有整页导航', async ({ page }) => {
  await setup(page);
  const docs = trackDocs(page);
  await page.goto('/');
  await settle(page);
  await mark(page);
  docs.length = 0;

  await page.click('.sgx-tb-tab[data-tab="chat"]');
  await expectTab(page, 'chat', '聊天 | Styrigx', '/chat/');
  await expect(page.locator('#chat-root')).toBeVisible();
  await expect(page.locator('#home-widgets')).toHaveCount(0);
  let s = await page.evaluate(() => ({
    sub: document.body.classList.contains('subpage'), dp: document.body.getAttribute('data-page'),
    robots: (document.querySelector('meta[name="robots"]') || {}).content || null,
    og: document.querySelector('meta[property="og:url"]').getAttribute('content'),
    ogt: document.querySelector('meta[property="og:title"]').getAttribute('content'),
    drawerHome: document.querySelector('#sgx-drawer [data-nav="home"]').getAttribute('aria-current'),
  }));
  expect(s).toEqual({ sub: true, dp: '', robots: 'noindex,nofollow', og: 'https://styrigx.com/chat/', ogt: '聊天', drawerHome: null });

  await page.click('.sgx-tb-tab[data-tab="settings"]');
  await expectTab(page, 'settings', '设置 | Styrigx', '/settings/');
  await expect(page.locator('[aria-label="分类"].set-cards')).toBeVisible();
  s = await page.evaluate(() => ({
    sub: document.body.classList.contains('subpage'), dp: document.body.getAttribute('data-page'),
    robots: (document.querySelector('meta[name="robots"]') || {}).content || null,
    og: document.querySelector('meta[property="og:url"]').getAttribute('content'),
  }));
  expect(s).toEqual({ sub: true, dp: 'settings', robots: null, og: 'https://styrigx.com/settings/' });

  await page.click('.sgx-tb-tab[data-tab="home"]');
  await expectTab(page, 'home', 'Styrigx', '/');
  await expect(page.locator('#home-widgets')).toBeVisible();
  s = await page.evaluate(() => ({
    sub: document.body.classList.contains('subpage'), dp: document.body.getAttribute('data-page'),
    drawerHome: document.querySelector('#sgx-drawer [data-nav="home"]').getAttribute('aria-current'),
    ids: document.querySelectorAll('#sgx-main [id="chat-root"], #sgx-main [id="set-panes"]').length,
  }));
  expect(s).toEqual({ sub: false, dp: '', drawerHome: 'page', ids: 0 });

  expect(await sameDoc(page)).toBe(true);
  expect(docs, '切栏不请求文档').toEqual([]);
});

test('前进 / 后退：同一文档里换栏，内容和标题跟着地址', async ({ page }) => {
  await setup(page);
  const docs = trackDocs(page);
  await page.goto('/');
  await settle(page);
  await mark(page);
  docs.length = 0;
  await page.click('.sgx-tb-tab[data-tab="chat"]');
  await expectTab(page, 'chat', '聊天 | Styrigx', '/chat/');
  await page.click('.sgx-tb-tab[data-tab="settings"]');
  await expectTab(page, 'settings', '设置 | Styrigx', '/settings/');
  await page.goBack();
  await expectTab(page, 'chat', '聊天 | Styrigx', '/chat/');
  await expect(page.locator('#chat-root')).toBeVisible();
  await page.goBack();
  await expectTab(page, 'home', 'Styrigx', '/');
  await expect(page.locator('#home-widgets')).toBeVisible();
  await page.goForward();
  await expectTab(page, 'chat', '聊天 | Styrigx', '/chat/');
  await page.goForward();
  await expectTab(page, 'settings', '设置 | Styrigx', '/settings/');
  await expect(page.locator('#set-panes')).toHaveCount(1);
  expect(await sameDoc(page)).toBe(true);
  expect(docs).toEqual([]);
});

for (const [lang, pre] of [['zh', ''], ['en', '/en']]) {
  test(`直接打开 / 刷新每个地址（${lang}）：服务器直出那一栏；进来后照样页内切换`, async ({ page }) => {
    await setup(page, { lang });
    const T = lang === 'en' ? { home: 'Styrigx', chat: 'Chat | Styrigx', settings: 'Settings | Styrigx' } : { home: 'Styrigx', chat: '聊天 | Styrigx', settings: '设置 | Styrigx' };
    const P = { home: pre + '/', chat: pre + '/chat/', settings: pre + '/settings/' };
    const SEL = { home: '#home-widgets', chat: '#chat-root', settings: '#set-panes' };
    for (const id of ['home', 'chat', 'settings']) {
      await page.goto(P[id]);
      await expectTab(page, id, T[id], P[id]);
      await expect(page.locator(SEL[id])).toHaveCount(1);
      await page.reload();
      await expectTab(page, id, T[id], P[id]);
      await expect(page.locator(SEL[id])).toHaveCount(1);
      /* 链接 href 照旧是真地址（没 JS、新标签页打开都能用） */
      expect(await page.locator('.sgx-tb-tab').evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual([P.home, P.chat, P.settings]);
    }
    await settle(page);
    await mark(page);
    await page.click('.sgx-tb-tab[data-tab="home"]');
    await expectTab(page, 'home', T.home, P.home);
    await page.click('.sgx-tb-tab[data-tab="chat"]');
    await expectTab(page, 'chat', T.chat, P.chat);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe(lang);
    expect(await sameDoc(page)).toBe(true);
  });
}

/** 从 (x0,y0) 滑到 (x1,y1)（CDP 真实触摸序列，同 tab-swipe.spec.js） */
async function swipe(page, x0, y0, x1, y1, ms = 200, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) });
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(ms / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('左右滑：同一文档里换栏，药丸和内容一起换', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await settle(page);
  await mark(page);
  /* 药丸换的那一次更新里内容也已经换了（不再「药丸先动、内容慢几帧」） */
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__mismatch = 0;
    new MutationObserver(() => {
      const cur = document.querySelector('.sgx-tb-tab[aria-current="page"]');
      const id = cur && cur.getAttribute('data-tab');
      const has = id === 'chat' ? !!document.getElementById('chat-root') : id === 'settings' ? !!document.getElementById('set-panes') : !!document.getElementById('home-widgets');
      if (!has) w.__mismatch++;
    }).observe(document.querySelector('.sgx-tb-tabs'), { attributes: true, subtree: true, attributeFilter: ['aria-current'] });
  });
  await swipe(page, 300, 500, 120, 510);
  await expectTab(page, 'chat', '聊天 | Styrigx', '/chat/');
  await swipe(page, 300, 300, 100, 300);
  await expectTab(page, 'settings', '设置 | Styrigx', '/settings/');
  await swipe(page, 120, 400, 320, 390);
  await expectTab(page, 'chat', '聊天 | Styrigx', '/chat/');
  await swipe(page, 120, 300, 320, 290);
  await expectTab(page, 'home', 'Styrigx', '/');
  expect(await sameDoc(page)).toBe(true);
  expect(await page.evaluate(() => /** @type {any} */ (window).__mismatch)).toBe(0);
});

test('切过去以后各栏功能可用：聊天发一条、设置换调色板（主页跟着变）、主页时钟走；设置子页整页导航、返回正常', async ({ page }) => {
  await setup(page);
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' });
    const body = ['Hugo 的最新版本是 **v0.168.0**。'].map((text) => 'data: ' + JSON.stringify({ t: 'delta', text }) + '\n\n').join('') + 'data: {"t":"done"}\n\n';
    await route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body });
  });
  await page.goto('/');
  await settle(page);
  await mark(page);
  await expect(page.locator('#clk-l-time')).toHaveText(/^\d\d:\d\d$/);

  await page.click('.sgx-tb-tab[data-tab="chat"]');
  await page.fill('#chat-input', 'Hugo 最新版本是多少？');
  await page.click('#chat-send');
  await expect(page.locator('.chat-msg[data-role="model"] .chat-md strong')).toHaveText('v0.168.0');
  await expect(page.locator('.chat-msg[data-role="user"]')).toHaveCount(1);

  await page.click('.sgx-tb-tab[data-tab="settings"]');
  await expect(page.locator('#set-panes')).toHaveCount(1);
  await page.click('.sgx-tb-tab[data-tab="home"]');
  await expect(page.locator('#home-widgets')).toBeVisible();
  await expect(page.locator('#clk-l-time')).toHaveText(/^\d\d:\d\d$/);
  await page.click('.sgx-tb-tab[data-tab="chat"]');
  /* 聊天切走再回来：对话还在（同一块 DOM 留着） */
  await expect(page.locator('.chat-msg[data-role="model"] .chat-md strong')).toHaveText('v0.168.0');
  await page.fill('#chat-input', 'x');
  await expect(page.locator('#chat-send')).toBeEnabled();

  await page.click('.sgx-tb-tab[data-tab="settings"]');
  await expect(page.locator('#set-panes')).toHaveCount(1);
  expect(await sameDoc(page)).toBe(true);
  /* 设置子页：普通导航（新文档），返回回到设置首页 */
  await page.click('.set-cards a.set-row[href="/settings/theme/"]');
  await page.waitForURL('**/settings/theme/');
  expect(await sameDoc(page)).toBe(false);
  await page.locator('#palette-dots .pal-tile[data-palette="teal"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'teal');
  await page.goBack();
  await page.waitForURL((u) => u.pathname === '/settings/');
  await expectTab(page, 'settings', '设置 | Styrigx', '/settings/');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'teal');
  /* 退回来的这份文档里照样页内切换 */
  await mark(page);
  await settle(page);
  await page.click('.sgx-tb-tab[data-tab="home"]');
  await expectTab(page, 'home', 'Styrigx', '/');
  expect(await sameDoc(page)).toBe(true);
});

test('设置首页每次切进来都重新挂、切走时拆干净：设置里的开关照样能点，布局撤销条不留到别的栏', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await settle(page);
  for (let i = 0; i < 3; i++) {
    await page.click('.sgx-tb-tab[data-tab="settings"]');
    await expect(page.locator('#set-panes')).toHaveCount(1);
    /* DeX 两栏：右窗格默认「显示」；点左栏「壁纸和主题」在原地换窗格（脚本挂上了） */
    await page.click('#set-cat-nav [data-cat="theme"]');
    await expect(page.locator('#sg-theme')).toHaveClass(/active/);
    expect(new URL(page.url()).pathname).toBe('/settings/');
    await page.click('.sgx-tb-tab[data-tab="home"]');
    await expect(page.locator('#home-widgets')).toBeVisible();
  }
  await page.click('.sgx-tb-tab[data-tab="settings"]');
  const mode = await page.evaluate(() => localStorage.getItem('sgx-layout') || 'auto');
  const btn = page.locator('#seg-layout button[data-v="mobile"]');
  if (mode !== 'mobile') {
    await page.click('#set-cat-nav [data-cat="display"]');
    await btn.click();
    await expect(page.locator('#sgx-layout-snackbar')).toHaveCount(1);
    await page.click('.sgx-tb-tab[data-tab="chat"]');
    await expect(page.locator('#sgx-layout-snackbar')).toHaveCount(0);
  }
});

test('反复切换不泄漏：window / document 监听数不涨，计时器不叠加', async ({ page }) => {
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.__ls = new Map();
    let n = 0;
    for (const T of [Window.prototype, Document.prototype]) {
      const add = T.addEventListener, rm = T.removeEventListener;
      T.addEventListener = function (type, fn, opt) {
        const key = (this === window ? 'w:' : 'd:') + type;
        const cap = typeof opt === 'boolean' ? opt : !!(opt && opt.capture);
        const id = ++n;
        const rec = { key, fn, cap, id };
        const sig = opt && typeof opt === 'object' && opt.signal;
        if (!(sig && sig.aborted)) {
          let dup = false;
          w.__ls.forEach((r) => { if (r.key === key && r.fn === fn && r.cap === cap) dup = true; });
          if (!dup) {
            w.__ls.set(id, rec);
            if (sig) sig.addEventListener('abort', () => w.__ls.delete(id));
            if (opt && typeof opt === 'object' && opt.once) {
              const orig = fn;
              /* once：触发一次就算移除（近似） */
              add.call(this, type, () => w.__ls.delete(id), { once: true, capture: cap });
              void orig;
            }
          }
        }
        return add.call(this, type, fn, opt);
      };
      T.removeEventListener = function (type, fn, opt) {
        const key = (this === window ? 'w:' : 'd:') + type;
        const cap = typeof opt === 'boolean' ? opt : !!(opt && opt.capture);
        w.__ls.forEach((r, id) => { if (r.key === key && r.fn === fn && r.cap === cap) w.__ls.delete(id); });
        return rm.call(this, type, fn, opt);
      };
    }
    const si = window.setInterval, ci = window.clearInterval;
    w.__iv = new Set();
    window.setInterval = /** @type {any} */ (function (/** @type {any[]} */ ...a) { const id = si.apply(window, /** @type {any} */ (a)); w.__iv.add(id); return id; });
    window.clearInterval = function (id) { w.__iv.delete(id); return ci.call(window, id); };
  });
  await setup(page);
  await page.goto('/');
  await settle(page);
  const cycle = async () => {
    for (const id of ['chat', 'settings', 'home']) {
      await page.click(`.sgx-tb-tab[data-tab="${id}"]`);
      await expect(page.locator(`.sgx-tb-tab[data-tab="${id}"]`)).toHaveAttribute('aria-current', 'page');
    }
    await page.waitForTimeout(250);
  };
  const snap = () => page.evaluate(() => {
    const w = /** @type {any} */ (window);
    /** @type {Record<string, number>} */
    const c = {};
    w.__ls.forEach((r) => { c[r.key] = (c[r.key] || 0) + 1; });
    return { c, iv: w.__iv.size };
  });
  await cycle();
  const a = await snap();
  for (let i = 0; i < 5; i++) await cycle();
  const b = await snap();
  expect(b).toEqual(a);
});

test('云同步：站长页内切换不重复 GET /api/prefs（core 只初始化一次）', async ({ page }) => {
  await setup(page, { owner: true });
  let gets = 0;
  await page.route('**/api/prefs', (r) => {
    if (r.request().method() === 'GET') gets++;
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"items":{}}' });
  });
  const docs = trackDocs(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-sgx-role', 'owner');
  await settle(page);
  await mark(page);
  docs.length = 0;
  for (let i = 0; i < 3; i++) {
    for (const id of ['chat', 'settings', 'home']) {
      await page.click(`.sgx-tb-tab[data-tab="${id}"]`);
      await expect(page.locator(`.sgx-tb-tab[data-tab="${id}"]`)).toHaveAttribute('aria-current', 'page');
    }
  }
  await page.waitForTimeout(500);
  expect(await sameDoc(page), '站长会话下也是页内切换').toBe(true);
  expect(docs).toEqual([]);
  expect(gets).toBe(1);
});

test('滚动位置按栏记', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 412, height: 500 });
  await page.goto('/');
  await settle(page);
  await page.evaluate(() => window.scrollTo(0, 200));
  await page.click('.sgx-tb-tab[data-tab="settings"]');
  await expect(page.locator('#set-panes')).toHaveCount(1);
  expect(await page.evaluate(() => window.scrollY), '第一次进来从顶部开始').toBe(0);
  await page.evaluate(() => window.scrollTo(0, 150));
  await page.click('.sgx-tb-tab[data-tab="home"]');
  await expect(page.locator('#home-widgets')).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(200);
  await page.click('.sgx-tb-tab[data-tab="settings"]');
  await expect(page.locator('#set-panes')).toHaveCount(1);
  expect(await page.evaluate(() => window.scrollY)).toBe(150);
  await page.goBack();
  await expect(page.locator('#home-widgets')).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(200);
});

test('取不到能用的页面（服务器出错）→ 整页导航；连点只落在最后一栏', async ({ page }) => {
  await setup(page);
  /* 后台取 /chat/ 一律 500（整页导航的文档请求照常） */
  await page.route((u) => u.pathname === '/chat/', (r) => (r.request().resourceType() === 'document' ? r.continue() : r.fulfill({ status: 500, body: 'x' })));
  const docs = trackDocs(page);
  await page.goto('/');
  await settle(page);
  await mark(page);
  docs.length = 0;
  /* 连点：聊天（取不到）→ 设置 → 主页 → 设置：最后落在设置，同一文档 */
  await page.evaluate(() => {
    const t = (id) => /** @type {HTMLElement} */ (document.querySelector(`.sgx-tb-tab[data-tab="${id}"]`)).click();
    t('chat'); t('settings'); t('home'); t('settings');
  });
  await expectTab(page, 'settings', '设置 | Styrigx', '/settings/');
  await page.waitForTimeout(600);
  await expectTab(page, 'settings', '设置 | Styrigx', '/settings/');
  expect(await sameDoc(page)).toBe(true);
  expect(docs).toEqual([]);
  /* 点聊天：取不到 → 整页导航到 /chat/ */
  await page.click('.sgx-tb-tab[data-tab="chat"]');
  await page.waitForURL('**/chat/');
  await expect(page.locator('#chat-root')).toBeVisible();
  expect(docs).toEqual(['/chat/']);
  expect(await sameDoc(page)).toBe(false);
});

test('视觉：页内切过去的栏和直接打开的同一栏逐像素一致（412×915）', async ({ page }) => {
  await setup(page);
  /* 入场动画只在会话第一次进站时播（动画元素单独合成层，圆角抗锯齿会差 1~2 个色阶）；页内切换从第一次切栏起就不播，直接打开这边也按「不是第一次」比 */
  await page.addInitScript(() => { try { sessionStorage.setItem('sgx-entered', '1'); } catch (e) {} });
  const shot = () => page.screenshot({ animations: 'disabled', caret: 'hide' });
  const direct = {};
  for (const [id, path] of [['chat', '/chat/'], ['settings', '/settings/'], ['home', '/']]) {
    await page.goto(path);
    await settle(page);
    await page.waitForTimeout(300);
    direct[id] = await shot();
  }
  /* 从主页（刚直接打开的那份）切到聊天、设置，再切回主页 */
  for (const id of ['chat', 'settings', 'home']) {
    await page.click(`.sgx-tb-tab[data-tab="${id}"]`);
    await expect(page.locator(`.sgx-tb-tab[data-tab="${id}"]`)).toHaveAttribute('aria-current', 'page');
    await page.mouse.move(0, 0);
    await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement).blur());
    await page.waitForTimeout(400);
    const got = await shot();
    expect(got.equals(direct[id]), id + '：页内切过去的和直接打开的应逐像素一致').toBe(true);
  }
});
