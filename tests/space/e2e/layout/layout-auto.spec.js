/**
 * 布局（P4-3 PR-4b，Gray 2026-11-07 定稿）：只有手机 phone / 桌面 desktop（主站版面类照旧 layout-mobile / layout-dex）。
 * - 手动（快捷面板 手机 / 自动 / 桌面，sgx-layout = phone / auto / desktop；旧值 mobile → phone、dex / pc → desktop）照办，任何视口都一样
 * - 自动：navigator.userAgentData.mobile（没有就看 UA）；算出桌面但视口 < 720 CSS px → 手机。这里是无头桌面 UA（mobile = false）
 * - 外壳框（各页外框）= min(100% − 2 × 页边距, 手机 640 / 桌面 1440)；顶栏不再定内容栏（手机顶栏 min(100% − 32, 640)，桌面 min(960, 100% − 48)）
 * 手机 UA 的用例见 tests/space/e2e/topbar/topbar-length.spec.js。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, setHomeCards, expect } = require('../helpers/helpers');

async function go(page, vp, url, pref) {
  await page.setViewportSize(vp);
  /* 固定语言，免得跟随浏览器语言跳到另一种（P4-3 PR-4c：英文无前缀、中文 /zh/；地址不带 /zh/ 的按中文钉住，首帧 replace 到 /zh/） */
  await page.addInitScript((ln) => { try { localStorage.setItem('sgx-lang', ln); } catch (e) {} }, 'zh');
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  if (pref) await page.addInitScript((l) => { try { localStorage.setItem('sgx-layout', l); } catch (e) {} }, pref);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

const AUTO = [
  [915, 412, 'dex'],
  [932, 430, 'dex'],
  [841, 673, 'dex'],
  [1133, 744, 'dex'],
  [1366, 650, 'dex'],
  [412, 915, 'mobile'],
  [700, 900, 'mobile'],
  [1024, 1366, 'dex'],
  [1920, 950, 'dex'],
];

for (const [width, height, want] of AUTO) {
  test(`自动（桌面 UA）${width}×${height} → ${want}`, async ({ page }) => {
    await go(page, { width, height }, '/');
    await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('html')).toHaveClass(new RegExp('\\blayout-' + want + '\\b'));
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', want === 'dex' ? 'desktop' : 'phone');
    await expect(page.locator('html')).not.toHaveClass(/\blayout-pc\b/);
  });
}

for (const [pref, vp, want] of [['desktop', { width: 412, height: 915 }, 'dex'], ['dex', { width: 915, height: 412 }, 'dex'], ['pc', { width: 1366, height: 768 }, 'dex'], ['phone', { width: 1366, height: 768 }, 'mobile'], ['mobile', { width: 1920, height: 950 }, 'mobile']]) {
  test(`手动 ${pref} 在 ${vp.width}×${vp.height} → ${want}（手动照办，不看视口；旧值照认）`, async ({ page }) => {
    await go(page, vp, '/', pref);
    await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('html')).toHaveClass(new RegExp('\\blayout-' + want + '\\b'));
  });
}

/* ----- 顶栏：宽只看视口宽 + 布局；桌面布局页名胶囊按整条顶栏居中 ----- */
for (const [width, height] of [[1280, 800], [1920, 1080], [1024, 700], [768, 1024]]) {
  test(`顶栏 ${width}×${height}（桌面布局）：宽 min(960, 100% − 48) 居中，页名胶囊按整条顶栏居中，字标 / 图标组贴两端、互不重叠`, async ({ page }) => {
    await go(page, { width, height }, '/');
    const b = await page.evaluate(() => {
      const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, w: b.width }; };
      return { bar: r('.sgx-topbar'), logo: r('.sgx-tb-logo'), title: r('.sgx-tb-title'), acts: r('.sgx-tb-acts'), vw: window.innerWidth };
    });
    expect(Math.abs(b.bar.w - Math.min(960, width - 48))).toBeLessThanOrEqual(1);
    expect(Math.abs(b.bar.x + b.bar.w / 2 - b.vw / 2)).toBeLessThanOrEqual(1);
    expect(b.logo.x - b.bar.x).toBeLessThanOrEqual(9);
    expect(b.bar.x + b.bar.w - (b.acts.x + b.acts.w)).toBeLessThanOrEqual(9);
    expect(Math.abs(b.title.x + b.title.w / 2 - (b.bar.x + b.bar.w / 2))).toBeLessThanOrEqual(2);
    expect(b.title.x).toBeGreaterThanOrEqual(b.logo.x + b.logo.w + 12 - 0.5);
    expect(b.title.x + b.title.w).toBeLessThanOrEqual(b.acts.x - 12 + 0.5);
  });
}
test('顶栏 412×915（手机布局）：没有页名胶囊，字标和图标组贴两端', async ({ page }) => {
  await go(page, { width: 412, height: 915 }, '/security/');
  await expect(page.locator('.sgx-tb-title')).toBeHidden();
  const b = await page.evaluate(() => ({ bar: document.querySelector('.sgx-topbar').getBoundingClientRect().width }));
  expect(Math.abs(b.bar - 380)).toBeLessThanOrEqual(1);
});

/* ----- 手机布局：外框最宽 640 居中，左右边线 = 顶栏两端（手机顶栏和外框同宽） ----- */
const WRAPS = [['/', '.home-wrap'], ['/theme/', '.set-layout'], ['/account/', '.acct-layout'], ['/status/', '.acct-layout'], ['/404.html', '.sgx-404']];
async function frame(page, sel) {
  return page.evaluate((s) => {
    const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width }; };
    return { wrap: r(document.querySelector(s)), bar: r(document.querySelector('.sgx-topbar')), vw: innerWidth };
  }, sel);
}
for (const [path, sel] of WRAPS) {
  test(`宽竖屏 834×1194 手动手机：${path} 外框 640 居中，边线 = 顶栏（手机顶栏 min(100% − 32, 640)）`, async ({ page }) => {
    await go(page, { width: 834, height: 1194 }, path, 'phone');
    await expect(page.locator('html')).toHaveClass(/\blayout-mobile\b/);
    const f = await frame(page, sel);
    expect(Math.abs(f.wrap.w - 640)).toBeLessThanOrEqual(1);
    expect(Math.abs(f.wrap.l + f.wrap.w / 2 - f.vw / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(f.wrap.l - f.bar.l) + Math.abs(f.wrap.r - f.bar.r)).toBeLessThanOrEqual(1);
  });
}

/* ----- 桌面布局：外框 = min(100% − 2 × 页边距, 1440) 居中（顶栏不再定内容栏，桌面顶栏最宽 960），内部列在框里居中 ----- */
for (const [w, h] of [[1024, 700], [1366, 650], [1920, 950]]) {
  for (const [path, sel] of WRAPS) {
    test(`桌面 ${w}×${h}：${path} 外框 = min(100% − 2m, 1440) 居中；顶栏 = min(960, 100% − 48) 居中`, async ({ page }) => {
      await go(page, { width: w, height: h }, path);
      await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
      const f = await frame(page, sel);
      const m = Math.min(48, Math.max(16, 5.333 + 0.022222 * w));
      expect(Math.abs(f.bar.w - Math.min(960, w - 48)), `顶栏宽 ${f.bar.w}`).toBeLessThanOrEqual(1);
      expect(Math.abs(f.wrap.w - Math.min(w - 2 * m, 1440)), `${sel} 外框宽 ${f.wrap.w}`).toBeLessThanOrEqual(1);
      expect(Math.abs(f.wrap.l + f.wrap.w / 2 - f.vw / 2), `${sel} 居中`).toBeLessThanOrEqual(1);
    });
  }
  test(`桌面 ${w}×${h}：内部列 —— 旷野子页 / 服务状态 720 居中（P4-3 PR-4b 起设置首页的两栏删除）`, async ({ page }) => {
    const col = async (path, s) => {
      await go(page, { width: w, height: h }, path);
      await expect(page.locator(s).first()).toBeAttached();
      await page.waitForLoadState('load');
      return page.evaluate((q) => { const vw = innerWidth; return [...document.querySelectorAll(q)].filter((e) => e.offsetParent !== null).map((e) => { const b = e.getBoundingClientRect(); return { l: b.left, w: b.width, c: b.left + b.width / 2 - vw / 2 }; }); }, s);
    };
    await go(page, { width: w, height: h }, '/');
    await expect(page.locator('.set-dex-cols, .set-col-l')).toHaveCount(0);
    const m = Math.min(48, Math.max(16, 5.333 + 0.022222 * w));
    const shell = Math.min(w - 2 * m, 1440);
    for (const [path, s, want] of [['/theme/', '.set-layout > .set-main', 720], ['/status/', '#st-foot', 720]]) {
      const [c] = await col(path, s);
      expect(Math.abs(c.w - Math.min(want, shell)), `${path} ${s} 宽 ${c.w}`).toBeLessThanOrEqual(1);
      expect(Math.abs(c.c), `${path} 居中`).toBeLessThanOrEqual(1);
    }
  });
}

/* ----- 临界：719 / 720 / 721 宽（自动，桌面 UA；高度不再参与） ----- */
for (const w of [719, 720, 721]) {
  for (const h of [499, 800]) {
    test(`临界 ${w}×${h}：模式正确、无横向滚动、卡片 ≥ 320`, async ({ page }) => {
      await go(page, { width: w, height: h }, '/');
      const want = w >= 720 ? 'dex' : 'mobile';
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

/* ----- 自动跟随视口（matchMedia 听 720 线，不刷新）：分屏 900×600 → 700×600 切手机，再拉回 900 回到桌面 ----- */
test('分屏：900×600 是桌面，拖窄到 700×600 实时切手机，再拉回 900 回到桌面', async ({ page }) => {
  await go(page, { width: 900, height: 600 }, '/');
  await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.setViewportSize({ width: 700, height: 600 });
  await expect(page.locator('html')).toHaveClass(/\blayout-mobile\b/, { timeout: 3000 });
  await expect.poll(async () => { const f = await frame(page, '.home-wrap'); return Math.abs(f.wrap.w - 640) <= 1 && Math.abs(f.wrap.l - f.bar.l) <= 1; }, { timeout: 3000 }).toBe(true);
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/, { timeout: 3000 });
});

/* 粗指针下顶栏标签点击区的用例删除：PR-4b 定稿后顶栏没有标签（页名胶囊只显示页名、不可点）；三颗圆按钮本身 40 × 40 */
