/**
 * 2.8.0：legacy-lock-screen 已彻底删除，只剩 lock-gate 一个开关。v5 S5 起没有锁屏界面：lock-gate 开时旧锁屏地址 ?entry=1 打开终端、预填 su 。
 * - SGX_TEST_FLAGS=gate-off  → 构建：LOCK_GATE=false（守卫不跑：不绑自动回锁）
 * - 默认构建（LOCK_GATE=true）→ ?entry=1 打开终端
 * CI 里各用一次对应构建来跑；其他构建下跳过。
 */
const { test, expect } = require('@playwright/test');

const flagsMode = process.env.SGX_TEST_FLAGS; // 'gate-off' | undefined

test.describe('lock feature flag (lock-gate)', () => {
  test('lock-gate on (default build): ?entry=1 opens the terminal with su prefilled (v6), no lock screen', async ({ page }) => {
    test.skip(flagsMode === 'gate-off', '默认构建：LOCK_GATE=true');

    await page.goto('/wild/?entry=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '', { timeout: 15000 });
    await expect(page.locator('#sgx-term-in')).toBeEditable({ timeout: 5000 });
    await expect(page.locator('#sgx-term-in')).toHaveValue('su ');
    await expect(page.locator('#sgx-entry')).toHaveCount(0);
  });

  test('lock-gate off: no lock screen, valid page does not auto-relock on focus', async ({ page }) => {
    test.skip(flagsMode !== 'gate-off', '需要构建：SGX_TEST_LOCK_GATE=0');

    await page.route('**/api/lock-session-check*', async (route) => { await route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' }); });
    await page.route((u) => u.pathname === '/wild/', async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace(/<html(\s|>)/, '<html data-sgx-lock-session="valid"$1');
      await route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
    });
    await page.goto('/wild/?entry=1&test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#site-nav .sgx-topbar')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#sgx-entry, #sgx-entry-cover')).toHaveCount(0);
    let navigated = false;
    page.on('framenavigated', () => { navigated = true; });
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
    await page.waitForTimeout(1500);
    expect(navigated).toBe(false);
  });
});
