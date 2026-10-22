/**
 * 2.5.0 PC 布局断言（Gray 2026-10-10 验收要求）；2026-10-23 PC 档删除，DeX 接手 PC 的尺寸。
 * - 1920x1080 / 2560x1440 下 html 为 layout-dex（自动）
 * - 首页栅格（2026-10-23 PR-D）：外框 = 顶栏框；每行左缘贴外框左缘，整行卡（名片 / 屏幕时间）右缘贴外框右缘；
 *   按列排的卡宽 = (框宽 − (N−1)·gap) / N（≥ 1200 宽 N = 3），且不小于 320（天气 + 日刻全有数据时）
 * - （2026-10-19 Dock 已删除，原「滚到底 Dock 不压卡片」用例一并删除）
 * - 宽屏 DeX 下桌面图标网格（#home-apps）彻底不渲染
 *
 * Hark 规则：domcontentloaded + 等具体元素，不用 networkidle / waitForTimeout。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, setHomeCards, expect } = require('./helpers');

const PCS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

async function gotoWide(page, vp) {
  await page.setViewportSize(vp);
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('html')).toHaveClass(/layout-dex/);
}

function boxesIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

for (const vp of PCS) {
  test.describe(`dex-wide-layout ${vp.width}x${vp.height}`, () => {
    test('栅格：行左缘 / 整行卡右缘贴外框，列宽 = 3 列等分（≥ 320）', async ({ page }) => {
      await gotoWide(page, vp);
      /* 天气 + 日刻全有数据（缺卡时按可见卡数收列，见 layout-auto「时钟行」） */
      await setHomeCards(page, { weather: true, daymark: true });
      const g = await page.evaluate(() => {
        const wrap = document.querySelector('.home-wrap').getBoundingClientRect();
        const bar = document.querySelector('.sgx-topbar').getBoundingClientRect();
        const grid = document.querySelector('#home-widgets');
        const gap = parseFloat(getComputedStyle(grid).columnGap);
        const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        const cards = [...grid.querySelectorAll(':scope > .widget')].filter((e) => e.offsetParent !== null)
          .map((e) => { const r = e.getBoundingClientRect(); return { id: e.id, x: r.left, r: r.right, w: r.width, y: r.top + scrollY }; });
        return { wrap: { l: wrap.left, r: wrap.right, w: wrap.width }, bar: { l: bar.left, r: bar.right }, gap, cols, cards };
      });
      expect(g.cols).toBe(3);
      expect(Math.abs(g.wrap.l - g.bar.l), '外框左缘 = 顶栏左缘').toBeLessThanOrEqual(1);
      expect(Math.abs(g.wrap.r - g.bar.r), '外框右缘 = 顶栏右缘').toBeLessThanOrEqual(1);
      const colW = (g.wrap.w - 2 * g.gap) / 3;
      expect(g.cards.length).toBeGreaterThan(2);
      for (const c of g.cards) {
        const rowStart = Math.min(...g.cards.filter((d) => Math.abs(d.y - c.y) < 8).map((d) => d.x));
        expect(Math.abs(rowStart - g.wrap.l), `${c.id} 所在行左缘`).toBeLessThanOrEqual(1);
        if (c.id === 'w-profile' || c.id === 'w-screen') expect(Math.abs(c.r - g.wrap.r), `${c.id} 整行`).toBeLessThanOrEqual(1);
        else { expect(Math.abs(c.w - colW), `${c.id} 列宽 ${c.w} ≠ ${colW}`).toBeLessThanOrEqual(1); expect(c.w).toBeGreaterThanOrEqual(320); }
      }
    });


    test('宽屏 DeX 下桌面图标网格不渲染', async ({ page }) => {
      await gotoWide(page, vp);
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
  test('DeX 下桌面图标网格不渲染', async ({ page }) => {
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
