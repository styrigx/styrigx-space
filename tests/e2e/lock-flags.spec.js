/**
 * 2.8.0：legacy-lock-screen 已彻底删除，只剩 owner-gate 一个开关。
 * - SGX_TEST_FLAGS=gate-off  → 构建：OWNER_GATE=false（锁屏完全不出现）
 * - 默认构建（OWNER_GATE=true）→ 锁屏正常出现
 * CI 里各用一次对应构建来跑；其他构建下跳过。
 */
const { test, expect } = require('@playwright/test');

const flagsMode = process.env.SGX_TEST_FLAGS; // 'gate-off' | undefined

test.describe('lock feature flag (owner-gate)', () => {
  test('lock screen shows when owner-gate is on (default build)', async ({ page }) => {
    test.skip(flagsMode === 'gate-off', '默认构建：OWNER_GATE=true');

    await page.goto('/?lock=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    /* 2.8.0：头像点击弹出方式选择 */
    await page.click('#sgx-lock-avatar');
    await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible({ timeout: 5000 });
  });

  test('no lock at all when owner-gate disabled', async ({ page }) => {
    test.skip(flagsMode !== 'gate-off', '需要构建：SGX_TEST_OWNER_GATE=0');

    await page.goto('/?lock=1', { waitUntil: 'domcontentloaded' });
    /* owner-gate 关：锁屏完全不出现（即使 ?lock=1） */
    await expect(page.locator('#sgx-lock')).toBeHidden({ timeout: 15000 });
  });
});
