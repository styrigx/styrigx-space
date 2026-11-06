// 「分享本页」（共享外壳 share.js，2026-10-24 起是顶栏右圆；2026-11-04 P5-1 起是快捷面板里的磁贴 [data-qp="share"]，右圆分享删除；
// P4-3 PR-4b 起快捷面板只有一页、四站同一套，主站也有）：
// - 进门二值（P2-3）：不分角色，都 POST https://styrigx.com/api/share（同源带 cookie）
//   { action:'create', reuse:true, name:页面标题, to:当前页（去 lock / why / return / share）, hours:24, session:43200 } → navigator.share 短链；
//   系统分享被拒 / 没有 → 复制 + toast「已复制分享链接」；用户取消不复制；生成中再点不理；接口失败只 toast，不分享原地址。
// - 服务端回 401 reauth → share.js 自带的最小锁侧复验步骤（dialog.sgx-share-reauth：锁屏通行密钥 / 解锁密码）→ 通过后自动重试一次；取消 = 不分享。
// - 360 / 412 宽：顶栏胶囊（字标 · 页名胶囊 · 九宫格 · 快捷设置 · AI）不溢出，没有右圆分享，页面不横向滚动。
import { test, expect } from '@playwright/test';

const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
const SHORT = 'https://styrigx.com/s/' + CODE;
const PAGE = '/curio/404.html';
const HOMES = ['/curio/', '/curio/en/'];

test.use({ viewport: { width: 412, height: 915 } });

/** share: 'ok' | 'none' | 'NotAllowedError' | 'AbortError' */
async function setup(page, { share = 'ok', api } = {}) {
  await page.addInitScript((mode) => {
    window.__shareLog = [];
    if (mode === 'none') Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    else {
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (d) => {
          window.__shareLog.push(['share', { title: d.title, url: d.url }]);
          if (mode !== 'ok') { const e = new Error('x'); e.name = mode; throw e; }
        },
      });
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => { window.__shareLog.push(['copy', t]); } },
    });
  }, share);
  const calls = [];
  await page.route('https://styrigx.com/api/share', async (route) => {
    const req = route.request();
    const origin = req.headers()['origin'] || '*';
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST', Vary: 'Origin' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ body: JSON.parse(req.postData() || '{}'), type: req.headers()['content-type'] });
    const r = api ? await api(calls.length) : [200, { ok: true, reused: false, link: { path: '/s/' + CODE } }];
    return route.fulfill({ status: r[0], headers: cors, contentType: 'application/json', body: JSON.stringify(r[1]) });
  });
  return calls;
}

/** 打开页面 → 快捷面板（PR-4b 起只有一页），等「分享本页」磁贴可点 */
async function go(page, path) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await openShareTile(page);
}
async function openShareTile(page) {
  await page.locator('.sgx-tb-quick').click();
  await expect(page.locator('#sgx-qp')).toHaveAttribute('data-state', 'open');
  await expect(page.locator('#sgx-qp [data-qp="share"][data-sgx-share]')).toBeVisible();
}
const log = (page) => page.evaluate(() => window.__shareLog);

test.describe('快捷面板「分享本页」磁贴', () => {
  test('生成带临时会话的短链（reuse、24 小时 / 12 小时、标题当名字、当前页去掉 lock/return）→ 系统分享短链', async ({ page }) => {
    const calls = await setup(page);
    await go(page, PAGE + '?lock=1&return=%2F&keep=1');
    const url = await page.evaluate(() => location.origin + location.pathname + '?keep=1');
    const title = await page.title();
    await page.locator('[data-sgx-share]').click();
    await expect.poll(() => log(page)).toEqual([['share', { title, url: SHORT }]]);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toContain('application/json');
    expect(calls[0].body).toEqual({ action: 'create', reuse: true, name: Array.from(title.trim()).slice(0, 24).join(''), to: url, hours: 24, session: 43200 });
  });

  test('生成中按钮 aria-busy、再点不理（只发一次请求）；完了恢复', async ({ page }) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = await setup(page, { api: async () => { await gate; return [200, { ok: true, reused: true, link: { path: '/s/' + CODE } }]; } });
    await go(page, PAGE);
    const btn = page.locator('[data-sgx-share]');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-busy', 'true');
    await expect(btn).toHaveClass(/\bis-busy\b/);
    await btn.click();
    await btn.click();
    release();
    await expect(btn).not.toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => log(page)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  test('系统分享被拒（NotAllowedError）→ 复制短链 + toast「已复制分享链接」', async ({ page }) => {
    await setup(page, { share: 'NotAllowedError' });
    await go(page, PAGE);
    await page.locator('[data-sgx-share]').click();
    await expect(page.locator('.sgx-share-toast')).toHaveText('已复制分享链接');
    await expect(page.locator('.sgx-share-toast')).toHaveClass(/\bshow\b/);
    expect((await log(page)).map((x) => x[0])).toEqual(['share', 'copy']);
    expect((await log(page))[1][1]).toBe(SHORT);
  });

  test('没有 Web Share → 直接复制短链 + toast；用户取消（AbortError）→ 不复制不提示', async ({ page }) => {
    await setup(page, { share: 'none' });
    await go(page, PAGE);
    await page.locator('[data-sgx-share]').click();
    await expect(page.locator('.sgx-share-toast')).toHaveText('已复制分享链接');
    expect(await log(page)).toEqual([['copy', SHORT]]);
  });

  test('用户取消系统分享 → 不复制、不 toast', async ({ page }) => {
    await setup(page, { share: 'AbortError' });
    await go(page, PAGE);
    await page.locator('[data-sgx-share]').click();
    await expect.poll(() => log(page)).toEqual([['share', { title: await page.title(), url: SHORT }]]);
    await page.waitForTimeout(300);
    await expect(page.locator('.sgx-share-toast')).toHaveCount(0);
  });

  test('接口 401（锁屏会话失效）→ toast 提示重新解锁，不分享也不复制原地址；不弹复验', async ({ page }) => {
    await setup(page, { api: async () => [401, { ok: false, error: 'session' }] });
    await go(page, PAGE);
    await page.locator('[data-sgx-share]').click();
    await expect(page.locator('.sgx-share-toast')).toContainText('重新解锁');
    await expect(page.locator('dialog.sgx-share-reauth')).toHaveCount(0);
    expect(await log(page)).toEqual([]);
    await expect(page.locator('[data-sgx-share]')).not.toHaveAttribute('aria-busy', 'true');
  });

  test('401 reauth → 弹最小锁侧复验（只给设了的方式）→ 解锁密码通过 → 自动重试，系统分享短链', async ({ page }) => {
    const calls = await setup(page, { api: async (n) => (n === 1 ? [401, { ok: false, error: 'reauth' }] : [200, { ok: true, reused: true, link: { path: '/s/' + CODE } }]) });
    const pw = [];
    await page.route('**/api/lock-reauth', (r) => r.fulfill({ json: { ok: true, valid: false, passkey: false, password: true } }));
    await page.route('**/api/lock-password', (r) => { pw.push(JSON.parse(r.request().postData() || '{}')); return r.fulfill({ json: { ok: true } }); });
    await go(page, PAGE);
    await page.locator('[data-sgx-share]').click();
    const step = page.locator('dialog.sgx-share-reauth');
    await expect(step).toBeVisible();
    await expect(step.locator('[data-pk]')).toHaveCount(0);
    await step.locator('.sgx-share-reauth-in').fill('lock-pass-1');
    await step.locator('.sgx-share-reauth-pw button[type="submit"]').click();
    await expect(step).toHaveCount(0);
    await expect.poll(() => log(page)).toEqual([['share', { title: await page.title(), url: SHORT }]]);
    expect(pw).toEqual([{ action: 'verify', password: 'lock-pass-1', reauth: true }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual(calls[0].body);
  });

  test('401 reauth → 复验取消 → 什么也不分享、不 toast，按钮恢复', async ({ page }) => {
    const calls = await setup(page, { api: async () => [401, { ok: false, error: 'reauth' }] });
    await page.route('**/api/lock-reauth', (r) => r.fulfill({ json: { ok: true, valid: false, passkey: true, password: true } }));
    await go(page, PAGE);
    await page.locator('[data-sgx-share]').click();
    const step = page.locator('dialog.sgx-share-reauth');
    await expect(step).toBeVisible();
    await step.locator('[data-cancel]').click();
    await expect(step).toHaveCount(0);
    expect(await log(page)).toEqual([]);
    await expect(page.locator('.sgx-share-toast.show')).toHaveCount(0);
    await expect(page.locator('[data-sgx-share]')).not.toHaveAttribute('aria-busy', 'true');
    expect(calls).toHaveLength(1);
  });

  test('磁贴：在快捷面板里（单页，四站同一套），文案「分享本页」「短链，24 小时」；顶栏上没有右圆分享', async ({ page }) => {
    await setup(page);
    await go(page, PAGE);
    const tile = page.locator('#sgx-qp [data-qp="share"]');
    await expect(tile).toHaveCount(1);
    await expect(tile.locator('.sgx-qp-label')).toHaveText('分享本页');
    await expect(tile.locator('.sgx-qp-state')).toHaveText('短链，24 小时');
    await expect(page.locator('[data-sgx-share]')).toHaveCount(1);
    await expect(page.locator('.sgx-topbar [data-sgx-share], .sgx-tb-end, .sgx-tb-share')).toHaveCount(0);
    /* P4-3 PR-4b：四站快捷面板同一套——磁贴 深色 / 跟随系统 / 分享本页 / 立即锁定，语言整行，调色板，布局 */
    expect(await page.locator('#sgx-qp [data-qp]').evaluateAll((els) => els.map((e) => e.getAttribute('data-qp')))).toEqual(['dark', 'system', 'share', 'lock', 'lang']);
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [role="tab"], #sgx-qp [data-nav]')).toHaveCount(0);
  });

  for (const w of [360, 412]) {
    test(`${w} 宽：顶栏胶囊（字标 · 九宫格 · 快捷设置 · AI；手机布局不显示页名胶囊）贴页边距，三颗圆按钮 40 × 40，页面不横向滚动（所有进门的人一样）`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 800 });
      for (const home of HOMES) {
        await page.goto(home, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.sgx-topbar')).toBeVisible();
        const r = await page.evaluate(() => {
          const b = (s) => document.querySelector(s).getBoundingClientRect();
          const bar = b('.sgx-topbar'), logo = b('.sgx-tb-logo'), pill = b('.sgx-tb-pill'), acts = b('.sgx-tb-acts');
          /* P4-3 PR-4b 定稿：手机布局中间整块不显示（页名胶囊只显示页名，子站分区走首页入口） */
          const shown = [...document.querySelectorAll('.sgx-tb-pill > *')].filter((e) => !e.classList.contains('sgx-tb-progress') && e.getBoundingClientRect().width > 0).length;
          return { bar: [Math.round(bar.left), Math.round(bar.right), Math.round(bar.height)],
            btns: [...document.querySelectorAll('.sgx-tb-acts > *')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
            between: logo.right <= acts.left + 0.5, shown, gap: [...document.querySelectorAll('.sgx-tb-acts > *')].map((e) => e.getBoundingClientRect().left),
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
        });
        expect(r.bar).toEqual([16, w - 16, 52]);
        /* PR-4b 定稿：右边三颗圆按钮 40 × 40、间距 6（九宫格 · 快捷设置 · AI） */
        expect(r.btns).toEqual([[40, 40], [40, 40], [40, 40]]);
        expect(Math.round(r.gap[1] - r.gap[0]), home + ' 按钮步距 46').toBe(46);
        expect(r.between, home + ' 字标在按钮组左边、不重叠').toBe(true);
        expect(r.shown, home + ' 手机布局不显示页名胶囊 / 分区页签').toBe(0);
        expect(r.overflow).toBe(false);
      }
    });
  }
});
