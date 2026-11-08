/**
 * 2.5.0 PC 布局断言（Gray 2026-10-10 验收要求）；2026-10-23 PC 档删除，DeX 接手 PC 的尺寸。
 * - 1920x1080 / 2560x1440 下 html 为 layout-dex（自动）
 * - 首页栅格（2026-10-23 PR-D；P4-3 PR-4b 起顶栏不再定内容栏；宽屏平铺 PR 起外框 = 100% − 2m 通栏、名片 / 日刻去卡片栏间距 0）：每行左缘贴外框左缘，整行卡（名片 / 屏幕时间）右缘贴外框右缘；
 *   按列排的卡宽 = (框宽 − gap) / 2（P4-2c 起固定 2 列：名片和日刻并排），且不小于 320（日刻有数据时）
 * - （2026-10-19 Dock 已删除，原「滚到底 Dock 不压卡片」用例一并删除）
 * - 宽屏 DeX 下桌面图标网格（#home-apps）彻底不渲染
 *
 * Hark 规则：domcontentloaded + 等具体元素，不用 networkidle / waitForTimeout。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, setHomeCards, expect } = require('../helpers/helpers');

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
  await expect(page.locator('#home-hero')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('html')).toHaveClass(/layout-dex/);
}

function boxesIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

for (const vp of PCS) {
  test.describe(`dex-wide-layout ${vp.width}x${vp.height}`, () => {
    test('首页（2026-11 PR-2 首屏终端；对齐 PR-B 四节）：内容栏 = 顶栏内容栏（1080 居中，左右缘和字标 / 图标组对齐）；hero 居中、终端 ≤ 820 居中；各分节、日刻引言、目录 / 旷野三卡铺满内容栏', async ({ page }) => {
      await gotoWide(page, vp);
      await setHomeCards(page, { daymark: true });
      const g = await page.evaluate(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width }; };
        const logo = box(document.querySelector('#site-nav .sgx-tb-logo'));
        const acts = box(document.querySelector('#site-nav .sgx-tb-acts'));
        return { vw: innerWidth, wrap: box(document.querySelector('.home-wrap')), logo, acts,
          hero: box(document.getElementById('home-hero')), term: box(document.getElementById('home-term')),
          secs: [...document.querySelectorAll('.home-sec')].map((e) => [e.id, box(e)]),
          cards: [['w-daymark', document.getElementById('w-daymark')], ['curio-dirs', document.querySelector('#curio .home-dirs')], ['wild-cards', document.querySelector('#wild .home-wild')]].map(([id, e]) => [id, box(e)]),
          rows: ['#curio .home-dirs', '#wild .home-wild'].map((s) => { const ul = document.querySelector(s); return [s, box(ul.firstElementChild), box(ul.lastElementChild)]; }),
          sw: document.scrollingElement.scrollWidth };
      });
      const m = Math.min(48, Math.max(16, 5.333 + 0.022222 * g.vw));
      const want = Math.min(1080, g.vw - 2 * m);
      expect(Math.abs(g.wrap.w - want), `内容栏宽 ${g.wrap.w} ≠ ${want}`).toBeLessThanOrEqual(1);
      expect(Math.abs(g.wrap.l - (g.logo.l + 4)), '内容栏左缘 = 字标左缘（字标内缩 4）').toBeLessThanOrEqual(1);
      expect(Math.abs(g.wrap.r - g.acts.r), '内容栏右缘 = 图标组右缘').toBeLessThanOrEqual(1);
      expect(Math.abs(g.hero.w - g.wrap.w)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.term.w - Math.min(820, g.wrap.w)), `终端宽 ${g.term.w}`).toBeLessThanOrEqual(1);
      expect(Math.abs((g.term.l + g.term.r) / 2 - (g.wrap.l + g.wrap.r) / 2), '终端居中').toBeLessThanOrEqual(1);
      expect(g.secs.map((x) => x[0])).toEqual(['blog', 'curio', 'daymark', 'wild']);
      for (const [id, b] of g.secs.concat(g.cards)) {
        expect(Math.abs(b.l - g.wrap.l), `${id} 左缘`).toBeLessThanOrEqual(1);
        expect(Math.abs(b.r - g.wrap.r), `${id} 右缘`).toBeLessThanOrEqual(1);
      }
      /* 三卡一行：第一张贴左缘、最后一张贴右缘 */
      for (const [s, first, last] of g.rows) {
        expect(Math.abs(first.l - g.wrap.l), `${s} 第一张左缘`).toBeLessThanOrEqual(1);
        expect(Math.abs(last.r - g.wrap.r), `${s} 最后一张右缘`).toBeLessThanOrEqual(1);
      }
      expect(g.sw).toBeLessThanOrEqual(g.vw);
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
  await expect(page.locator('#home-hero')).toBeVisible({ timeout: 15000 });
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
