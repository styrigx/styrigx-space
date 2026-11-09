/**
 * 触屏滚动 + AI 浮钮让位（2026-11-08 PR-A）：
 * - 手机从终端窗（旷野三窗 / 主页可输入终端）起划，页面照样往下滚（.sgx-term-body 纵向不再 overscroll-behavior: contain）；
 *   模态抽屉（Ctrl K）纵向仍收住，见 input.css。
 * - 滚到底时 AI 浮钮不压 tmux 页脚（状态栏 + rss · github · x 那一行）：mountFootLift 把页脚露出的高度写到 --sgx-foot-lift，浮钮停在页脚上沿之上。
 * 手势用 CDP Input.dispatchTouchEvent 一帧一帧发（headless shell 里 synthesizeScrollGesture 的 touch 手势不滚页面），走的是浏览器真实的触摸滚动链。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, nextFrames, scrolledTo, expect } = require('../helpers/helpers');

test.use({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });

async function go(page, path) {
  await blockExternalRequests(page);
  await freezeTime(page);
  if (path.indexOf('/zh/') === 0) await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}

/** 在 (x, y) 按下，往上拖 dy（手指上划 = 页面往下滚），12 帧，松手 */
async function swipeUp(page, x, y, dy) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - (dy * i) / 12 }] });
    await nextFrames(page, 1);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** 把选择器命中的第 n 个终端窗挪到视口上部，返回窗里一个起划点（视口坐标） */
async function startPoint(page, sel, n) {
  const p = await page.evaluate(([s, i]) => {
    const el = document.querySelectorAll(s)[i];
    const r0 = el.getBoundingClientRect();
    /* 留出至少 200px 还能往下滚的余量（窗靠近页底时就不把它挪到顶上，起划点落在窗里偏下的位置） */
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.max(0, Math.min(window.scrollY + r0.top - 140, max - 200)));
    const r = el.getBoundingClientRect();
    const top = Math.max(r.top, 80);
    const bot = Math.min(r.bottom, window.innerHeight - 120);
    return { x: Math.round(r.left + r.width / 2), y: Math.round(top + Math.min((bot - top) / 2, 120)) };
  }, [sel, n]);
  await nextFrames(page, 2);
  /* 起划点确实落在这个终端窗里 */
  const inside = await page.evaluate(([s, i, x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && document.querySelectorAll(s)[i].contains(hit);
  }, [sel, n, p.x, p.y]);
  expect(inside, `${sel}[${n}] 起划点在窗内`).toBe(true);
  return p;
}

test.describe('触屏：从终端窗起划滚页面', () => {
  test('旷野三窗：在窗里上划，页面 scrollY 增加', async ({ page }) => {
    await go(page, '/wild/');
    const sel = '.wild-term .sgx-term-body';
    const n = await page.locator(sel).count();
    expect(n).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < n; i++) {
      const p = await startPoint(page, sel, i);
      const y0 = await page.evaluate(() => window.scrollY);
      await swipeUp(page, p.x, p.y, 220);
      await expect.poll(() => page.evaluate(() => window.scrollY), { message: `窗 ${i} 上划后页面要滚` }).toBeGreaterThan(y0 + 60);
    }
  });

  test('主页可输入终端：窗没满时上划直接滚页面', async ({ page }) => {
    await go(page, '/');
    const sel = '#home-term .sgx-term-body';
    await expect(page.locator(sel)).toBeVisible();
    const p = await startPoint(page, sel, 0);
    const y0 = await page.evaluate(() => window.scrollY);
    await swipeUp(page, p.x, p.y, 220);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y0 + 60);
  });
});

test.describe('AI 浮钮给页脚让位', () => {
  for (const path of ['/wild/', '/']) {
    test(`滚到底：浮钮不压页脚状态栏和链接行（${path}）`, async ({ page }) => {
      await go(page, path);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await scrolledTo(page);
      await nextFrames(page, 3);
      const g = await page.evaluate(() => {
        const fab = document.querySelector('#site-nav .sgx-tb-ai').getBoundingClientRect();
        const foot = document.querySelector('.sgx-foot').getBoundingClientRect();
        const bar = document.querySelector('.sgx-foot-bar').getBoundingClientRect();
        const links = document.querySelector('.sgx-foot-links').getBoundingClientRect();
        return { fabB: fab.bottom, fabT: fab.top, footT: foot.top, barT: bar.top, linksT: links.top, vh: window.innerHeight };
      });
      expect(g.footT, '页脚已滚进视口').toBeLessThan(g.vh);
      expect(g.fabB, '浮钮下沿在页脚上沿之上').toBeLessThanOrEqual(g.footT);
      expect(g.fabB).toBeLessThanOrEqual(g.barT);
      expect(g.fabB).toBeLessThanOrEqual(g.linksT);
    });
  }

  test('页脚不在视口时浮钮回到基准位置（离底 ≥ 28px）', async ({ page }) => {
    await go(page, '/wild/');
    await page.evaluate(() => window.scrollTo(0, 0));
    await scrolledTo(page, 0);
    await nextFrames(page, 3);
    const g = await page.evaluate(() => ({ b: document.querySelector('#site-nav .sgx-tb-ai').getBoundingClientRect().bottom, vh: window.innerHeight, lift: getComputedStyle(document.querySelector('#site-nav .sgx-tb-ai')).getPropertyValue('--sgx-foot-lift').trim() }));
    expect(g.lift === '' || g.lift === '0px').toBe(true);
    expect(g.vh - g.b).toBeGreaterThanOrEqual(28);
  });
});
