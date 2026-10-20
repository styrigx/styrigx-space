/**
 * 快捷面板（2026-10-20 改为顶栏下内嵌展开）验收：
 * - 顶栏长条右端全站都有快捷面板图标 .sgx-tb-quick；点它在顶栏正下方、正文最前面展开 #sgx-qp，
 *   下面的正文整体下移（第一块内容下移 = 面板高度），宽度与本页内容列一致；没有遮罩、没有把手。
 * - 收起：再点图标 / 在面板上上滑（> 40px）/ Esc；离开本页即收起。点面板外面、滚动不收起。
 * - 图标 aria-expanded 同步；展开焦点到第一个磁贴，收起焦点回到图标；减弱动效立刻到位。
 * - 磁贴只放设置里已有的项，写的是和设置页同一个 localStorage key（同一套 setter，lib/prefs.js），
 *   即时生效、不刷新；设置页随之同步显示。
 * - 390px 宽：长条页名放得下「安全与隐私」，英文长页名省略号，不压到两端图标。
 * - 面板开着时长条页名位置显示「快捷面板」/ Quick panel（~150ms 交叉淡化），收起后换回页名；
 *   面板里没有标题行（.sgx-qp-head），直接从磁贴开始；页名元素文本与 document.title 不变。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 }, colorScheme: 'light' });

async function go(page, path, lang = 'zh', freeze = true) {
  await blockExternalRequests(page);
  /* 冻结时间会让 Date.now() 恒定，立即锁定的防误触窗口（400ms）永远过不去，那条测试不冻结 */
  if (freeze) await freezeTime(page);
  /* 只在没有偏好时写（语言磁贴切换后不要被 init script 改回去） */
  await page.addInitScript((l) => {
    try { if (!localStorage.getItem('sgx-lang')) localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
}

const qp = (page) => page.locator('#sgx-qp');
const tile = (page, id) => page.locator(`#sgx-qp [data-qp="${id}"]`);
const ls = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);

async function openQp(page) {
  await page.locator('.sgx-tb-quick').click();
  await expect(qp(page)).toBeVisible();
  await expect(qp(page)).toHaveClass(/\bis-open\b/);
  /* 等展开结束（data-state=open）；is-open 只是过渡起点 */
  await expect(qp(page)).toHaveAttribute('data-state', 'open');
}
/** 正文第一块内容（面板后面的页面列里第一个看得见的子块）的位置 */
const firstContent = (page) => page.evaluate(() => {
  const col = document.getElementById('sgx-qp').nextElementSibling;
  const el = Array.from(col.children).find((c) => c.getBoundingClientRect().height > 0) || col;
  const r = el.getBoundingClientRect();
  return { y: r.top + window.scrollY, left: r.left, right: r.right };
});
const qpBox = (page) => page.evaluate(() => {
  const r = document.getElementById('sgx-qp').getBoundingClientRect();
  return { y: r.top + window.scrollY, h: r.height, left: r.left, right: r.right };
});
/** 长条页名位置看得见的文字：页名文本节点与 ::after「快捷面板」各自的不透明度（颜色 alpha × opacity） */
const capsuleLabel = (page) => page.evaluate(() => {
  const el = document.querySelector('.sgx-tb-title');
  const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return 1; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const cs = getComputedStyle(el);
  const as = getComputedStyle(el, '::after');
  return {
    text: el.textContent,
    nameAlpha: alpha(cs.color) * parseFloat(cs.opacity),
    after: as.content,
    afterAlpha: alpha(as.color) * parseFloat(as.opacity),
    title: document.title,
  };
});
async function expectClosed(page) {
  await expect(qp(page)).toBeHidden();
  await expect(qp(page)).toHaveAttribute('data-state', 'closed');
  await expect(qp(page)).not.toHaveClass(/\bis-open\b/);
  await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'false');
}

test.describe('顶栏：长条里的快捷面板图标', () => {
  const PAGES = ['/', '/bookmarks/', '/search/', '/settings/', '/settings/display/', '/settings/security/', '/settings/account/'];
  for (const path of PAGES) {
    test(`${path}：九宫格 · 长条（搜索 · 页名 · 快捷面板）· 头像`, async ({ page }) => {
      await go(page, path);
      const order = await page.evaluate(() =>
        Array.from(document.querySelector('.sgx-topbar').children).map((el) => el.className.split(' ')[0]));
      expect(order).toEqual(['sgx-tb-nav', 'sgx-tb-pill', 'sgx-tb-me']);
      const inner = await page.evaluate(() =>
        Array.from(document.querySelector('.sgx-tb-pill').children).map((el) => el.className.split(' ')[0]));
      expect(inner).toEqual(['sgx-tb-search', 'sgx-tb-title', 'sgx-tb-quick']);
      const q = page.locator('.sgx-tb-quick');
      expect(await q.evaluate((el) => el.tagName)).toBe('BUTTON');
      await expect(q).toHaveAttribute('aria-label', '快捷面板');
      await expect(q).toHaveAttribute('aria-controls', 'sgx-qp');
      await expect(q).toHaveAttribute('aria-expanded', 'false');
      /* 内嵌展开，不是弹出对话框 */
      expect(await q.getAttribute('aria-haspopup')).toBeNull();
      /* 40px 圆形点击区，贴长条右端（内缩 6） */
      const qb = await q.boundingBox();
      const pb = await page.locator('.sgx-tb-pill').boundingBox();
      expect(Math.round(qb.width)).toBe(40);
      expect(Math.round(qb.height)).toBe(40);
      expect(Math.abs(pb.x + pb.width - (qb.x + qb.width) - 6)).toBeLessThanOrEqual(1);
    });
  }

  test('390px：「安全与隐私」完整显示，英文长页名省略号，页名不出长条', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(page, '/settings/security/');
    const t = page.locator('.sgx-tb-title');
    await expect(t).toHaveText('安全与隐私');
    expect(await t.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.evaluate(() => localStorage.setItem('sgx-lang', 'en'));
    await page.goto('/en/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(t).toHaveText('Security and privacy');
    const st = await t.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, to: getComputedStyle(el).textOverflow }));
    expect(st.to).toBe('ellipsis');
    expect(st.sw).toBeGreaterThan(st.cw);
    const tb = await t.boundingBox();
    const pill = await page.locator('.sgx-tb-pill').boundingBox();
    /* 页名在长条内居中（左右对称），不出长条 */
    expect(Math.abs(tb.x + tb.width / 2 - (pill.x + pill.width / 2))).toBeLessThanOrEqual(1);
    expect(tb.x).toBeGreaterThanOrEqual(pill.x);
    expect(tb.x + tb.width).toBeLessThanOrEqual(pill.x + pill.width);
  });
});

test.describe('快捷面板：内嵌开合', () => {
  for (const path of ['/', '/settings/']) {
    test(`${path}：点图标在顶栏下内嵌展开，正文下移面板高度；再点收起，正文回原位`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await go(page, path);
      const q = page.locator('.sgx-tb-quick');
      await expect(q).toHaveAttribute('aria-expanded', 'false');
      await expect(qp(page)).toBeHidden();
      expect(await qp(page).evaluate((el) => el.tagName)).toBe('SECTION');
      expect(await qp(page).evaluate((el) => el.parentElement.id)).toBe('sgx-main');
      const before = await firstContent(page);
      await openQp(page);
      await expect(q).toHaveAttribute('aria-expanded', 'true');
      const box = await qpBox(page);
      const after = await firstContent(page);
      /* 第一块内容下移 = 面板高度（含面板与正文的间距）±2px */
      expect(Math.abs(after.y - before.y - box.h), `下移 ${after.y - before.y}，面板高 ${box.h}`).toBeLessThanOrEqual(2);
      expect(box.h).toBeGreaterThan(200);
      /* 面板顶边 = 原来第一块内容的顶边（顶栏下方 --sgx-content-top），左右缘 = 内容列（卡片）左右缘 */
      expect(Math.abs(box.y - before.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(box.left - before.left)).toBeLessThanOrEqual(2);
      expect(Math.abs(box.right - before.right)).toBeLessThanOrEqual(2);
      const tb = await page.locator('.sgx-topbar').boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(tb.y + tb.height);
      /* 不是模态：没有 <dialog>、没有遮罩 / 把手；图标是按下态 */
      await expect(page.locator('dialog#sgx-qp, .sgx-qp-handle')).toHaveCount(0);
      const bg = await q.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      /* 焦点到第一个磁贴 */
      await expect(tile(page, 'dark')).toBeFocused();
      /* 再点同一个图标收起（面板不盖住顶栏，可直接点） */
      await q.click();
      await expectClosed(page);
      await expect(q).toBeFocused();
      const back = await firstContent(page);
      expect(Math.abs(back.y - before.y)).toBeLessThanOrEqual(1);
      expect((await qpBox(page)).h).toBeLessThanOrEqual(0.5);
    });
  }

  test('展开过程中正文跟着平滑下移（不是一下跳到位）', async ({ page }) => {
    await go(page, '/');
    const before = await firstContent(page);
    await page.locator('.sgx-tb-quick').click();
    await page.waitForTimeout(60);
    const mid = await firstContent(page);
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    const after = await firstContent(page);
    expect(mid.y).toBeGreaterThan(before.y);
    expect(mid.y).toBeLessThan(after.y);
  });

  test('点面板外面、点面板空白处、滚动都不收起', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    /* 面板空白处：面板左上角内边距 */
    const sb = await page.locator('.sgx-qp-sheet').boundingBox();
    await page.mouse.click(sb.x + 6, sb.y + 6);
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    /* 面板外面的空白（页边距）：不收起，也不离开本页 */
    await page.mouse.click(4, 800);
    await expect(page).toHaveURL(/\/settings\/$/);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'true');
  });

  test('在面板上上滑（鼠标拖动 > 40px）收起；拖得不够不收', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    const h = await page.locator('.sgx-qp-sheet').boundingBox();
    const x = h.x + 60;
    const y = h.y + 300;
    /* 上移 20px：不收 */
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 20, { steps: 4 });
    await page.mouse.up();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    /* 上移 80px：收起，焦点回到图标，松手处的磁贴没被点中 */
    const mode = await ls(page, 'sgx-theme-mode');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 80, { steps: 6 });
    await page.mouse.up();
    await expectClosed(page);
    await expect(page.locator('.sgx-tb-quick')).toBeFocused();
    expect(await ls(page, 'sgx-theme-mode')).toBe(mode);
  });

  test('在面板上上滑（触摸）收起', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    await page.evaluate(() => {
      const el = document.querySelector('.sgx-qp-sheet');
      const mk = (y) => new Touch({ identifier: 1, target: el, clientX: 150, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [mk(400)], changedTouches: [mk(400)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [mk(330)], bubbles: true }));
    });
    await expectClosed(page);
  });

  test('Esc 收起，焦点回到图标', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page.locator('.sgx-tb-quick')).toBeFocused();
    await expect(page).toHaveURL(/\/settings\/$/);
  });

  test('离开本页再返回：面板是收起的；没有历史哨兵', async ({ page }) => {
    await go(page, '/');
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openQp(page);
    expect(await page.evaluate(() => history.state && history.state.sgxQp)).toBeFalsy();
    /* 系统返回直接离开本页（面板是正文的一部分，不拦返回） */
    await page.goBack();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/settings\/$/);
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await expectClosed(page);
  });

  test('刚点开（展开还没结束）就 Esc / 连点两下：照样收起，之后还能正常打开', async ({ page }) => {
    await go(page, '/settings/');
    await page.evaluate(() => {
      document.querySelector('.sgx-tb-quick').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await expectClosed(page);
    await page.locator('.sgx-tb-quick').click();
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await page.evaluate(() => {
      const b = document.querySelector('.sgx-tb-quick');
      b.click();
      b.click();
    });
    await expectClosed(page);
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
  });

  test('减弱动效（系统）：开合立刻到位', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, '/settings/');
    const before = await firstContent(page);
    await page.evaluate(() => document.querySelector('.sgx-tb-quick').click());
    /* 同一帧里就已展开到位 */
    const st = await page.evaluate(() => {
      const el = document.getElementById('sgx-qp');
      return { state: el.getAttribute('data-state'), h: el.getBoundingClientRect().height };
    });
    expect(st.state).toBe('open');
    const after = await firstContent(page);
    expect(Math.abs(after.y - before.y - st.h)).toBeLessThanOrEqual(2);
    await page.keyboard.press('Escape');
    expect(await qp(page).getAttribute('data-state')).toBe('closed');
    await expectClosed(page);
  });

  test('减弱动效（设置项 / 面板磁贴）：收起立刻到位', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    await tile(page, 'motion').click();
    await expect(page.locator('html')).toHaveClass(/\breduced-motion\b/);
    const st = await page.evaluate(() => {
      document.querySelector('.sgx-tb-quick').click();
      const el = document.getElementById('sgx-qp');
      return { state: el.getAttribute('data-state'), h: el.getBoundingClientRect().height };
    });
    expect(st.state).toBe('closed');
    expect(st.h).toBeLessThanOrEqual(0.5);
  });

  test('导航抽屉照常工作', async ({ page }) => {
    await go(page, '/settings/');
    await page.locator('.sgx-tb-nav').click();
    await expect(page.locator('#sgx-drawer')).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expect(page.locator('#sgx-drawer')).toBeHidden();
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
  });
});

test.describe('快捷面板：长条页名换成「快捷面板」', () => {
  for (const [path, lang, name, label] of [['/', 'zh', '首页', '快捷面板'], ['/settings/security/', 'zh', '安全与隐私', '快捷面板'], ['/en/', 'en', 'Home', 'Quick panel']]) {
    test(`${path}：开着显示「${label}」，收起后换回「${name}」，document.title 不变`, async ({ page }) => {
      await go(page, path, lang);
      const t0 = await capsuleLabel(page);
      expect(t0.text).toBe(name);
      expect(t0.nameAlpha).toBe(1);
      expect(t0.afterAlpha).toBe(0);
      /* 面板里没有标题行 */
      await expect(page.locator('.sgx-qp-head')).toHaveCount(0);
      await expect(qp(page)).toHaveAttribute('aria-label', label);
      await openQp(page);
      await expect.poll(async () => (await capsuleLabel(page)).afterAlpha).toBe(1);
      const t1 = await capsuleLabel(page);
      expect(t1.after).toContain(label);
      expect(t1.nameAlpha).toBe(0);
      /* 读屏 / 文本仍是页名，标签页标题不动 */
      expect(t1.text).toBe(name);
      await expect(page.locator('.sgx-tb-title')).toHaveText(name);
      expect(t1.title).toBe(t0.title);
      /* 面板直接从磁贴开始：第一个子块是磁贴网格 */
      expect(await page.locator('.sgx-qp-sheet').evaluate((el) => el.firstElementChild.className)).toContain('sgx-qp-grid');
      await page.locator('.sgx-tb-quick').click();
      await expectClosed(page);
      await expect.poll(async () => (await capsuleLabel(page)).nameAlpha).toBe(1);
      const t2 = await capsuleLabel(page);
      expect(t2.afterAlpha).toBe(0);
      expect(t2.text).toBe(name);
      expect(t2.title).toBe(t0.title);
    });
  }

  test('交叉淡化约 150ms：中途两者都半透明', async ({ page }) => {
    await go(page, '/');
    await page.evaluate(() => document.querySelector('.sgx-tb-quick').click());
    await page.waitForTimeout(60);
    const mid = await capsuleLabel(page);
    expect(mid.afterAlpha).toBeGreaterThan(0);
    expect(mid.afterAlpha).toBeLessThan(1);
    expect(mid.nameAlpha).toBeGreaterThan(0);
    expect(mid.nameAlpha).toBeLessThan(1);
    await expect.poll(async () => (await capsuleLabel(page)).afterAlpha).toBe(1);
  });

  test('减弱动效：页名立刻切换', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, '/');
    const st = await page.evaluate(() => {
      document.querySelector('.sgx-tb-quick').click();
      const el = document.querySelector('.sgx-tb-title');
      return { a: getComputedStyle(el, '::after').opacity, c: getComputedStyle(el).color };
    });
    expect(st.a).toBe('1');
    expect(st.c).toBe('rgba(0, 0, 0, 0)');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.sgx-tb-title'), '::after').opacity)).toBe('0');
  });
});

test.describe('快捷面板：内容', () => {
  test('中文：磁贴与行（只有设置里已有的项）+ 全部设置', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await expect(page.locator('#sgx-qp .sgx-qp-tile .sgx-qp-label')).toHaveText(['深色模式', '跟随系统', '减弱动效', '语言', '立即锁定']);
    await expect(page.locator('#sgx-qp .sgx-qp-row-label')).toHaveText(['调色板', '字体大小', '布局']);
    await expect(page.locator('#sgx-qp [data-qp-palette]')).toHaveCount(13);
    await expect(page.locator('#sgx-qp [data-qp-seg="font-size"] button')).toHaveText(['小', '标准', '大']);
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] button')).toHaveText(['自动', 'Mobile', 'DeX', 'PC']);
    await expect(page.locator('#sgx-qp .sgx-qp-all')).toHaveText('全部设置');
    await expect(page.locator('#sgx-qp .sgx-qp-all')).toHaveAttribute('href', '/settings/');
    /* 默认：浅色、跟随系统开、减弱动效关、默认色板、标准字体、自动布局 */
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'false');
    await expect(tile(page, 'dark').locator('[data-qp-state]')).toHaveText('关');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system').locator('[data-qp-state]')).toHaveText('开');
    await expect(tile(page, 'motion')).toHaveAttribute('aria-pressed', 'false');
    await expect(tile(page, 'lang').locator('.sgx-qp-state')).toHaveText('中文');
    await expect(page.locator('#sgx-qp [data-qp-palette="lake"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sgx-qp [data-qp-seg="font-size"] [data-v="standard"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
    /* 开着的磁贴是主色容器底色 */
    const on = await tile(page, 'system').evaluate((el) => getComputedStyle(el).backgroundColor);
    const off = await tile(page, 'dark').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(on).not.toBe(off);
  });

  test('英文文案', async ({ page }) => {
    await go(page, '/en/', 'en');
    await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-label', 'Quick panel');
    await openQp(page);
    await expect(page.locator('#sgx-qp .sgx-qp-tile .sgx-qp-label')).toHaveText(['Dark mode', 'Follow system', 'Reduce motion', 'Language', 'Lock now']);
    await expect(page.locator('#sgx-qp .sgx-qp-row-label')).toHaveText(['Color palette', 'Font size', 'Layout']);
    await expect(tile(page, 'system').locator('[data-qp-state]')).toHaveText('On');
    await expect(page.locator('#sgx-qp .sgx-qp-all')).toHaveText('All settings');
    await expect(page.locator('#sgx-qp .sgx-qp-all')).toHaveAttribute('href', '/en/settings/');
  });
});

test.describe('快捷面板：与设置页同一个设置', () => {
  test('深色模式：写 sgx-theme-mode，即时变深 / 变浅；设置页同步', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await tile(page, 'dark').click();
    expect(await ls(page, 'sgx-theme-mode')).toBe('dark');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'false');
    await expect(qp(page)).toHaveAttribute('data-state', 'open'); /* 不关面板、不刷新 */
    await page.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#theme-previews [data-mode="dark"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'false');
    await openQp(page);
    await tile(page, 'dark').click();
    expect(await ls(page, 'sgx-theme-mode')).toBe('light');
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    /* 设置页开着时即时同步（同一页的设置行跟着变） */
    await expect(page.locator('#theme-previews [data-mode="light"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('跟随系统：与设置页「跟随系统」开关同一语义', async ({ page }) => {
    await go(page, '/settings/display/');
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'true');
    await openQp(page);
    await tile(page, 'system').click();
    /* 关掉跟随系统 → 固定为当前看到的浅色 */
    expect(await ls(page, 'sgx-theme-mode')).toBe('light');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'false');
    await tile(page, 'system').click();
    /* 改回跟随系统：默认值不存 */
    expect(await ls(page, 'sgx-theme-mode')).toBeNull();
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'true');
    /* 反向：在设置页改，面板打开时反映 */
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await page.locator('#theme-previews [data-mode="dark"]').click();
    await openQp(page);
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'false');
  });

  test('减弱动效：写 sgx-reduced-motion；设置页同步', async ({ page }) => {
    await go(page, '/settings/accessibility/');
    await openQp(page);
    await tile(page, 'motion').click();
    expect(await ls(page, 'sgx-reduced-motion')).toBe('1');
    await expect(page.locator('html')).toHaveClass(/\breduced-motion\b/);
    await expect(tile(page, 'motion')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sw-motion')).toHaveAttribute('aria-checked', 'true');
    await tile(page, 'motion').click();
    expect(await ls(page, 'sgx-reduced-motion')).toBeNull();
    await expect(page.locator('html')).not.toHaveClass(/\breduced-motion\b/);
    await expect(page.locator('#sw-motion')).toHaveAttribute('aria-checked', 'false');
  });

  test('调色板：写 sgx-palette，即时换色；设置页同步', async ({ page }) => {
    await go(page, '/settings/theme/');
    await openQp(page);
    await page.locator('#sgx-qp [data-qp-palette="forest"]').click();
    expect(await ls(page, 'sgx-palette')).toBe('forest');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'forest');
    await expect(page.locator('#sgx-qp [data-qp-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#palette-dots [data-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#sgx-qp [data-qp-palette="lake"]').click();
    expect(await ls(page, 'sgx-palette')).toBeNull();
    await expect(page.locator('html')).not.toHaveAttribute('data-palette', /.+/);
    await expect(page.locator('#palette-dots [data-palette="lake"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('字体大小：写 sgx-font-size，即时生效；设置页同步', async ({ page }) => {
    await go(page, '/settings/display/');
    await openQp(page);
    await page.locator('#sgx-qp [data-qp-seg="font-size"] [data-v="large"]').click();
    expect(await ls(page, 'sgx-font-size')).toBe('large');
    expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('112.5%');
    await expect(page.locator('#seg-font [data-v="large"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#sgx-qp [data-qp-seg="font-size"] [data-v="standard"]').click();
    expect(await ls(page, 'sgx-font-size')).toBeNull();
    expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('');
    /* 反向：设置页改小 → 面板打开时反映 */
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await page.locator('#seg-font [data-v="small"]').click();
    await openQp(page);
    await expect(page.locator('#sgx-qp [data-qp-seg="font-size"] [data-v="small"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('布局：窄屏 DeX / PC 置灰；写 sgx-layout；设置页同步', async ({ page }) => {
    await go(page, '/settings/display/');
    await openQp(page);
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="dex"]')).toBeDisabled();
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="pc"]')).toBeDisabled();
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="mobile"]').click();
    expect(await ls(page, 'sgx-layout')).toBe('mobile');
    await expect(page.locator('#seg-layout [data-v="mobile"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]').click();
    /* 自动 = 默认值；baseof.html __layoutMode 会把空值补写成 auto（与设置页相同） */
    expect(['auto', null]).toContain(await ls(page, 'sgx-layout'));
    await expect(page.locator('#seg-layout [data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('布局（宽屏）：选 DeX 立即换成 DeX 布局', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await go(page, '/settings/display/');
    await openQp(page);
    /* 宽屏：同样内嵌在内容列里（左右缘 = 内容列），在顶栏下方 */
    const box = await qpBox(page);
    const col = await page.evaluate(() => {
      const r = document.querySelector('#sgx-qp + * > .set-main, #sgx-qp + *').getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    expect(box.left).toBeGreaterThanOrEqual(col.left - 1);
    expect(box.right).toBeLessThanOrEqual(col.right + 1);
    const tb = await page.locator('.sgx-topbar').boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(tb.y + tb.height);
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="dex"]').click();
    expect(await ls(page, 'sgx-layout')).toBe('dex');
    await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="pc"]').click();
    await expect(page.locator('html')).toHaveClass(/\blayout-pc\b/);
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]').click();
    expect(['auto', null]).toContain(await ls(page, 'sgx-layout'));
    await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/); /* 1366×768 横屏 < 1600 → 自动 = DeX */
  });

  test('语言：切到 English（sgx-lang=en），同一页，不在历史里多留一步', async ({ page }) => {
    await go(page, '/');
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openQp(page);
    await expect(tile(page, 'lang')).toHaveAttribute('aria-label', /English/);
    await tile(page, 'lang').click();
    await expect(page).toHaveURL(/\/en\/settings\/$/);
    expect(await ls(page, 'sgx-lang')).toBe('en');
    await expect(page.locator('.sgx-tb-title')).toHaveText('Settings');
    await page.goBack();
    /* 回到进设置页之前的主页（语言偏好已是英文，主页 replace 到 /en/） */
    await expect(page).toHaveURL(/localhost:\d+\/(en\/)?$/);
  });

  test('立即锁定：关面板后弹出与安全页相同的确认层，确认后调 /api/lock', async ({ page }) => {
    let called = false;
    await go(page, '/', 'zh', false);
    await page.route('**/api/lock', async (route) => {
      called = true;
      await route.fulfill({ status: 200, body: '{}' });
    });
    await openQp(page);
    await tile(page, 'lock').click();
    await expectClosed(page);
    const dlg = page.locator('#sec-locknow-confirm');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('立即锁定？');
    /* 取消：不调接口 */
    await dlg.locator('[data-act="cancel"]').click();
    await expect(dlg).toBeHidden();
    expect(called).toBe(false);
    await page.waitForTimeout(450); /* 防误触窗口（400ms）过去 */
    await openQp(page);
    await tile(page, 'lock').click();
    await expect(dlg).toBeVisible();
    await dlg.locator('[data-act="ok"]').click();
    await expect(page).toHaveURL(/\?lock=1/);
    expect(called).toBe(true);
  });

  test('全部设置：进设置页，返回回到原页（不多一步）', async ({ page }) => {
    await go(page, '/');
    await page.goto('/bookmarks/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openQp(page);
    await page.locator('#sgx-qp .sgx-qp-all').click();
    await expect(page).toHaveURL(/\/settings\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/bookmarks\/$/);
    await expect(qp(page)).toBeHidden();
  });
});
