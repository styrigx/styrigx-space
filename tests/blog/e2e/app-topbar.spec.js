// 2026-10-20 沉浸式 app 顶栏验收（不截图，只断言行为和布局）：
// - 顶栏三块：九宫格 · 长条 · 右圆分享（2026-10-24 留言板撤了）；没有 ‹ 返回、没有 ⋮，没有版权页脚。
// - 列表页长条 = 分段滑块 首页 · 文章 · 专题（没有归档）：点、滑、键盘切换，hash 记住页签。
// - 指示器 = 抽屉当前项同一套 tonal（--sgx-nav-selected，同主站顶栏三栏 .sgx-tb-tab）；阅读进度 = 填充档（--sgx-accent = --sgx-primary-fill）；
//   都跟 sgx-ui cookie 的 pal / 自定义种子 accent 变；抽屉当前项 / 目录当前节是 tonal。
// - 九宫格 → 左侧导航抽屉（主站共享外壳同一份：主站 / 奇趣 / 日刻 / 博客，字标 + 头像、底栏搜索框，毛玻璃、tonal 当前项）；文章页抽屉最下面是目录。
// - 只有列表页（首页）长条是 首页 · 文章 · 专题；其他页（文章、标签、404）长条只有页名；文章页长条底边一条强调色细线是阅读进度。
// - 2026-11-04 P5-1 顶栏全大椭圆（四站同一个，共享外壳 partials/sgx-shell-topbar.html）：一整条胶囊 logo · 长条 · 快捷面板 · AI · 头像；
//   九宫格、导航抽屉、右圆分享删除。站点列表在快捷面板第 1 页「导航」（博客是 tonal 当前项，没有搜索框），「分享本页」在第 2 页。
// - P4-3 PR-4b 定稿：字标 · 页名胶囊 · 九宫格 · 快捷设置 · AI；头像搬进 AI 窗口头部；九宫格开导航面板 #sgx-nav（2×2 站点磁贴，博客「开」态）；
//   快捷面板只有一页（四站同一套，「分享本页」磁贴在里面）。
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

/* 预设种子从共享外壳的 palettes.json 读（主站改种子时不用改测试） */
const SEEDS = Object.fromEntries(
  JSON.parse(readFileSync(new URL('../../../atlas/web/blog/data/sgx-shell/palettes.json', import.meta.url), 'utf8')).presets.map((p) => [p.id, p.seed]),
);

test.use({ viewport: { width: 412, height: 915 } });

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
      localStorage.setItem('styrigx-blog-lang', 'zh');
    } catch {}
  });
});

const ARTICLE = '/blog/post/2026-10-07-muse-playbook/';
const SERIES_V2 = '/blog/post/2026-10-11-key-spec-whitepaper-v2/';

async function ready(page) {
  await expect(page.locator('[data-sgx-panes]')).toHaveAttribute('data-state', 'ready');
}

/** 计算 var(--sgx-accent) 的实际颜色 */
const accentColor = (page) => roleColor(page, '--sgx-accent');
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

/** 指示器和当前页签对齐（等过渡结束） */
async function expectIndicatorOn(page, id) {
  await expect
    .poll(
      () =>
        page.evaluate((tab) => {
          const ind = document.querySelector('.sgx-seg-ind').getBoundingClientRect();
          const btn = document.querySelector(`[data-sgx-tab="${tab}"]`).getBoundingClientRect();
          return Math.max(Math.abs(ind.left - btn.left), Math.abs(ind.width - btn.width));
        }, id),
      { timeout: 3000 },
    )
    .toBeLessThanOrEqual(1);
}

async function expectTab(page, id) {
  await expect(page.locator(`[data-sgx-tab="${id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`[data-pane="${id}"]`)).toHaveClass(/\bis-active\b/);
  await expect(page.locator(`[data-pane="${id}"]`)).not.toHaveAttribute('inert', '');
  await expectIndicatorOn(page, id);
}

test.describe('顶栏', () => {
  for (const path of ['/blog/', '/blog/en/', ARTICLE, '/blog/tags/ai/', '/blog/404.html']) {
    test(`${path}：胶囊 字标 · 页名胶囊 · 九宫格 · 快捷设置 · AI（头像在 AI 窗口头部），没有右圆 / ‹ / ⋮，没有页脚`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      expect(await page.locator('.sgx-topbar > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['sgx-tb-logo', 'sgx-tb-pill', 'sgx-tb-acts']);
      expect(await page.locator('.sgx-tb-acts > *').evaluateAll((els) => els.map((e) => e.className.split(' ').filter((c) => c !== 'sgx-tb-btn')[0]))).toEqual(['sgx-tb-grid', 'sgx-tb-quick', 'sgx-tb-ai']);
      await expect(page.locator('.sgx-tb-logo')).toHaveAttribute('href', path.startsWith('/blog/en/') ? '/blog/en/' : '/blog/');
      await expect(page.locator('#site-nav .sgx-tb-me, .sgx-topbar img')).toHaveCount(0);
      await expect(page.locator('#sgx-ai .sgx-ai-me')).toHaveAttribute('href', path.startsWith('/blog/en/') ? 'https://styrigx.com/en/account/' : 'https://styrigx.com/account/');
      await expect(page.locator('.sgx-tb-nav, #sgx-drawer, .sgx-tb-end, .sgx-tb-share, .sgx-topbar [data-sgx-share]')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-end-group, .sgx-tb-guestbook, a[href*="guestbook"]')).toHaveCount(0);
      await expect(page.locator('footer, .oui-footer')).toHaveCount(0);
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

test.describe('列表页页签', () => {
  test('三个页签：首页 · 文章 · 专题，默认首页；指示器是 tonal（--sgx-nav-selected，同主站顶栏三栏）', async ({ page }) => {
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await expect(page.locator('.sgx-tb-pill [role="tablist"] [role="tab"]')).toHaveText([
      '首页',
      '文章',
      '专题',
    ]);
    await expectTab(page, 'home');
    const tonal = await roleColor(page, '--sgx-nav-selected');
    const onTonal = await roleColor(page, '--sgx-on-nav-selected');
    const [ind, txt] = await page.evaluate(() => [
      getComputedStyle(document.querySelector('.sgx-seg-ind')).backgroundColor,
      getComputedStyle(document.querySelector('[data-sgx-tab="home"]')).color,
    ]);
    expect(ind).toBe(tonal);
    expect(txt).toBe(onTonal);
    expect(ind).not.toBe('rgb(0, 0, 0)');
    expect(txt).not.toBe(ind);
    /* 首页面板：标题区 + 最新 3 篇 + 系列卡 */
    await expect(page.locator('[data-pane="home"] h1')).toHaveText('博客');
    await expect(page.locator('[data-pane="home"] .latest-card')).toHaveCount(3);
    await expect(page.locator('[data-pane="home"] .series-card')).toHaveCount(1);
  });

  test('点页签切换，hash 记住，刷新停在原页签', async ({ page }) => {
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.locator('[data-sgx-tab="posts"]').click();
    await expectTab(page, 'posts');
    await expect(page).toHaveURL(/\/#posts$/);
    expect(await page.locator('[data-pane="posts"] .note-entry').count()).toBeGreaterThan(3);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    await expectTab(page, 'posts');
    await page.locator('[data-sgx-tab="topics"]').click();
    await expectTab(page, 'topics');
    await expect(page).toHaveURL(/\/#topics$/);
    await page.locator('[data-sgx-tab="home"]').click();
    await expectTab(page, 'home');
    expect(new URL(page.url()).hash).toBe('');
  });

  test('从文章返回列表：停在原页签', async ({ page }) => {
    await page.goto('/blog/#posts', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await expectTab(page, 'posts');
    await page.locator('[data-pane="posts"] .note-title a').first().click();
    await page.waitForURL(/\/post\//);
    await page.goBack();
    await expect(page).toHaveURL(/\/#posts$/);
    await ready(page);
    await expectTab(page, 'posts');
  });

  test('键盘：← → Home End，焦点跟着走', async ({ page }) => {
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.locator('[data-sgx-tab="home"]').focus();
    await page.keyboard.press('ArrowRight');
    await expectTab(page, 'posts');
    await expect(page.locator('[data-sgx-tab="posts"]')).toBeFocused();
    await page.keyboard.press('End');
    await expectTab(page, 'topics');
    await page.keyboard.press('Home');
    await expectTab(page, 'home');
    await page.keyboard.press('ArrowLeft');
    await expectTab(page, 'topics');
    /* 漫游 tabindex：只有当前页签可 Tab 进入 */
    await expect(page.locator('.sgx-tb-pill [role="tab"][tabindex="0"]')).toHaveCount(1);
  });

  test('左右滑动切换面板，指示器跟手', async ({ page }) => {
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await ready(page);
    const y = 600;
    await page.mouse.move(340, y);
    await page.mouse.down();
    for (let x = 340; x >= 200; x -= 20) await page.mouse.move(x, y);
    const mid = await page.evaluate(() =>
      Number(
        getComputedStyle(document.querySelector('[data-sgx-seg]')).getPropertyValue('--seg-pos'),
      ),
    );
    expect(mid).toBeGreaterThan(0.1);
    expect(mid).toBeLessThan(0.9);
    for (let x = 200; x >= 60; x -= 20) await page.mouse.move(x, y);
    await page.mouse.up();
    await expectTab(page, 'posts');
    await expect(page).toHaveURL(/#posts$/);
    /* 往右滑回首页 */
    await page.mouse.move(60, y);
    await page.mouse.down();
    for (let x = 60; x <= 360; x += 25) await page.mouse.move(x, y);
    await page.mouse.up();
    await expectTab(page, 'home');
    /* 首页再往右滑：到头了，留在首页 */
    await page.mouse.move(60, y);
    await page.mouse.down();
    for (let x = 60; x <= 360; x += 25) await page.mouse.move(x, y);
    await page.mouse.up();
    await expectTab(page, 'home');
  });

  test('竖向拖动不触发切换', async ({ page }) => {
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.mouse.move(200, 700);
    await page.mouse.down();
    await page.mouse.move(215, 500, { steps: 8 });
    await page.mouse.up();
    await expectTab(page, 'home');
  });

  test('专题：系列在最前、按篇序；点标签就地筛选，hash 可直达', async ({ page }) => {
    await page.goto('/blog/#topics', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await expectTab(page, 'topics');
    const pane = page.locator('[data-pane="topics"]');
    await expect(pane.locator('.sgx-sec-title:visible').first()).toHaveText('系列');
    const card = pane.locator('[data-series-card]').first();
    await expect(card.locator('.series-card-name')).toHaveText('Styrigx UI 鉴权规范');
    await expect(card.locator('li a')).toHaveCount(2);
    await expect(card.locator('li a').first()).toHaveAttribute(
      'href',
      '/blog/post/2026-10-11-key-spec-whitepaper/',
    );
    /* 标签筛选 */
    const chip = pane.locator('[data-topic-filter="tag:ai"]');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/#topics\/tag\/ai$/);
    const results = pane.locator('[data-topic-results]');
    await expect(results).toBeVisible();
    const n = await results.locator('[data-topic-post]:visible').count();
    expect(n).toBeGreaterThan(0);
    await expect(results.locator('[data-topic-results-title]')).toContainText(`${n} 篇`);
    await results.locator('[data-topic-clear]').click();
    await expect(results).toBeHidden();
    await expect(page).toHaveURL(/#topics$/);
    /* 直达 */
    await page.goto('/blog/#topics/tag/ai', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await expectTab(page, 'topics');
    await expect(pane.locator('[data-topic-filter="tag:ai"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(results).toBeVisible();
  });

  test('文章列表里的 #标签 跳到专题筛选', async ({ page }) => {
    await page.goto('/blog/#posts', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.locator('[data-pane="posts"] .note-meta a[href^="#topics/tag/"]').first().click();
    await expectTab(page, 'topics');
    await expect(page.locator('[data-topic-results]')).toBeVisible();
  });

  test('英文：Home · Posts · Topics', async ({ page }) => {
    await page.goto('/blog/en/', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await expect(page.locator('.sgx-tb-pill [role="tab"]')).toHaveText(['Home', 'Posts', 'Topics']);
  });

  test('减弱动效：指示器 / 面板没有过渡', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await ready(page);
    const d = await page.evaluate(() => [
      getComputedStyle(document.querySelector('.sgx-seg-ind')).transitionDuration,
      getComputedStyle(document.querySelector('[data-sgx-track]')).transitionDuration,
    ]);
    /* one-ui.css 的全局减弱动效规则把过渡压到 ≤ 1ms */
    for (const v of d) expect(parseFloat(v)).toBeLessThanOrEqual(0.001);
    await page.locator('[data-sgx-tab="topics"]').click();
    await expectTab(page, 'topics');
  });

  test('标签页：长条只有页名（标签名），没有滑块', async ({ page }) => {
    await page.goto('/blog/tags/ai/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-tb-pill .sgx-seg')).toHaveCount(0);
    await expect(page.locator('.sgx-tb-pill .sgx-tb-title')).toHaveText('AI');
    await expect(page.locator('#sgx-nav [data-nav="blog"]')).toHaveAttribute('href', '/blog/');
  });
});

test.describe('九宫格导航面板 #sgx-nav（P4-3 PR-4b，四站同一个）', () => {
  const nav = (page) => page.locator('#sgx-nav');
  async function openNav(page) {
    await page.locator('.sgx-topbar .sgx-tb-grid').click();
    await expect(nav(page)).toBeVisible();
    await expect(nav(page)).toHaveAttribute('data-state', 'open');
  }

  test('旷野 / 奇趣 / 日刻 / 博客（同主站）2×2 磁贴；博客是「开」态当前项；毛玻璃面板；没有搜索框；快捷面板只有一页', async ({ page }) => {
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar .sgx-tb-grid')).toHaveAttribute('aria-expanded', 'false');
    await openNav(page);
    await expect(page.locator('.sgx-topbar .sgx-tb-grid')).toHaveAttribute('aria-expanded', 'true');
    const tiles = nav(page).locator('a.sgx-nav-tile');
    await expect(tiles.locator('.sgx-qp-label')).toHaveText(['旷野', '奇趣', '日刻', '博客']);
    await expect(nav(page).locator('[data-nav="home"]')).toHaveAttribute('href', 'https://styrigx.com/');
    await expect(nav(page).locator('[data-nav="daymark"]')).toHaveAttribute('href', '/daymark/');
    await expect(nav(page).locator('[data-nav="book"]')).toHaveCount(0);
    await expect(page.locator('#sgx-nav input, #sgx-nav [type="search"], #sgx-nav [role="search"], #sgx-nav a[href*="/search/"]')).toHaveCount(0);
    for (let i = 0; i < 4; i++) await expect(tiles.nth(i).locator('.sgx-qp-ic svg')).toHaveCount(1);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(nav(page).locator('[aria-current="page"] .sgx-qp-label')).toHaveText('博客');
    const st = await page.evaluate(() => {
      const cur = getComputedStyle(document.querySelector('#sgx-nav .sgx-nav-tile[aria-current]'));
      const other = getComputedStyle(document.querySelector('#sgx-nav .sgx-nav-tile[data-nav="curio"]'));
      const sheet = getComputedStyle(document.querySelector('#sgx-nav .sgx-qp-sheet'));
      return { bg: cur.backgroundColor, other: other.backgroundColor, filter: sheet.backdropFilter || sheet.webkitBackdropFilter };
    });
    expect(st.bg).not.toBe(st.other);
    expect(st.filter).toContain('blur');
    /* 2×2：两行两列 */
    const b = await tiles.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; }));
    expect(b[0][1]).toBe(b[1][1]);
    expect(b[2][1]).toBe(b[3][1]);
    expect(b[0][0]).toBe(b[2][0]);
    expect(b[2][1]).toBeGreaterThan(b[0][1]);
    /* 面板落在顶栏下方，左右对齐顶栏 */
    const sheet = await page.locator('#sgx-nav .sgx-qp-sheet').boundingBox();
    const bar = await page.locator('.sgx-topbar').boundingBox();
    expect(Math.abs(sheet.y - (bar.y + bar.height) - 8)).toBeLessThanOrEqual(1);
    expect(Math.abs(sheet.x - bar.x)).toBeLessThanOrEqual(1);
    /* 快捷面板只有一页：没有页签、导航列表，分享磁贴直接在里面 */
    await page.keyboard.press('Escape');
    await expect(nav(page)).toBeHidden();
    await page.locator('.sgx-topbar .sgx-tb-quick').click();
    await expect(page.locator('#sgx-qp')).toHaveAttribute('data-state', 'open');
    await expect(page.locator('#sgx-qp [role="tab"], #sgx-qp [role="tabpanel"], #sgx-qp [data-nav]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-qp="share"][data-sgx-share]')).toBeVisible();
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
    await expect(page).toHaveURL(/\/blog\/$/);
    await expect(page.locator('.sgx-topbar .sgx-tb-grid')).toHaveAttribute('aria-expanded', 'false');
  });

  test('已在博客首页点博客：只关面板，不跳页', async ({ page }) => {
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await openNav(page);
    await nav(page).locator('a.sgx-nav-tile', { hasText: '博客' }).click();
    await expect(nav(page)).toBeHidden();
    await expect(page).toHaveURL(/\/blog\/$/);
  });

  test('刚点开就 Esc：照样关上，之后还能再开', async ({ page }) => {
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.querySelector('.sgx-topbar .sgx-tb-grid').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await expect(nav(page)).toBeHidden();
    await expect(nav(page)).toHaveAttribute('data-state', 'closed');
    await openNav(page);
  });

  test('英文：Space / Curio / Daymark / Blog；AI 窗口头像去主站英文账号页', async ({ page }) => {
    await page.goto('/blog/en/', { waitUntil: 'domcontentloaded' });
    await openNav(page);
    await expect(nav(page).locator('.sgx-qp-label')).toHaveText(['Space', 'Curio', 'Daymark', 'Blog']);
    await expect(nav(page).locator('[data-nav="home"]')).toHaveAttribute('href', 'https://styrigx.com/en/');
    await expect(nav(page).locator('[data-nav="blog"]')).toHaveAttribute('href', '/blog/en/');
    await expect(page.locator('#sgx-ai .sgx-ai-me')).toHaveAttribute('href', 'https://styrigx.com/en/account/');
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

  test('进度细线在长条底边，随滚动填满（强调色）', async ({ page }) => {
    await page.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
    const bar = page.locator('[data-sgx-progress]');
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    const box = await bar.boundingBox();
    const pill = await page.locator('.sgx-tb-pill').boundingBox();
    expect(box.height).toBeLessThanOrEqual(4);
    expect(pill.y + pill.height - (box.y + box.height)).toBeLessThanOrEqual(6);
    await page.evaluate(() => {
      const el = document.querySelector('#article-start');
      const top = window.scrollY + el.getBoundingClientRect().top;
      window.scrollTo(0, top + el.offsetHeight / 2 - innerHeight / 2);
    });
    await expect
      .poll(async () => Number(await bar.getAttribute('aria-valuenow')))
      .toBeGreaterThan(20);
    expect(Number(await bar.getAttribute('aria-valuenow'))).toBeLessThan(80);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow'))).toBe(100);
    const accent = await accentColor(page);
    const fill = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('[data-sgx-progress]'), '::after').backgroundColor,
    );
    expect(fill).toBe(accent);
  });

  test('非文章页：抽屉里没有目录、长条没有进度线；首页三页签，其他页只有页名', async ({ page }) => {
    for (const [path, name] of [['/blog/', null], ['/blog/tags/ai/', 'AI'], ['/blog/404.html', '页面不存在']]) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.sgx-drawer-toc, [data-sgx-progress]')).toHaveCount(0);
      if (name === null) {
        await expect(page.locator('.sgx-tb-pill .sgx-seg-btn')).toHaveText(['首页', '文章', '专题']);
      } else {
        await expect(page.locator('.sgx-tb-pill .sgx-seg')).toHaveCount(0);
        await expect(page.locator('.sgx-tb-pill .sgx-tb-title')).toHaveText(name);
      }
    }
  });

  test('文章页没有评论区', async ({ page }) => {
    await page.route('https://giscus.app/**', (r) => r.fulfill({ status: 204 }));
    await page.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.comment-section, [data-comment-provider], [data-giscus], iframe.giscus-frame')).toHaveCount(0);
  });

  test('系列文章：系列小块（第 n / N 篇 + 上一篇），点系列名到专题', async ({ page }) => {
    await page.goto(SERIES_V2, { waitUntil: 'domcontentloaded' });
    const block = page.locator('.sgx-series-block');
    await expect(block).toBeVisible();
    await expect(block.locator('.sgx-series-name')).toHaveText('Styrigx UI 鉴权规范');
    await expect(block.locator('.sgx-series-pos')).toHaveText('第 2 / 2 篇');
    await expect(block.locator('a[rel="prev"]')).toHaveAttribute(
      'href',
      '/blog/post/2026-10-11-key-spec-whitepaper/',
    );
    await expect(block.locator('a[rel="next"]')).toHaveCount(0);
    await block.locator('.sgx-series-name').click();
    await expect(page).toHaveURL(/\/#topics\/series\//);
    await ready(page);
    await expectTab(page, 'topics');
    await expect(page.locator('[data-series-card].is-target')).toHaveCount(1);
  });
});

test.describe('跟随主站设置（sgx-ui cookie）', () => {
  test('pal 换预设、accent 是自定义种子 → 指示器跟着变；accent = 预设种子时不算自定义', async ({
    page,
    context,
    baseURL,
  }) => {
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    const bg = () =>
      page.evaluate(() => getComputedStyle(document.querySelector('.sgx-seg-ind')).backgroundColor);
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

  test('lang=en：中文列表页跳英文并保留 hash；没有英文版的文章不跳', async ({
    page,
    context,
    baseURL,
  }) => {
    await setUi(context, baseURL, { v: 2, lang: 'en' });
    await page.goto('/blog/#topics', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/blog\/en\/#topics$/);
    await page.goto('/blog/post/2026-10-11-key-spec-whitepaper/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe('/blog/post/2026-10-11-key-spec-whitepaper/');
  });

  test('mode=dark 首帧就是深色', async ({ page, context, baseURL }) => {
    await setUi(context, baseURL, { v: 2, mode: 'dark' });
    await page.goto('/blog/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
