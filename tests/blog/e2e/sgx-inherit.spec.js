// B2-7：博客继承主站外观（sgx-ui cookie）。不截图，只断言属性和计算色。
import { test, expect } from '@playwright/test';

/* 语言清理（2026-11-07）起博客也「跟随系统」每页都跳（四站同一份首帧跳转 lang-boot.js），Playwright 默认 en-US 会把 /blog/zh/… 换到英文页。
   本文件都是中文用例，按中文浏览器跑（同奇趣 / 日刻）。 */
test.use({ locale: 'zh-CN' });

const enc = (o) =>
  Buffer.from(JSON.stringify(o))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function setUi(context, baseURL, ui) {
  const u = new URL(baseURL);
  await context.addCookies([{ name: 'sgx-ui', value: enc(ui), domain: u.hostname, path: '/' }]);
}

test.beforeEach(async ({ page }) => {
  // 不让测试真的上报到线上主站
  await page.route('https://styrigx.com/api/wellbeing', (r) => r.fulfill({ status: 204 }));
});

test('首帧应用调色板/深色/字号，换页后保持', async ({ page, context, baseURL }) => {
  await setUi(context, baseURL, {
    v: 2,
    mode: 'dark',
    pal: 'matcha',
    fs: 'large',
    rm: 1,
    mat: Date.now(),
  });
  await page.goto('/blog/zh/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-palette', 'matcha');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(html).toHaveClass(/reduced-motion/);
  const fs = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  expect(fs).toBe('18px');
  const primary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--sgx-primary').trim(),
  );
  expect(primary).not.toBe('');

  await page.locator('a[href*="/post/"]').first().click();
  await page.waitForURL(/\/post\//);
  await expect(html).toHaveAttribute('data-palette', 'matcha');
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('没有 cookie 时保持原行为', async ({ page }) => {
  await page.goto('/blog/zh/');
  await expect(page.locator('html')).not.toHaveAttribute('data-palette', /.+/);
});

test('切换调色板会改变主色', async ({ page, context, baseURL }) => {
  await page.goto('/blog/zh/');
  const base = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--sgx-primary').trim(),
  );
  await setUi(context, baseURL, { v: 2, mode: 'light', pal: 'cherry', mat: Date.now() });
  await page.reload();
  const cherry = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--sgx-primary').trim(),
  );
  expect(cherry).not.toBe(base);
});

test('文章页隐藏时上报 post:<slug>', async ({ page }) => {
  let body = null;
  await page.unroute('https://styrigx.com/api/wellbeing');
  await page.route('https://styrigx.com/api/wellbeing', async (r) => {
    body = r.request().postData();
    await r.fulfill({ status: 204 });
  });
  await page.goto('/blog/zh/post/2026-10-11-agent-collaboration-whitepaper-v2/');
  await page.mouse.click(5, 300);
  await page.waitForTimeout(5600);
  await page.mouse.click(5, 300);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => body, { timeout: 5000 }).not.toBeNull();
  const b = JSON.parse(body);
  expect(b.s[0].k).toBe('post:2026-10-11-agent-collaboration-whitepaper-v2');
  expect(b.s[0].sec).toBeGreaterThanOrEqual(5);
  expect(b.s[0].t).toBeTruthy();
});
