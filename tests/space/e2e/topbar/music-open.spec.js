/**
 * 音乐分层方案 v1.13 第二步 2c：顶栏音乐图标点开播放器（topbar/panel.js mountMusic）。
 * - 没开：弹出播放器小窗（窗口名 sgx-music-player），去当前语言的播放器页；
 * - 已开：再点只切过去，不开第二个、不重新加载（歌不断）；
 * - 被拦（window.open 回 null）：本页直接跳到播放器页。
 * 纯逻辑在 tests/space/ui/topbar/music-open.test.mjs。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');

async function go(page, block) {
  await blockExternalRequests(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  if (block) await page.addInitScript(() => { window.open = function () { return null; }; });
  await page.goto('/zh/status/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}

test('没开就弹、已开切过去（单窗口、不重载）', async ({ page, context }) => {
  await go(page);
  await expect(page.locator('.sgx-tb-music')).toHaveAttribute('href', '/curio/zh/music/player/');
  const [pop] = await Promise.all([context.waitForEvent('page'), page.locator('.sgx-tb-music').click()]);
  await pop.waitForURL(/\/curio\/zh\/music\/player\/$/);
  await pop.waitForLoadState('domcontentloaded');
  expect(await pop.evaluate(() => window.name)).toBe('sgx-music-player');
  expect(page.url()).toMatch(/\/zh\/status\/$/);
  await pop.evaluate(() => { window.__still = 1; });
  let extra = 0;
  context.on('page', () => { extra++; });
  await page.locator('.sgx-tb-music').click();
  await page.waitForTimeout(600);
  expect(extra).toBe(0);
  expect(context.pages().length).toBe(2);
  expect(await pop.evaluate(() => window.__still)).toBe(1);
  expect(page.url()).toMatch(/\/zh\/status\/$/);
});

test('弹窗被拦：本页直接跳到播放器页', async ({ page }) => {
  await go(page, true);
  await page.locator('.sgx-tb-music').click();
  await page.waitForURL(/\/curio\/zh\/music\/player\/$/);
});
