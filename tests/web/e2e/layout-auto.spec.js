/**
 * 2026-10-23 布局三档（Mobile · Auto · DeX），只看可用视口（innerWidth × innerHeight），不看 UA：
 * - 自动：w > h 且 w ≥ 840 且 h ≥ 500 → DeX，其余 → Mobile
 * - 手动 DeX：w < 840 或 h < 500 → Mobile（偏好保留）
 * - 设置 › 显示 › 布局：Mobile / Auto / DeX 三个英文标签（中英文页都一样），不够 DeX 时 DeX 置灰 + 提示
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, setHomeCards, expect } = require('./helpers');

async function go(page, vp, url, pref) {
  await page.setViewportSize(vp);
  /* 固定语言，免得跟随浏览器语言跳到另一种 */
  await page.addInitScript((ln) => { try { localStorage.setItem('sgx-lang', ln); } catch (e) {} }, url.startsWith('/en/') ? 'en' : 'zh');
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  if (pref) await page.addInitScript((l) => { try { localStorage.setItem('sgx-layout', l); } catch (e) {} }, pref);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

const AUTO = [
  [915, 412, 'mobile'],
  [932, 430, 'mobile'],
  [841, 673, 'dex'],
  [1133, 744, 'dex'],
  [1366, 650, 'dex'],
  [412, 915, 'mobile'],
  [1024, 1366, 'mobile'],
  [1920, 950, 'dex'],
];

for (const [width, height, want] of AUTO) {
  test(`自动 ${width}×${height} → ${want}`, async ({ page }) => {
    await go(page, { width, height }, '/');
    await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('html')).toHaveClass(new RegExp('\\blayout-' + want + '\\b'));
    await expect(page.locator('html')).not.toHaveClass(/\blayout-pc\b/);
  });
}

test('手动 DeX 在 915×412（手机横屏）→ mobile，偏好保留', async ({ page }) => {
  await go(page, { width: 915, height: 412 }, '/', 'dex');
  await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('html')).toHaveClass(/\blayout-mobile\b/);
  expect(await page.evaluate(() => localStorage.getItem('sgx-layout'))).toBe('dex');
});

test('旧值 pc 在 1366×768 → DeX，并迁成 dex', async ({ page }) => {
  await go(page, { width: 1366, height: 768 }, '/', 'pc');
  await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
  expect(await page.evaluate(() => localStorage.getItem('sgx-layout'))).toBe('dex');
});

for (const [lang, hint] of [['zh', 'DeX 仅在大屏生效（当前不满足）'], ['en', 'DeX only works on large screens (not met here)']]) {
  test(`设置 › 显示 › 布局（${lang}）：Mobile / Auto / DeX，默认 Auto；915×412 下 DeX 置灰 + 提示`, async ({ page }) => {
    await go(page, { width: 915, height: 412 }, (lang === 'en' ? '/en' : '') + '/settings/display/');
    const seg = page.locator('#seg-layout button');
    await expect(seg).toHaveText(['Mobile', 'Auto', 'DeX']);
    await expect(page.locator('#seg-layout [data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#seg-layout [data-v="dex"]')).toBeDisabled();
    await expect(page.locator('#seg-layout-narrow-hint')).toHaveText(hint);
  });
}

test('设置 › 显示 › 布局：841×673 下 DeX 可选、没有提示；选 DeX 后是 DeX', async ({ page }) => {
  await go(page, { width: 841, height: 673 }, '/settings/display/');
  await expect(page.locator('#seg-layout [data-v="dex"]')).toBeEnabled();
  await expect(page.locator('#seg-layout-narrow-hint')).toHaveCount(0);
  await page.locator('#seg-layout [data-v="dex"]').click();
  expect(await page.evaluate(() => localStorage.getItem('sgx-layout'))).toBe('dex');
  await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
});

/* ----- 顶栏长条：宽屏只包住内容居中，手机照旧拉满 ----- */
async function bars(page) {
  return page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, w: b.width }; };
    return { bar: r('.sgx-topbar'), nav: r('.sgx-tb-nav'), pill: r('.sgx-tb-pill'), end: r('.sgx-tb-end'), tabs: r('.sgx-tb-tabs'), vw: window.innerWidth };
  });
}
for (const [width, height] of [[1280, 800], [1920, 1080], [1024, 700], [768, 1024]]) {
  test(`顶栏长条 ${width}×${height}：主页标签胶囊按内容定宽、居中，两侧圆贴两端`, async ({ page }) => {
    await go(page, { width, height }, '/');
    await expect(page.locator('.sgx-tb-tabs')).toBeVisible();
    const b = await bars(page);
    expect(Math.abs(b.pill.x + b.pill.w / 2 - b.vw / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.nav.x - b.bar.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.end.x + b.end.w - (b.bar.x + b.bar.w))).toBeLessThanOrEqual(1);
    expect(b.pill.w).toBeLessThanOrEqual(480);
    expect(b.pill.w).toBeGreaterThanOrEqual(160);
    expect(b.pill.w).toBeLessThan(b.bar.w - 2 * b.nav.w - 16 - 40);
  });
}
test('顶栏长条 412×915：手机照旧拉满（左右圆之间只隔 8px）', async ({ page }) => {
  await go(page, { width: 412, height: 915 }, '/settings/security/');
  const b = await bars(page);
  expect(Math.abs(b.pill.x - (b.nav.x + b.nav.w) - 8)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.end.x - (b.pill.x + b.pill.w) - 8)).toBeLessThanOrEqual(1);
});

/* ----- 宽竖屏 Mobile：外框最宽 640 居中，左右边线 = 顶栏两侧圆外缘（2026-10-23 PR-D） ----- */
const WRAPS = [['/', '.home-wrap'], ['/settings/', '.set-layout'], ['/settings/display/', '.set-layout'], ['/chat/', '.chat-wrap'], ['/account/', '.acct-layout'], ['/account/status/', '.acct-layout'], ['/404.html', '.sgx-404']];
async function frame(page, sel) {
  return page.evaluate((s) => {
    const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width }; };
    return { wrap: r(document.querySelector(s)), bar: r(document.querySelector('.sgx-topbar')), vw: innerWidth };
  }, sel);
}
for (const [path, sel] of WRAPS) {
  test(`宽竖屏 834×1194 Mobile：${path} 外框 640 居中，边线 = 顶栏`, async ({ page }) => {
    await go(page, { width: 834, height: 1194 }, path);
    await expect(page.locator('html')).toHaveClass(/\blayout-mobile\b/);
    const f = await frame(page, sel);
    expect(Math.abs(f.wrap.w - 640)).toBeLessThanOrEqual(1);
    expect(Math.abs(f.wrap.l + f.wrap.w / 2 - f.vw / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(f.wrap.l - f.bar.l) + Math.abs(f.wrap.r - f.bar.r)).toBeLessThanOrEqual(1);
  });
}

/* ----- DeX：外框 = 顶栏框（最宽 1440），内部列在框里居中 ----- */
for (const [w, h] of [[1024, 700], [1366, 650], [1920, 950]]) {
  for (const [path, sel] of WRAPS) {
    test(`DeX ${w}×${h}：${path} 外框边线 = 顶栏两侧圆外缘`, async ({ page }) => {
      await go(page, { width: w, height: h }, path);
      await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
      const f = await frame(page, sel);
      const m = Math.min(48, Math.max(16, 5.333 + 0.022222 * w));
      expect(Math.abs(f.bar.w - Math.min(w - 2 * m, 1440)), `顶栏宽 ${f.bar.w}`).toBeLessThanOrEqual(1);
      expect(Math.abs(f.wrap.l - f.bar.l) + Math.abs(f.wrap.r - f.bar.r), `${sel} ${f.wrap.l}–${f.wrap.r} / 顶栏 ${f.bar.l}–${f.bar.r}`).toBeLessThanOrEqual(1);
    });
  }
  test(`DeX ${w}×${h}：内部列 —— 设置两栏 280 + 24 + ≤720 整体居中，子页 / 服务状态 720，聊天 760`, async ({ page }) => {
    const col = async (path, s) => {
      await go(page, { width: w, height: h }, path);
      await expect(page.locator(s).first()).toBeAttached();
      await page.waitForLoadState('load');
      return page.evaluate((q) => { const vw = innerWidth; return [...document.querySelectorAll(q)].filter((e) => e.offsetParent !== null).map((e) => { const b = e.getBoundingClientRect(); return { l: b.left, w: b.width, c: b.left + b.width / 2 - vw / 2 }; }); }, s);
    };
    const [cols] = await col('/settings/', '.set-dex-cols');
    const left = await page.evaluate(() => document.querySelector('.set-col-l').getBoundingClientRect().width);
    const bar = await page.evaluate(() => document.querySelector('.sgx-topbar').getBoundingClientRect().width);
    expect(Math.abs(cols.w - Math.min(1024, bar)), `两栏宽 ${cols.w}`).toBeLessThanOrEqual(1);
    expect(Math.abs(cols.c), '两栏居中').toBeLessThanOrEqual(1);
    expect(Math.abs(left - 280), `左栏 ${left}`).toBeLessThanOrEqual(1);
    for (const [path, s, want] of [['/settings/display/', '.set-layout > .set-main', 720], ['/account/status/', '#st-foot', 720], ['/chat/', '#chat-empty', 760]]) {
      const [c] = await col(path, s);
      expect(Math.abs(c.w - Math.min(want, bar)), `${path} ${s} 宽 ${c.w}`).toBeLessThanOrEqual(1);
      expect(Math.abs(c.c), `${path} 居中`).toBeLessThanOrEqual(1);
    }
  });
}

/* ----- 临界：839 / 840 / 841 宽 × 499 / 500 / 501 高 ----- */
for (const w of [839, 840, 841]) {
  for (const h of [499, 500, 501]) {
    test(`临界 ${w}×${h}：模式正确、无横向滚动、卡片 ≥ 320`, async ({ page }) => {
      await go(page, { width: w, height: h }, '/');
      const want = w >= 840 && h >= 500 ? 'dex' : 'mobile';
      await expect(page.locator('html')).toHaveClass(new RegExp('\\blayout-' + want + '\\b'));
      await expect(page.locator('#home-widgets')).toBeVisible();
      const m = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth,
        cards: [...document.querySelectorAll('#home-widgets > .widget')].filter((e) => e.offsetParent !== null).map((e) => [e.id, e.getBoundingClientRect().width]) }));
      expect(m.sw).toBeLessThanOrEqual(m.iw);
      expect(m.cards.length).toBeGreaterThan(0);
      for (const [id, cw] of m.cards) expect(cw, `${id} 宽 ${cw}`).toBeGreaterThanOrEqual(320);
    });
  }
}

/* ----- 首页栅格退列：收窄容器，列数按 320 最小列宽一路退到 1 列，绝不挤到 320 以下 ----- */
test('栅格退列：1920 宽 3 列，容器收窄到 1000 / 700 / 600 / 330 → 2 / 2 / 1 / 1 列；< 1200 宽 2 列', async ({ page }) => {
  await go(page, { width: 1920, height: 950 }, '/');
  await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
  /* 天气 + 日刻全有数据（缺卡时会按可见卡数收列，见下一条） */
  await setHomeCards(page, { weather: true, daymark: true });
  const cols = (px) => page.evaluate((v) => {
    const g = document.querySelector('#home-widgets');
    /* 减弱动效下全局 transition-duration .01ms（transition-property 默认 all）：宽度变化会走一帧过渡，先关掉再量 */
    g.style.transition = 'none';
    g.style.width = v ? v + 'px' : '';
    const t = getComputedStyle(g).gridTemplateColumns.split(' ').map(parseFloat);
    return { n: t.length, min: Math.min(...t), raw: getComputedStyle(g).gridTemplateColumns };
  }, px);
  for (const [px, n] of [[0, 3], [1000, 2], [700, 2], [600, 1], [330, 1]]) {
    const c = await cols(px);
    expect(c.n, `容器 ${px || '原宽'} → ${c.raw}`).toBe(n);
    expect(c.min).toBeGreaterThanOrEqual(320);
  }
  await page.setViewportSize({ width: 1180, height: 760 });
  await expect.poll(() => page.evaluate(() => { const g = document.querySelector('#home-widgets'); g.style.width = ''; return getComputedStyle(g).gridTemplateColumns.split(' ').length; })).toBe(2);
});

/* ----- 时钟那一行：天气 / 日刻缺数据（.hidden）或没输出时，可见的卡铺满整行，右缘 = 容器右缘，不留空白 ----- */
for (const [w, h, n] of [[1280, 760, 3], [841, 673, 2]]) {
  for (const [wx, dm] of [[false, false], [true, false], [false, true], [true, true]]) {
    const vis = 1 + Number(wx) + Number(dm);
    test(`时钟行 ${w}×${h}（${n} 列）：可见 ${vis} 张（天气 ${wx ? '有' : '无'} / 日刻 ${dm ? '有' : '无'}）→ 无空白`, async ({ page }) => {
      await go(page, { width: w, height: h }, '/');
      await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
      await expect(page.locator('#home-widgets')).toBeVisible();
      await setHomeCards(page, { weather: wx, daymark: dm });
      const m = await page.evaluate(() => {
        const g = document.querySelector('#home-widgets');
        const gr = g.getBoundingClientRect();
        const gap = parseFloat(getComputedStyle(g).columnGap);
        const cols = getComputedStyle(g).gridTemplateColumns.split(' ').length;
        const box = (id) => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); return { id, shown: getComputedStyle(e).display !== 'none', l: r.left, r: r.right, w: r.width, t: r.top, b: r.bottom }; };
        return { g: { l: gr.left, r: gr.right, w: gr.width }, gap, cols, profile: box('w-profile'), cards: ['dual-clock', 'weather', 'w-daymark'].map(box).filter(Boolean) };
      });
      /* 隐藏的卡 display:none、不占格 */
      for (const c of m.cards) if (c.id !== 'dual-clock') expect(c.shown, `${c.id} 显隐`).toBe(c.id === 'weather' ? wx : dm);
      const shown = m.cards.filter((c) => c.shown);
      expect(shown.length).toBe(vis);
      /* 按行分组：每行左缘 = 容器左缘，最后一张右缘 = 容器右缘（最后一行在全数据 3 张 / 2 列时除外：那是原布局，单独断言不变） */
      const rows = [];
      for (const c of shown) { const r = rows.find((x) => Math.abs(x[0].t - c.t) < 2); if (r) r.push(c); else rows.push([c]); }
      const full = wx && dm;
      expect(m.cols, `列数`).toBe(full ? n : Math.min(n, vis));
      rows.forEach((r, i) => {
        r.sort((a, b) => a.l - b.l);
        expect(Math.abs(r[0].l - m.g.l), `第 ${i + 1} 行左缘`).toBeLessThanOrEqual(1);
        if (full && n === 2 && i === rows.length - 1) return;
        expect(Math.abs(r[r.length - 1].r - m.g.r), `第 ${i + 1} 行右缘 ${r[r.length - 1].r} ≠ 容器 ${m.g.r}`).toBeLessThanOrEqual(1);
        /* 同一行平分：卡宽相等，间距 = gap */
        for (let k = 1; k < r.length; k++) {
          expect(Math.abs(r[k].w - r[0].w), `第 ${i + 1} 行等宽`).toBeLessThanOrEqual(1);
          expect(Math.abs(r[k].l - r[k - 1].r - m.gap), `第 ${i + 1} 行间距`).toBeLessThanOrEqual(1);
        }
      });
      for (const c of shown) expect(c.w).toBeGreaterThanOrEqual(320);
      /* 名片仍整行（边线和容器一致） */
      expect(Math.abs(m.profile.l - m.g.l)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.profile.r - m.g.r)).toBeLessThanOrEqual(1);
      /* 全数据：原布局 —— N 列等分，2 列时日刻在第二行第一列 */
      if (full) {
        const colW = (m.g.w - (n - 1) * m.gap) / n;
        for (const c of shown) expect(Math.abs(c.w - colW), `${c.id} 列宽`).toBeLessThanOrEqual(1);
        expect(rows.length).toBe(n === 3 ? 1 : 2);
      }
    });
  }
}

/* ----- Auto 跟随可用视口：分屏 900×600 → 820×600 实时切 Mobile（nav.js resize 180ms 去抖） ----- */
test('分屏：900×600 是 DeX，拖窄到 820×600 实时切 Mobile，再拉回 900 回到 DeX', async ({ page }) => {
  await go(page, { width: 900, height: 600 }, '/');
  await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.setViewportSize({ width: 820, height: 600 });
  await expect(page.locator('html')).toHaveClass(/\blayout-mobile\b/, { timeout: 3000 });
  /* 换档那一帧外框还在走减弱动效下的 .01ms 过渡（transition-property 默认 all），并发高时偶尔量到中间值：轮询到稳定 */
  await expect.poll(async () => { const f = await frame(page, '.home-wrap'); return Math.abs(f.wrap.w - 640) <= 1 && Math.abs(f.wrap.l - f.bar.l) <= 1; }, { timeout: 3000 }).toBe(true);
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/, { timeout: 3000 });
});

/* ----- 输入方式：粗指针（触屏）下小控件点击区 ≥ 48px，看上去的尺寸不变 ----- */
test.describe('粗指针（触屏）', () => {
  test.use({ hasTouch: true });
  test('顶栏标签看上去仍 40 高、点击区 48', async ({ page }) => {
    await go(page, { width: 1280, height: 800 }, '/chat/');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const t = await page.evaluate(() => {
      const e = document.querySelector('.sgx-tb-tab[aria-current="page"]');
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return { h: b.height, vis: b.height - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth),
        hitTop: document.elementFromPoint(b.left + b.width / 2, b.top + 1)?.closest('.sgx-tb-tab') === e };
    });
    expect(t.h).toBeGreaterThanOrEqual(48);
    expect(Math.abs(t.vis - 40)).toBeLessThanOrEqual(0.5);
    expect(t.hitTop).toBe(true);
  });
  test('聊天输入栏 44px 按钮：点击区 ≥ 48（外沿 2px 处仍点得中），看上去仍 44', async ({ page }) => {
    await go(page, { width: 412, height: 915 }, '/chat/');
    const r = await page.evaluate(() => {
      const e = document.querySelector('#chat-new'); const b = e.getBoundingClientRect();
      return { w: b.width, hit: document.elementFromPoint(b.left + b.width / 2, b.top - 2)?.closest('#chat-new') === e };
    });
    expect(Math.round(r.w)).toBe(44);
    expect(r.hit).toBe(true);
  });
});
