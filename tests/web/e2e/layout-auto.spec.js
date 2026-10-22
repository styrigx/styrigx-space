/**
 * 2026-10-23 布局三档（Mobile · Auto · DeX），只看可用视口（innerWidth × innerHeight），不看 UA：
 * - 自动：w > h 且 w ≥ 840 且 h ≥ 500 → DeX，其余 → Mobile
 * - 手动 DeX：w < 840 或 h < 500 → Mobile（偏好保留）
 * - 设置 › 显示 › 布局：Mobile / Auto / DeX 三个英文标签（中英文页都一样），不够 DeX 时 DeX 置灰 + 提示
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

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

/* ----- 宽竖屏 Mobile：内容栏最宽 640（42rem − px-4×2）居中 ----- */
for (const [path, sel] of [['/', '.home-wrap'], ['/settings/', '.set-layout'], ['/status/', '.st-wrap'], ['/chat/', '.chat-wrap'], ['/account/', '.acct-layout']]) {
  test(`宽竖屏 834×1194 Mobile：${path} 内容栏 ≤ 672 且居中`, async ({ page }) => {
    await go(page, { width: 834, height: 1194 }, path);
    await expect(page.locator('html')).toHaveClass(/\blayout-mobile\b/);
    const r = await page.evaluate((s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { x: b.x, w: b.width, vw: window.innerWidth }; }, sel);
    expect(r.w).toBeLessThanOrEqual(672.5);
    expect(Math.abs(r.x + r.w / 2 - r.vw / 2)).toBeLessThanOrEqual(1);
  });
}
