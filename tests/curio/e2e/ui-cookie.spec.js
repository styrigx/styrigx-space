// 外观 / 语言跟主站（sgx-ui cookie）：真页面跑一遍主站契约夹具（tests/fixtures/ui-cookie-contract.json，sync-shell 原样同步）。
// - 每个用例：带上 cookie、系统浅色 / 深色各加载一次，<html> 状态 = 夹具的 light.root / dark.root（共享读端 SgxUI.apply 内联在 <head>）
// - 选湖蓝 lake 必须写 data-palette="lake"（不能当默认渲染成 terra）
// - 自定义主题色：没缓存时加载 shell-accent.js 算角色，写 <style id="sgx-accent-roles"> 和本站缓存
// - 语言（语言清理 2026-11-07：四站同一份首帧跳转 lang-boot.js）：cookie 带明确语言且版本合法 → 跳到那种语言的同一页；
//   版本不认识 / lang 是 system / 空 / 没有 cookie = 跟随系统 → 按浏览器语言（本文件浏览器用 zh-CN，和原来中文页的用例一致）
const { test, expect } = require('@playwright/test');

/* 浏览器语言中文：跟随系统时停在中文页（夹具外观用例都开在中文页） */
test.use({ locale: 'zh-CN' });
const fx = require('../../fixtures/ui-cookie-contract.json');

const PAGE = '/curio/zh/404.html';
const enc = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function setup(page) {
  await page.route('**/api/**', (r) => r.fulfill({ json: { ok: true } }));
  await page.route(/^https:\/\/([a-z]+\.)?styrigx\.com\//, (r) => r.fulfill({ status: 204, body: '' }));
}
async function setCookie(context, value) {
  await context.clearCookies();
  if (value) await context.addCookies([{ name: 'sgx-ui', value, url: test.info().project.use.baseURL || 'http://localhost:8932' }]);
}
const rootState = () => {
  const h = document.documentElement;
  return {
    dark: h.classList.contains('dark'),
    'data-theme-mode': h.getAttribute('data-theme-mode'),
    'data-dark': h.getAttribute('data-dark'),
    'data-font-size': h.getAttribute('data-font-size'),
    fontSize: h.style.fontSize,
    'data-palette': h.getAttribute('data-palette'),
    '--sgx-seed': h.style.getPropertyValue('--sgx-seed'),
    'reduced-motion': h.classList.contains('reduced-motion'),
    'data-reduced-motion': h.getAttribute('data-reduced-motion'),
  };
};

for (const sys of ['light', 'dark']) {
  test(`契约夹具 ${fx.cases.length} 个用例（系统${sys === 'dark' ? '深' : '浅'}色）：<html> 状态和主站一致`, async ({ page, context }) => {
    await setup(page);
    await page.emulateMedia({ colorScheme: sys });
    for (const c of fx.cases) {
      await setCookie(context, c.cookie);
      await page.goto(PAGE);
      expect(await page.evaluate(rootState), c.name).toEqual(c[sys].root);
    }
  });
}

test('湖蓝 lake：写 data-palette="lake"，主色取 lake 的角色（不是默认 terra）', async ({ page, context }) => {
  await setup(page);
  await setCookie(context, fx.cases.find((c) => c.name.startsWith('湖蓝 lake')).cookie);
  await page.goto(PAGE);
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'lake');
  const seed = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sgx-seed').trim());
  expect(seed).toBe('#f17f72');
});

test('自定义主题色：没缓存 → 加载 shell-accent.js 算角色，写 <style id="sgx-accent-roles"> + 本站缓存；再进页首帧直接用缓存', async ({ page, context }) => {
  await setup(page);
  await setCookie(context, fx.cases.find((c) => c.name.startsWith('自定义主题色（默认色板上）')).cookie);
  await page.goto(PAGE);
  await expect(page.locator('#sgx-accent-js')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (document.getElementById('sgx-accent-roles') || {}).textContent || '')).toContain('--sgx-primary');
  const cache = await page.evaluate(() => localStorage.getItem('sgx-shell-accent-css'));
  expect(cache).toMatch(/^[0-9a-f]{12}\|#1f8a70\n/);
  await page.reload();
  await expect(page.locator('#sgx-accent-js')).toHaveCount(0);
  expect(await page.evaluate(() => document.getElementById('sgx-accent-roles').textContent.length)).toBeGreaterThan(100);
});

test('语言：合法 cookie 带 lang=en → 中文页换到英文同一页（保留 #页签）；版本不认识 / 没有 cookie = 跟随系统（中文浏览器）', async ({ page, context }) => {
  await setup(page);
  await setCookie(context, enc({ v: 2, mode: 'light', pal: 'dustyblue', lang: 'en' }));
  /* P4-3 奇趣拆页：分区是子页，hash 只剩发现的 #c/<分类> */
  await page.goto('/curio/zh/finds/#c/2');
  await expect(page).toHaveURL(/:\d+\/curio\/finds\/#c\/2$/);
  await setCookie(context, enc({ v: 3, mode: 'light', lang: 'en' }));
  await page.goto('/curio/zh/');
  await expect(page).toHaveURL(/:\d+\/curio\/zh\/$/);
  /* 跟随系统每页都跳（不只主站）：没有 cookie、中文浏览器打开英文页 → 中文同一页 */
  await setCookie(context, fx.cases[0].cookie);
  await page.goto('/curio/');
  await expect(page).toHaveURL(/\/curio\/zh\/$/);
  /* 明确存了 system（新写法）同样跟随系统 */
  await setCookie(context, enc({ v: 2, mode: 'light', lang: 'system' }));
  /* 奇趣拆页（#298）起旧 #devices 在首页转到设备子页：跟随系统（中文）→ 中文设备子页 */
  await page.goto('/curio/#devices');
  await expect(page).toHaveURL(/\/curio\/zh\/devices\/$/);
});

test.describe('英文浏览器', () => {
  test.use({ locale: 'en-US' });
  test('跟随系统 + 英文浏览器：中文页回英文同一页；明确选了中文就留在中文', async ({ page, context }) => {
    await setup(page);
    await setCookie(context, enc({ v: 2, mode: 'light', lang: 'system' }));
    await page.goto('/curio/zh/');
    await expect(page).toHaveURL(/:\d+\/curio\/$/);
    await setCookie(context, enc({ v: 2, mode: 'light', lang: 'zh' }));
    await page.goto('/curio/zh/');
    await expect(page).toHaveURL(/:\d+\/curio\/zh\/$/);
  });
});
