/**
 * 状态页 + 主站顶栏三栏（2026-10-22 PR2）验收。/api/status 一律 mock（tests/fixtures/status-summary.cjs，形状 = workers/status/src/monitor.js summary）。
 * - 顶栏：主页 / 聊天 / 状态三页的长条里是三个标签（en：Home / Chat / Status），当前页 aria-current="page"；点了切页；
 *   其他页（设置）长条照旧只有页名；长条仍在屏幕正中，标签在长条里居中。
 * - 状态页：横幅（全部正常 / 有 1 个故障）、每站一张卡（主站 / 博客 / 日刻 / 奇趣 / 规则集，正常 / 故障、延迟、90 格可用率条 + 百分比）、
 *   近期故障（北京时间）；加载中骨架、空状态、错误（503 重试 / 401 会话过期）；同源请求带 cookie；页面可见时每 60 秒刷新；点色块看当天说明。
 * - 用量（PR3）：站点卡下面「用量」卡（Workers / D1 / R2 / KV：值 / 上限 / 百分比 / 进度条，> 70% 琥珀、> 90% 红，「更新于 N 分钟前」）；
 *   usage = null → 「用量未配置」；加载中 / 出错 / 空状态不显示。
 * - 手机 412×915（三星）和桌面 1280×800 都跑；手机不横向溢出。
 * 聊天：切到聊天页能看到空状态「问点需要联网查的」（聊天本身见 chat-page.spec.js）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');
const fx = require('../../fixtures/status-summary.cjs');

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {{lang?: string, api?: any, clock?: boolean}} [opt]
 *   api：对象 = 200 JSON；{status, body} = 指定状态码；函数 = 每次请求调用、返回前两者之一；null = 不注册 mock
 */
async function go(page, path, opt = {}) {
  const lang = opt.lang || (path.startsWith('/en/') ? 'en' : 'zh');
  await blockExternalRequests(page);
  if (opt.clock) await page.clock.install({ time: fx.NOW });
  else await freezeTime(page);
  await page.addInitScript((l) => { try { localStorage.setItem('sgx-lang', l); } catch (e) {} }, lang);
  const calls = [];
  if (opt.api !== null) {
    await page.route('**/api/status', async (route) => {
      calls.push(route.request());
      let r = typeof opt.api === 'function' ? opt.api(calls.length) : opt.api;
      if (r === undefined) r = fx.normal();
      if (r && r.__hold) { await r.__hold; r = r.data; }
      const isRaw = r && typeof r.status === 'number' && 'body' in r;
      await route.fulfill({
        status: isRaw ? r.status : 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(isRaw ? r.body : r),
      });
    });
  }
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  return calls;
}

async function box(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error('no box: ' + sel);
  return b;
}
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const VIEWPORTS = [
  ['手机 412×915', { width: 412, height: 915 }],
  ['桌面 1280×800', { width: 1280, height: 800 }],
];

for (const [label, viewport] of VIEWPORTS) {
  test.describe(`${label}：顶栏三栏`, () => {
    test.use({ viewport });

    for (const [path, cur] of [['/', 'home'], ['/chat/', 'chat'], ['/status/', 'status']]) {
      test(`${path}：长条里是 主页 / 聊天 / 状态，当前「${cur}」高亮，没有页名`, async ({ page }) => {
        await go(page, path);
        const tabs = page.locator('.sgx-tb-pill .sgx-tb-tab');
        await expect(tabs).toHaveText(['主页', '聊天', '状态']);
        expect(await tabs.evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual(['/', '/chat/', '/status/']);
        await expect(page.locator('.sgx-tb-tab[aria-current="page"]')).toHaveCount(1);
        await expect(page.locator(`.sgx-tb-tab[data-tab="${cur}"]`)).toHaveAttribute('aria-current', 'page');
        await expect(page.locator('.sgx-tb-pill .sgx-tb-title')).toHaveCount(0);
        /* 顶栏结构不变：九宫格圆 | 长条 | 快捷面板圆；长条中心 = 屏幕中心；标签组在长条里居中、不超出长条 */
        expect(await page.locator('.sgx-topbar > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['sgx-tb-nav', 'sgx-tb-pill', 'sgx-tb-end']);
        const pill = await box(page, '.sgx-tb-pill');
        const grp = await box(page, '.sgx-tb-tabs');
        expect(near(pill.x + pill.width / 2, viewport.width / 2), `长条中心 ${pill.x + pill.width / 2}`).toBe(true);
        expect(near(grp.x + grp.width / 2, pill.x + pill.width / 2), `标签组中心 ${grp.x + grp.width / 2}`).toBe(true);
        expect(grp.x >= pill.x && grp.x + grp.width <= pill.x + pill.width).toBe(true);
        expect(near(grp.height, 40) && near(grp.y + grp.height / 2, pill.y + pill.height / 2)).toBe(true);
        /* 三个标签等宽、文字不截断 */
        const ws = await tabs.evaluateAll((els) => els.map((e) => [e.getBoundingClientRect().width, e.scrollWidth <= e.clientWidth]));
        expect(near(ws[0][0], ws[1][0]) && near(ws[1][0], ws[2][0]), JSON.stringify(ws)).toBe(true);
        expect(ws.every((w) => w[1])).toBe(true);
        /* 当前页药丸 = 导航抽屉当前项同一套色 */
        const c = await page.evaluate(() => {
          const cs = getComputedStyle(document.querySelector('.sgx-tb-tab[aria-current="page"]'));
          const ref = document.createElement('div');
          ref.style.background = 'var(--sgx-nav-selected)';
          ref.style.color = 'var(--sgx-on-nav-selected)';
          document.body.appendChild(ref);
          const r = getComputedStyle(ref);
          const out = { bg: cs.backgroundColor, fg: cs.color, refBg: r.backgroundColor, refFg: r.color };
          ref.remove();
          return out;
        });
        expect(c.bg).toBe(c.refBg);
        expect(c.fg).toBe(c.refFg);
      });
    }

    test('英文：Home / Chat / Status，链接带 /en', async ({ page }) => {
      await go(page, '/en/status/');
      await expect(page.locator('.sgx-tb-tab')).toHaveText(['Home', 'Chat', 'Status']);
      expect(await page.locator('.sgx-tb-tab').evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual(['/en/', '/en/chat/', '/en/status/']);
      await expect(page.locator('.sgx-tb-tab[data-tab="status"]')).toHaveAttribute('aria-current', 'page');
    });

    test('点标签切页：主页 → 状态 → 聊天 → 主页', async ({ page }) => {
      await go(page, '/');
      await page.locator('.sgx-tb-tab[data-tab="status"]').click();
      await page.waitForURL(/\/status\/$/);
      await expect(page.locator('#st-banner')).toHaveAttribute('data-state', 'up');
      await page.locator('.sgx-tb-tab[data-tab="chat"]').click();
      await page.waitForURL(/\/chat\/$/);
      await expect(page.locator('#chat-empty .st-msg-title')).toHaveText('问点需要联网查的');
      await expect(page.locator('.sgx-tb-tab[data-tab="chat"]')).toHaveAttribute('aria-current', 'page');
      await page.locator('.sgx-tb-tab[data-tab="home"]').click();
      await page.waitForURL((u) => new URL(u).pathname === '/');
      await expect(page.locator('.sgx-tb-tab[data-tab="home"]')).toHaveAttribute('aria-current', 'page');
    });

    test('其他页（设置）长条照旧只有页名，没有标签', async ({ page }) => {
      await go(page, '/settings/');
      await expect(page.locator('.sgx-tb-tab')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-title')).toHaveText('设置');
    });
  });

  test.describe(`${label}：状态页`, () => {
    test.use({ viewport });

    test('全部正常：横幅、5 张卡、90 格条、可用率、近期故障（北京时间）、页脚；同源带 cookie 请求', async ({ page }) => {
      await page.context().addCookies([{ name: 'sgx-test', value: '1', domain: 'localhost', path: '/' }]);
      const calls = await go(page, '/status/', { api: fx.normal() });
      const root = page.locator('#st-root');
      await expect(root).toHaveAttribute('data-state', 'ready');
      await expect(root).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('#st-banner')).toHaveAttribute('data-state', 'up');
      await expect(page.locator('#st-banner .st-banner-title')).toHaveText('全部正常');
      await expect(page.locator('#st-banner .st-banner-sub')).toHaveText('5 个服务运行正常');
      const cards = page.locator('#st-sites .st-card');
      await expect(cards).toHaveCount(5);
      await expect(page.locator('.st-skel')).toHaveCount(0);
      await expect(cards.locator('.st-name')).toHaveText(['主站', '博客', '日刻', '奇趣', '规则集']);
      await expect(cards.locator('.st-host')).toHaveText(['styrigx.com', 'blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com', 'proxy-rules.styrigx.com']);
      await expect(cards.locator('.st-chip')).toHaveText(['正常', '正常', '正常', '正常', '正常']);
      await expect(cards.first().locator('.st-meta')).toContainText('延迟 123 ms');
      await expect(cards.first().locator('.st-meta')).toContainText('刚刚检查');
      for (let i = 0; i < 5; i++) await expect(cards.nth(i).locator('.st-cell')).toHaveCount(90);
      await expect(cards.nth(1).locator('.st-pct')).toHaveText('可用率 99.96%');
      await expect(cards.nth(1).locator('.st-cell[data-level="minor"]')).toHaveCount(1);
      await expect(cards.nth(2).locator('.st-cell[data-level="down"]')).toHaveCount(1);
      await expect(cards.first().locator('.st-cell[data-level="none"]')).toHaveCount(50);
      /* 90 格都在卡片里、每格有宽度 */
      const cells = await cards.first().locator('.st-cell').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
      expect(Math.min(...cells)).toBeGreaterThan(1.5);
      const bar = await box(page, '#st-sites .st-card >> nth=0 >> .st-bar');
      const card = await box(page, '#st-sites .st-card >> nth=0');
      expect(bar.x >= card.x && bar.x + bar.width <= card.x + card.width).toBe(true);
      /* 故障：已恢复两条，按开始时间新 → 旧，北京时间 */
      const inc = page.locator('#st-inc .st-inc');
      await expect(page.locator('#st-inc-wrap')).toBeVisible();
      await expect(inc).toHaveCount(2);
      await expect(inc.nth(0).locator('.st-inc-site')).toHaveText('博客');
      await expect(inc.nth(0).locator('.st-chip')).toHaveText('已恢复');
      await expect(inc.nth(0).locator('.st-inc-time')).toHaveText(/开始 9月27日 09:00.*恢复 09:25.*持续 25 分钟/);
      await expect(inc.nth(1).locator('.st-inc-cause')).toHaveText('超时');
      await expect(page.locator('#st-foot')).toHaveText('更新于 12:00（北京时间），每分钟自动刷新');
      /* 请求：同源 GET /api/status，带上 cookie */
      expect(calls.length).toBe(1);
      expect(calls[0].method()).toBe('GET');
      expect(new URL(calls[0].url()).origin).toBe(new URL(page.url()).origin);
      expect(await calls[0].headerValue('cookie')).toContain('sgx-test=1');
      /* 手机不横向溢出 */
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test('一个故障：横幅「有 1 个故障」、奇趣卡故障 + 超时、进行中的故障排第一', async ({ page }) => {
      await go(page, '/status/', { api: fx.oneDown() });
      await expect(page.locator('#st-banner')).toHaveAttribute('data-state', 'down');
      await expect(page.locator('#st-banner .st-banner-title')).toHaveText('有 1 个故障');
      await expect(page.locator('#st-banner .st-banner-sub')).toHaveText('奇趣暂时无法访问');
      const curio = page.locator('.st-card[data-site="curio"]');
      await expect(curio).toHaveAttribute('data-state', 'down');
      await expect(curio.locator('.st-chip')).toHaveText('故障');
      await expect(curio.locator('.st-meta-last')).toHaveText('超时');
      await expect(curio.locator('.st-meta-last')).toHaveAttribute('data-ok', '0');
      await expect(curio.locator('.st-pct')).toHaveText('可用率 99.98%');
      await expect(page.locator('.st-card[data-state="up"]')).toHaveCount(4);
      const first = page.locator('#st-inc .st-inc').first();
      await expect(first).toHaveAttribute('data-open', '1');
      await expect(first.locator('.st-inc-site')).toHaveText('奇趣');
      await expect(first.locator('.st-chip')).toHaveText('进行中');
      await expect(first.locator('.st-inc-time')).toHaveText(/开始 10月9日 11:53.*已持续 7 分钟/);
      /* 横幅颜色 = danger 容器（等入场动画 / 过渡结束） */
      await expect.poll(() => page.evaluate(() => {
        const ref = document.createElement('div');
        ref.style.background = 'var(--sgx-danger-container)';
        document.body.appendChild(ref);
        const v = getComputedStyle(ref).backgroundColor;
        ref.remove();
        return getComputedStyle(document.getElementById('st-banner')).backgroundColor === v;
      })).toBe(true);
    });

    test('英文页：横幅 / 卡片 / 故障都是英文', async ({ page }) => {
      await go(page, '/en/status/', { api: fx.oneDown() });
      await expect(page.locator('#st-banner .st-banner-title')).toHaveText('1 service down');
      await expect(page.locator('.st-card .st-name')).toHaveText(['Space', 'Blog', 'Daymark', 'Curio', 'Proxy rules']);
      await expect(page.locator('.st-card[data-site="curio"] .st-chip')).toHaveText('Down');
      await expect(page.locator('.st-card[data-site="space"] .st-pct')).toHaveText('100% uptime');
      await expect(page.locator('#st-inc .st-inc').first().locator('.st-chip')).toHaveText('Ongoing');
      await expect(page.locator('#st-inc-wrap h3')).toHaveText('Recent incidents');
    });

    test('还没有数据：空状态卡，不显示横幅 / 卡片 / 故障', async ({ page }) => {
      await go(page, '/status/', { api: fx.empty() });
      await expect(page.locator('#st-root')).toHaveAttribute('data-state', 'empty');
      await expect(page.locator('#st-empty')).toBeVisible();
      await expect(page.locator('#st-empty .st-msg-title')).toHaveText('还没有监测数据');
      await expect(page.locator('#st-banner')).toBeHidden();
      await expect(page.locator('#st-sites')).toBeHidden();
      await expect(page.locator('#st-inc-wrap')).toBeHidden();
    });

    test('出错（503）：错误卡 + 重试，重试成功后显示数据', async ({ page }) => {
      let fail = true;
      await go(page, '/status/', { api: () => (fail ? { status: 503, body: { ok: false, error: 'upstream' } } : fx.normal()) });
      await expect(page.locator('#st-root')).toHaveAttribute('data-state', 'error');
      await expect(page.locator('#st-error')).toBeVisible();
      await expect(page.locator('#st-error .st-msg-title')).toHaveText('暂时拿不到状态');
      await expect(page.locator('#st-banner')).toBeHidden();
      await expect(page.locator('#st-sites')).toBeHidden();
      fail = false;
      await page.locator('#st-error .st-btn').click();
      await expect(page.locator('#st-root')).toHaveAttribute('data-state', 'ready');
      await expect(page.locator('#st-error')).toBeHidden();
      await expect(page.locator('.st-card')).toHaveCount(5);
    });

    test('会话过期（401）：错误卡「会话已过期」+「重新解锁」', async ({ page }) => {
      await go(page, '/status/', { api: { status: 401, body: { ok: false, error: 'unauthorized' } } });
      await expect(page.locator('#st-error .st-msg-title')).toHaveText('会话已过期');
      await expect(page.locator('#st-error .st-btn')).toHaveText('重新解锁');
      await expect(page.locator('#st-error .st-btn')).toHaveAttribute('data-action', 'reload');
    });

    test('加载中：骨架 + 「正在加载…」，aria-busy', async ({ page }) => {
      let release;
      const hold = new Promise((r) => { release = r; });
      await go(page, '/status/', { api: () => ({ __hold: hold, data: fx.normal() }) });
      await expect(page.locator('#st-root')).toHaveAttribute('data-state', 'loading');
      await expect(page.locator('#st-root')).toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('.st-skel')).toHaveCount(5);
      await expect(page.locator('#st-banner .st-banner-title')).toHaveText('正在加载…');
      release();
      await expect(page.locator('#st-root')).toHaveAttribute('data-state', 'ready');
    });

    test('点色块：卡片底部显示当天说明，再点收起', async ({ page }) => {
      await go(page, '/status/', { api: fx.normal() });
      const blog = page.locator('.st-card[data-site="blog"]');
      const cell = blog.locator('.st-cell[data-level="minor"]');
      await cell.click();
      await expect(blog.locator('.st-detail')).toBeVisible();
      await expect(blog.locator('.st-detail')).toHaveText(/^9月27日 · 可用率 98\.26% · 1440 次检查 · 平均 \d+ ms$/);
      await expect(cell).toHaveAttribute('data-picked', '1');
      await cell.click();
      await expect(blog.locator('.st-detail')).toBeHidden();
    });

    test('用量：站点卡下面一张卡，7 行（Workers / D1 合计 + 3 个库 / R2 / KV），值 / 上限 / 百分比 / 进度条颜色、更新于 N 分钟前', async ({ page }) => {
      await go(page, '/status/', { api: fx.withUsage(fx.normal(), fx.usage()) });
      const wrap = page.locator('#st-usage-wrap');
      await expect(wrap).toBeVisible();
      await expect(wrap.locator('h3')).toHaveText('用量');
      const rows = page.locator('#st-usage .st-u');
      await expect(rows).toHaveCount(7);
      await expect(rows.locator('.st-u-name')).toHaveText(['Workers 请求（今天）', 'D1 数据库（合计）', 'styrigx-status', 'styrigx-auth', 'styrigx-sgx', 'R2 存储', 'KV 存储']);
      await expect(rows.nth(0).locator('.st-u-val')).toHaveText('73,456 / 100,00073.5%');
      await expect(rows.nth(0)).toHaveAttribute('data-level', 'warn');
      await expect(rows.nth(2)).toHaveAttribute('data-level', 'crit');
      await expect(rows.nth(2)).toHaveAttribute('data-child', '1');
      await expect(rows.nth(5).locator('.st-u-val')).toHaveText('2 GB / 10 GB20.1%');
      await expect(rows.nth(5).locator('.st-u-sub')).toHaveText('2 个存储桶 · 1,234 个对象');
      await expect(rows.nth(6).locator('.st-u-sub')).toHaveText('3 个命名空间 · 420 个键');
      await expect(page.locator('#st-usage .st-u-track[role="progressbar"]')).toHaveCount(7);
      await expect(page.locator('#st-usage .st-usage-foot')).toHaveText('更新于 18 分钟前（北京时间 11:42），每小时更新');
      /* 位置：最后一张站点卡下面、近期故障上面 */
      const lastCard = await box(page, '#st-sites .st-card >> nth=4');
      const u = await box(page, '#st-usage-wrap');
      const inc = await box(page, '#st-inc-wrap');
      expect(u.y).toBeGreaterThan(lastCard.y + lastCard.height);
      expect(inc.y).toBeGreaterThan(u.y + u.height - 1);
      /* 进度条：宽度 ∝ 用量；琥珀 = --m-warm，红 = --sgx-danger，正常 = --sgx-primary-fill（填充档，2026-10-23 PR-G 修订） */
      const fills = await page.locator('#st-usage .st-u').evaluateAll((els) => {
        const color = (v) => { const d = document.createElement('div'); d.style.background = 'var(' + v + ')'; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
        const ref = { ok: color('--sgx-primary-fill'), warn: color('--m-warm'), crit: color('--sgx-danger') };
        return els.map((li) => {
          const tr = li.querySelector('.st-u-track').getBoundingClientRect();
          const f = li.querySelector('.st-u-fill');
          return { ratio: f.getBoundingClientRect().width / tr.width, okColor: getComputedStyle(f).backgroundColor === ref[li.getAttribute('data-level')], trackIn: tr.left >= li.getBoundingClientRect().left && tr.right <= li.getBoundingClientRect().right };
        });
      });
      expect(Math.abs(fills[0].ratio - 0.7346)).toBeLessThan(0.02);
      expect(Math.abs(fills[2].ratio - 0.936)).toBeLessThan(0.02);
      expect(fills.every((f) => f.okColor && f.trackIn)).toBe(true);
      /* 文字不溢出卡片；手机不横向溢出 */
      const card = await box(page, '#st-usage');
      for (const sel of ['.st-u-val', '.st-u-name']) {
        const bs = await page.locator('#st-usage ' + sel).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
        expect(Math.max(...bs)).toBeLessThanOrEqual(card.x + card.width + 0.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test('用量：usage = null → 「用量未配置」，没有进度条；旧版接口（没有 usage 字段）同样；英文「Usage not configured」', async ({ page }) => {
      await go(page, '/status/', { api: fx.withUsage(fx.normal(), null, 'not-configured') });
      await expect(page.locator('#st-usage-wrap')).toBeVisible();
      await expect(page.locator('#st-usage .st-usage-none')).toHaveAttribute('data-reason', 'not-configured');
      await expect(page.locator('#st-usage .st-usage-none-title')).toHaveText('用量未配置');
      await expect(page.locator('#st-usage .st-u-track')).toHaveCount(0);
      await expect(page.locator('.st-card')).toHaveCount(5);
      await go(page, '/status/', { api: fx.normal() });
      await expect(page.locator('#st-usage .st-usage-none-title')).toHaveText('用量未配置');
      await go(page, '/en/status/', { api: fx.withUsage(fx.normal(), null, 'not-configured') });
      await expect(page.locator('#st-usage-wrap h3')).toHaveText('Usage');
      await expect(page.locator('#st-usage .st-usage-none-title')).toHaveText('Usage not configured');
      await go(page, '/status/', { api: fx.withUsage(fx.normal(), null, 'api-error') });
      await expect(page.locator('#st-usage .st-usage-none-title')).toHaveText('用量暂时拿不到');
    });

    test('用量：加载中 / 出错 / 空状态时不显示', async ({ page }) => {
      await go(page, '/status/', { api: { status: 503, body: { ok: false } } });
      await expect(page.locator('#st-root')).toHaveAttribute('data-state', 'error');
      await expect(page.locator('#st-usage-wrap')).toBeHidden();
      await go(page, '/status/', { api: fx.withUsage(fx.empty(), fx.usage()) });
      await expect(page.locator('#st-root')).toHaveAttribute('data-state', 'empty');
      await expect(page.locator('#st-usage-wrap')).toBeHidden();
    });
  });
}

test.describe('自动刷新', () => {
  test.use({ viewport: { width: 412, height: 915 } });

  test('页面可见时每 60 秒刷新一次；刷新失败保留旧数据、页脚提示', async ({ page }) => {
    let n = 0;
    const calls = await go(page, '/status/', {
      clock: true,
      api: () => {
        n++;
        if (n === 2) return fx.oneDown();
        if (n === 3) return { status: 503, body: { ok: false, error: 'upstream' } };
        return fx.normal();
      },
    });
    await expect(page.locator('#st-banner')).toHaveAttribute('data-state', 'up');
    expect(calls.length).toBe(1);
    await page.clock.fastForward(30 * 1000);
    expect(calls.length).toBe(1);
    await page.clock.fastForward(31 * 1000);
    await expect(page.locator('#st-banner')).toHaveAttribute('data-state', 'down');
    expect(calls.length).toBe(2);
    await page.clock.fastForward(60 * 1000);
    await expect(page.locator('#st-foot')).toHaveText(/^刷新失败，显示的是 12:01 的数据$/);
    expect(calls.length).toBe(3);
    await expect(page.locator('#st-banner')).toHaveAttribute('data-state', 'down');
    await expect(page.locator('.st-card')).toHaveCount(5);
  });
});

test.describe('聊天页空状态', () => {
  test.use({ viewport: { width: 412, height: 915 } });

  test('/chat/ 和 /en/chat/：「问点需要联网查的」/「Ask something that needs the web」', async ({ page }) => {
    await go(page, '/chat/', { api: null });
    await expect(page.locator('#chat-empty .st-msg-title')).toHaveText('问点需要联网查的');
    await go(page, '/en/chat/', { api: null });
    await expect(page.locator('#chat-empty .st-msg-title')).toHaveText('Ask something that needs the web');
  });
});
