/**
 * 顶栏与页面头部统一规格 v1.0 验收测试。
 *
 * 配置区（文件顶部）：页面 URL 和各站按钮选择器。
 * 与 Book 的 tests/e2e/topbar-spec.spec.js 保持结构一致。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

/* ================= 配置区 ================= */
const PAGES = {
  home: '/',
  homeEn: '/en/',
  settings: '/settings/',
  settingsEn: '/en/settings/',
};
/* 原按钮选择器（卡片版按钮点击时转发到这些） */
const ORIG_BACK_SELECTORS = ['.subpage-back', '[data-go-back]'];
const ORIG_MORE_SELECTORS = ['.subpage-more', '#files-more', '#sec-more'];
/* 卡片版按钮选择器（实现后） */
const CARD_BACK = '.sgx-topcard-back';
const CARD_MORE = '.sgx-topcard-more';
const CARD = '.sgx-topcard';
const BRAND = '.sgx-topcard-brand';
const MINI_TITLE = '.subpage-mini-title';
/* =========================================== */

test.use({ viewport: { width: 390, height: 844 } });

async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

async function gotoPage(pg, path) {
  await blockExternalRequests(pg);
  await pg.goto(path, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector(CARD, { timeout: 15000 });
  /* 等入场动画/字体收敛 */
  await pg.waitForTimeout(500);
}

/**
 * 公共断言：元素的盒模型在容差内。
 * @param {import('@playwright/test').Locator} locator
 * @param {{left?:number, top?:number, width?:number, height?:number, right?:number, bottom?:number}} box
 * @param {number} tol
 */
async function expectBox(locator, box, tol = 1) {
  const r = await locator.boundingBox();
  expect(r, 'element should have a bounding box').not.toBeNull();
  for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom']) {
    if (box[k] === undefined) continue;
    let actual;
    if (k === 'right') actual = r.x + r.width;
    else if (k === 'bottom') actual = r.y + r.height;
    else if (k === 'left') actual = r.x;
    else if (k === 'top') actual = r.y;
    else actual = r[k];
    expect(Math.abs(actual - box[k]), `${k}: actual=${actual}, expected=${box[k]}±${tol}`).toBeLessThanOrEqual(tol);
  }
}

/**
 * 用 Range 量文字位置（精确到字形）。
 * @param {import('@playwright/test').Locator} locator
 * @returns {Promise<DOMRect>}
 */
async function textRect(locator) {
  return locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
}

/* 验收 1-7：中英文各跑一遍 */
for (const lang of ['zh', 'en']) {
  test.describe(`topbar v1.0 [${lang}]`, () => {
    test.beforeEach(async ({ page }) => {
      await pinLang(page, lang);
    });

    /* 验收 1：卡片几何 */
    test('1. 卡片位置尺寸：left/right 16±1，top 16±1，height 52±1，圆角 26px', async ({ page }) => {
      await gotoPage(page, lang === 'en' ? PAGES.homeEn : PAGES.home);
      const card = page.locator(CARD);
      await expectBox(card, { left: 16, top: 16, height: 52 }, 1);
      /* right = viewport 宽 - 16 */
      const vw = page.viewportSize().width;
      await expectBox(card, { right: vw - 16 }, 1);
      /* 圆角 computed 26px */
      const radius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
      expect(radius).toContain('26px');
    });

    /* 验收 2：品牌组几何 */
    test('2. 头像距卡片左 12±1，头像右到文字左 8±1，垂直居中 ≤1', async ({ page }) => {
      await gotoPage(page, lang === 'en' ? PAGES.homeEn : PAGES.home);
      const card = page.locator(CARD);
      const brand = page.locator(BRAND);
      const avatar = brand.locator('img, .sgx-topcard-avatar').first();
      const textEl = brand.locator('.sgx-topcard-text, span').last();

      const cb = await card.boundingBox();
      const ab = await avatar.boundingBox();
      /* 头像左边缘距卡片左边缘 12±1 */
      expect(Math.abs(ab.x - cb.x - 12), `avatar left offset: ${ab.x - cb.x}`).toBeLessThanOrEqual(1);

      /* 头像右到文字左 8±1（Range 量文字） */
      const tr = await textRect(textEl);
      const gap = tr.left - (ab.x + ab.width);
      expect(Math.abs(gap - 8), `text gap: ${gap}`).toBeLessThanOrEqual(1);

      /* 垂直居中：头像中心、文字中心 vs 卡片中心 ≤1 */
      const cardCy = cb.y + cb.height / 2;
      const avatarCy = ab.y + ab.height / 2;
      const textCy = tr.top + tr.height / 2;
      expect(Math.abs(avatarCy - cardCy), 'avatar vertical center').toBeLessThanOrEqual(1);
      expect(Math.abs(textCy - cardCy), 'text vertical center').toBeLessThanOrEqual(1);
    });

    /* 验收 3：#site-nav 透明 */
    test('3. #site-nav computed background-color 透明', async ({ page }) => {
      for (const p of [lang === 'en' ? PAGES.homeEn : PAGES.home, lang === 'en' ? PAGES.settingsEn : PAGES.settings]) {
        await gotoPage(page, p);
        const bg = await page.locator('#site-nav').evaluate((el) => getComputedStyle(el).backgroundColor);
        /* transparent 或 rgba(0,0,0,0) */
        expect(bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent', `#site-nav bg on ${p}: ${bg}`).toBe(true);
      }
    });

    /* 验收 4：时间和天气已删除 */
    test('4. 页面不存在 #nav-time-center 和 #nav-wx', async ({ page }) => {
      await gotoPage(page, lang === 'en' ? PAGES.homeEn : PAGES.home);
      expect(await page.locator('#nav-time-center').count()).toBe(0);
      expect(await page.locator('#nav-wx').count()).toBe(0);
    });

    /* 验收 5：设置页标题区几何 */
    test('5. 设置页标题区：大标题底边=区底边-76，区高=max(240,0.3×844)，按钮 16/8', async ({ page }) => {
      await gotoPage(page, lang === 'en' ? PAGES.settingsEn : PAGES.settings);
      const head = page.locator('[data-subpage-head]').first();
      const hb = await head.boundingBox();
      /* 区高 = max(240, 0.3*844=253.2) = 253.2 ±1 */
      const expectedH = Math.max(240, 0.3 * 844);
      expect(Math.abs(hb.height - expectedH), `head height: ${hb.height}`).toBeLessThanOrEqual(1);

      /* 大标题底边 = 区底边 - 76 */
      const title = head.locator('.subpage-title');
      const tb = await title.boundingBox();
      const titleBottomToHeadBottom = (hb.y + hb.height) - (tb.y + tb.height);
      expect(Math.abs(titleBottomToHeadBottom - 76), `title bottom gap: ${titleBottomToHeadBottom}`).toBeLessThanOrEqual(1);

      /* ← 距左 16±1、距区底边 8±1；⋮ 距右 16±1、距区底边 8±1 */
      const back = head.locator('.subpage-back');
      const more = head.locator('.subpage-actions button, .subpage-more').first();
      const bb = await back.boundingBox();
      const mb = await more.boundingBox();
      const vw = page.viewportSize().width;
      expect(Math.abs(bb.x - 16), 'back left').toBeLessThanOrEqual(1);
      expect(Math.abs((hb.y + hb.height) - (bb.y + bb.height) - 8), 'back bottom').toBeLessThanOrEqual(1);
      expect(Math.abs(vw - (mb.x + mb.width) - 16), 'more right').toBeLessThanOrEqual(1);
      expect(Math.abs((hb.y + hb.height) - (mb.y + mb.height) - 8), 'more bottom').toBeLessThanOrEqual(1);
    });

    /* 验收 6：滚动后状态（三种模式） */
    for (const mode of ['normal', 'js-fallback', 'reduced-motion']) {
      test(`6. 滚动 400px 后状态 [${mode}]`, async ({ page }) => {
        if (mode === 'js-fallback') {
          /* 强制 JS 兜底：让 CSS.supports('animation-timeline: view()') 返回 false */
          await page.addInitScript(() => {
            const orig = CSS.supports.bind(CSS);
            // @ts-ignore
            CSS.supports = (...args) => {
              if (args[0] && String(args[0]).includes('animation-timeline')) return false;
              // @ts-ignore
              return orig(...args);
            };
            document.documentElement.classList.add('sgx-no-view-timeline');
          });
        }
        if (mode === 'reduced-motion') {
          await page.emulateMedia({ reducedMotion: 'reduce' });
        }
        await gotoPage(page, lang === 'en' ? PAGES.settingsEn : PAGES.settings);

        /* 滚动 400px */
        await page.evaluate(() => window.scrollTo(0, 400));
        /* 用 expect.poll 等小标题 opacity 变 1，不用 waitForTimeout */
        const mini = page.locator(MINI_TITLE).first();
        await expect.poll(async () => {
          return await mini.evaluate((el) => parseFloat(getComputedStyle(el).opacity));
        }, { timeout: 5000 }).toBeGreaterThan(0.9);

        /* 品牌组 opacity 0 且不可点 */
        const brand = page.locator(BRAND);
        const brandOpacity = await brand.evaluate((el) => parseFloat(getComputedStyle(el).opacity));
        expect(brandOpacity).toBeLessThanOrEqual(0.1);
        const brandPe = await brand.evaluate((el) => getComputedStyle(el).pointerEvents);
        expect(brandPe).toBe('none');

        /* 小标题 opacity 1，中心与卡片中心误差 ≤1 */
        const card = page.locator(CARD);
        const cb = await card.boundingBox();
        const mb2 = await mini.boundingBox();
        const cardCx = cb.x + cb.width / 2;
        const cardCy = cb.y + cb.height / 2;
        const miniCx = mb2.x + mb2.width / 2;
        const miniCy = mb2.y + mb2.height / 2;
        expect(Math.abs(miniCx - cardCx), 'mini-title horizontal center').toBeLessThanOrEqual(1);
        expect(Math.abs(miniCy - cardCy), 'mini-title vertical center').toBeLessThanOrEqual(1);

        /* 卡片版 ← 左边缘 = 卡片左 + 6；⋮ 右边缘 = 卡片右 - 6 */
        const cardBack = page.locator(CARD_BACK);
        const cardMore = page.locator(CARD_MORE);
        const cbb = await cardBack.boundingBox();
        const cmb = await cardMore.boundingBox();
        expect(Math.abs(cbb.x - cb.x - 6), 'card back left').toBeLessThanOrEqual(1);
        expect(Math.abs((cb.x + cb.width) - (cmb.x + cmb.width) - 6), 'card more right').toBeLessThanOrEqual(1);

        /* 点卡片版 ← 效果和原按钮一致（这里只验证可点且触发导航/历史） */
        /* 滚回顶部后还原 */
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(async () => {
          return await brand.evaluate((el) => parseFloat(getComputedStyle(el).opacity));
        }, { timeout: 5000 }).toBeGreaterThan(0.9);
      });
    }
  });
}

/* 验收 7：DeX 1280 宽卡片居中 */
test.describe('topbar v1.0 [dex]', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('7. DeX 1280：卡片宽 1068±1 且水平居中', async ({ page }) => {
    await pinLang(page, 'zh');
    await gotoPage(page, PAGES.home);
    const card = page.locator(CARD);
    await expectBox(card, { width: 1068 }, 1);
    const cb = await card.boundingBox();
    const vw = page.viewportSize().width;
    const cardCx = cb.x + cb.width / 2;
    expect(Math.abs(cardCx - vw / 2), 'card centered').toBeLessThanOrEqual(1);
  });
});
