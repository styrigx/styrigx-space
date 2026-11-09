/**
 * 2.7.0：语言跟随系统不冲突、不循环跳转。P4-3 PR-4c（§6.8）起英文是默认语言（无前缀），中文在 /zh/。
 * - sgx-lang 未设置（system 模式）时，跟随 navigator.language
 * - 从 / 跳到 /zh/ 后不再跳回（无循环）
 * - 从 /zh/ 跳到 / 后不再跳回（无循环）
 * - 明确设置 sgx-lang=zh/en 时按偏好跳转（每一页）
 * - 2026-11-09 Auto：跟随系统只在从站外进主站首页时跳；深链 / 分享地址不跳；navigator.languages 里有 zh* 就是中文；
 *   NAVIGATE 语言行 EN | Auto | 中文，没存过选择 = Auto 亮；在深链上选 Auto 只保存不跳
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

test('明确偏好 sgx-lang=zh 时 /wild/ 跳到 /zh/wild/（进站 v3 L1：/security/ 已删）', async ({ page: pg }) => {
  await blockExternalRequests(pg);
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  await pg.goto('/wild/', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL((url) => url.pathname === '/zh/wild/', { timeout: 10000 });
  expect(new URL(pg.url()).pathname).toBe('/zh/wild/');
});

test('明确偏好 sgx-lang=en 时 /zh/wild/ 跳到 /wild/', async ({ page: pg }) => {
  await blockExternalRequests(pg);
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {}
  });
  await pg.goto('/zh/wild/', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL((url) => url.pathname === '/wild/', { timeout: 10000 });
  expect(new URL(pg.url()).pathname).toBe('/wild/');
});

test('旧的 /en/… 删除不 301：静态站里不存在（线上 404，部署后另行手动验收）', async ({ page: pg }) => {
  for (const p of ['/en/', '/en/account/', '/en/security/lock/', '/en/status/']) {
    const r = await pg.request.get(p, { maxRedirects: 0 });
    expect(r.status(), p).toBe(404);
  }
});

test('Auto（system）：深链不跳——浏览器英文打开 /zh/wild/、浏览器中文打开 /wild/ 都停在原地', async ({ browser }) => {
  for (const [locale, path] of [['en-US', '/zh/wild/'], ['zh-CN', '/wild/']]) {
    const ctx = await browser.newContext({ locale, viewport: { width: 412, height: 915 } });
    const pg = await ctx.newPage();
    await blockExternalRequests(pg);
    await clearLang(pg);
    await pg.goto(path, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(1500);
    expect(new URL(pg.url()).pathname, locale + ' ' + path).toBe(path);
    await ctx.close();
  }
});

test('Auto（system）：navigator.languages 里有 zh*（不在第一位）也算中文，进 / 跳 /zh/ 且不循环', async ({ page: pg, context }) => {
  await blockExternalRequests(pg);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    Object.defineProperty(navigator, 'languages', { value: ['en-US', 'zh-CN'], configurable: true });
  });
  await clearLang(pg);
  await pg.goto('/', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL((url) => url.pathname === '/zh/', { timeout: 10000 });
  await pg.waitForFunction(() => window.location.pathname === '/zh/', { timeout: 3000, polling: 500 });
});

test('NAVIGATE 语言行：EN | Auto | 中文；深链上选 Auto 写 sgx-lang=system、不跳页，重新载入也不跳', async ({ page: pg }) => {
  await blockExternalRequests(pg);
  await pg.addInitScript(() => {
    try { if (!sessionStorage.getItem('lf-seeded')) { localStorage.setItem('sgx-lang', 'zh'); sessionStorage.setItem('lf-seeded', '1'); } } catch (e) {}
  });
  await pg.goto('/zh/wild/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await pg.locator('.sgx-tb-grid').click();
  await expect(pg.locator('#sgx-nav')).toHaveAttribute('data-state', 'open');
  const seg = pg.locator('#sgx-nav [data-qp-langs]');
  await expect(seg.locator('[role="radio"]')).toHaveText(['EN', 'Auto', '中文']);
  await expect(seg.locator('[aria-checked="true"]')).toHaveAttribute('data-qp-lang', 'zh');
  await seg.locator('[data-qp-lang="system"]').click();
  await expect(seg.locator('[aria-checked="true"]')).toHaveAttribute('data-qp-lang', 'system');
  expect(await pg.evaluate(() => localStorage.getItem('sgx-lang'))).toBe('system');
  await pg.waitForTimeout(800);
  expect(new URL(pg.url()).pathname).toBe('/zh/wild/');
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(1000);
  expect(new URL(pg.url()).pathname).toBe('/zh/wild/');
});

test('NAVIGATE 语言行：没存过选择的访客打开面板 = Auto 亮', async ({ page: pg }) => {
  await blockExternalRequests(pg);
  await clearLang(pg);
  await pg.goto('/wild/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await pg.locator('.sgx-tb-grid').click();
  await expect(pg.locator('#sgx-nav')).toHaveAttribute('data-state', 'open');
  await expect(pg.locator('#sgx-nav [data-qp-langs] [aria-checked="true"]')).toHaveAttribute('data-qp-lang', 'system');
});

/* Muse 冒烟 2026-11-09：存了明确的 en 时点页脚 zh 没反应（新页首帧又被存着的 en 弹回）。
   站内明确的换语言链接（页脚 en · zh，data-sgx-lang-set）点下去先把那种语言存成明确偏好，再跳；站外直接打开才按存着的偏好跳 */
async function seedLangOnce(pg, v) {
  await pg.addInitScript((val) => {
    try { if (!sessionStorage.getItem('lf-seeded')) { localStorage.setItem('sgx-lang', val); sessionStorage.setItem('lf-seeded', '1'); } } catch (e) {}
  }, v);
}

/* 页脚语言在手机布局上收起，按 Muse 冒烟的桌面视口测 */
test.describe('页脚语言链接（桌面）', () => {
  test.use({ viewport: { width: 1366, height: 900 } });

  test('页脚语言链接：存了 en，在 /wild/ 点页脚 zh → 到 /zh/wild/ 停住，sgx-lang 改存 zh，重新载入也不弹回', async ({ page: pg }) => {
    await blockExternalRequests(pg);
    await seedLangOnce(pg, 'en');
    await pg.goto('/wild/', { waitUntil: 'domcontentloaded' });
    const zh = pg.locator('.sgx-foot-lang a[hreflang="zh"]');
    await expect(zh).toHaveAttribute('data-sgx-lang-set', '');
    await zh.click();
    await pg.waitForURL((u) => u.pathname === '/zh/wild/', { timeout: 10000 });
    await pg.waitForTimeout(1000);
    expect(new URL(pg.url()).pathname).toBe('/zh/wild/');
    expect(await pg.evaluate(() => localStorage.getItem('sgx-lang'))).toBe('zh');
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(800);
    expect(new URL(pg.url()).pathname).toBe('/zh/wild/');
  });

  test('页脚语言链接：存了 zh，在 /zh/wild/ 点页脚 en → 到 /wild/ 停住，sgx-lang 改存 en', async ({ page: pg }) => {
    await blockExternalRequests(pg);
    await seedLangOnce(pg, 'zh');
    await pg.goto('/zh/wild/', { waitUntil: 'domcontentloaded' });
    await pg.locator('.sgx-foot-lang a[hreflang="en"]').click();
    await pg.waitForURL((u) => u.pathname === '/wild/', { timeout: 10000 });
    await pg.waitForTimeout(1000);
    expect(new URL(pg.url()).pathname).toBe('/wild/');
    expect(await pg.evaluate(() => localStorage.getItem('sgx-lang'))).toBe('en');
  });
});

test('明确存了 en：站外直接打开 /zh/ → 回 /（明确偏好每一页都跳；只有站内点语言链接才换）', async ({ page: pg }) => {
  await blockExternalRequests(pg);
  await seedLangOnce(pg, 'en');
  await pg.goto('/zh/', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
  expect(await pg.evaluate(() => localStorage.getItem('sgx-lang'))).toBe('en');
});
