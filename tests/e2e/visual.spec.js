/**
 * 2.4.0 E：视觉回归测试。
 * 5 视口 × 中英 × 深浅色 × 主要页面（/、/files/、/store/、/browser/、/settings/）
 * + F 的两张基准（弹层打开、引擎菜单打开）。
 * 首次运行：npx playwright test --update-snapshots 生成基准；
 * 后续运行自动对比，不一致即失败。
 *
 * Hark：goto 用 domcontentloaded + 等具体元素，不用 networkidle
 * （CI 里外部请求会让 networkidle 永远等不到）；删掉全部 waitForTimeout。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

const VIEWPORTS = {
  mobile: { width: 412, height: 915 },
  landscape: { width: 915, height: 412 },
  tabletPortrait: { width: 800, height: 1280 },
  tabletLandscape: { width: 1280, height: 800 },
  desktop: { width: 1920, height: 1080 },
};
/* 安全与隐私：新页面加入视觉回归（先只报告，基线未生成前不阻塞） */
const PAGES = ['/', '/files/', '/store/', '/browser/', '/settings/', '/settings/security/', '/settings/security/lock/'];
const LANGS = [
  { prefix: '', name: 'zh' },
  { prefix: '/en', name: 'en' },
];
const THEMES = [
  { name: 'light', setup: null },
  { name: 'dark', setup: 'dark' },
];

/* 页面主容器：等它出现即认为页面主体已渲染 */
const MAIN = 'main, #app-grid';

/** 等页面就绪：主容器可见 + 字体加载完成 */
async function waitPageReady(pg) {
  await expect(pg.locator(MAIN).first()).toBeVisible({ timeout: 15000 });
  await pg.evaluate(() => document.fonts.ready);
}

/** 所有组合：视口 × 语言 × 主题 × 页面 */
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      for (const page of PAGES) {
        const name = `${vpName}-${lang.name}-${theme.name}${page.replace(/\//g, '_')}`;
        test(name, async ({ page: pg }) => {
          await pg.setViewportSize(vp);
          await blockExternalRequests(pg);
          /* 2.8.0：files 页面书单 mock（page.route 后注册优先于 blockExternalRequests 的通配拦截）
             封面 URL 也 route 到本地占位图，避免被拦成破图 */
          if (page === '/files/') {
            /* Hark：拦截 filesindex.json，取真实响应，只替换书籍条目（固定日期 10-01~10-08，在冻结时间 10-09 的 30 天窗口内），站点等保留 */
            await pg.route('**/files-index.json**', async (route) => {
              const res = await route.fetch();
              const data = await res.json();
              const items = data.items || [];
              /* 保留非书籍条目，书籍换成 3 本固定 */
              const kept = items.filter((it) => it.type !== 'book');
              const books = [
                { id: 'book-fixture-a', type: 'book', lang: 'zh', title: 'Fixture Book A', subtitle: 'Author A', url: '/books/fixture-a/', cover: '/covers/fixture-a.png', addedAt: '2026-10-08' },
                { id: 'book-fixture-b', type: 'book', lang: 'zh', title: 'Fixture Book B', subtitle: 'Author B', url: '/books/fixture-b/', cover: '/covers/fixture-b.png', addedAt: '2026-10-05' },
                { id: 'book-fixture-c', type: 'book', lang: 'zh', title: 'Fixture Book C', subtitle: 'Author C', url: '/books/fixture-c/', cover: '/covers/fixture-c.png', addedAt: '2026-10-01' },
                { id: 'book-fixture-a-en', type: 'book', lang: 'en', title: 'Fixture Book A', subtitle: 'Author A', url: '/en/books/fixture-a/', cover: '/covers/fixture-a.png', addedAt: '2026-10-08' },
                { id: 'book-fixture-b-en', type: 'book', lang: 'en', title: 'Fixture Book B', subtitle: 'Author B', url: '/en/books/fixture-b/', cover: '/covers/fixture-b.png', addedAt: '2026-10-05' },
                { id: 'book-fixture-c-en', type: 'book', lang: 'en', title: 'Fixture Book C', subtitle: 'Author C', url: '/en/books/fixture-c/', cover: '/covers/fixture-c.png', addedAt: '2026-10-01' },
              ];
              data.items = kept.concat(books);
              await route.fulfill({ response: res, json: data });
            });
            /* Hark：route 用前后双星号通配（实际请求可能带查询参数），带 CORS 头 */
            const SHELF_FIXTURE = {
              books: [
                { title: 'Book One', author: 'Author A', cover: '/covers/1.png', date: '2026-10-01', url: '#', comment: 'Test book 1' },
                { title: 'Book Two', author: 'Author B', cover: '/covers/2.png', date: '2026-10-02', url: '#', comment: 'Test book 2' },
                { title: 'Book Three', author: 'Author C', cover: '/covers/3.png', date: '2026-10-03', url: '#', comment: 'Test book 3' },
              ],
            };
            await pg.route('**/api/shelf**', async (route) => {
              /* Hark 修正：goto 前 pg.url() 还是 about:blank，origin 取请求头 */
              const origin = route.request().headers()['origin'] || '*';
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: {
                  'access-control-allow-origin': origin,
                  'access-control-allow-credentials': 'true',
                },
                body: JSON.stringify(SHELF_FIXTURE),
              });
            });
            /* 封面图 route 到本地 1x1 占位 */
            await pg.route('**/covers/*', async (route) => {
              await route.fulfill({
                contentType: 'image/png',
                body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
              });
            });
          }
          /* 关掉动画，保证截图稳定（goto 之前设置，context 级生效） */
          await pg.emulateMedia({ reducedMotion: 'reduce' });
          /* 预置主题 + 冻结时间，避免动态内容导致截图不稳定
             （锁屏由构建期 SGX_TEST_NO_LOCK=1 禁用，见 deploy.yml） */
          /* 2.8.0：固定音乐索引，避免按日期漂移导致基线不稳定 */
          if (page === '/' || page === '/en/') {
            await pg.addInitScript(() => {
              try { localStorage.setItem('sgx-np-idx', '0'); } catch (e) {}
            });
          }
          await pg.addInitScript((t) => {
            if (t === 'dark') {
              try { localStorage.setItem('sgx-theme-mode', 'dark'); } catch (e) {}
            }
          }, theme.setup);
          /* 2.8.0：语言跟随系统（2.7.0 起）会按浏览器 locale 跳转 /en/，
             Playwright 默认 en-US 会导致中文截图拍到英文页。
             按测试语言显式钉住 sgx-lang，保证截图语言确定、基线可复现；
             跟随行为本身由 lang-follow.spec.js 单独覆盖。 */
          await pg.addInitScript((ln) => {
            try { localStorage.setItem('sgx-lang', ln); } catch (e) {}
          }, lang.name);
          /* 2.8.0：中文走系统字体回退，不同机器默认中文字体不同会导致截图漂移。
             在默认栈尾部显式指定 Noto Sans CJK SC（CI 已安装，见 deploy.yml），
             拉丁文仍走原栈（Inter/webfont），保证截图跨环境一致。 */
          await pg.addStyleTag({
            content: 'html{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans CJK",sans-serif !important}',
          });
          await freezeTime(pg);
          await pg.goto(lang.prefix + page, { waitUntil: 'domcontentloaded' });
          await waitPageReady(pg);
          /* 浏览器页：快捷访问 favicon 走外部请求（测试拦截 abort），失败兜底
             异步把 img 换成首字母 span；截图前等可视区图标全部落定，
             否则截图会抓到"破图图标 vs 字母占位"的中间态导致抖动 */
          if (page.includes('/browser')) {
            try {
              await pg.waitForFunction(() => {
                const vh = window.innerHeight || 800;
                const imgs = document.querySelectorAll('img[data-favname]');
                for (const img of imgs) {
                  const r = img.getBoundingClientRect();
                  if (r.bottom > 0 && r.top < vh && !img.complete) return false;
                }
                return true;
              }, { timeout: 20000 });
            } catch (e) { /* 超时也不卡死：继续截图 */ }
          }
          await expect(pg).toHaveScreenshot(`${name}.png`, {
            fullPage: false,
            animations: 'disabled',
            /* 遮罩动态区域：时钟、天气 */
            mask: [pg.locator('#dual-clock'), pg.locator('#weather')],
          });
        });
      }
    }
  }
}

/* F 基准 1：弹层打开（2.6.0 起日期时间行在 /settings/manage/ 子页） */
test('baseline-sheet-open', async ({ page: pg }) => {
  await pg.setViewportSize(VIEWPORTS.mobile);
  await blockExternalRequests(pg);
  await pg.emulateMedia({ reducedMotion: 'reduce' });
  /* 2.8.0：钉住中文，避免语言跟随跳转到 /en/ 导致基线语言漂移 */
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  /* 2.8.0：中文回退字体显式化（见主循环注释），保证跨环境一致 */
  await pg.addStyleTag({
    content: 'html{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans CJK",sans-serif !important}',
  });
  await freezeTime(pg);
  await pg.goto('/settings/manage/', { waitUntil: 'domcontentloaded' });
  await waitPageReady(pg);
  /* 2.8.0：等目标行就绪（可能在折叠区下方） */
  await pg.locator('#row-datetime').waitFor({ state: 'visible', timeout: 15000 });
  await pg.locator('#row-datetime').scrollIntoViewIfNeeded();
  await pg.click('#row-datetime');
  /* 等原生 dialog 弹层打开 */
  await expect(pg.locator('dialog[open]').first()).toBeVisible({ timeout: 10000 });
  await expect(pg).toHaveScreenshot('baseline-sheet-open.png', { animations: 'disabled' });
});

/* F 基准 2：引擎菜单打开（浏览器页搜索引擎菜单） */
test('baseline-engine-menu', async ({ page: pg }) => {
  await pg.setViewportSize(VIEWPORTS.mobile);
  await blockExternalRequests(pg);
  await pg.emulateMedia({ reducedMotion: 'reduce' });
  /* 2.8.0：钉住中文，避免语言跟随跳转到 /en/ 导致基线语言漂移 */
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  /* 2.8.0：中文回退字体显式化（见主循环注释），保证跨环境一致 */
  await pg.addStyleTag({
    content: 'html{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans CJK",sans-serif !important}',
  });
  await freezeTime(pg);
  await pg.goto('/browser/', { waitUntil: 'domcontentloaded' });
  await waitPageReady(pg);
  /* 2.8.0：引擎切换按钮在搜索弹出层内，须先点底部地址栏胶囊打开弹出层，
     否则按钮被页面内容盖住点不到（之前直接点导致 30s 超时） */
  await pg.locator('#brw-addrbar').click();
  await expect(pg.locator('#brw-overlay.open')).toBeVisible({ timeout: 10000 });
  const btn = pg.locator('#brw-engine-btn');
  if (await btn.count()) {
    await btn.click();
    /* 等引擎菜单弹出（popover 菜单容器） */
    await expect(pg.locator('#brw-eng-menu').first()).toBeVisible({ timeout: 10000 });
  }
  await expect(pg).toHaveScreenshot('baseline-engine-menu.png', { animations: 'disabled' });
});


/* 2.8.0：站点卡片标题非空断言（中英）。data/sites.yaml 的 title 字段缺失会导致中文站名空白（线上真 bug）。 */
test('site-card-titles-nonempty', async ({ page: pg }) => {
  for (const lang of ['', '/en']) {
    await pg.goto(lang + '/files/', { waitUntil: 'domcontentloaded' });
    await pg.locator('[data-home-group="sites"] .files-rows li').first().waitFor({ timeout: 15000 });
    const titles = await pg.locator('[data-home-group="sites"] .files-rows li .text-\\[15px\\]').allTextContents();
    for (const t of titles) {
      if (!t.trim()) throw new Error(`Empty site title on ${lang || '/'} files page`);
    }
    if (titles.length === 0) throw new Error(`No site cards on ${lang || '/'} files page`);
  }
});
