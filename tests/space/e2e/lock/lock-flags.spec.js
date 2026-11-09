/**
 * 2.8.0：legacy-lock-screen 已彻底删除，只剩 lock-gate 一个开关。
 * - SGX_TEST_FLAGS=gate-off  → 构建：LOCK_GATE=false（锁屏完全不出现）
 * - 默认构建（LOCK_GATE=true）→ 锁屏正常出现
 * CI 里各用一次对应构建来跑；其他构建下跳过。
 */
const { test, expect } = require('@playwright/test');

const flagsMode = process.env.SGX_TEST_FLAGS; // 'gate-off' | undefined

test.describe('lock feature flag (lock-gate)', () => {
  test('lock screen shows when lock-gate is on (default build)', async ({ page }) => {
    test.skip(flagsMode === 'gate-off', '默认构建：LOCK_GATE=true');

    await page.goto('/?entry=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-entry')).toBeVisible({ timeout: 15000 });
    /* 进站 v3 L1：entry@space 终端输入行可用（没有弹层） */
    await expect(page.locator('#sgx-entry-cmd')).toBeEditable({ timeout: 5000 });
  });

  test('no lock at all when lock-gate disabled', async ({ page }) => {
    test.skip(flagsMode !== 'gate-off', '需要构建：SGX_TEST_LOCK_GATE=0');

    await page.goto('/?entry=1', { waitUntil: 'domcontentloaded' });
    /* lock-gate 关：锁屏完全不出现（即使 ?entry=1） */
    await expect(page.locator('#sgx-entry')).toBeHidden({ timeout: 15000 });
    await expect(page.locator('#sgx-entry-cover')).toHaveCount(0);
  });
});
