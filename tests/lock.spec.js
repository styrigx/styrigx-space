/**
 * Hark：锁屏专用测试（与视觉回归/Lighthouse 分离）。
 * - 未解锁时锁屏覆盖内容（无法交互）
 * - ?lock=1 强制触发锁屏
 * - Turnstile 验证卡行为
 * - 锁屏基准截图（Hark：冻结时间 + 遮罩时钟/日期/天气，否则每次必然不同）
 *
 * 注意：这些测试需要锁屏启用的构建（生产构建）；CI 的 visual/Lighthouse
 * 用 SGX_TEST_NO_LOCK=1 的构建，两者分离。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

/* Hark：CI 里 networkidle 可能永远等不到（锁屏页请求外部资源：天气、Turnstile），
   改用 domcontentloaded + 等锁屏元素出现，不再依赖网络空闲 */
async function gotoLock(page) {
  await page.goto('/?lock=1', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
}

test.describe('lock screen', () => {
  /* Hark：每个测试先拦截外部请求（天气、Turnstile、字体/CDN），
     /api/* mock 在测试体内注册，顺序靠后优先匹配 */
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
  });

  test('?lock=1 forces lock screen on any page', async ({ page }) => {
    await freezeTime(page);
    await gotoLock(page);
    const lock = page.locator('#sgx-lock');
    /* 锁屏覆盖内容：主内容不可见/不可点 */
    const main = page.locator('main, #app-grid').first();
    if (await main.count()) {
      /* 锁屏是全屏覆盖，main 应被遮挡 */
      const box = await lock.boundingBox();
      expect(box.width).toBeGreaterThan(300);
    }
  });

  test('lock screen baseline screenshot', async ({ page }) => {
    await freezeTime(page);
    await page.setViewportSize({ width: 412, height: 915 });
    await gotoLock(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    /* Hark：遮罩时钟、日期（实时内容）；天气元素不存在则跳过 */
    const masks = [page.locator('#sgx-lock-clock'), page.locator('#sgx-lock-date')];
    await expect(page).toHaveScreenshot('lock-screen.png', {
      animations: 'disabled',
      mask: masks,
    });
  });

  test('avatar click opens verify dialog (local fallback)', async ({ page }) => {
    await freezeTime(page);
    /* localhost → 直接解锁（无 Turnstile），验证兜底路径 */
    await gotoLock(page);
    await page.click('#sgx-lock-avatar');
    /* 本地应直接解锁，锁屏消失 */
    const lock = page.locator('#sgx-lock');
    await expect(lock).toBeHidden({ timeout: 5000 });
    /* session 标记已写 */
    const shown = await page.evaluate(() => {
      try { return sessionStorage.getItem('sgx-lock-shown'); } catch (e) { return null; }
    });
    expect(shown).toBe('1');
  });

  test('password link opens password dialog', async ({ page }) => {
    await freezeTime(page);
    await gotoLock(page);
    const pwlink = page.locator('#sgx-lock-pwlink');
    await expect(pwlink).toBeVisible();
    await pwlink.click();
    const dlg = page.locator('.sgx-verify-dlg');
    await expect(dlg).toBeVisible();
    /* 密码框存在 */
    await expect(page.locator('#sgx-pw-input')).toBeVisible();
  });

  test('wrong password shows error (mocked API)', async ({ page }) => {
    await freezeTime(page);
    /* Hark：http-server 没有 /api/*，用 page.route mock 后端 */
    await page.route('**/api/owner-password', async (route) => {
      const req = route.request();
      const body = JSON.parse(req.postData() || '{}');
      if (body.action === 'verify') {
        /* 模拟：密码错误 */
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'wrong' }),
        });
      } else {
        await route.continue();
      }
    });
    await gotoLock(page);
    await page.click('#sgx-lock-pwlink');
    await page.fill('#sgx-pw-input', 'wrongpassword123');
    await page.click('#sgx-pw-go');
    /* 应提示密码错误（mock 返回 wrong） */
    const err = page.locator('#sgx-verify-err');
    await expect(err).toHaveText(/密码错误|wrong/i, { timeout: 10000 });
  });

  test('locked out after 5 wrong attempts (mocked API)', async ({ page }) => {
    await freezeTime(page);
    let attempts = 0;
    await page.route('**/api/owner-password', async (route) => {
      const req = route.request();
      const body = JSON.parse(req.postData() || '{}');
      if (body.action === 'verify') {
        attempts++;
        if (attempts >= 5) {
          /* 模拟：第 5 次后锁定 */
          await route.fulfill({
            status: 429,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: 'locked', retryAfter: 30 }),
          });
        } else {
          await route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: 'wrong' }),
          });
        }
      } else {
        await route.continue();
      }
    });
    await gotoLock(page);
    await page.click('#sgx-lock-pwlink');
    const err = page.locator('#sgx-verify-err');
    /* 连续 5 次错误：每次等当次请求的响应回来，避免循环跑赢 fetch；
       Hark：submitPw 收到"密码错误"会清 input.value，和下一轮 fill 竞争，
       必须等响应回来再填下一次 */
    for (let i = 0; i < 5; i++) {
      await page.fill('#sgx-pw-input', 'wrong' + i);
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/owner-password')),
        page.click('#sgx-pw-go'),
      ]);
      if (i < 4) await expect(err).toHaveText(/密码错误|wrong/i);
    }
    expect(attempts).toBe(5);
    /* 应显示锁定提示，且按钮被禁用 */
    await expect(err).toHaveText(/尝试次数过多|Too many/i, { timeout: 10000 });
    await expect(page.locator('#sgx-pw-go')).toBeDisabled();
  });
});
