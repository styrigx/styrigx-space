// 「分享本页」（共享外壳 share.js，2026-10-24 起是顶栏右圆；2026-11-04 P5-1 起是快捷面板里的磁贴 [data-qp="share"]，右圆分享删除；
// P4-3 PR-4b 起快捷面板只有一页、四站同一套，主站也有）：
// - 进门二值（P2-3）：不分角色，都 POST https://styrigx.com/api/share（同源带 cookie）
//   { action:'create', reuse:true, name:页面标题, to:当前页（去 lock / why / return / share）, hours:24, session:43200 } → navigator.share 短链；
//   系统分享被拒 / 没有 → 复制 + toast「已复制分享链接」；用户取消不复制；生成中再点不理；接口失败只 toast，不分享原地址。
// - 新建只要进站会话（SPACE-V3）：401 一律是会话过期 → toast 回锁屏重新解锁；没有复验弹层（列表 / 作废在盾牌，要 reauth）。
// - 2026-11 PR-1 起「分享本页」在 NAVIGATE（>_）面板里 [data-qp="share"]；360 / 412 宽：顶栏 v3 通栏不溢出，没有分享按钮，页面不横向滚动。
import { test, expect } from '@playwright/test';

/* 语言清理（2026-11-07）起奇趣 / 日刻也「跟随系统」每页都跳（四站同一份首帧跳转 lang-boot.js），Playwright 默认 en-US 会把 /<站>/zh/… 换到英文页。
   本文件的中文用例按中文浏览器跑（同 ui-cookie.spec.js）；要看英文页的地方先明确选英文（同源 localStorage sgx-lang=en），见 chooseLang。 */
test.use({ locale: 'zh-CN' });
/** 明确选语言（同源 localStorage sgx-lang；'system' = 回到跟随系统）。页面已在本站时用。 @param {import('@playwright/test').Page} page @param {string} l */
const chooseLang = (page, l) => page.evaluate((v) => { localStorage.setItem('sgx-lang', v); }, l);

const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
const SHORT = 'https://styrigx.com/s/' + CODE;
const PAGE = '/daymark/zh/404.html';
const HOMES = ['/daymark/zh/', '/daymark/'];

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

/** 打开页面 → NAVIGATE 面板（2026-11 PR-1 起分享 / 锁定在 NAVIGATE 里），等「分享本页」按钮可点 */
async function go(page, path) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  /* v5 S5：旧锁屏参数（?lock= / ?entry=）= 打开全站终端、预填 sudo styrigx；先关掉终端再开 NAVIGATE */
  if (/[?&](lock|entry)=/.test(path)) {
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '', { timeout: 15000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
  }
  await openShareTile(page);
}
async function openShareTile(page) {
  await page.locator('.sgx-tb-grid').click();
  await expect(page.locator('#sgx-nav')).toHaveAttribute('data-state', 'open');
  await expect(page.locator('#sgx-nav [data-qp="share"][data-sgx-share]')).toBeVisible();
}
const log = (page) => page.evaluate(() => window.__shareLog);

test.describe('NAVIGATE「分享本页」按钮', () => {
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

  test('新建只要进站会话：401 reauth 也当会话过期处理（toast 重新解锁，不弹复验、不重试）', async ({ page }) => {
    const calls = await setup(page, { api: async () => [401, { ok: false, error: 'reauth' }] });
    await go(page, PAGE);
    await page.locator('[data-sgx-share]').click();
    await expect(page.locator('.sgx-share-toast')).toContainText('重新解锁');
    await expect(page.locator('dialog.sgx-share-reauth')).toHaveCount(0);
    expect(await log(page)).toEqual([]);
    expect(calls).toHaveLength(1);
    await expect(page.locator('[data-sgx-share]')).not.toHaveAttribute('aria-busy', 'true');
  });

  test('按钮：在 NAVIGATE 面板里（四站同一套），读屏名「分享本页」、按钮上写 share；顶栏上没有分享；外观面板里没有分享 / 锁定', async ({ page }) => {
    await setup(page);
    await go(page, PAGE);
    const btn = page.locator('#sgx-nav [data-qp="share"]');
    await expect(btn).toHaveCount(1);
    await expect(btn).toHaveAttribute('aria-label', '分享本页');
    await expect(btn.locator('span')).toHaveText('share');
    await expect(page.locator('[data-sgx-share]')).toHaveCount(1);
    await expect(page.locator('.sgx-topbar [data-sgx-share], .sgx-tb-end, .sgx-tb-share')).toHaveCount(0);
    /* 2026-11 PR-1：NAVIGATE = 站点列表 → lang / layout 分段 → share / lock → STATUS；外观面板只有 MODE + PALETTE */
    expect(await page.locator('#sgx-nav [data-qp]').evaluateAll((els) => els.map((e) => e.getAttribute('data-qp')))).toEqual(['share', 'term']); /* v5 S6 去掉 lock */ /* 2026-11 PR-2：加「$ terminal」 */
    await expect(page.locator('#sgx-nav [data-qp-seg="layout"]')).toHaveCount(1);
    await expect(page.locator('#sgx-nav [data-qp-langs]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [data-qp], #sgx-qp [role="tab"], #sgx-qp [data-nav]')).toHaveCount(0);
  });

  for (const w of [360, 412]) {
    test(`${w} 宽：顶栏 v3 通栏（字标 · 外观 · 盾牌 · | · >_ · 头像；不显示页名）贴页边距，按钮 40 × 40，页面不横向滚动（所有进门的人一样）`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 800 });
      for (const home of HOMES) {
        if (!/\/zh\//.test(home)) await chooseLang(page, 'en');
        await page.goto(home, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.sgx-topbar')).toBeVisible();
        const r = await page.evaluate(() => {
          const b = (s) => document.querySelector(s).getBoundingClientRect();
          const bar = b('.sgx-topbar'), logo = b('.sgx-tb-logo'), acts = b('.sgx-tb-acts');
          const shown = [...document.querySelectorAll('#site-nav .sgx-tb-pill > *')].filter((e) => e.getBoundingClientRect().width > 0).length;
          return { bar: [Math.round(bar.left), Math.round(bar.right), Math.round(bar.height)],
            logoL: Math.round(logo.left), actsR: Math.round(acts.right),
            kids: [...document.querySelectorAll('.sgx-tb-acts > *')].map((e) => e.className.split(' ').filter((c) => !c.startsWith('is-')).pop()) /* 去掉状态类：头像加载中带 .is-busy（2026-11-09 头像外圈） */,
            btns: [...document.querySelectorAll('.sgx-tb-acts > .sgx-tb-btn, .sgx-tb-acts > .sgx-tb-av')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
            between: logo.right <= acts.left + 0.5, shown,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
        });
        expect(r.bar).toEqual([0, w, 56]); /* 手机布局顶栏高 56（2026-11-09 fix/mobile-topbar-56，原 64） */
        expect(r.logoL, home + ' 字标左缘 = 页边距 12 − 4（2026-11 对齐 PR-B：手机页边距 16 → 12，照设计稿 m=1 的 --pad）').toBe(8);
        expect(r.actsR, home + ' 图标组右缘 = 宽 − 12').toBe(w - 12);
        expect(r.kids).toEqual(['sgx-tb-shield', 'sgx-tb-quick', 'sgx-tb-grid', 'sgx-tb-sep', 'sgx-tb-term', 'sgx-tb-av'] /* v5 S6 顶栏 E */);
        expect(r.btns).toEqual([[40, 40], [40, 40], [40, 40], [40, 40], [40, 40]]);
        expect(r.between, home + ' 字标在按钮组左边、不重叠').toBe(true);
        expect(r.shown, home + ' 不显示页名 / 分区页签').toBe(0);
        expect(r.overflow).toBe(false);
      }
    });
  }
});
