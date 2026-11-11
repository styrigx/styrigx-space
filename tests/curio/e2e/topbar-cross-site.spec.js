/* 四站同一个顶栏（2026-11-04 P5-1，方案 6.4 / 6.5，任务书 P5-1「测试」两条 e2e）。
 * 跑在拼好的整站（space/web/public：主站在 /，奇趣 /curio/、日刻 /daymark/、博客 /blog/，同源），和线上 PR3 后的四站同源一样：
 * - P4-3 PR-4b 起四站面板同一套：主站页面也有「分享本页」（原定案第 4 条「主站不输出」作废）；2026-11 PR-1 起它在 NAVIGATE（>_）面板里，
 *   外观面板只有 MODE + PALETTE（四站 DOM 同一份见 quick-panel-identity.spec.js）。
 * - 子站外观面板改外观（深色 / 调色板）→ 回主站同步生效：四站共用一个写端（共享外壳 prefs-write.js），写同一个 sgx-ui cookie / localStorage（定案第 5 条）。
 * 主站在 space/web/public 里是生产构建（锁屏启用、没有网关）：这里只看顶栏 / 快捷面板的 DOM 和首帧外观，不过锁屏。 */
const { test, expect } = require('@playwright/test');

const MAIN = ['/', '/wild/', '/zh/', '/zh/wild/']; /* 2026-11-09 L1：安全页删除（盾牌弹层）*/
const SUB = ['/curio/', '/daymark/', '/blog/', '/blog/post/2026-10-11-agent-collaboration-whitepaper-v2/'];

test.beforeEach(async ({ page }) => {
  /* 不让页面去打真接口，页面照常出顶栏：主站（锁屏检查等）回 401；子站数据接口回 503。
     子站不能回 401：奇趣 / 日刻把本站接口的任何 401 当「锁了」整页 reload（sgx-lock-sync.js），会一直刷新 */
  await page.route('**/api/**', (r) => {
    const sub = /^\/(curio|daymark|blog)\//.test(new URL(r.request().url()).pathname);
    return r.fulfill(sub
      ? { status: 503, contentType: 'application/json', body: '{"ok":false,"error":"unavailable"}' }
      : { status: 401, contentType: 'application/json', body: '{"ok":false,"error":"session"}' });
  });
  await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
});

async function openSet(page) {
  await page.locator('.sgx-tb-quick').click();
  await expect(page.locator('#sgx-qp')).toHaveAttribute('data-state', 'open');
}
async function openNav(page) {
  await page.locator('.sgx-tb-grid').click();
  await expect(page.locator('#sgx-nav')).toHaveAttribute('data-state', 'open');
}

test('v6 P4：四站页面都没有「分享本页」磁贴（Gray 11-11 17:47；构建产物里也没有）', async ({ page }) => {
  for (const p of MAIN) {
    await page.goto(p, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-nav')).toHaveCount(1);
    await expect(page.locator('#sgx-nav [data-qp="share"], [data-sgx-share]'), p).toHaveCount(0);
    const html = await (await page.request.get(p)).text();
    expect(html, p).not.toMatch(/data-qp="?share\b|data-sgx-share/);
  }
  for (const p of SUB) {
    await page.goto(p, { waitUntil: 'domcontentloaded' });
    await openNav(page);
    await expect(page.locator('#sgx-nav [data-qp="share"], [data-sgx-share]'), p).toHaveCount(0);
  }
});

test('子站外观面板换调色板（v4：深浅跟着调色板）→ 回主站同步生效；再在主站侧改回来，子站也跟着', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/curio/', { waitUntil: 'domcontentloaded' });
  /* 默认 terra 是深套：系统浅色也是深的 */
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await openSet(page);
  await expect(page.locator('#sgx-qp [data-qp-mode]')).toHaveCount(0);
  await page.locator('#sgx-qp [data-qp-palette="sage"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'sage');
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  const cookie = (await page.context().cookies()).find((c) => c.name === 'sgx-ui');
  expect(cookie, '写了 sgx-ui cookie').toBeTruthy();

  /* 主站：同源同一份 cookie / localStorage，首帧就是浅套 sage */
  for (const p of ['/', '/wild/']) {
    await page.goto(p, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html'), p).not.toHaveClass(/\bdark\b/);
    await expect(page.locator('html'), p).toHaveAttribute('data-palette', 'sage');
  }
  expect(await page.evaluate(() => [localStorage.getItem('sgx-theme-mode'), localStorage.getItem('sgx-palette')])).toEqual([null, 'sage']);

  /* 日刻、博客也跟着（读同一个 cookie） */
  for (const p of ['/daymark/', '/blog/']) {
    await page.goto(p, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html'), p).not.toHaveClass(/\bdark\b/);
    await expect(page.locator('html'), p).toHaveAttribute('data-palette', 'sage');
  }

  /* 反过来：日刻外观面板恢复默认（terra，深套）→ 奇趣首帧深色、没有 data-palette */
  await page.goto('/daymark/', { waitUntil: 'domcontentloaded' });
  await openSet(page);
  await page.locator('#sgx-qp [data-qp-reset]').click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(page.locator('html')).not.toHaveAttribute('data-palette', 'sage');
  await page.goto('/curio/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(page.locator('html')).not.toHaveAttribute('data-palette', /.+/);
});
