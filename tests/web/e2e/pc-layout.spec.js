/**
 * 2.5.0 PC 布局断言（Gray 2026-10-10 验收要求）。
 * - 1920x1080 / 2560x1440 下 html 为 layout-pc
 * - 同一行卡片右边缘误差 ≤1px（栅格铺满，无右侧空白）
 * - （2026-10-19 Dock 已删除，原「滚到底 Dock 不压卡片」用例一并删除）
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


    test('PC 下桌面图标网格不渲染', async ({ page }) => {
      await gotoPC(page, vp);
      await expect(page.locator('#home-apps')).toBeHidden();
      const visibleTiles = await page.locator('.app-grid .app-tile:visible').count();
      expect(visibleTiles).toBe(0);
    });

  });
}

/* ----- DeX（1366x768 横屏 → layout-dex）第二轮返工断言 ----- */
async function gotoDex(page) {
  await page.setViewportSize({ width: 1366, height: 768 });
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('html')).toHaveClass(/layout-dex/);
}

test.describe('dex-layout 1366x768', () => {
  test('DeX 下桌面图标网格不渲染（与 PC 一致）', async ({ page }) => {
    await gotoDex(page);
    await expect(page.locator('#home-apps')).toBeHidden();
    const visibleTiles = await page.locator('.app-grid .app-tile:visible').count();
    expect(visibleTiles).toBe(0);
  });

  test('DeX 下底部渐隐带不渲染', async ({ page }) => {
    await gotoDex(page);
    await expect(page.locator('#edge-bottom')).toBeHidden();
  });

});
