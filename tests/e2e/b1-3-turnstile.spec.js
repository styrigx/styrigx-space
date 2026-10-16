/**
 * B1-3：Turnstile 8s 超时与重试。
 * - 脚本加载失败 → 显示「验证失败」+ 重试
 * - 8 秒无回调 → 显示「验证时间过长」+ 重试（假时钟，不真等 8 秒）
 * - 点「重试」→ 重新发起验证（8s 计时重启）
 * - 验证成功 → 不出重试
 *
 * 注意：锁屏测试跑在生产构建（SGX_TEST_SUITE=lock）。
 * 用 ?test-no-local-bypass=1 强制走线上验证逻辑（否则 localhost 直接解锁，
 * 不进 Turnstile）。用 addInitScript 固定 sgx-lang=zh（否则跟随浏览器语言
 * 跳到 /en/）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

/* 固定中文：防止 baseof 内联脚本跟随浏览器语言跳到 /en/ */
async function setZh(page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
}

/* 强制线上逻辑：不走 localhost 直接解锁 */
async function gotoLockOnline(page) {
  await page.goto('/?lock=1&test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
}

/* 点头像 → 方法弹层 → 访客进入 → 进入 Turnstile 验证态 */
async function openVerifyFlow(page) {
  await page.click('#sgx-lock-avatar');
  await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible({ timeout: 5000 });
  await page.click('#sgx-mopt-visitor');
  await expect(page.locator('.sgx-verify-loading')).toBeVisible({ timeout: 5000 });
}

/* turnstile 脚本桩：render 永不回调 */
async function stubTurnstileNoCallback(page) {
  await page.addInitScript(() => {
    window.turnstile = {
      render: function () { return 1; },
      reset: function () {},
    };
  });
}

test.describe('B1-3 Turnstile 8s 超时与重试', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
  });

  test('脚本加载失败 → 显示「验证失败」+ 重试', async ({ page }) => {
    await setZh(page);
    /* 脚本返回空 JS：onload 成功但 window.turnstile 未定义 → verifyFailed。
       无论走全新加载还是预加载后的轮询分支，结果都是「验证失败」。 */
    await page.route('**/challenges.cloudflare.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: '/* turnstile stub: no global */',
      });
    });
    await gotoLockOnline(page);
    await openVerifyFlow(page);
    const retry = page.locator('#sgx-verify-retry');
    await expect(retry).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.sgx-verify-failtx')).toContainText('验证失败');
  });

  test('8 秒无回调 → 显示「验证时间过长」+ 重试（假时钟）', async ({ page }) => {
    await setZh(page);
    await stubTurnstileNoCallback(page);
    await gotoLockOnline(page);
    await page.clock.install();
    await openVerifyFlow(page);
    await expect(page.locator('.sgx-verify-loading-tx')).toContainText('正在验证');
    /* 8s 到：verifyTimer 触发 */
    await page.clock.fastForward(8000);
    const retry = page.locator('#sgx-verify-retry');
    await expect(retry).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.sgx-verify-failtx')).toContainText('验证时间过长');
  });

  test('点「重试」→ 重新发起验证（8s 计时重启）', async ({ page }) => {
    await setZh(page);
    await stubTurnstileNoCallback(page);
    await gotoLockOnline(page);
    await page.clock.install();
    await openVerifyFlow(page);
    await page.clock.fastForward(8000);
    const retry = page.locator('#sgx-verify-retry');
    await expect(retry).toBeVisible({ timeout: 5000 });
    /* 点重试：重新发起，回到「正在验证…」，重试按钮消失 */
    await retry.click();
    await expect(page.locator('.sgx-verify-loading-tx')).toContainText('正在验证');
    await expect(page.locator('#sgx-verify-retry')).toHaveCount(0);
    /* 计时重启：再过 8s 又出重试 */
    await page.clock.fastForward(8000);
    await expect(page.locator('#sgx-verify-retry')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.sgx-verify-failtx')).toContainText('验证时间过长');
  });

  test('验证成功 → 不出重试', async ({ page }) => {
    await setZh(page);
    /* render 立刻回调成功 token */
    await page.addInitScript(() => {
      window.turnstile = {
        render: function (el, opts) {
          setTimeout(function () { opts.callback('fake-token-123'); }, 50);
          return 1;
        },
        reset: function () {},
      };
    });
    await page.route('**/api/verify', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await gotoLockOnline(page);
    await page.clock.install();
    await openVerifyFlow(page);
    await page.clock.fastForward(100);
    /* 成功态：出现勾；重试按钮从未出现 */
    await expect(page.locator('.sgx-check')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#sgx-verify-retry')).toHaveCount(0);
  });
});
