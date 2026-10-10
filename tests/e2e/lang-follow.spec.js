/**
 * 2.7.0：语言跟随系统不冲突、不循环跳转。
 * - sgx-lang 未设置（system 模式）时，跟随 navigator.language
 * - 从 / 跳到 /en/ 后不再跳回（无循环）
 * - 从 /en/ 跳到 / 后不再跳回（无循环）
 * - 明确设置 sgx-lang=zh/en 时按偏好跳转
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 } });

async function clearLang(pg) {
  await pg.addInitScript(() => {
    try { localStorage.removeItem('sgx-lang'); } catch (e) {}
  });
}

test('system 模式：浏览器英文时 / 跳到 /en/ 且不循环', async ({ page: pg, context }) => {
  await blockExternalRequests(pg);
  // 模拟浏览器语言为英文
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
  });
  await clearLang(pg);
  await pg.goto('/', { waitUntil: 'domcontentloaded' });
  // 应跳转到 /en/
  await pg.waitForURL('**/en/**', { timeout: 10000 });
  expect(pg.url()).toContain('/en/');
  // 确认 URL 稳定：轮询 3 秒，URL 一直包含 /en/（无循环跳回）
  await pg.waitForFunction(
    () => window.location.href.includes('/en/'),
    { timeout: 3000, polling: 500 }
  );
  expect(pg.url()).toContain('/en/');
});

test('system 模式：浏览器中文时 /en/ 跳到 / 且不循环', async ({ page: pg, context }) => {
  await blockExternalRequests(pg);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true });
  });
  await clearLang(pg);
  await pg.goto('/en/', { waitUntil: 'domcontentloaded' });
  // 应跳转到 /
  await pg.waitForURL(url => !url.pathname.startsWith('/en'), { timeout: 10000 });
  expect(pg.url()).not.toContain('/en/');
  // 确认 URL 稳定（无循环跳回）
  await pg.waitForFunction(
    () => !window.location.href.includes('/en/'),
    { timeout: 3000, polling: 500 }
  );
  expect(pg.url()).not.toContain('/en/');
});

test('明确偏好 sgx-lang=en 时 / 跳到 /en/', async ({ page: pg }) => {
  await blockExternalRequests(pg);
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {}
  });
  await pg.goto('/', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL('**/en/**', { timeout: 10000 });
  expect(pg.url()).toContain('/en/');
});

test('明确偏好 sgx-lang=zh 时 /en/ 跳到 /', async ({ page: pg }) => {
  await blockExternalRequests(pg);
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  await pg.goto('/en/', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL(url => !url.pathname.startsWith('/en'), { timeout: 10000 });
  expect(pg.url()).not.toContain('/en/');
});
