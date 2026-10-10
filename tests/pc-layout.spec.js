/**
 * 2.5.0 PC 布局断言（Gray 2026-10-10 验收要求）。
 * - 1920x1080 / 2560x1440 下 html 为 layout-pc
 * - 同一行卡片右边缘误差 ≤1px（栅格铺满，无右侧空白）
 * - 滚到底时 Dock 不与任何卡片/内容区元素重叠
 * - PC 下桌面图标网格（#home-apps）彻底不渲染
 *
 * Hark 规则：domcontentloaded + 等具体元素，不用 networkidle / waitForTimeout。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

const PCS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

async function gotoPC(page, vp) {
  await page.setViewportSize(vp);
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('html')).toHaveClass(/layout-pc/);
}

function boxesIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

for (const vp of PCS) {
  test.describe(`pc-layout ${vp.width}x${vp.height}`, () => {
    test('同一行卡片右边缘对齐（误差≤1px）', async ({ page }) => {
      await gotoPC(page, vp);
      const rows = await page.evaluate(() => {
        const els = [...document.querySelectorAll('#home-widgets > .widget')]
          .filter((e) => e.offsetParent !== null);
        return els.map((e) => {
          const r = e.getBoundingClientRect();
          return { y: r.y + window.scrollY, right: r.right, w: r.width, id: e.id || '?' };
        });
      });
      // 按行分组（y 相近即为同一行）
      const groups = [];
      for (const w of rows.sort((a, b) => a.y - b.y)) {
        const g = groups.find((g) => Math.abs(g.y - w.y) < 8);
        if (g) { g.items.push(w); g.y = Math.min(g.y, w.y); }
        else groups.push({ y: w.y, items: [w] });
      }
      expect(groups.length).toBeGreaterThan(2);
      // 每行铺满栅格：行内最右缘贴容器右缘、最左缘贴容器左缘（误差≤1px），不留右侧空白
      const wrap = await page.evaluate(() => {
        const el = document.querySelector('.home-wrap');
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          left: r.left + parseFloat(cs.paddingLeft),
          right: r.right - parseFloat(cs.paddingRight),
        };
      });
      for (const g of groups) {
        const rights = g.items.map((i) => i.right);
        const lefts = g.items.map((i) => i.right - i.w);
        const maxRight = Math.max(...rights);
        const minLeft = Math.min(...lefts);
        expect(Math.abs(maxRight - wrap.right), `行右缘未铺满: ${g.items.map((i) => i.id).join(',')}`).toBeLessThanOrEqual(1);
        expect(Math.abs(minLeft - wrap.left), `行左缘未对齐: ${g.items.map((i) => i.id).join(',')}`).toBeLessThanOrEqual(1);
      }
    });

    test('滚到底 Dock 不压住任何卡片', async ({ page }) => {
      await gotoPC(page, vp);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect.poll(async () =>
        page.evaluate(() => window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 2),
      ).toBe(true);
      const res = await page.evaluate(() => {
        const dock = document.getElementById('dex-dock').getBoundingClientRect();
        const els = [...document.querySelectorAll('main .widget, main section')]
          .filter((e) => e.offsetParent !== null);
        const bad = [];
        for (const e of els) {
          const b = e.getBoundingClientRect();
          const hit = !(b.bottom <= dock.top || b.top >= dock.bottom || b.right <= dock.left || b.left >= dock.right);
          if (hit) bad.push(e.id || e.className.slice(0, 30));
        }
        // footer 内容（去掉 padding）也不能被压
        const f = document.querySelector('footer');
        const fb = f.getBoundingClientRect();
        const fcs = getComputedStyle(f);
        const contentBottom = fb.bottom - parseFloat(fcs.paddingBottom);
        return { bad, footerClear: contentBottom <= dock.top };
      });
      expect(res.bad).toEqual([]);
      expect(res.footerClear).toBe(true);
    });

    test('PC 下桌面图标网格不渲染', async ({ page }) => {
      await gotoPC(page, vp);
      await expect(page.locator('#home-apps')).toBeHidden();
      const visibleTiles = await page.locator('.app-grid .app-tile:visible').count();
      expect(visibleTiles).toBe(0);
    });

    test('顶栏与内容区左右对齐', async ({ page }) => {
      await gotoPC(page, vp);
      const r = await page.evaluate(() => {
        const pad = (el) => parseFloat(getComputedStyle(el).paddingLeft);
        const wrap = document.querySelector('.home-wrap');
        const nav = document.querySelector('.nav-inner');
        const wr = wrap.getBoundingClientRect(), nr = nav.getBoundingClientRect();
        const brand = document.getElementById('nav-brand').getBoundingClientRect();
        const tc = document.getElementById('nav-time-center').getBoundingClientRect();
        return {
          contentLeft: Math.round(wr.left + pad(wrap)), contentRight: Math.round(wr.right - pad(wrap)),
          brandLeft: Math.round(brand.left), tcRight: Math.round(tc.right),
        };
      });
      expect(Math.abs(r.brandLeft - r.contentLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(r.tcRight - r.contentRight)).toBeLessThanOrEqual(1);
    });
  });
}
