/**
 * Hark：验证 legacy-lock-screen 和 owner-gate 是独立开关（真跑，不用假 skip）。
 * - SGX_TEST_FLAGS=legacy-off  → 构建：LEGACY=false, OWNER_GATE=true
 * - SGX_TEST_FLAGS=both-off    → 构建：LEGACY=false, OWNER_GATE=false
 * CI 里各用一次对应构建来跑；其他构建下跳过。
 */
const { test, expect } = require('@playwright/test');

const flagsMode = process.env.SGX_TEST_FLAGS; // 'legacy-off' | 'both-off' | undefined

test.describe('lock feature flags (independent switches)', () => {
  test('owner-gate works when legacy lock is disabled', async ({ page }) => {
    test.skip(flagsMode !== 'legacy-off', '需要构建：SGX_TEST_LEGACY=0（LEGACY=false, OWNER_GATE=true）');

    await page.goto('/?lock=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    /* 旧锁屏关掉，owner-gate 的密码入口照常可用 */
    await expect(page.locator('#sgx-lock-pwlink')).toBeVisible();
  });

  test('no lock at all when both disabled', async ({ page }) => {
    test.skip(flagsMode !== 'both-off', '需要构建：SGX_TEST_LEGACY=0 SGX_TEST_OWNER_GATE=0');

    await page.goto('/?lock=1', { waitUntil: 'domcontentloaded' });
    /* 两个开关都关：锁屏完全不出现（即使 ?lock=1） */
    await expect(page.locator('#sgx-lock')).toBeHidden({ timeout: 15000 });
  });
});
