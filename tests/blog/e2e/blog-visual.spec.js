import { test, expect } from '@playwright/test';

// One UI 视觉基线：每个页面 × 浅色/深色 × 手机 390×844 / 桌面 1200px。
// 基线图在 tests/e2e/blog-visual.spec.js-snapshots/，只在 CI 生成（update-snapshots.yml），同版本 Chromium 对比。

// 抽屉头头像等远程图片：截图前等所有图片解码完，避免有时在、有时空导致基线抖动
async function imagesReady(page) {
  await page
    .waitForFunction(() => Array.from(document.images).every((i) => i.complete), null, {
      timeout: 10000,
    })
    .catch(() => {});
}

const PAGES = [
  { name: 'home', path: '/blog/' },
  { name: 'home-en', path: '/blog/en/' },
  { name: 'article', path: '/blog/post/2026-10-07-muse-playbook/' },
  { name: 'article-en', path: '/blog/en/post/2026-10-07-muse-playbook/' },
  { name: 'tag', path: '/blog/tags/ai' },
  { name: 'not-found', path: '/blog/404.html' },
];

for (const { name, path } of PAGES) {
  test(`${name} baseline screenshot`, async ({ page }) => {
    // 固定主题：清掉已存偏好，让 colorScheme 生效
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('navfolio-theme');
      } catch {}
    });
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    // 等字体与图片稳定
    await page.evaluate(() => document.fonts.ready);
    await page
      .locator('.oui-article-wrap, .oui-archive-wrap, .oui-notfound')
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => {});
    // 无横向溢出断言
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    });
    expect(overflow, `${name} 有横向溢出`).toBe(false);
    await imagesReady(page);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false });
  });
}

test('悬浮顶栏不遮挡首个标题（布局断言）', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('navfolio-theme');
    } catch {}
  });
  // 首页 + 文章页：页面顶部时，首个可见标题（首页是「最新」分区标题，h1 只给读屏）的 top 必须 ≥ 顶栏 bottom
  for (const path of ['/blog/', '/blog/post/2026-10-07-muse-playbook/']) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    const result = await page.evaluate(() => {
      const header = document.querySelector('.sgx-topbar');
      const h1 = document.querySelector(
        '#sgx-pane-home .sgx-sec-head, .oui-article-wrap h1, .oui-page-title h1',
      );
      if (!header || !h1) return { ok: false, reason: 'header 或 h1 未找到' };
      const hb = header.getBoundingClientRect();
      const ht = h1.getBoundingClientRect();
      return { ok: ht.top >= hb.bottom - 1, h1Top: ht.top, headerBottom: hb.bottom };
    });
    expect(
      result.ok,
      `${path} 首个标题被顶栏遮挡 (h1.top=${result.h1Top}, header.bottom=${result.headerBottom})`,
    ).toBe(true);
  }
});

// ===== 顶栏 v4（沉浸式 app）=====
// 行为测试（页签 / 抽屉 / 阅读进度 / cookie）在 app-topbar.spec.js；这里只量三块布局。
test.describe('顶栏 v4 布局', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('styrigx-blog-lang', 'zh');
      } catch {}
    });
  });

  test('三块：左圆九宫格 · 长条 · 右圆分享（手机 52px、间距 8；≥ 840 宽 56px、间距 12；贴两端）', async ({ page }) => {
    /* 共享外壳尺寸体系（2026-10-23）：--sgx-tb-btn 52 → 56、--sgx-tb-gap 8 → 12（≥ 840 宽） */
    const wide = page.viewportSize().width >= 840;
    const B = wide ? 56 : 52;
    const G = wide ? 12 : 8;
    for (const path of ['/blog/', '/blog/post/2026-10-07-muse-playbook/']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      const r = await page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect();
        const pill = box(document.querySelector('.sgx-tb-pill'));
        const nav = box(document.querySelector('.sgx-topbar > .sgx-tb-nav'));
        const bar = box(document.querySelector('.sgx-topbar'));
        const meEl = document.querySelector('.sgx-topbar > .sgx-tb-end');
        const me = box(meEl);
        return {
          pillH: pill.height,
          nav: [nav.width, nav.height],
          me: [me.width, me.height],
          gaps: [Math.round(pill.left - nav.right), Math.round(me.left - pill.right)],
          sides: [Math.round(nav.left - bar.left), Math.round(bar.right - me.right)],
          meShare: meEl.matches('button[data-sgx-share]'),
        };
      });
      expect(r.pillH).toBe(B);
      expect(r.nav).toEqual([B, B]);
      /* 右圆分享：和左边九宫格圆一样大（2026-10-24 留言板撤了，不再是 86px 胶囊） */
      expect(r.me).toEqual([B, B]);
      /* 手机：长条拉满，两边各隔 8；≥ 600 宽：长条按内容定宽、居中在顶栏正中（共享外壳），两边间距相等且不小于 --sgx-tb-gap */
      if (page.viewportSize().width < 600) expect(r.gaps).toEqual([G, G]);
      else {
        expect(r.gaps[0]).toBeGreaterThanOrEqual(G);
        expect(Math.abs(r.gaps[0] - r.gaps[1])).toBeLessThanOrEqual(1);
      }
      expect(r.sides).toEqual([0, 0]);
      expect(r.meShare, '右圆 = 分享按钮').toBe(true);
    }
  });

  test('英文浏览器（没有 cookie）：/ 跳 /en/ 一次后停住，不循环', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'en-US' });
    const page = await ctx.newPage();
    let navs = 0;
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navs++;
    });
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const settled = navs;
    await page.waitForTimeout(1500);
    expect(new URL(page.url()).pathname).toBe('/blog/en/');
    expect(navs, '停在 /en/ 后不再导航').toBe(settled);
    await ctx.close();
  });
});
