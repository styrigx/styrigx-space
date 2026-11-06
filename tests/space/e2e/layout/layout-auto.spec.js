/**
 * 2026-10-23 布局三档（Mobile · Auto · DeX），只看可用视口（innerWidth × innerHeight），不看 UA：
 * - 自动：w > h 且 w ≥ 840 且 h ≥ 500 → DeX，其余 → Mobile
 * - 手动 DeX：w < 840 或 h < 500 → Mobile（偏好保留）
 * - 设置 › 显示 › 布局：Mobile / Auto / DeX 三个英文标签（中英文页都一样），不够 DeX 时 DeX 置灰 + 提示
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, setHomeCards, expect } = require('../helpers/helpers');

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

/* ----- 顶栏长条：宽屏定宽 400px 居中（P4-3 PR-4a §6.3，原来按内容定宽），手机照旧拉满（2026-11-04 P5-1 胶囊：两侧是 logo 和 快捷面板 · AI · 头像） ----- */
async function bars(page) {
  return page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, w: b.width }; };
    return { bar: r('.sgx-topbar'), logo: r('.sgx-tb-logo'), pill: r('.sgx-tb-pill'), acts: r('.sgx-tb-acts'), tabs: r('.sgx-tb-tabs'), vw: window.innerWidth };
  });
}
for (const [width, height] of [[1280, 800], [1920, 1080], [1024, 700], [768, 1024]]) {
  test(`顶栏长条 ${width}×${height}：中段定宽 400px 居中、标签在中段里居中，logo / 按钮组贴胶囊两端、互不重叠`, async ({ page }) => {
    await go(page, { width, height }, '/');
    await expect(page.locator('.sgx-tb-tabs')).toBeVisible();
    const b = await bars(page);
    expect(Math.abs(b.pill.x + b.pill.w / 2 - b.vw / 2)).toBeLessThanOrEqual(1);
    /* logo 左缘 / 按钮组右缘离胶囊边 = (胶囊高 − 40) / 2（≤ 8） */
    expect(b.logo.x - b.bar.x).toBeLessThanOrEqual(9);
    expect(b.bar.x + b.bar.w - (b.acts.x + b.acts.w)).toBeLessThanOrEqual(9);
    expect(Math.round(b.pill.w)).toBe(400);
    expect(b.pill.x).toBeGreaterThanOrEqual(b.logo.x + b.logo.w);
    expect(b.pill.x + b.pill.w).toBeLessThanOrEqual(b.acts.x);
    expect(Math.abs(b.tabs.x + b.tabs.w / 2 - b.vw / 2)).toBeLessThanOrEqual(1);
  });
}
test('顶栏长条 412×915：手机照旧拉满（logo 和按钮组之间只隔胶囊间距 4px）', async ({ page }) => {
  await go(page, { width: 412, height: 915 }, '/settings/security/');
  const b = await bars(page);
  expect(Math.abs(b.pill.x - (b.logo.x + b.logo.w) - 4)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.acts.x - (b.pill.x + b.pill.w) - 4)).toBeLessThanOrEqual(1);
});

/* ----- 宽竖屏 Mobile：外框最宽 640 居中，左右边线 = 顶栏两侧圆外缘（2026-10-23 PR-D） ----- */
const WRAPS = [['/', '.home-wrap'], ['/settings/', '.set-layout'], ['/settings/display/', '.set-layout'], ['/account/', '.acct-layout'], ['/settings/status/', '.acct-layout'], ['/404.html', '.sgx-404']];
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
    for (const [path, s, want] of [['/settings/display/', '.set-layout > .set-main', 720], ['/settings/status/', '#st-foot', 720]]) {
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

/* ----- 首页栅格（P4-2c 起双时钟、天气删除）：DeX 固定 2 列，名片 + 日刻并排各一列，屏幕时间整行；
   日刻没数据（.hidden）或没输出时名片整行；容器窄到放不下 2 个 320 就退成 1 列 ----- */
for (const [w, h] of [[1920, 950], [1280, 760], [841, 673]]) {
  for (const dm of [true, false]) {
    test(`首页栅格 ${w}×${h}：日刻${dm ? '有' : '无'} → ${dm ? '名片和日刻并排' : '名片整行'}，屏幕时间整行，无空白`, async ({ page }) => {
      await go(page, { width: w, height: h }, '/');
      await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
      await expect(page.locator('#home-widgets')).toBeVisible();
      await setHomeCards(page, { daymark: dm });
      const m = await page.evaluate(() => {
        const g = document.querySelector('#home-widgets');
        const gr = g.getBoundingClientRect();
        const box = (id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, t: r.top }; };
        return { g: { l: gr.left, r: gr.right, w: gr.width }, gap: parseFloat(getComputedStyle(g).columnGap), cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
          profile: box('w-profile'), daymark: box('w-daymark'), screen: box('w-screen') };
      });
      expect(m.cols).toBe(2);
      expect(Math.abs(m.profile.l - m.g.l)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.screen.l - m.g.l)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.screen.r - m.g.r), '屏幕时间整行').toBeLessThanOrEqual(1);
      if (dm) {
        const colW = (m.g.w - m.gap) / 2;
        expect(Math.abs(m.profile.w - colW)).toBeLessThanOrEqual(1);
        expect(Math.abs(m.daymark.w - colW)).toBeLessThanOrEqual(1);
        expect(Math.abs(m.daymark.t - m.profile.t), '同一行').toBeLessThanOrEqual(1);
        expect(Math.abs(m.daymark.r - m.g.r)).toBeLessThanOrEqual(1);
        expect(m.profile.w).toBeGreaterThanOrEqual(320);
      } else {
        expect(Math.abs(m.profile.r - m.g.r), '名片整行').toBeLessThanOrEqual(1);
      }
    });
  }
}

test('栅格退列：容器收窄到 700 / 600 / 330 → 2 / 1 / 1 列，绝不挤到 320 以下', async ({ page }) => {
  await go(page, { width: 1920, height: 950 }, '/');
  await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
  await setHomeCards(page, { daymark: true });
  for (const [px, n] of [[0, 2], [700, 2], [600, 1], [330, 1]]) {
    const c = await page.evaluate((v) => {
      const g = document.querySelector('#home-widgets');
      g.style.transition = 'none';
      g.style.width = v ? v + 'px' : '';
      const t = getComputedStyle(g).gridTemplateColumns.split(' ').map(parseFloat);
      return { n: t.length, min: Math.min(...t), raw: getComputedStyle(g).gridTemplateColumns };
    }, px);
    expect(c.n, `容器 ${px || '原宽'} → ${c.raw}`).toBe(n);
    expect(c.min).toBeGreaterThanOrEqual(320);
  }
});

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
    /* 2026-11-04 P5-1：/chat/ 不再是标签页，改在设置首页量 */
    await go(page, { width: 1280, height: 800 }, '/settings/');
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
});
