/**
 * 布局（P4-3 PR-4b，Gray 2026-11-07 定稿）：只有手机 phone / 桌面 desktop（主站版面类照旧 layout-mobile / layout-dex）。
 * - 手动（快捷面板 手机 / 自动 / 桌面，sgx-layout = phone / auto / desktop；旧值 mobile → phone、dex / pc → desktop）照办，任何视口都一样
 * - 自动：navigator.userAgentData.mobile（没有就看 UA）；算出桌面但视口 < 720 CSS px → 手机。这里是无头桌面 UA（mobile = false）
 * - 外壳框（各页外框）= 手机 min(100% − 2 × 页边距, 640) / 桌面 100% − 2 × 页边距（宽屏平铺 PR 起通栏）；顶栏 v3（2026-11 PR-1）贴顶通栏，内容收进居中的 1080
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
    await expect(page.locator('#home-hero')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('html')).toHaveClass(new RegExp('\\blayout-' + want + '\\b'));
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', want === 'dex' ? 'desktop' : 'phone');
    await expect(page.locator('html')).not.toHaveClass(/\blayout-pc\b/);
  });
}

for (const [pref, vp, want] of [['desktop', { width: 412, height: 915 }, 'dex'], ['dex', { width: 915, height: 412 }, 'dex'], ['pc', { width: 1366, height: 768 }, 'dex'], ['phone', { width: 1366, height: 768 }, 'mobile'], ['mobile', { width: 1920, height: 950 }, 'mobile']]) {
  test(`手动 ${pref} 在 ${vp.width}×${vp.height} → ${want}（手动照办，不看视口；旧值照认）`, async ({ page }) => {
    await go(page, vp, '/', pref);
    await expect(page.locator('#home-hero')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('html')).toHaveClass(new RegExp('\\blayout-' + want + '\\b'));
  });
}

/* ----- 顶栏 v3（2026-11 UI 重设计 PR-1）：贴顶通栏（x 0、宽 = 视口宽，任何布局一样），内容收进居中的 --sgx-content-w（1080）：
   左右内边距 pad = max(页边距, (宽 − 1080) / 2)；字标左缘 = pad − 4（内缩），图标组右缘 = 宽 − pad；不显示页名 ----- */
const pageM = (w) => (w < 600 ? 12 /* 对齐 PR-B：手机页边距 12 */ : Math.min(48, Math.max(16, 5.333 + 0.022222 * w)));
const tbPad = (w) => Math.max(pageM(w), (w - 1080) / 2);
for (const [width, height] of [[1280, 800], [1920, 1080], [1024, 700], [768, 1024]]) {
  test(`顶栏 ${width}×${height}（桌面布局）：贴顶通栏，内容收进居中的 1080；字标 / 图标组贴内容两端、互不重叠；不显示页名`, async ({ page }) => {
    await go(page, { width, height }, '/');
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'desktop');
    const b = await page.evaluate(() => {
      const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, w: b.width }; };
      return { bar: r('.sgx-topbar'), logo: r('.sgx-tb-logo'), acts: r('.sgx-tb-acts'), vw: window.innerWidth };
    });
    const pad = tbPad(width);
    expect(Math.abs(b.bar.x) + Math.abs(b.bar.w - b.vw), `顶栏 x ${b.bar.x} 宽 ${b.bar.w}`).toBeLessThanOrEqual(1);
    expect(Math.abs(b.logo.x - (pad - 4)), `字标左 ${b.logo.x}，应为 ${pad - 4}`).toBeLessThanOrEqual(1);
    expect(Math.abs(b.acts.x + b.acts.w - (width - pad)), `图标组右缘 ${b.acts.x + b.acts.w}，应为 ${width - pad}`).toBeLessThanOrEqual(1);
    expect(b.logo.x + b.logo.w).toBeLessThanOrEqual(b.acts.x);
    await expect(page.locator('#site-nav .sgx-tb-pill')).toBeHidden();
  });
}
test('顶栏 412×915（手机布局）：通栏，不显示页名，字标和图标组贴页边距 12（对齐 PR-B）', async ({ page }) => {
  await go(page, { width: 412, height: 915 }, '/wild/'); /* 进站 v3 L1：/security/ 已删 */
  await expect(page.locator('#site-nav .sgx-tb-pill')).toBeHidden();
  const b = await page.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return { bar: r('.sgx-topbar'), logo: r('.sgx-tb-logo'), acts: r('.sgx-tb-acts') }; });
  expect(Math.abs(b.bar.width - 412)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.logo.left - 8)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.acts.right - 400)).toBeLessThanOrEqual(1);
});

/* ----- 手机布局：外框最宽 640 居中（顶栏 v3 是通栏，不再和外框同宽） ----- */
/* 首页（/）2026-11 PR-2 起内容栏对齐顶栏内容（1080），不跟外壳框，单独测（见下「首页内容栏」） */
/* 对齐 PR-B：原 /status/ 并进旷野 /wild/，旷野页内容栏同主页（对齐顶栏内容 1080，见「首页 / 旷野内容栏」） */
const WRAPS = [['/404.html', '.sgx-404']]; /* 进站 v3 L1：/security/、/security/tempkeys/ 已删（盾牌命令行取代） */
async function frame(page, sel) {
  return page.evaluate((s) => {
    const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width }; };
    return { wrap: r(document.querySelector(s)), bar: r(document.querySelector('.sgx-topbar')), vw: innerWidth };
  }, sel);
}
for (const [path, sel] of WRAPS) {
  test(`宽竖屏 834×1194 手动手机：${path} 外框 640 居中；顶栏通栏`, async ({ page }) => {
    await go(page, { width: 834, height: 1194 }, path, 'phone');
    await expect(page.locator('html')).toHaveClass(/\blayout-mobile\b/);
    const f = await frame(page, sel);
    expect(Math.abs(f.wrap.w - 640)).toBeLessThanOrEqual(1);
    expect(Math.abs(f.wrap.l + f.wrap.w / 2 - f.vw / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(f.bar.l) + Math.abs(f.bar.w - f.vw), `顶栏 ${f.bar.l} / ${f.bar.w}`).toBeLessThanOrEqual(1);
  });
}

/* ----- 桌面布局：外框 = min(1080, 100% − 2 × 页边距) 居中（2026-11 PR-A 照设计稿：所有页内容 1080 居中，撤掉 #308 宽屏通栏）；顶栏 v3 通栏；内部列在框里居中 ----- */
for (const [w, h] of [[1024, 700], [1366, 650], [1920, 950]]) {
  for (const [path, sel] of WRAPS) {
    test(`桌面 ${w}×${h}：${path} 外框 = min(1080, 100% − 2m) 居中；顶栏通栏`, async ({ page }) => {
      await go(page, { width: w, height: h }, path);
      await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
      const f = await frame(page, sel);
      const m = Math.min(48, Math.max(16, 5.333 + 0.022222 * w));
      expect(Math.abs(f.bar.l) + Math.abs(f.bar.w - f.vw), `顶栏 ${f.bar.l} / ${f.bar.w}`).toBeLessThanOrEqual(1);
      expect(Math.abs(f.wrap.w - Math.min(1080, w - 2 * m)), `${sel} 外框宽 ${f.wrap.w}`).toBeLessThanOrEqual(1);
      expect(Math.abs(f.wrap.l + f.wrap.w / 2 - f.vw / 2), `${sel} 居中`).toBeLessThanOrEqual(1);
    });
  }
  test(`桌面 ${w}×${h}：内部列 —— 风格页 720 居中、旷野页 = 外框宽（≤ 1080；P4-3 PR-4b 起设置首页的两栏删除）`, async ({ page }) => {
    const col = async (path, s) => {
      await go(page, { width: w, height: h }, path);
      await expect(page.locator(s).first()).toBeAttached();
      await page.waitForLoadState('load');
      return page.evaluate((q) => { const vw = innerWidth; return [...document.querySelectorAll(q)].filter((e) => e.offsetParent !== null).map((e) => { const b = e.getBoundingClientRect(); return { l: b.left, w: b.width, c: b.left + b.width / 2 - vw / 2 }; }); }, s);
    };
    await go(page, { width: w, height: h }, '/');
    await expect(page.locator('.set-dex-cols, .set-col-l')).toHaveCount(0);
    const m = Math.min(48, Math.max(16, 5.333 + 0.022222 * w));
    const shell = Math.min(1080, w - 2 * m);
    /* 风格页（交互模块，设计不动）仍 720；旷野页（原服务状态并进来）内容列 = 外框（最宽 1080） */
    for (const [path, s, want] of [['/wild/', '.wild-wrap', shell]] /* 对齐 PR-C：风格页 /theme/（720 栏）退役 */) {
      const [c] = await col(path, s);
      expect(Math.abs(c.w - Math.min(want, shell)), `${path} ${s} 宽 ${c.w}`).toBeLessThanOrEqual(1);
      expect(Math.abs(c.c), `${path} 居中`).toBeLessThanOrEqual(1);
    }
  });
}

/* ----- 首页 / 旷野内容栏（2026-11 PR-2 首屏终端；对齐 PR-B 旷野页同规则）：任何布局 = 顶栏内容栏 min(1080, 100% − 2 × 页边距) 居中，左缘 = 字标左缘 + 4、右缘 = 图标组右缘 ----- */
for (const [path, wrapSel, ready] of [['/', '.home-wrap', '#home-hero'], ['/wild/', '.wild-wrap', '#st-root']]) for (const [w, h, pref] of [[834, 1194, 'phone'], [412, 915, ''], [1024, 700, ''], [1366, 650, ''], [1920, 950, '']]) {
  test(`${path === '/' ? '首页' : '旷野'}内容栏 ${w}×${h}${pref ? ' 手动手机' : ''}：对齐顶栏内容（1080）`, async ({ page }) => {
    await go(page, { width: w, height: h }, path, pref || undefined);
    await expect(page.locator(ready)).toBeVisible({ timeout: 15000 });
    const f = await page.evaluate((ws) => {
      const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width }; };
      return { wrap: r(ws), logo: r('#site-nav .sgx-tb-logo'), acts: r('#site-nav .sgx-tb-acts'), vw: innerWidth, sw: document.scrollingElement.scrollWidth };
    }, wrapSel);
    const want = Math.min(1080, w - 2 * pageM(w));
    expect(Math.abs(f.wrap.w - want), `外框宽 ${f.wrap.w} ≠ ${want}`).toBeLessThanOrEqual(1);
    expect(Math.abs(f.wrap.l - (f.logo.l + 4))).toBeLessThanOrEqual(1);
    expect(Math.abs(f.wrap.r - f.acts.r)).toBeLessThanOrEqual(1);
    expect(f.sw).toBeLessThanOrEqual(f.vw);
  });
}

/* ----- 临界：719 / 720 / 721 宽（自动，桌面 UA；高度不再参与） ----- */
for (const w of [719, 720, 721]) {
  for (const h of [499, 800]) {
    test(`临界 ${w}×${h}：模式正确、无横向滚动、卡片 ≥ 320`, async ({ page }) => {
      await go(page, { width: w, height: h }, '/');
      const want = w >= 720 ? 'dex' : 'mobile';
      await expect(page.locator('html')).toHaveClass(new RegExp('\\blayout-' + want + '\\b'));
      await expect(page.locator('#home-hero')).toBeVisible();
      /* 2026-11 PR-2：首页各块（hero、终端、分节）都铺满内容栏，不会窄到 320 以下；
         对齐 PR-B：[02] 目录卡 / [04] 旷野两张小卡（2026-11-11 删 about）桌面两栏、手机一栏，每张 ≥ 200（720 宽桌面三栏约 218） */
      const m = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth,
        cards: [...document.querySelectorAll('#home-hero, #about, .home-sec')].filter((e) => e.offsetParent !== null).map((e) => [e.id, e.getBoundingClientRect().width]),
        minis: [...document.querySelectorAll('.home-dirs > li, .home-wild > li')].map((e) => e.getBoundingClientRect().width) }));
      expect(m.sw).toBeLessThanOrEqual(m.iw);
      expect(m.cards.length).toBeGreaterThan(0);
      for (const [id, cw] of m.cards) expect(cw, `${id} 宽 ${cw}`).toBeGreaterThanOrEqual(320);
      expect(m.minis.length).toBe(5); /* 奇趣 3 + 旷野 2 */
      for (const cw of m.minis) expect(cw, `小卡宽 ${cw}`).toBeGreaterThanOrEqual(200);
    });
  }
}

/* ----- 首页（2026-11 PR-2 首屏终端；原「首页栅格」「栅格退列」用例随小组件网格删除）：日刻有 / 没数据都不留空白——
   有数据引言铺满 [03] 日刻分节；没数据（.hidden）分节只剩标题和命令行，下一节紧接着；[04] 旷野两张小卡铺满分节（对齐 PR-B；about 小卡 2026-11-11 删） ----- */
for (const [w, h] of [[1920, 950], [1280, 760], [841, 673]]) {
  for (const dm of [true, false]) {
    test(`首页分节 ${w}×${h}：日刻${dm ? '有' : '无'}数据，卡片铺满分节、没有空白；旷野两卡铺满`, async ({ page }) => {
      await go(page, { width: w, height: h }, '/');
      await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
      await expect(page.locator('#home-hero')).toBeVisible();
      await setHomeCards(page, { daymark: dm });
      const m = await page.evaluate(() => {
        const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, t: r.top, b: r.bottom }; };
        const sec = document.getElementById('daymark');
        const head = sec.querySelector('.home-sec-cmd');
        return { sec: box(sec), head: box(head), dm: box(document.getElementById('w-daymark')), dmShown: !document.getElementById('w-daymark').classList.contains('hidden'),
          st: box(document.querySelector('#wild .home-wild')), first: box(document.querySelector('#wild .home-wild > li:first-child')) };
      });
      /* v6 P4：屏幕时间小卡随数字健康删除（定稿 v5.5 §四），status 小卡前移到第一栏 */
      expect(Math.abs(m.first.l - m.st.l), '旷野第一张小卡在第一栏').toBeLessThanOrEqual(1);
      if (dm) {
        expect(m.dmShown).toBe(true);
        expect(Math.abs(m.dm.l - m.sec.l)).toBeLessThanOrEqual(1);
        expect(Math.abs(m.dm.r - m.sec.r), '日刻卡铺满').toBeLessThanOrEqual(1);
        expect(m.dm.w).toBeGreaterThanOrEqual(320);
      } else {
        expect(m.sec.b - m.head.b, '没数据时分节不留空白').toBeLessThanOrEqual(24);
      }
    });
  }
}

test('首页收窄：容器 700 / 600 / 330 → 各块跟着收、终端不超出、不出横向滚动', async ({ page }) => {
  await go(page, { width: 1920, height: 950 }, '/');
  await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
  await setHomeCards(page, { daymark: true });
  for (const px of [700, 600, 330]) {
    const c = await page.evaluate((v) => {
      const g = document.querySelector('.home-wrap');
      g.style.width = v + 'px';
      const gr = g.getBoundingClientRect();
      const over = [...g.querySelectorAll('#about, .home-sec, #w-daymark, .home-dir')].filter((e) => e.offsetParent !== null)
        .filter((e) => { const r = e.getBoundingClientRect(); return r.left < gr.left - 1 || r.right > gr.right + 1; }).map((e) => e.id);
      return { over, sw: document.scrollingElement.scrollWidth, iw: innerWidth };
    }, px);
    expect(c.over, `容器 ${px}`).toEqual([]);
    expect(c.sw).toBeLessThanOrEqual(c.iw);
  }
});

/* ----- 自动跟随视口（matchMedia 听 720 线，不刷新）：分屏 900×600 → 700×600 切手机，再拉回 900 回到桌面 ----- */
test('分屏：900×600 是桌面，拖窄到 700×600 实时切手机，再拉回 900 回到桌面', async ({ page }) => {
  await go(page, { width: 900, height: 600 }, '/');
  await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.setViewportSize({ width: 700, height: 600 });
  await expect(page.locator('html')).toHaveClass(/\blayout-mobile\b/, { timeout: 3000 });
  /* 首页内容栏对齐顶栏内容（2026-11 PR-2）：700 宽手机 = 700 − 2 × 页边距，居中 */
  await expect.poll(async () => { const f = await frame(page, '.home-wrap'); return Math.abs(f.wrap.w - (700 - 2 * pageM(700))) <= 1 && Math.abs(f.wrap.l + f.wrap.w / 2 - f.vw / 2) <= 1; }, { timeout: 3000 }).toBe(true);
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/, { timeout: 3000 });
});

/* 粗指针下顶栏标签点击区的用例删除：PR-4b 定稿后顶栏没有标签（页名胶囊只显示页名、不可点）；三颗圆按钮本身 40 × 40 */
