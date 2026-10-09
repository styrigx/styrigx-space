/**
 * Hark：验证 legacy-lock-screen 和 owner-gate 是独立开关。
 * - 只关旧锁屏（LEGACY=false, OWNER_GATE=true）时，owner-gate 照常工作
 * - 两个都关时，锁屏完全不出现
 *
 * 注意：这是编译期开关，需要特定构建才能测试。
 * CI 默认构建两个都是 true；此文件记录预期行为。
 */
const { test, expect } = require('@playwright/test');

test.describe('lock feature flags (independent switches)', () => {
  test('owner-gate works when legacy lock is disabled (build: LEGACY=false, OWNER_GATE=true)', async ({ page }) => {
    /* 此测试需要 SGX_FEAT_LEGACY_LOCK_SCREEN=false 的构建。
       当前 CI 构建两个都是 true，跳过；手动验证时取消 skip。 */
    test.skip(true, '需要特定构建：LEGACY=false, OWNER_GATE=true');
    
    await page.goto('/?lock=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    /* 旧锁屏 UI 不应出现，但密码入口应可用 */
    const pwlink = page.locator('#sgx-lock-pwlink');
    await expect(pwlink).toBeVisible();
  });

  test('no lock at all when both disabled (build: LEGACY=false, OWNER_GATE=false)', async ({ page }) => {
    test.skip(true, '需要特定构建：LEGACY=false, OWNER_GATE=false');
    
    await page.goto('/?lock=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const lock = page.locator('#sgx-lock');
    await expect(lock).toBeHidden();
  });
});
