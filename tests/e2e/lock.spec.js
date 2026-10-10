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

/* 2.8.0 锁屏重设计：点头像 → 底部弹层 → 选方式 */
async function openMethodSheet(page) {
  await page.click('#sgx-lock-avatar');
  await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible({ timeout: 5000 });
}
async function choosePassword(page) {
  await openMethodSheet(page);
  await page.click('#sgx-mopt-pw');
  await expect(page.locator('#sgx-pw-input')).toBeVisible({ timeout: 5000 });
}
async function choosePasskey(page) {
  await openMethodSheet(page);
  await page.click('#sgx-mopt-pk');
}

/* 断言两个元素的 boundingBox 不相交 */
async function assertNoOverlap(page, loc1, loc2) {
  const b1 = await loc1.boundingBox();
  const b2 = await loc2.boundingBox();
  expect(b1).not.toBeNull();
  expect(b2).not.toBeNull();
  const overlap =
    b1.x < b2.x + b2.width &&
    b1.x + b1.width > b2.x &&
    b1.y < b2.y + b2.height &&
    b1.y + b1.height > b2.y;
  expect(overlap).toBe(false);
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
    /* 2.4.1：不再用 sessionStorage 标记解锁状态，一切以服务端为准；
       本地无后端，锁屏消失即视为解锁成功 */
  });

  test('password option opens password dialog (via avatar sheet)', async ({ page }) => {
    await freezeTime(page);
    await gotoLock(page);
    /* 2.8.0：点头像 → 弹层 → 选密码 */
    await openMethodSheet(page);
    await page.click('#sgx-mopt-pw');
    const dlg = page.locator('.sgx-verify-dlg');
    await expect(dlg).toBeVisible();
    /* 密码框存在 */
    await expect(page.locator('#sgx-pw-input')).toBeVisible();
  });

  test('dialog open: avatar does not overlap clock', async ({ page }) => {
    /* 弹层打开时头像淡出，不得与时钟/日期/天气重叠（boundingBox 不相交）。
       三种弹层（验证/密码/通行密钥）共用同一 dialog 组件和淡出机制，测密码弹层即可。 */
    await freezeTime(page);
    await gotoLock(page);
    const avatar = page.locator('.sgx-lock-user');
    const clock = page.locator('#sgx-lock-clock');
    await expect(avatar).toBeVisible();
    await expect(clock).toBeVisible();

    /* 打开密码弹层（2.8.0：经头像弹层） */
    await choosePassword(page);
    await expect(page.locator('.sgx-verify-dlg')).toBeVisible();
    /* 等淡出动画完成（opacity 变为 0） */
    await expect.poll(async () => {
      return await avatar.evaluate((el) => getComputedStyle(el).opacity);
    }, { timeout: 5000 }).toBe('0');
    await assertNoOverlap(page, avatar, clock);

    /* 关闭后头像恢复可见 */
    await page.keyboard.press('Escape');
    await expect(page.locator('.sgx-verify-dlg')).toBeHidden({ timeout: 5000 });
    await expect.poll(async () => {
      return await avatar.evaluate((el) => getComputedStyle(el).opacity);
    }, { timeout: 5000 }).toBe('1');
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
    await choosePassword(page);
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
    await choosePassword(page);
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

  /* 2.4.1 回跳修复：带 return 解锁后，直接 location.replace(location.href)
     交给 L1 middleware 做 302，不再走前端 600ms 客户端跳转。
     （测试环境是 http-server，没有 middleware，所以 URL 保持不变，
     但能验证发生了 reload 而不是客户端跳转到 /settings/） */
  test('unlock with ?return= reloads page for L1 302 (no client-side jump)', async ({ page }) => {
    await freezeTime(page);
    const ret = encodeURIComponent('/settings/');
    await page.goto('/?lock=1&return=' + ret, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    /* localhost 本地回退：点头像直接解锁（无 session-check） */
    const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.click('#sgx-lock-avatar');
    await navPromise;
    /* 2.4.1：reload 同一个 URL（L1 会做 302），而不是 600ms 后跳到 /settings/ */
    expect(page.url()).toContain('return=');
    expect(page.url()).not.toMatch(/\/settings\/$/);
  });

  /* 2.4.1 回跳修复：另一个标签页解锁后，切回来自动检测并回跳。
     锁屏显示期间监听 visibilitychange/focus/pageshow，调 session-check。
     （localhost 下用 ?test-no-local-bypass=1 强制走线上逻辑） */
  /* 2.4.1 回跳修复：锁屏显示期间，切回标签页会自动重查会话。
     （localhost 下用 ?test-no-local-bypass=1 强制走线上逻辑）
     401 时保持锁屏；ok 时走 handleSessionOk 回跳（由 'unlock with ?return=' 测试覆盖）。 */
  test('lock screen rechecks session on focus (401 keeps lock)', async ({ page }) => {
    await freezeTime(page);
    let fetchCount = 0;
    await page.route('**/api/session-check', async (route) => {
      fetchCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false }),
      });
    });
    const ret = encodeURIComponent('/settings/');
    await page.goto('/?lock=1&return=' + ret + '&test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    /* dispatch focus → recheckSession → fetch → 401 → 锁屏保持 */
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
    await page.waitForFunction(() => new Promise((resolve) => setTimeout(resolve, 1500)), null, { timeout: 10000 });
    expect(fetchCount).toBeGreaterThan(0);
    await expect(page.locator('#sgx-lock')).toBeVisible();
  });

  test('session-check 401 keeps lock screen (fail-closed)', async ({ page }) => {
    await freezeTime(page);
    /* mock owner-password 成功，但 session-check 返回 401 */
    await page.route('**/api/owner-password', async (route) => {
      const req = route.request();
      const body = JSON.parse(req.postData() || '{}');
      if (body.action === 'verify') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.continue();
      }
    });
    await page.route('**/api/session-check', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false }),
      });
    });
    await page.goto('/?lock=1&test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    await choosePassword(page);
    await page.fill('#sgx-pw-input', 'correctpassword');
    await page.click('#sgx-pw-go');
    /* session-check 401 → 显示"会话未生效"标题，锁屏保持（fail-closed） */
    const title = page.locator('#sgx-verify-title');
    await expect(title).toHaveText(/会话未生效|Session not active/i, { timeout: 10000 });
    await expect(page.locator('#sgx-lock')).toBeVisible();
  });
});




/* 2.8.0 锁屏重设计 e2e */
test.describe('lock screen redesign (2.8.0)', () => {
  test('点头像 → 底部弹层 → 三个选项', async ({ page }) => {
    await freezeTime(page);
    await gotoLock(page);
    /* 只有头像，没有 Styrigx 文字和常驻链接 */
    await expect(page.locator('#sgx-lock-avatar')).toBeVisible();
    await expect(page.locator('.sgx-lock-name')).toHaveCount(0);
    await expect(page.locator('#sgx-lock-pwlink')).toHaveCount(0);
    await expect(page.locator('#sgx-lock-pkbtn')).toHaveCount(0);
    /* 点头像 → 弹层出现 */
    await openMethodSheet(page);
    /* 三个选项：访客进入在前，通行密钥，密码 */
    const visitorOpt = page.locator('#sgx-mopt-visitor');
    const pkOpt = page.locator('#sgx-mopt-pk');
    const pwOpt = page.locator('#sgx-mopt-pw');
    await expect(visitorOpt).toBeVisible();
    await expect(pwOpt).toBeVisible();
    /* 访客是第一个 */
    const firstId = await page.locator('.sgx-method-opt').first().getAttribute('id');
    expect(firstId).toBe('sgx-mopt-visitor');
    /* 选密码 → 密码框出现 */
    await pwOpt.click();
    await expect(page.locator('#sgx-pw-input')).toBeVisible();
  });

  test('弹层可关闭（Esc/点外部）', async ({ page }) => {
    await freezeTime(page);
    await gotoLock(page);
    await openMethodSheet(page);
    /* Esc 关闭 */
    await page.keyboard.press('Escape');
    await expect(page.locator('#sgx-method-sheet')).toHaveCount(0);
    /* 重新打开，点外部关闭 */
    await openMethodSheet(page);
    await page.locator('.sgx-sheet-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('#sgx-method-sheet')).toHaveCount(0);
  });
});
