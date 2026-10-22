/**
 * 原地搜索层（2026-10-22，取代全网搜索页 /search/；共享外壳组件 shell/search-layer.js，主站宿主 shell/search-host.js）。
 * - 点导航抽屉底栏的搜索框：不跳页，抽屉在这次点击里关上（复制件原地淡出），搜索框变形成底部搜索栏
 *   （长条药丸「搜索」+ 单独的 ✕ 圆，和原 /search/ 页底栏同一套），输入框同步聚焦；上方是盖住当前页的结果层。
 * - 顶栏不动（不重绘、不淡、不换标题）；顶栏没有搜索图标了。
 * - 历史：抽屉的哨兵直接交给搜索层（replaceState），✕ / 系统返回关层，永远不叠条目。
 * - 空输入背景（放大镜 +「聚合搜索」，内容区居中、跟着键盘）、站内结果、「用 <引擎> 搜索」、回车规则、方向键。
 * - /search/?q=、/browser/?q=、/en/search/ → 首页打开搜索层并预填；opensearch 用 /?q=。
 * - 搜索层代码懒加载：页面入口里没有它，按下九宫格才去取。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 } });

async function go(page, path, opts = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript((o) => {
    try {
      localStorage.setItem('sgx-lang', o.lang || 'zh');
      if (o.engine) localStorage.setItem('sgx-search-engine', o.engine);
      if (o.rm) localStorage.setItem('sgx-reduced-motion', '1');
    } catch (e) {}
    /* window.open 记下来，不真开 */
    window.__opened = [];
    window.open = function (u) { window.__opened.push(String(u)); return null; };
  }, opts);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
}
const drawer = (page) => page.locator('#sgx-drawer');
const layer = (page) => page.locator('.sgx-srch');
const bar = (page) => page.locator('.sgx-srch-bar');
const input = (page) => page.locator('#sgx-srch-input');

async function openDrawer(page) {
  await page.locator('.sgx-tb-nav').click();
  await expect(drawer(page)).toHaveAttribute('data-state', 'open');
}
async function openFromDrawer(page) {
  await openDrawer(page);
  /* 搜索层代码在打开抽屉时就开始取 */
  await page.waitForFunction(() => !!document.querySelector('meta[name="sgx-search-src"]'));
  await drawer(page).locator('a.sgx-drawer-search').click();
  await expect(input(page)).toBeFocused({ timeout: 5000 });
  await expect(layer(page)).toBeVisible();
}

test('点抽屉搜索框：原地打开（不跳页）、输入框同步聚焦、抽屉关上；顶栏原样、没有搜索图标', async ({ page }) => {
  await go(page, '/settings/');
  await page.evaluate(() => { window.__noReload = 1; });
  await expect(page.locator('#sgx-tb-search, .sgx-tb-search')).toHaveCount(0);
  const title0 = await page.locator('.sgx-tb-title').textContent();
  await openDrawer(page);
  /* 同步聚焦：click 处理函数返回时焦点已经在输入框上（安卓只在手势里同步 focus 才弹键盘） */
  const sync = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 50));
    const a = document.querySelector('#sgx-drawer a.sgx-drawer-search');
    a.click();
    const el = document.activeElement;
    return { id: el && el.id, dlgOpen: document.getElementById('sgx-drawer').open };
  });
  expect(sync).toEqual({ id: 'sgx-srch-input', dlgOpen: false });
  expect(await page.evaluate(() => window.__noReload)).toBe(1);
  expect(new URL(page.url()).pathname).toBe('/settings/');
  await expect(layer(page)).toBeVisible();
  await expect(page.locator('.sgx-tb-title')).toHaveText(title0 || '');
  await expect(input(page)).toHaveAttribute('placeholder', '搜索');
  /* 抽屉复制件淡完就删 */
  await expect(page.locator('.sgx-srch-ghost')).toHaveCount(0, { timeout: 2000 });
});

test('底栏：长条药丸 + 单独的 ✕ 圆（同高 56、同材质、间距 8、左右 16），贴底；结果层在顶栏下面', async ({ page }) => {
  await go(page, '/');
  await openFromDrawer(page);
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const r = (q) => document.querySelector(q).getBoundingClientRect();
    const cs = (q) => getComputedStyle(document.querySelector(q));
    const p = cs('.sgx-srch-pill'), c = cs('.sgx-srch-close');
    return { p: r('.sgx-srch-pill'), c: r('.sgx-srch-close'), vw: innerWidth, vh: innerHeight,
      mat: [p.backgroundColor === c.backgroundColor, p.borderTopColor === c.borderTopColor, p.boxShadow === c.boxShadow],
      crad: c.borderTopLeftRadius, lz: +cs('.sgx-srch').zIndex, navz: +cs('#site-nav').zIndex
    };
  });
  expect(Math.abs(m.p.height - 56)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(m.c.width - 56)).toBeLessThanOrEqual(0.5);
  expect(m.crad).toBe('999px');
  expect(m.mat).toEqual([true, true, true]);
  expect(Math.abs(m.c.left - m.p.right - 8)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.p.left - 16)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.vw - m.c.right - 16)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.vh - m.p.bottom - 12)).toBeLessThanOrEqual(1);
  expect(m.lz).toBeLessThan(m.navz);
});

test('空输入：背景是放大镜 +「聚合搜索」，在内容区（顶栏下沿到底栏上沿）正中；没有最近搜索，旧键被清掉', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('sgx-browser-history', JSON.stringify(['a1'])); } catch (e) {} });
  await go(page, '/');
  await openFromDrawer(page);
  const empty = page.locator('.sgx-srch-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toHaveText('聚合搜索');
  await expect(page.locator('.sgx-srch-chip')).toHaveCount(0);
  await expect(input(page)).toHaveAttribute('placeholder', '搜索');
  const m = await page.evaluate(() => {
    const tb = document.querySelector('.sgx-tb-pill').getBoundingClientRect();
    const bar = document.querySelector('.sgx-srch-bar').getBoundingClientRect();
    const ic = document.querySelector('.sgx-srch-empty-ic').getBoundingClientRect();
    const tx = document.querySelector('.sgx-srch-empty-tx').getBoundingClientRect();
    const bic = document.querySelector('.sgx-srch-bar .sgx-srch-ic');
    return { mid: (ic.top + tx.bottom) / 2, top: tb.bottom, bottom: bar.top, cx: (ic.left + ic.right) / 2, vw: innerWidth,
      same: bic.innerHTML === document.querySelector('.sgx-srch-empty-ic').innerHTML,
      hist: localStorage.getItem('sgx-browser-history') };
  });
  expect(m.same).toBe(true);
  expect(Math.abs(m.cx - m.vw / 2)).toBeLessThanOrEqual(1);
  /* 内容区 = 顶栏下沿 + 16px 到底栏上沿 − 12px，背景在它正中（±24px：顶部 safe-area / 留白） */
  expect(Math.abs(m.mid - (m.top + m.bottom) / 2)).toBeLessThanOrEqual(24);
  expect(m.hist).toBeNull();
  /* 输入后背景藏起来，清空后回来 */
  await input(page).fill('设置');
  await expect(empty).toBeHidden();
  await input(page).fill('');
  await expect(empty).toBeVisible();
});

test('空输入背景跟着键盘：底栏上移多少，背景中心上移一半', async ({ page }) => {
  await go(page, '/');
  await openFromDrawer(page);
  const at = () => page.evaluate(() => { const r = document.querySelector('.sgx-srch-empty-ic').getBoundingClientRect(); return r.top; });
  const y0 = await at();
  await page.evaluate(() => { document.querySelector('.sgx-srch').style.setProperty('--sgx-srch-kb', '300px'); });
  const y1 = await at();
  expect(Math.abs((y0 - y1) - 150)).toBeLessThanOrEqual(1);
});

test('输入：站内结果 + 最后一行「用 <引擎> 搜索 “…”」（跟 设置 › 隐私 里选的引擎）；ⓧ 清空回到空背景', async ({ page }) => {
  await go(page, '/', { engine: 'bing' });
  await openFromDrawer(page);
  await input(page).fill('设置');
  await expect(page.locator('[data-srch-u]').first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-srch-u]').first()).toContainText('设置');
  const rows = page.locator('[data-srch-u], [data-srch-engine]');
  await expect(rows.last()).toHaveText('用 Bing 搜索 “设置”');
  await expect(page.locator('[data-srch-clear-input]')).toBeVisible();
  await page.locator('[data-srch-clear-input]').click();
  await expect(input(page)).toHaveValue('');
  await expect(input(page)).toBeFocused();
  await expect(page.locator('.sgx-srch-empty')).toBeVisible();
  await expect(page.locator('[data-srch-clear-input]')).toBeHidden();
});

test('回车：像网址 → 新标签 https://；否则用引擎搜（新标签）；不再记录搜索历史', async ({ page }) => {
  await go(page, '/');
  await openFromDrawer(page);
  await input(page).fill('example.com');
  await input(page).press('Enter');
  await input(page).focus();
  await input(page).fill('猫咪 图片');
  await input(page).press('Enter');
  expect(await page.evaluate(() => window.__opened)).toEqual([
    'https://example.com',
    'https://www.google.com/search?q=' + encodeURIComponent('猫咪 图片'),
  ]);
  expect(await page.evaluate(() => localStorage.getItem('sgx-browser-history'))).toBeNull();
  /* 回车后收键盘，层还在 */
  await expect(input(page)).not.toBeFocused();
  await expect(layer(page)).toBeVisible();
});

test('回车：标题和输入完全一样的站内结果直接打开（先关层、退掉哨兵，再跳）', async ({ page }) => {
  await go(page, '/');
  const len0 = await page.evaluate(() => history.length);
  await openFromDrawer(page);
  await input(page).fill('设置');
  await expect(page.locator('[data-srch-u]').first()).toBeVisible({ timeout: 5000 });
  await input(page).press('Enter');
  await expect(page).toHaveURL(/\/settings\/$/, { timeout: 10000 });
  await page.goBack();
  await expect(page).toHaveURL(/localhost:\d+\/$/);
  expect(await page.evaluate(() => !!(history.state && (history.state.sgxSearch || history.state.sgxDrawer)))).toBe(false);
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(len0 + 2);
});

test('方向键：↓ 选中行（aria-activedescendant），回车打开选中的引擎行', async ({ page }) => {
  await go(page, '/');
  await openFromDrawer(page);
  await input(page).fill('zzqx');
  const rows = page.locator('[data-srch-u], [data-srch-engine]');
  await expect(rows).toHaveCount(1);
  await input(page).press('ArrowDown');
  await expect(rows.first()).toHaveClass(/\bis-active\b/);
  await expect(input(page)).toHaveAttribute('aria-activedescendant', /sgx-srch-o\d+/);
  await input(page).press('ArrowUp');
  await expect(rows.first()).not.toHaveClass(/\bis-active\b/);
  await input(page).press('ArrowDown');
  await input(page).press('Enter');
  expect(await page.evaluate(() => window.__opened)).toEqual(['https://www.google.com/search?q=zzqx']);
});

test('历史：抽屉的哨兵交给搜索层，✕ 关闭回到原页；反复开关 history.length 不涨', async ({ page }) => {
  await go(page, '/');
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible();
  const len0 = await page.evaluate(() => history.length);
  await openDrawer(page);
  expect(await page.evaluate(() => history.length)).toBe(len0 + 1);
  await drawer(page).locator('a.sgx-drawer-search').click();
  await expect(input(page)).toBeFocused({ timeout: 5000 });
  expect(await page.evaluate(() => ({ n: history.length, s: !!(history.state && history.state.sgxSearch) }))).toEqual({ n: len0 + 1, s: true });
  await page.locator('[data-srch-close]').click();
  await expect(layer(page)).toBeHidden();
  await expect(bar(page)).toBeHidden();
  await page.waitForTimeout(200);
  expect(new URL(page.url()).pathname).toBe('/settings/');
  expect(await page.evaluate(() => !!(history.state && history.state.sgxSearch))).toBe(false);
  for (let i = 0; i < 3; i++) {
    await openFromDrawer(page);
    await page.locator('[data-srch-close]').click();
    await expect(layer(page)).toBeHidden();
  }
  expect(await page.evaluate(() => history.length)).toBe(len0 + 1);
  /* 返回一次就离开设置页（没有残留的哨兵） */
  await page.goBack();
  await expect(page).toHaveURL(/localhost:\d+\/$/);
});

test('系统返回：只关搜索层，停在本页；再返回才离开', async ({ page }) => {
  await go(page, '/');
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible();
  await openFromDrawer(page);
  await page.goBack();
  await expect(layer(page)).toBeHidden();
  await expect(drawer(page)).toBeHidden();
  expect(new URL(page.url()).pathname).toBe('/settings/');
  await page.goBack();
  await expect(page).toHaveURL(/localhost:\d+\/$/);
});

test('Esc 关闭；Ctrl+K 不开抽屉直接打开（push 一条，✕ 退掉）', async ({ page }) => {
  await go(page, '/settings/');
  const len0 = await page.evaluate(() => history.length);
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.keyboard.press('Control+k');
  await expect(input(page)).toBeFocused({ timeout: 5000 });
  expect(await page.evaluate(() => history.length)).toBe(len0 + 1);
  await page.keyboard.press('Escape');
  await expect(layer(page)).toBeHidden();
  expect(await page.evaluate(() => !!(history.state && history.state.sgxSearch))).toBe(false);
});

test('顶栏在打开过程中一直在、不动：不重绘（无 DOM 变化）、不透明度一直 1、位置不变、没有 view transition', async ({ page }) => {
  await go(page, '/');
  await openDrawer(page);
  const r = await page.evaluate(async () => {
    const nav = document.getElementById('site-nav');
    const tb = document.querySelector('.sgx-topbar');
    let muts = 0;
    const mo = new MutationObserver((l) => { muts += l.length; });
    mo.observe(nav, { subtree: true, childList: true, attributes: true, characterData: true });
    const rect0 = JSON.stringify(tb.getBoundingClientRect());
    let vt = 0;
    const svt = document.startViewTransition;
    if (svt) document.startViewTransition = function () { vt++; return svt.apply(document, arguments); };
    const samples = [];
    document.querySelector('#sgx-drawer a.sgx-drawer-search').click();
    const t0 = performance.now();
    await new Promise((res) => {
      const f = () => {
        samples.push({ o: +getComputedStyle(nav).opacity * +getComputedStyle(tb).opacity, r: JSON.stringify(tb.getBoundingClientRect()), vis: getComputedStyle(tb).visibility });
        if (performance.now() - t0 < 500) requestAnimationFrame(f); else res();
      };
      requestAnimationFrame(f);
    });
    mo.disconnect();
    return { muts, vt, n: samples.length, allOpaque: samples.every((s) => s.o === 1 && s.vis === 'visible'), allSame: samples.every((s) => s.r === rect0) };
  });
  /* aria-expanded 同步是抽屉按钮的属性变化（九宫格按钮 aria-expanded true → false），只允许这一种 */
  expect(r.muts).toBeLessThanOrEqual(1);
  expect(r.vt).toBe(0);
  expect(r.n).toBeGreaterThan(5);
  expect(r.allOpaque).toBe(true);
  expect(r.allSame).toBe(true);
});

test('减弱动效：不复制抽屉、不做变形，直接打开并聚焦', async ({ page }) => {
  await go(page, '/', { rm: true });
  await openDrawer(page);
  /* 等懒加载的搜索层把隐藏 DOM 建好再同步点击（没到时宿主走代理输入框兜底聚焦，那条路径下面不测动画；CI 慢机上曾因此 flaky） */
  await page.waitForFunction(() => !!document.querySelector('.sgx-srch-pill'));
  const n = await page.evaluate(() => {
    document.querySelector('#sgx-drawer a.sgx-drawer-search').click();
    return { ghosts: document.querySelectorAll('.sgx-srch-ghost').length, anims: document.querySelector('.sgx-srch-pill').getAnimations().length, focus: document.activeElement.id };
  });
  expect(n).toEqual({ ghosts: 0, anims: 0, focus: 'sgx-srch-input' });
});

test('旧入口：/search/?q=、/browser/?q=、/browser/search/?q= → 首页打开搜索层并预填（URL 去掉 q）', async ({ page }) => {
  for (const [p, q] of [['/search/?q=xyz', 'xyz'], ['/browser/?q=abc', 'abc'], ['/browser/search/?q=%E4%BD%A0%E5%A5%BD', '你好']]) {
    await go(page, p);
    await expect(input(page)).toHaveValue(q, { timeout: 10000 });
    await expect(layer(page)).toBeVisible();
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/');
    expect(await page.evaluate(() => !!(history.state && history.state.sgxSearch))).toBe(true);
  }
  /* 没有 q：空的搜索层；英文 */
  await go(page, '/en/search/', { lang: 'en' });
  await expect(layer(page)).toBeVisible({ timeout: 10000 });
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/en/');
  await expect(input(page)).toHaveAttribute('placeholder', 'Search');
  await page.goto('/en/browser/#focus', { waitUntil: 'domcontentloaded' });
  await expect(layer(page)).toBeVisible({ timeout: 10000 });
  expect(new URL(page.url()).pathname).toBe('/en/');
  const os = await (await page.request.get('/opensearch.xml')).text();
  expect(os).toContain('template="https://styrigx.com/?q={searchTerms}"');
  for (const p of ['/search/', '/en/search/']) {
    const html = await (await page.request.get(p)).text();
    expect(html, p).not.toContain('sgx-topbar');
    expect(html, p).toContain('noindex');
  }
});

test('懒加载：页面入口里没有搜索层代码；按下九宫格才取', async ({ page }) => {
  const reqs = [];
  page.on('request', (r) => { if (/search-layer\.[0-9a-f]+\.js/.test(r.url())) reqs.push(r.url()); });
  await go(page, '/');
  await page.waitForTimeout(500);
  expect(reqs).toHaveLength(0);
  const entry = await page.evaluate(() => document.querySelector('script[type="module"]').src);
  const code = await (await page.request.get(entry)).text();
  expect(code).not.toContain('sgx-srch-ghost');
  await page.locator('.sgx-tb-nav').dispatchEvent('pointerdown');
  await expect.poll(() => reqs.length).toBe(1);
});

/* 2026-10-23 PR-D：< 840 宽底栏左右缘对齐外壳框（= 顶栏两侧圆外缘）：手机 16px 页边距，宽竖屏 Mobile 跟 640 框 */
for (const [w, h] of [[412, 915], [768, 1024]]) {
  test(`${w}×${h}：底栏左右缘 = 顶栏左右缘`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await go(page, '/');
    await openFromDrawer(page);
    const m = await page.evaluate(() => {
      const b = document.querySelector('.sgx-srch-bar').getBoundingClientRect();
      const t = document.querySelector('.sgx-topbar').getBoundingClientRect();
      return { bl: b.left, br: b.right, tl: t.left, tr: t.right };
    });
    expect(Math.abs(m.bl - m.tl), `左 ${m.bl} / ${m.tl}`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.br - m.tr), `右 ${m.br} / ${m.tr}`).toBeLessThanOrEqual(1);
  });
}

test('桌面（1280）：底栏 560px 居中，结果列最宽 640 居中', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await go(page, '/');
  await openFromDrawer(page);
  /* 空输入没有结果卡（只有「聚合搜索」背景）：输入一个词，等站内结果卡出来再量 */
  await input(page).fill('设置');
  await expect(page.locator('.sgx-srch-card').first()).toBeVisible({ timeout: 5000 });
  const m = await page.evaluate(() => {
    const b = document.querySelector('.sgx-srch-bar').getBoundingClientRect();
    const c = document.querySelector('.sgx-srch-card').getBoundingClientRect();
    return { bw: b.width, bc: b.left + b.width / 2, cw: c.width, cc: c.left + c.width / 2, vw: innerWidth };
  });
  expect(Math.abs(m.bw - 560)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.bc - m.vw / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.cw - 640)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.cc - m.vw / 2)).toBeLessThanOrEqual(1);
});
