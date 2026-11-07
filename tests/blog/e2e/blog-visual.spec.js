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

/* 语言清理（2026-11-07）起博客也「跟随系统」每页都跳（四站同一份首帧跳转 lang-boot.js），Playwright 默认 en-US 会把 /blog/zh/… 换到英文页。
   截图 / 布局用例要的是「这一页」本身：每页首帧前明确选它自己的语言（同源 localStorage sgx-lang），不跳；
   浏览器 locale 不改（仍 en-US），和基线生成环境一致。「中文浏览器」那条用自己的 zh-CN 上下文，不受影响。 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('sgx-lang', location.pathname.startsWith('/blog/zh/') ? 'zh' : 'en');
    } catch {}
  });
});

const PAGES = [
  { name: 'home', path: '/blog/zh/' },
  { name: 'home-en', path: '/blog/' },
  { name: 'article', path: '/blog/zh/post/2026-10-07-muse-playbook/' },
  { name: 'article-en', path: '/blog/post/2026-10-07-muse-playbook/' },
  { name: 'tag', path: '/blog/zh/tags/ai' },
  { name: 'not-found', path: '/blog/zh/404.html' },
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
  for (const path of ['/blog/zh/', '/blog/zh/post/2026-10-07-muse-playbook/']) {
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
        localStorage.setItem('styrigx-blog-lang', 'en'); // P4-3 PR-4c：英文首页 /blog/ 不按浏览器语言跳 /blog/zh/
      } catch {}
    });
  });

  test('胶囊（2026-11-04 P5-1，四站同一个；P4-3 PR-4b 定稿）：字标 · 页名胶囊 · 九宫格 · 快捷设置 · AI（胶囊高手机 52、≥ 840 宽 56；里面按钮 40，字标 / AI 离胶囊边 (高 − 40) / 2）', async ({ page }) => {
    /* 共享外壳尺寸体系（2026-10-23）：--sgx-tb-btn 52 → 56（≥ 840 宽）；P5-1 起它是胶囊高，里面按钮 --sgx-tb-ic 40 */
    const wide = page.viewportSize().width >= 840;
    const B = wide ? 56 : 52;
    const inset = (B - 40) / 2;
    for (const path of ['/blog/zh/', '/blog/zh/post/2026-10-07-muse-playbook/']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      const r = await page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect();
        const bar = box(document.querySelector('.sgx-topbar'));
        const logo = box(document.querySelector('.sgx-topbar > .sgx-tb-logo'));
        /* PR-4b：头像搬进 AI 窗口头部，最右是 AI 按钮；页名胶囊量 .sgx-tb-title（中间那格是弹簧网格，格子本身不居中） */
        const pill = box(document.querySelector('.sgx-tb-title'));
        const me = box(document.querySelector('.sgx-tb-acts > .sgx-tb-ai'));
        const btns = [...document.querySelectorAll('.sgx-tb-acts > *')].map((e) => { const b = box(e); return [Math.round(b.width), Math.round(b.height)]; });
        return {
          barH: Math.round(bar.height),
          btns,
          sides: [Math.round((logo.left - bar.left) * 2) / 2, Math.round((bar.right - me.right) * 2) / 2],
          between: pill.width === 0 ? logo.right <= box(document.querySelector('.sgx-tb-acts')).left + 0.5 : logo.right <= pill.left + 0.5 && pill.right <= box(document.querySelector('.sgx-tb-acts')).left + 0.5,
          center: [pill.left + pill.width / 2 - bar.left, bar.right - (pill.left + pill.width / 2)],
          share: !!document.querySelector('.sgx-topbar [data-sgx-share], .sgx-tb-end, .sgx-tb-nav'),
        };
      });
      expect(r.barH).toBe(B);
      expect(r.btns).toEqual([[40, 40], [40, 40], [40, 40]]);
      expect(r.sides).toEqual([inset, inset]);
      expect(r.between).toBe(true);
      /* ≥ 600 宽：长条按内容定宽、居中在顶栏正中（共享外壳 1fr auto 1fr） */
      if (page.viewportSize().width >= 600) expect(Math.abs(r.center[0] - r.center[1])).toBeLessThanOrEqual(1);
      expect(r.share, '没有九宫格 / 右圆分享').toBe(false);
    }
  });

  test('中文浏览器（没有 cookie）：英文首页 /blog/ 跳 /blog/zh/ 一次后停住，不循环（P4-3 PR-4c 起英文默认）', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'zh-CN' });
    const page = await ctx.newPage();
    let navs = 0;
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navs++;
    });
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const settled = navs;
    await page.waitForTimeout(1500);
    expect(new URL(page.url()).pathname).toBe('/blog/zh/');
    expect(navs, '停在 /blog/zh/ 后不再导航').toBe(settled);
    await ctx.close();
  });
});
