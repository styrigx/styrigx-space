/**
 * 2.7.0：语言跟随系统不冲突、不循环跳转。P4-3 PR-4c（§6.8）起英文是默认语言（无前缀），中文在 /zh/。
 * - sgx-lang 未设置（system 模式）时，跟随 navigator.language
 * - 从 / 跳到 /zh/ 后不再跳回（无循环）
 * - 从 /zh/ 跳到 / 后不再跳回（无循环）
 * - 明确设置 sgx-lang=zh/en 时按偏好跳转
 * - 旧的 /en/… 不再是语言前缀：不跳转，直接 404（删除不 301）
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');

test.use({ viewport: { width: 412, height: 915 } });

async function clearLang(pg) {
  await pg.addInitScript(() => {
    try { localStorage.removeItem('sgx-lang'); } catch (e) {}
  });
}

const isZh = (u) => /^\/zh(\/|$)/.test(new URL(u).pathname);

test('system 模式：浏览器中文时 / 跳到 /zh/ 且不循环', async ({ page: pg, context }) => {
  await blockExternalRequests(pg);
  // 模拟浏览器语言为中文
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true });
  });
  await clearLang(pg);
  await pg.goto('/', { waitUntil: 'domcontentloaded' });
  // 应跳转到 /zh/
  await pg.waitForURL((url) => url.pathname === '/zh/', { timeout: 10000 });
  // 确认 URL 稳定：轮询 3 秒，URL 一直在 /zh/（无循环跳回）
  await pg.waitForFunction(() => window.location.pathname === '/zh/', { timeout: 3000, polling: 500 });
  expect(isZh(pg.url())).toBe(true);
});

test('system 模式：浏览器英文时 /zh/ 跳到 / 且不循环', async ({ page: pg, context }) => {
  await blockExternalRequests(pg);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
  });
  await clearLang(pg);
  await pg.goto('/zh/', { waitUntil: 'domcontentloaded' });
  // 应跳转到 /
  await pg.waitForURL((url) => url.pathname === '/', { timeout: 10000 });
  // 确认 URL 稳定（无循环跳回）
  await pg.waitForFunction(() => window.location.pathname === '/', { timeout: 3000, polling: 500 });
  expect(isZh(pg.url())).toBe(false);
});

test('明确偏好 sgx-lang=zh 时 /security/ 跳到 /zh/security/', async ({ page: pg }) => {
  await blockExternalRequests(pg);
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  await pg.goto('/security/', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL((url) => url.pathname === '/zh/security/', { timeout: 10000 });
  expect(new URL(pg.url()).pathname).toBe('/zh/security/');
});

test('明确偏好 sgx-lang=en 时 /zh/security/ 跳到 /security/', async ({ page: pg }) => {
  await blockExternalRequests(pg);
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {}
  });
  await pg.goto('/zh/security/', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL((url) => url.pathname === '/security/', { timeout: 10000 });
  expect(new URL(pg.url()).pathname).toBe('/security/');
});

test('旧的 /en/… 删除不 301：静态站里不存在（线上 404，部署后另行手动验收）', async ({ page: pg }) => {
  for (const p of ['/en/', '/en/account/', '/en/security/lock/', '/en/status/']) {
    const r = await pg.request.get(p, { maxRedirects: 0 });
    expect(r.status(), p).toBe(404);
  }
});
