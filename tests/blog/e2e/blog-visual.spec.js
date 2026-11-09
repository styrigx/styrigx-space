import { test, expect } from '@playwright/test';
/* 2026-11 UI 重设计 PR-1：旧截图基线已删除（普通提交，不改历史），新精简基线在重设计最后一个 PR 重拍；
   在那之前不比截图（SHOTS = false），同一用例里的布局 / 行为断言照跑。重拍时改回 true。 */
const SHOTS = false;

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
  { name: 'article', path: '/blog/zh/post/2026-09-27-invite-board/' },
  { name: 'article-en', path: '/blog/post/2026-09-27-invite-board/' },
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
    if (SHOTS) await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false });
  });
}

test('悬浮顶栏不遮挡首个标题（布局断言）', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('navfolio-theme');
    } catch {}
  });
  // 首页 + 文章页：页面顶部时，首个可见标题的 top 必须 ≥ 顶栏 bottom（对齐 PR-C：首页是页头 .sgx-ph 的大标题「博客_」）
  for (const path of ['/blog/zh/', '/blog/zh/post/2026-09-27-invite-board/']) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    const result = await page.evaluate(() => {
      const header = document.querySelector('.sgx-topbar');
      const h1 = document.querySelector(
        '.sgx-ph-title, .oui-article-wrap h1, .oui-page-title h1',
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

// ===== 顶栏 v3（2026-11 UI 重设计 PR-1，四站同一个）=====
// 行为测试（NAVIGATE / 阅读进度 / cookie）在 app-topbar.spec.js；这里只量布局。
test.describe('顶栏 v3 布局', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('styrigx-blog-lang', 'en'); // P4-3 PR-4c：英文首页 /blog/ 不按浏览器语言跳 /blog/zh/
      } catch {}
    });
  });

  test('通栏（贴顶、全宽、高 64）：字标 · 外观 · 盾牌 · | · >_ · 头像，按钮 40；内容收进居中的 max(页边距, (宽 − 1080) / 2)；不显示页名；没有右圆分享', async ({ page }) => {
    const w = page.viewportSize().width;
    const m = w < 600 ? 12 /* 对齐 PR-B：手机页边距 12 */ : Math.min(48, Math.max(16, 5.333 + 0.022222 * w));
    const pad = Math.max(m, (w - 1080) / 2);
    for (const path of ['/blog/zh/', '/blog/zh/post/2026-09-27-invite-board/']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      const r = await page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect();
        const bar = box(document.querySelector('.sgx-topbar'));
        const logo = box(document.querySelector('.sgx-topbar > .sgx-tb-logo'));
        const acts = box(document.querySelector('.sgx-tb-acts'));
        const btns = [...document.querySelectorAll('.sgx-tb-acts > .sgx-tb-btn, .sgx-tb-acts > .sgx-tb-av')].map((e) => { const b = box(e); return [Math.round(b.width), Math.round(b.height)]; });
        return {
          bar: [Math.round(bar.left), Math.round(bar.width), Math.round(bar.height)], vw: innerWidth,
          btns, logoL: logo.left, actsR: acts.right,
          between: logo.right <= acts.left + 0.5,
          pill: box(document.querySelector('#site-nav .sgx-tb-pill')).width,
          share: !!document.querySelector('.sgx-topbar [data-sgx-share], .sgx-tb-end, .sgx-tb-nav'),
        };
      });
      expect(r.bar).toEqual([0, r.vw, 64]);
      expect(r.btns).toEqual([[40, 40], [40, 40], [40, 40], [40, 40]]);
      expect(Math.abs(r.logoL - (pad - 4)), `${path} 字标左 ${r.logoL}`).toBeLessThanOrEqual(1);
      expect(Math.abs(r.actsR - (w - pad)), `${path} 图标组右 ${r.actsR}`).toBeLessThanOrEqual(1);
      expect(r.between).toBe(true);
      expect(r.pill, '不显示页名').toBe(0);
      expect(r.share, '顶栏没有分享').toBe(false);
    }
  });

  /* 2026-11-09 语言行 Auto：跟随浏览器只在从站外进主站首页（/ ↔ /zh/）时换，子站首页 /blog/ 不跳 */
  test('中文浏览器（没有 cookie = Auto）：英文首页 /blog/ 不跳，停在 /blog/', async ({ browser }) => {
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
    expect(new URL(page.url()).pathname).toBe('/blog/');
    expect(navs, '停在 /blog/ 后不再导航').toBe(settled);
    await ctx.close();
  });
});
