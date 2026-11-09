// 2026-10-20 沉浸式 app 顶栏验收（不截图，只断言行为和布局）：
// - 顶栏三块：九宫格 · 长条 · 右圆分享（2026-10-24 留言板撤了）；没有 ‹ 返回、没有 ⋮，没有版权页脚。
// - 2026-11 对齐 PR-C（设计稿 pg=blog / tree / post）：列表页是一页文章列表（分类 chips 筛选、less 分页、旧 #topics 地址转到目录页 / 筛选），目录页 /blog/tree/，文章文末两卡 + 分享一行。
// - 指示器 = 抽屉当前项同一套 tonal（--sgx-nav-selected，同主站顶栏三栏 .sgx-tb-tab）；阅读进度 = 填充档（--sgx-accent = --sgx-primary-fill）；
//   都跟 sgx-ui cookie 的 pal / 自定义种子 accent 变；抽屉当前项 / 目录当前节是 tonal。
// - 九宫格 → 左侧导航抽屉（主站共享外壳同一份：主站 / 奇趣 / 日刻 / 博客，字标 + 头像、底栏搜索框，毛玻璃、tonal 当前项）；文章页抽屉最下面是目录。
// - 只有列表页（首页）长条是 首页 · 文章 · 专题；其他页（文章、标签、404）长条只有页名；文章页长条底边一条强调色细线是阅读进度。
// - 2026-11-04 P5-1 顶栏全大椭圆（四站同一个，共享外壳 partials/shell-topbar.html）：一整条胶囊 logo · 长条 · 快捷面板 · AI · 头像；
//   九宫格、导航抽屉、右圆分享删除。站点列表在快捷面板第 1 页「导航」（博客是 tonal 当前项，没有搜索框），「分享本页」在第 2 页。
// - P4-3 PR-4b 定稿：字标 · 页名胶囊 · 九宫格 · 快捷设置 · AI；头像搬进 AI 窗口头部；九宫格开导航面板 #sgx-nav（2×2 站点磁贴，博客「开」态）；
//   快捷面板只有一页（四站同一套，「分享本页」磁贴在里面）。
// - 2026-11 UI 重设计 PR-1 顶栏 v3：贴顶通栏 = 字标 ❯ styrigx :~$_ · 页名标记（不显示）· 外观 · 盾牌 · | · >_（NAVIGATE）· 头像，
//   底边滑页进度条 .sgx-tb-prog；AI 浮钮右下角；NAVIGATE = 01 主页 … 05 旷野（博客「开」态）→ lang / layout → share / lock → STATUS；
//   外观面板只有 MODE + PALETTE；每页底部 tmux 页脚（当前窗口 1:blog）。
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

/* 预设种子从共享外壳的 palettes.json 读（主站改种子时不用改测试） */
const SEEDS = Object.fromEntries(
  JSON.parse(readFileSync(new URL('../../../space/web/data/shell/palettes.json', import.meta.url), 'utf8')).presets.map((p) => [p.id, p.seed]),
);

test.use({ viewport: { width: 412, height: 915 } });

/* 语言清理（2026-11-07）起博客也「跟随系统」每页都跳（四站同一份首帧跳转 lang-boot.js），Playwright 默认 en-US 会把 /blog/zh/… 换到英文页。
   本文件的中文用例按中文浏览器跑（同奇趣 / 日刻）；要看英文页的地方先明确选英文（同源 localStorage sgx-lang=en），见 preferLang。 */
test.use({ locale: 'zh-CN' });
/** 页面打开前就明确选语言（之后每次导航首帧前写 localStorage sgx-lang）。 @param {import('@playwright/test').Page} page @param {string} l */
const preferLang = (page, l) => page.addInitScript((v) => { try { localStorage.setItem('sgx-lang', v); } catch (e) {} }, l);

const enc = (o) =>
  Buffer.from(JSON.stringify(o))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function setUi(context, baseURL, ui) {
  const u = new URL(baseURL);
  await context.addCookies([{ name: 'sgx-ui', value: enc(ui), domain: u.hostname, path: '/' }]);
}

test.beforeEach(async ({ page }) => {
  await page.route('https://styrigx.com/**', (r) => r.fulfill({ status: 204 }));
  await page.addInitScript(() => {
    try {
      localStorage.setItem('styrigx-blog-lang', 'en'); // P4-3 PR-4c：英文首页 /blog/ 不按浏览器语言跳 /blog/zh/
    } catch {}
  });
});

const ARTICLE = '/blog/zh/post/2026-10-07-muse-playbook/';
const SERIES_V2 = '/blog/zh/post/2026-10-11-key-spec-whitepaper-v2/';

/** 计算任一 --sgx-* 角色的实际颜色 */
const roleColor = (page, v) =>
  page.evaluate((v) => {
    const probe = document.createElement('i');
    probe.style.color = 'var(' + v + ')';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, v);

test.describe('顶栏', () => {
  for (const path of ['/blog/zh/', '/blog/', ARTICLE, '/blog/zh/tags/ai/', '/blog/zh/404.html']) {
    test(`${path}：通栏 字标 · 外观 · 盾牌 · | · >_ · 头像（不显示页名）· AI 浮钮，没有右圆 / ‹ / ⋮；tmux 页脚当前窗口 blog`, async ({ page }) => {
      if (!/\/zh\//.test(path)) await preferLang(page, 'en');
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      expect(await page.locator('.sgx-topbar > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['sgx-tb-logo', 'sgx-tb-pill', 'sgx-tb-acts', 'sgx-tb-prog']);
      expect(await page.locator('.sgx-tb-acts > *').evaluateAll((els) => els.map((e) => e.className.split(' ').filter((c) => c !== 'sgx-tb-btn')[0]))).toEqual(['sgx-tb-quick', 'sgx-tb-shield', 'sgx-tb-sep', 'sgx-tb-grid', 'sgx-tb-av']);
      await expect(page.locator('#site-nav .sgx-tb-pill')).toBeHidden();
      await expect(page.locator('#site-nav > .sgx-tb-ai')).toHaveCount(1);
      await expect(page.locator('.sgx-tb-logo')).toHaveAttribute('href', path.startsWith('/blog/zh/') ? '/blog/zh/' : '/blog/');
      const acct = path.startsWith('/blog/zh/') ? 'https://styrigx.com/zh/account/' : 'https://styrigx.com/account/';
      await expect(page.locator('#site-nav .sgx-tb-me')).toHaveCount(0);
      await expect(page.locator('.sgx-topbar .sgx-tb-av')).toHaveAttribute('href', acct);
      /* 2026-11-08 账号 UI 改版：账号下拉 = 账号终端，没有去账号页的链接了 */
      await expect(page.locator('#sgx-acct')).toHaveCount(1);
      await expect(page.locator('#sgx-acct a[href*="/account/"]')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-nav, #sgx-drawer, .sgx-tb-end, .sgx-tb-share, .sgx-topbar [data-sgx-share]')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-end-group, .sgx-tb-guestbook, a[href*="guestbook"]')).toHaveCount(0);
      await expect(page.locator('.oui-footer')).toHaveCount(0);
      await expect(page.locator('footer')).toHaveCount(1);
      await expect(page.locator('footer.sgx-foot .sgx-foot-win a[aria-current="page"]')).toHaveAttribute('data-win', 'blog');
      await expect(
        page.locator('[data-sgx-back], .sgx-tb-back, [data-sgx-more], .sgx-tb-more'),
      ).toHaveCount(0);
      await expect(
        page.locator('[data-theme-toggle], [data-lang-switcher], [data-site-search-trigger]'),
      ).toHaveCount(0);
      /* 回到顶部按钮用自己的类名（原来借九宫格 .sgx-tb-nav 的样式） */
      await expect(page.locator('.sgx-tb-nav')).toHaveCount(0);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflow, '没有横向溢出').toBe(false);
    });
  }
});

test.describe('博客首页（对齐 PR-C，设计稿 pg=blog）：一页文章列表 + 分类 chips + less 分页', () => {
  const rows = (page) => page.locator('[data-post]:visible');
  async function listReady(page) {
    await expect(page.locator('[data-blog-list]')).toHaveAttribute('data-ready', 'true');
  }

  test('页头 ls -lt blog/ · 博客_ · 一行说明；chips 全部 7（当前）+ 分类 + 虚线 tree blog/ →；页名胶囊 = 站名；没有分区入口 / 面板', async ({ page }) => {
    await page.goto('/blog/zh/', { waitUntil: 'domcontentloaded' });
    await listReady(page);
    await expect(page.locator('.sgx-ph-cmd')).toHaveText('styrigx@space:~$ ls -lt blog/', { useInnerText: true });
    await expect(page.locator('h1.sgx-ph-title')).toHaveText('博客');
    await expect(page.locator('.sgx-ph-desc')).toContainText('共 7 篇');
    await expect(page.locator('.blog-chips [data-chip=""]').first()).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.blog-chips [data-chip=""]').first()).toHaveText('全部 7');
    await expect(page.locator('.sgx-chip--more')).toHaveAttribute('href', '/blog/zh/tree/');
    await expect(page.locator('.sgx-tb-pill .sgx-tb-title')).toHaveText('博客');
    await expect(page.locator('#blog-entries, [data-sgx-panes], [data-sgx-segs]')).toHaveCount(0);
  });

  test('分页：每页 6 篇，-- less (1/2) --；点页码 / → 翻页，地址 ?page=2，刷新停在原页；返回回第 1 页', async ({ page }) => {
    await page.goto('/blog/zh/', { waitUntil: 'domcontentloaded' });
    await listReady(page);
    await expect(rows(page)).toHaveCount(6);
    await expect(page.locator('[data-pg-less]')).toHaveText('-- less (1/2) --');
    await page.locator('.sgx-pg-next').click();
    await expect(page).toHaveURL(/\/blog\/zh\/\?page=2$/);
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator('[data-pg-less]')).toHaveText('-- less (2/2) --');
    await expect(page.locator('[data-pg-nums] a[aria-current="page"]')).toHaveText('2');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await listReady(page);
    await expect(rows(page)).toHaveCount(1);
    await page.goBack();
    await expect(page).toHaveURL(/\/blog\/zh\/$/);
    await expect(rows(page)).toHaveCount(6);
  });

  test('空格：分页条进入视口时翻下一页（less）', async ({ page }) => {
    await page.goto('/blog/zh/', { waitUntil: 'domcontentloaded' });
    await listReady(page);
    await page.locator('[data-blog-pager]').scrollIntoViewIfNeeded();
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(/\?page=2$/);
    await expect(page.locator('[data-pg-less]')).toHaveText('-- less (2/2) --');
  });

  test('chips 就地筛选：点分类 → 只剩该分类的文章、chip 主题色当前项、地址 ?tag=；点「全部」回来；行里的 #分类 同样筛选', async ({ page }) => {
    await page.goto('/blog/zh/', { waitUntil: 'domcontentloaded' });
    await listReady(page);
    const chip = page.locator('.blog-chips [data-chip]:not([data-chip=""])').first();
    const n = Number(((await chip.locator('i').textContent()) || '0').trim());
    const slug = await chip.getAttribute('data-chip');
    await chip.click();
    await expect(page).toHaveURL(new RegExp('\\?tag=' + encodeURIComponent(slug || '') + '$'));
    await expect(chip).toHaveAttribute('aria-current', 'true');
    await expect(rows(page)).toHaveCount(Math.min(n, 6));
    await page.locator('.blog-chips [data-chip=""]').first().click();
    await expect(page).toHaveURL(/\/blog\/zh\/$/);
    await expect(rows(page)).toHaveCount(6);
    await page.locator('[data-post] .sgx-pl-tg[href*="?tag="]').first().click();
    await expect(page).toHaveURL(/\/blog\/zh\/\?tag=/);
    await expect(page.locator('[data-post]:visible')).not.toHaveCount(0);
  });

  test('不在 chips 里的标签（目录页 / 文章页的 #标签 链接）：一行筛选提示「筛选：#标签 · n 篇 清除」', async ({ page }) => {
    await page.goto('/blog/zh/?tag=ed25519', { waitUntil: 'domcontentloaded' });
    await listReady(page);
    await expect(page.locator('[data-blog-filter-note]')).toBeVisible();
    await expect(page.locator('[data-filter-text]')).toHaveText('筛选：#Ed25519 · 1 篇');
    await expect(rows(page)).toHaveCount(1);
    await page.locator('[data-blog-filter-note] a').click();
    await expect(page).toHaveURL(/\/blog\/zh\/$/);
    await expect(page.locator('[data-blog-filter-note]')).toBeHidden();
  });

  test('旧地址（专题面板时代）：#posts → 首页，#topics → 目录页，#topics/tag/<slug> → ?tag=，#topics/series/<slug> → 目录页系列目录', async ({ page }) => {
    await page.goto('/blog/zh/#posts', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/blog\/zh\/$/);
    await page.goto('/blog/zh/#topics', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/blog\/zh\/tree\/$/);
    await page.goto('/blog/zh/#topics/tag/ai', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/blog\/zh\/\?tag=ai$/);
    await page.goto('/blog/zh/#topics/series/styrigx-ui-鉴权规范', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/blog\/zh\/tree\/#series-/);
    await expect(page.locator('[data-series]')).toHaveCount(1);
  });

  test('英文：Blog · All 6（英文 6 篇）', async ({ page }) => {
    await preferLang(page, 'en');
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await listReady(page);
    await expect(page.locator('h1.sgx-ph-title')).toHaveText('Blog');
    await expect(page.locator('.blog-chips [data-chip=""]').first()).toHaveText('All 6');
    await expect(page.locator('.sgx-tb-pill .sgx-tb-title')).toHaveText('Blog');
  });
});

test.describe('博客目录页（对齐 PR-C，设计稿 pg=tree）', () => {
  test('tree blog/ -L 2：分类 │ 年份 切换（会话内记住）；点文章行打开文章；标签 → 首页筛选', async ({ page }) => {
    await page.goto('/blog/zh/tree/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1.sgx-ph-title')).toHaveText('目录');
    const cat = page.locator('[data-tree-pane="cat"]');
    const yr = page.locator('[data-tree-pane="year"]');
    await expect(cat).toBeVisible();
    await expect(yr).toBeHidden();
    await page.locator('[data-tree-view="year"]').click();
    await expect(page.locator('[data-tree-view="year"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(yr).toBeVisible();
    await expect(cat).toBeHidden();
    await expect(yr).toContainText('2026/');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(yr).toBeVisible();
    await page.locator('[data-tree-view="cat"]').click();
    await expect(cat).toBeVisible();
    await page.locator('.sgx-tags2 a').first().click();
    await expect(page).toHaveURL(/\/blog\/zh\/\?tag=/);
    await page.goto('/blog/zh/tree/', { waitUntil: 'domcontentloaded' });
    await cat.locator('a.tf').first().click();
    await expect(page).toHaveURL(/\/blog\/zh\/post\//);
  });
});

test.describe('标签页', () => {
  test('标签页：长条只有页名（标签名），没有滑块', async ({ page }) => {
    await page.goto('/blog/zh/tags/ai/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-tb-pill .sgx-seg')).toHaveCount(0);
    await expect(page.locator('.sgx-tb-pill .sgx-tb-title')).toHaveText('AI');
    await expect(page.locator('#sgx-nav [data-nav="blog"]')).toHaveAttribute('href', '/blog/zh/');
  });
});

test.describe('九宫格导航面板 #sgx-nav（P4-3 PR-4b，四站同一个）', () => {
  const nav = (page) => page.locator('#sgx-nav');
  async function openNav(page) {
    await page.locator('.sgx-topbar .sgx-tb-grid').click();
    await expect(nav(page)).toBeVisible();
    await expect(nav(page)).toHaveAttribute('data-state', 'open');
  }

  test('NAVIGATE：01 主页 · 02 博客 · 03 奇趣 · 04 日刻 · 05 旷野（同主站）；博客是「开」态当前项（02/05）；实色面板；没有搜索框；外观面板只有 MODE + PALETTE', async ({ page }) => {
    await page.goto('/blog/zh/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar .sgx-tb-grid')).toHaveAttribute('aria-expanded', 'false');
    await openNav(page);
    await expect(page.locator('.sgx-topbar .sgx-tb-grid')).toHaveAttribute('aria-expanded', 'true');
    const tiles = nav(page).locator('a.sgx-nav-tile');
    await expect(tiles.locator('.sgx-nav-name')).toHaveText(['主页', '博客', '奇趣', '日刻', '旷野']);
    await expect(tiles.locator('.sgx-nav-no')).toHaveText(['01', '02', '03', '04', '05']);
    await expect(nav(page).locator('[data-nav-count]')).toHaveText('02/05');
    await expect(nav(page).locator('[data-nav="home"]')).toHaveAttribute('href', 'https://styrigx.com/zh/');
    await expect(nav(page).locator('[data-nav="daymark"]')).toHaveAttribute('href', '/daymark/zh/');
    /* 05 旷野：对齐 PR-B 起链到独立页 /wild/ */
    await expect(nav(page).locator('[data-nav="wild"]')).toHaveAttribute('href', 'https://styrigx.com/zh/wild/');
    await expect(nav(page).locator('[data-nav="book"]')).toHaveCount(0);
    await expect(page.locator('#sgx-nav input, #sgx-nav [type="search"], #sgx-nav [role="search"], #sgx-nav a[href*="/search/"]')).toHaveCount(0);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(nav(page).locator('[aria-current="page"] .sgx-nav-name')).toHaveText('博客');
    const st = await page.evaluate(() => {
      const cur = getComputedStyle(document.querySelector('#sgx-nav .sgx-nav-tile[aria-current]'));
      const other = getComputedStyle(document.querySelector('#sgx-nav .sgx-nav-tile[data-nav="curio"]'));
      const sheet = getComputedStyle(document.querySelector('#sgx-nav .sgx-qp-sheet'));
      return { bg: cur.backgroundImage, other: other.backgroundImage, filter: sheet.backdropFilter || sheet.webkitBackdropFilter || 'none' };
    });
    expect(st.bg).not.toBe(st.other);
    expect(st.filter).toBe('none');
    /* 竖排列表：一项一行 */
    const b = await tiles.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; }));
    for (let i = 1; i < b.length; i++) { expect(b[i][0]).toBe(b[0][0]); expect(b[i][1]).toBeGreaterThan(b[i - 1][1]); }
    /* 面板上沿贴顶栏下沿（2026-11 PR-A 照设计稿：静态实色卡、不留 8px 缝），左右对齐顶栏内容区（手机 412：页边距 12，对齐 PR-B） */
    const sheet = await page.locator('#sgx-nav .sgx-qp-sheet').boundingBox();
    const bar = await page.locator('.sgx-topbar').boundingBox();
    expect(Math.abs(sheet.y - (bar.y + bar.height))).toBeLessThanOrEqual(1);
    expect(Math.abs(sheet.x - 12)).toBeLessThanOrEqual(1);
    expect(Math.abs(sheet.x + sheet.width - (412 - 12))).toBeLessThanOrEqual(1);
    /* 分享 / 锁定在 NAVIGATE；外观面板没有页签、导航列表、分享 */
    await expect(page.locator('#sgx-nav [data-qp="share"][data-sgx-share]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(nav(page)).toBeHidden();
    await page.locator('.sgx-topbar .sgx-tb-quick').click();
    await expect(page.locator('#sgx-qp')).toHaveAttribute('data-state', 'open');
    await expect(page.locator('#sgx-qp [role="tab"], #sgx-qp [role="tabpanel"], #sgx-qp [data-nav], #sgx-qp [data-qp]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-qp-seg="mode"]')).toBeVisible();
  });

  test('Esc / 点遮罩关闭；文章页点本站 = 关面板后回博客首页', async ({ page }) => {
    await page.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
    await openNav(page);
    await page.keyboard.press('Escape');
    await expect(nav(page)).toBeHidden();
    await expect(nav(page)).toHaveAttribute('data-state', 'closed');
    await expect(page.locator('.sgx-topbar .sgx-tb-grid')).toBeFocused();
    await openNav(page);
    await page.mouse.click(206, 880);
    await expect(nav(page)).toBeHidden();
    await openNav(page);
    await nav(page).locator('a.sgx-nav-tile', { hasText: '博客' }).click();
    await expect(page).toHaveURL(/\/blog\/zh\/$/);
    await expect(page.locator('.sgx-topbar .sgx-tb-grid')).toHaveAttribute('aria-expanded', 'false');
  });

  test('已在博客首页点博客：只关面板，不跳页', async ({ page }) => {
    await page.goto('/blog/zh/', { waitUntil: 'domcontentloaded' });
    await openNav(page);
    await nav(page).locator('a.sgx-nav-tile', { hasText: '博客' }).click();
    await expect(nav(page)).toBeHidden();
    await expect(page).toHaveURL(/\/blog\/zh\/$/);
  });

  test('刚点开就 Esc：照样关上，之后还能再开', async ({ page }) => {
    await page.goto('/blog/zh/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.querySelector('.sgx-topbar .sgx-tb-grid').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await expect(nav(page)).toBeHidden();
    await expect(nav(page)).toHaveAttribute('data-state', 'closed');
    await openNav(page);
  });

  test('英文：Home / Blog / Curio / Daymark / Wild；顶栏头像去主站英文账号旧地址', async ({ page }) => {
    await preferLang(page, 'en');
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await openNav(page);
    await expect(nav(page).locator('.sgx-nav-name')).toHaveText(['Home', 'Blog', 'Curio', 'Daymark', 'Wild']);
    await expect(nav(page).locator('[data-nav="home"]')).toHaveAttribute('href', 'https://styrigx.com/');
    await expect(nav(page).locator('[data-nav="blog"]')).toHaveAttribute('href', '/blog/');
    await expect(page.locator('.sgx-topbar .sgx-tb-av')).toHaveAttribute('href', 'https://styrigx.com/account/');
  });
});

test.describe('文章页：页名 + 进度细线 + 抽屉目录', () => {
  test('长条只有页名（文章标题），没有页签；不放图标', async ({ page }) => {
    await page.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-tb-pill .sgx-seg')).toHaveCount(0);
    await expect(page.locator('.sgx-prog-title, #sgx-toc-sheet, .mobile-article-toc')).toHaveCount(
      0,
    );
    const title = (await page.locator('h1').first().innerText()).trim();
    await expect(page.locator('.sgx-tb-pill .sgx-tb-title')).toHaveText(title);
    await expect(page.locator('.sgx-tb-pill svg')).toHaveCount(0);
    /* 标题太长：一行省略，不换行、不撑破长条 */
    const t = await page.locator('.sgx-tb-pill .sgx-tb-title').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { ws: cs.whiteSpace, ov: cs.textOverflow, h: el.getBoundingClientRect().height, one: el.scrollHeight <= el.clientHeight + 1 };
    });
    expect(t.ws).toBe('nowrap');
    expect(t.ov).toBe('ellipsis');
    /* PR-4b：页名是 36px 高的胶囊（主题色椭圆衬底），一行，不撑高 */
    expect(t.h).toBeLessThanOrEqual(36.5);
    expect(t.one).toBe(true);
  });

  test('阅读进度：顶栏 v3 底边滑页进度条（整个视口宽、3px）随滚动变长，到底整宽；页名里的进度标记照样记数', async ({ page }) => {
    await page.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
    const bar = page.locator('[data-sgx-progress]');
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    const prog = page.locator('#site-nav .sgx-tb-prog');
    const box = await prog.boundingBox();
    const top = await page.locator('.sgx-topbar').boundingBox();
    expect(Math.abs(box.height - 3)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(top.y + top.height - (box.y + box.height))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(box.x) + Math.abs(box.width - 412)).toBeLessThanOrEqual(1);
    const fillW = () => page.evaluate(() => document.querySelector('#site-nav .sgx-tb-prog > i').getBoundingClientRect().width);
    await page.evaluate(() => {
      const el = document.querySelector('#article-start');
      const top = window.scrollY + el.getBoundingClientRect().top;
      window.scrollTo(0, top + el.offsetHeight / 2 - innerHeight / 2);
    });
    await expect
      .poll(async () => Number(await bar.getAttribute('aria-valuenow')))
      .toBeGreaterThan(20);
    expect(Number(await bar.getAttribute('aria-valuenow'))).toBeLessThan(80);
    await expect.poll(fillW).toBeGreaterThan(20);
    expect(await fillW()).toBeLessThan(412);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow'))).toBe(100);
    await expect.poll(fillW).toBeGreaterThan(408);
    /* 段是主题色 */
    const primary = await roleColor(page, '--sgx-primary');
    const img = await page.evaluate(() => getComputedStyle(document.querySelector('#site-nav .sgx-tb-prog > i')).backgroundImage);
    expect(img).toContain(primary);
  });

  test('非文章页：抽屉里没有目录、长条没有进度线；每页只有页名（首页 = 站名）', async ({ page }) => {
    for (const [path, name] of [['/blog/zh/', '博客'], ['/blog/zh/tags/ai/', 'AI'], ['/blog/zh/404.html', '页面不存在']]) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.sgx-drawer-toc, [data-sgx-progress]')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-pill .sgx-seg')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-pill .sgx-tb-title')).toHaveText(name);
    }
  });

  test('文章页没有评论区', async ({ page }) => {
    await page.route('https://giscus.app/**', (r) => r.fulfill({ status: 204 }));
    await page.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.comment-section, [data-comment-provider], [data-giscus], iframe.giscus-frame')).toHaveCount(0);
  });

  test('系列文章（对齐 PR-C）：元信息「系列 · 第 n / N 篇」，cd ../prev 卡 = 系列上一篇；点系列名到目录页系列目录', async ({ page }) => {
    await page.goto(SERIES_V2, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-series-block, .share-buttons, .related-posts')).toHaveCount(0);
    const meta = page.locator('.sgx-series-meta');
    await expect(meta).toHaveText('Styrigx UI 鉴权规范 · 第 2 / 2 篇');
    await expect(page.locator('.blog-nx a[rel="prev"]')).toHaveAttribute('href', '/blog/zh/post/2026-10-11-key-spec-whitepaper/');
    await expect(page.locator('.blog-nx a[rel="prev"]')).toContainText('cd ../prev');
    await meta.click();
    await expect(page).toHaveURL(/\/blog\/zh\/tree\/#series-/);
    await expect(page.locator('[data-series]')).toHaveCount(1);
  });

  test('文章页文末（对齐 PR-C）：两张 cd ../prev · cd ../next 卡；分享一行（X · 复制链接 · 问 Gray AI）手机在两卡下面，复制链接写剪贴板，问 Gray AI 打开 AI 窗', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.blog-nx .sgx-nx-a')).toHaveCount(2);
    const rd = page.locator('.blog-rd--inline');
    await expect(rd).toBeVisible();
    await expect(rd.locator('a[href^="https://x.com/intent/post"]')).toHaveText('X');
    await rd.locator('[data-share-copy]').click();
    await expect(rd.locator('[data-share-copy] span')).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('/blog/zh/post/2026-10-07-muse-playbook/');
    await rd.locator('[data-ask-ai]').click();
    await expect(page.locator('#sgx-ai')).toHaveAttribute('open', '');
  });
});

test.describe('跟随主站设置（sgx-ui cookie）', () => {
  test('pal 换预设、accent 是自定义种子 → AI 按钮（primary-container）跟着变；accent = 预设种子时不算自定义', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.goto('/blog/zh/', { waitUntil: 'domcontentloaded' });
    const bg = () =>
      page.evaluate(() => getComputedStyle(document.querySelector('.sgx-tb-ai')).backgroundColor);
    const base = await bg();
    await setUi(context, baseURL, { v: 2, mode: 'light', pal: 'cherry', accent: SEEDS.cherry });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'cherry');
    const cherry = await bg();
    expect(cherry).not.toBe(base);
    await expect(page.locator('#sgx-accent-roles')).toHaveCount(0);
    await setUi(context, baseURL, { v: 2, mode: 'light', pal: 'lake', accent: '#ff8800' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-accent-roles')).toHaveCount(1);
    await expect.poll(bg).not.toBe(base);
    expect(await bg()).not.toBe(cherry);
  });

  test('lang=en：中文列表页跳英文并保留 hash（文章锚点式 hash 不转址）；没有英文版的文章不跳', async ({
    page,
    context,
    baseURL,
  }) => {
    await setUi(context, baseURL, { v: 2, lang: 'en' });
    await page.goto('/blog/zh/#latest', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/blog\/#latest$/);
    await page.goto('/blog/zh/post/2026-10-11-key-spec-whitepaper/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe('/blog/zh/post/2026-10-11-key-spec-whitepaper/');
  });

  test('mode=dark 首帧就是深色', async ({ page, context, baseURL }) => {
    await setUi(context, baseURL, { v: 2, mode: 'dark' });
    await page.goto('/blog/zh/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
