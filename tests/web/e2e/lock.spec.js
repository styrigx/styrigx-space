/**
 * Hark：锁屏专用测试（与视觉回归/Lighthouse 分离）。
 * - 未解锁时锁屏覆盖内容（无法交互）
 * - ?lock=1 强制触发锁屏
 * - 访客进入（临时钥匙）弹层行为
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
    /* 2026-10-23：锁屏不再有时钟 / 日期，不用遮罩 */
    await expect(page).toHaveScreenshot('lock-screen.png', { animations: 'disabled' });
  });

  test('avatar → method sheet → visitor unlocks (local fallback)', async ({ page }) => {
    await freezeTime(page);
    /* 2.8.0：localhost 本地回退——点头像 → 方法弹层 → 选"访客进入"直接解锁（本地不输临时钥匙），验证兜底路径 */
    await gotoLock(page);
    await openMethodSheet(page);
    await page.click('#sgx-mopt-visitor');
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

  test('dialog open: avatar does not overlap the wordmark', async ({ page }) => {
    /* 弹层打开时头像淡出，不得与时钟/日期/天气重叠（boundingBox 不相交）。
       三种弹层（验证/密码/通行密钥）共用同一 dialog 组件和淡出机制，测密码弹层即可。 */
    await freezeTime(page);
    await gotoLock(page);
    const avatar = page.locator('.sgx-lock-user');
    /* 2026-10-23：锁屏没有时钟和左上字标了，改测头像块和顶栏标题不重叠 */
    const clock = page.locator('#sgx-lock .sgx-lock-tb');
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

  /* 2026-10-23：访客进入 = 输入临时钥匙（取代 Turnstile）。test-no-local-bypass 让 localhost 也走线上逻辑 */
  test('visitor: temporary key dialog — wrong key shows error, right key unlocks (mocked API)', async ({ page }) => {
    await freezeTime(page);
    const seen = [];
    await page.route('**/api/lock-temp-unlock', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      seen.push(body.code);
      const ok = body.code === 'abcd-efgh-jkmn';
      await route.fulfill({ status: ok ? 200 : 403, contentType: 'application/json',
        body: JSON.stringify(ok ? { ok: true, role: 'visitor' } : { ok: false, error: 'wrong' }) });
    });
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await page.goto('/?lock=1&test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    await openMethodSheet(page);
    /* 方法弹层：访客进入在第一行，说明是临时钥匙，不再提 Cloudflare / 机器人 */
    const opt = page.locator('#sgx-mopt-visitor');
    await expect(opt).toContainText('访客进入');
    await expect(opt).toContainText('临时钥匙');
    await expect(page.locator('#sgx-method-sheet')).not.toContainText(/Cloudflare|机器人/);
    await opt.click();
    const input = page.locator('#sgx-temp-input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await expect(input).toHaveAttribute('autocomplete', 'off');
    /* 空着点确定：提示输入，不发请求 */
    await page.click('#sgx-temp-go');
    await expect(page.locator('#sgx-verify-err')).toHaveText('请输入临时钥匙');
    expect(seen).toEqual([]);
    await input.fill('AAAA-BBBB-CCCC');
    await input.press('Enter');
    await expect(page.locator('#sgx-verify-err')).toHaveText('临时钥匙无效或已过期', { timeout: 10000 });
    await expect(input).toHaveValue('');
    await input.fill('abcd-efgh-jkmn');
    await page.click('#sgx-temp-go');
    expect(await page.evaluate(() => typeof window.turnstile)).toBe('undefined');
    await expect.poll(() => seen.length).toBe(2);
  });

  test('visitor: temporary key locked out (429) disables input with countdown (mocked API)', async ({ page }) => {
    await freezeTime(page);
    await page.route('**/api/lock-temp-unlock', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: '{"ok":false,"error":"locked"}' }));
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await page.goto('/?lock=1&test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    await openMethodSheet(page);
    await page.click('#sgx-mopt-visitor');
    await page.fill('#sgx-temp-input', 'AAAA-BBBB-CCCC');
    await page.click('#sgx-temp-go');
    await expect(page.locator('#sgx-verify-err')).toHaveText('尝试次数过多', { timeout: 10000 });
    await expect(page.locator('#sgx-temp-count')).toHaveText(/15 分钟后可再试/);
    await expect(page.locator('#sgx-temp-input')).toBeDisabled();
    await expect(page.locator('#sgx-temp-go')).toBeDisabled();
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

  /* 2026-10-21：带 return 解锁后，前端问 /api/session-check?return=（服务端校验 return，与首页 302 同一个函数），
     照服务端给的 next 跳；不再「重载锁屏地址等 L1 302」——锁屏入口 styrigx.com/?lock=1 线上曾不过网关，
     重载回来还是锁屏（用户报告：解锁后回不到子站 / 又回到锁屏）。 */
  test('unlock with ?return= goes to server-provided next (no reload of the lock URL)', async ({ page }) => {
    await freezeTime(page);
    let unlocked = false;
    const checks = [];
    await page.route('**/api/owner-password', async (route) => {
      unlocked = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/api/session-check*', async (route) => {
      checks.push(route.request().url());
      if (!unlocked) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, role: 'owner', next: '/settings/', upgrade: false }) });
    });
    await page.goto('/?lock=1&return=' + encodeURIComponent('/settings/') + '&test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    await choosePassword(page);
    await page.fill('#sgx-pw-input', 'correctpassword');
    await page.click('#sgx-pw-go');
    await page.waitForURL(/\/settings\/$/, { timeout: 10000 });
    expect(checks.some((u) => u.includes('return=' + encodeURIComponent('/settings/')))).toBe(true);
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
    await page.route('**/api/session-check*', async (route) => {
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
    await page.route('**/api/session-check*', async (route) => {
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

test.describe('lock password dialog keyboard avoidance (批次 A 验收修复 P1)', () => {
  /* 注：锁屏密码弹层用例放在本文件而非 dialog-kb.spec.js——
     dialog-kb.spec.js 跑在默认 suite（SGX_TEST_NO_LOCK=1 构建，lock.js 直接 return，
     锁屏弹层打不开）；本文件跑锁屏 suite（生产构建），才能真正打开锁屏密码弹层。 */
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
  });

  /* 污点 window.visualViewport 模拟键盘弹出（与 dialog-kb.spec.js 同一套做法） */
  async function taintViewport(pg) {
    await pg.evaluate(() => {
      try {
        Object.defineProperty(Navigator.prototype, 'virtualKeyboard', {
          configurable: true,
          get: () => undefined,
        });
      } catch (e) {}
      const real = window.visualViewport;
      const fake = {
        width: real ? real.width : window.innerWidth,
        height: real ? real.height : window.innerHeight,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
        _l: {},
      };
      fake.addEventListener = function (t, f) {
        (this._l[t] = this._l[t] || []).push(f);
      };
      fake.removeEventListener = function (t, f) {
        const a = this._l[t];
        if (a) {
          const i = a.indexOf(f);
          if (i !== -1) a.splice(i, 1);
        }
      };
      fake.__setHeight = function (h) {
        this.height = h;
        (this._l.resize || []).slice().forEach((f) => f());
      };
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        get: () => fake,
      });
      window.__fakeVV = fake;
    });
  }

  async function waitFrames(pg, n) {
    await pg.evaluate(
      (count) =>
        new Promise((resolve) => {
          const tick = () => {
            if (count <= 1) resolve();
            else {
              count -= 1;
              requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);
        }),
      n
    );
  }

  test('lock password dialog follows keyboard: dlg shifts up, input stays visible, restore on blur', async ({ page }) => {
    await freezeTime(page);
    await gotoLock(page);
    await taintViewport(page);
    await choosePassword(page);
    const dlg = page.locator('.sgx-verify-dlg');
    await expect(dlg).toBeVisible();
    const input = page.locator('#sgx-pw-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    const origTransform = await dlg.evaluate((el) => el.style.transform);
    expect(origTransform).toBe('');

    /* 模拟键盘弹出：visualViewport 高度缩小 300（followKeyboard 经 rAF 节流） */
    await page.evaluate(() => window.__fakeVV.__setHeight(window.innerHeight - 300));
    await waitFrames(page, 3);
    const raised = await page.evaluate(() => {
      const d = document.querySelector('.sgx-verify-dlg');
      const vv = window.__fakeVV;
      const inputEl = document.getElementById('sgx-pw-input');
      const goEl = document.getElementById('sgx-pw-go');
      const ir = inputEl.getBoundingClientRect();
      const br = goEl.getBoundingClientRect();
      return {
        transform: d.style.transform,
        inputBottom: ir.bottom,
        btnBottom: br.bottom,
        vvBottom: vv.offsetTop + vv.height,
      };
    });
    /* followKeyboard 作用到 dlg（不是 card）：dlg 上移键盘高度 */
    expect(raised.transform).toBe('translateY(-300px)');
    expect(raised.inputBottom).toBeLessThanOrEqual(raised.vvBottom + 1);
    expect(raised.btnBottom).toBeLessThanOrEqual(raised.vvBottom + 1);

    /* 恢复视口 + 失焦：弹层回到底部 */
    await page.evaluate(() => window.__fakeVV.__setHeight(window.innerHeight));
    await input.evaluate((el) => el.blur());
    await waitFrames(page, 3);
    const restored = await dlg.evaluate((el) => el.style.transform);
    expect(restored).toBe('');
  });
});

test.describe('lock password dialog eye button (批次 A 验收修复 P2)', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
  });

  test('lock password dialog: eye starts eye-off, toggles, keeps focus', async ({ page }) => {
    await freezeTime(page);
    await gotoLock(page);
    await choosePassword(page);
    const input = page.locator('#sgx-pw-input');
    await expect(input).toBeVisible();
    const eye = page.locator('#sgx-pw-eye');
    await expect(eye).toBeVisible();

    /* 锁屏套件不固定语言（现有测试均用中英双语正则），aria-label 接受任一语言 */
    await expect(eye).toHaveAttribute('aria-label', /显示密码|Show password/);
    await expect(eye).toHaveAttribute('aria-pressed', 'false');
    expect(await eye.evaluate((el) => el.innerHTML)).toContain('<line');

    await eye.click();
    await expect(eye).toHaveAttribute('aria-label', /隐藏密码|Hide password/);
    await expect(eye).toHaveAttribute('aria-pressed', 'true');
    expect(await eye.evaluate((el) => el.innerHTML)).not.toContain('<line');
    await expect(page.locator('#sgx-pw-input[type="text"]')).toBeVisible();
    await expect(input).toBeFocused();

    await eye.click();
    await expect(eye).toHaveAttribute('aria-label', /显示密码|Show password/);
    await expect(eye).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#sgx-pw-input[type="password"]')).toBeVisible();
  });
});

test.describe('lock method sheet row feedback (批次 A 验收修复 P2)', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
  });

  test('method row click vibrates 10ms', async ({ page }) => {
    await page.addInitScript(() => {
      window.__vibCalls = [];
      navigator.vibrate = (ms) => { window.__vibCalls.push(ms); return true; };
    });
    await freezeTime(page);
    await gotoLock(page);
    /* 头像 id 是 #sgx-lock-avatar（openMethodSheet 已封装） */
    await openMethodSheet(page);
    const pwBtn = page.locator('#sgx-mopt-pw');
    await expect(pwBtn).toBeVisible({ timeout: 5000 });
    await pwBtn.click();
    expect(await page.evaluate(() => window.__vibCalls)).toEqual([10]);
    /* 点击后进入密码态（弹层未关、未收键盘——行反馈不影响流程） */
    await expect(page.locator('#sgx-pw-input')).toBeVisible();
  });
});

test.describe('A-2 锁屏凭证清空态（resetOnly）/ 启动站（PR3：只剩「无法登录？」）', () => {
  test('锁屏凭证清空：方法弹层只显示访客 +「无法登录？」（无通行密钥/密码/根凭证入口）', async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });

    await freezeTime(page);
    await page.route('**/api/lock-config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, passkey: true, password: true, ownerConfigured: true, resetOnly: true }),
      });
    });
    await gotoLock(page);
    await openMethodSheet(page);
    const ids = await page.locator('.sgx-method-opt').evaluateAll((els) => els.map((el) => el.id));
    expect(ids).toEqual(['sgx-mopt-visitor']);
    await expect(page.locator('#sgx-mopt-cant')).toHaveText('无法登录？');
    await expect(page.locator('#sgx-mopt-reset, #sgx-mopt-mk')).toHaveCount(0);
  });

  test('启动站（lock-config 全 false）：根凭证在「无法登录？」里，走 /api/root-auth（不带 purpose）→ root-session', async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });

    await freezeTime(page);
    await page.route('**/api/lock-config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, passkey: false, password: false, ownerConfigured: false, resetOnly: false }),
      });
    });
    const calls = [];
    await page.route('**/api/root-auth', async (route) => {
      calls.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.route('**/api/root-session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"by":"root"}' }));
    await page.route('**/settings/security/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p id="landed">ok</p>' }));
    await gotoLock(page);
    await openMethodSheet(page);
    await expect(page.locator('#sgx-mopt-mk')).toHaveCount(0);
    await page.click('#sgx-mopt-cant');
    await expect(page.locator('#sgx-reset-title')).toHaveText('重置登录');
    await page.fill('#sgx-reset-root', 'root-key');
    await page.click('#sgx-reset-go');
    await expect(page.locator('#landed')).toBeVisible({ timeout: 8000 });
    expect(calls).toEqual([{ key: 'root-key' }]);
  });
});

test.describe('PR3 锁屏：无法登录？→ 弹层原地切到重置登录', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });

    await freezeTime(page);
  });

  test('根凭证 → needOwner → 账号凭证行（账号通行密钥 / 账号密码，没有「站长」字样）→ 账号密码通过 → /settings/security/lock/', async ({ page }) => {
    const bodies = [];
    await page.route('**/api/lockreset', async (route) => {
      const b = JSON.parse(route.request().postData() || '{}');
      bodies.push(b);
      if (b.ownerProof) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, needOwner: true, passkey: true, password: true }) });
    });
    await page.route('**/settings/security/lock/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p id="landed">ok</p>' }));
    await gotoLock(page);
    await openMethodSheet(page);
    await page.click('#sgx-mopt-cant');
    /* 同一个弹层（没有关掉再开别的） */
    await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible();
    await expect(page.locator('#sgx-reset-title')).toHaveText('重置登录');
    await expect(page.locator('#sgx-mopt-visitor')).toHaveCount(0);
    await expect(page.locator('.sgx-reset input[autocomplete="username"]')).toHaveValue('RootKey');
    await page.fill('#sgx-reset-root', 'root-key');
    await page.click('#sgx-reset-go');
    await expect(page.locator('.sgx-reset[data-step="owner"]')).toBeVisible();
    await expect(page.locator('.sgx-reset-opts .sgx-door-rowtitle')).toHaveText(['账号通行密钥', '账号密码']);
    await expect(page.locator('#sgx-method-sheet')).not.toContainText('站长');
    await page.locator('.sgx-door-row').filter({ hasText: '账号密码' }).click();
    await page.locator('.sgx-door-expand input[type="password"]').fill('acct-pw');
    await page.locator('.sgx-door-expand .sgx-door-btn-primary').click();
    await expect(page.locator('#landed')).toBeVisible({ timeout: 8000 });
    expect(bodies[0]).toEqual({ action: 'verify', rootKey: 'root-key' });
    expect(bodies[1]).toEqual({ action: 'verify', rootKey: 'root-key', ownerProof: { type: 'password', password: 'acct-pw' } });
  });

  test('恢复开关有效（verify 直接 ok）→ 不要账号凭证，直接去锁屏凭证页；根凭证错误 → 行内「验证失败」并清空', async ({ page }) => {
    let n = 0;
    await page.route('**/api/lockreset', async (route) => {
      n++;
      if (n === 1) {
        await route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"auth"}' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.route('**/settings/security/lock/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p id="landed">ok</p>' }));
    await gotoLock(page);
    await openMethodSheet(page);
    await page.click('#sgx-mopt-cant');
    await page.fill('#sgx-reset-root', 'wrong');
    await page.press('#sgx-reset-root', 'Enter');
    await expect(page.locator('#sgx-reset-err')).toHaveText('验证失败');
    await expect(page.locator('#sgx-reset-root')).toHaveValue('');
    await page.fill('#sgx-reset-root', 'right');
    await page.click('#sgx-reset-go');
    await expect(page.locator('#landed')).toBeVisible({ timeout: 8000 });
  });
});

test.describe('锁屏视觉统一（2026-10-23：与账号登录页同一套玻璃背景与版面）', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  });

  test('版面：顶栏标题静止时「锁定屏幕」（打开解锁弹层时变「解锁屏幕」，见 lock-mobile.spec.js）；没有左上字标和标语；头像 → 欢迎回来 / 很高兴再次见到你 → 解锁按钮；没有底部站点清单、时钟和日刻', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await gotoLock(page);
    const lock = page.locator('#sgx-lock');
    await expect(lock.locator('.sgx-glass-bg')).toHaveCount(1);
    await expect(page.locator('#sgx-lock-title')).toHaveText('锁定屏幕');
    await expect(lock.locator('.sgx-lock-brand, .sgx-wordmark')).toHaveCount(0);
    await expect(lock).not.toContainText('Personal');
    await expect(lock.locator('.sgx-lock-welcome')).toHaveText('欢迎回来');
    await expect(lock.locator('.sgx-lock-sub')).toHaveText('很高兴再次见到你');
    await expect(page.locator('#sgx-lock-go')).toBeVisible();
    await expect(lock.locator('.sgx-lock-foot')).toHaveCount(0);
    await expect(page.locator('#sgx-lock-clock')).toHaveCount(0);
    await expect(page.locator('#sgx-lock-dm')).toHaveCount(0);
    await expect(page.locator('#sgx-lock-stage')).not.toHaveClass(/is-pending/);
    /* 顺序：顶栏在头像上面，头像在按钮上面 */
    const w = await lock.locator('.sgx-lock-tb').boundingBox();
    const u = await page.locator('#sgx-lock-avatar').boundingBox();
    const g = await page.locator('#sgx-lock-go').boundingBox();
    expect(w.y + w.height).toBeLessThan(u.y);
    expect(u.y + u.height).toBeLessThan(g.y);
  });

  test('英文：Lock screen / Good to see you again / Unlock', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await page.goto('/en/?lock=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock-title')).toHaveText('Lock screen');
    await expect(page.locator('#sgx-lock .sgx-lock-sub')).toHaveText('Good to see you again');
    await expect(page.locator('#sgx-lock-go')).toHaveText('Unlock');
  });

  test('「解锁」按钮 = 点头像：打开同一个解锁方式弹层', async ({ page }) => {
    await gotoLock(page);
    await page.click('#sgx-lock-go');
    await expect(page.locator('#sgx-method-sheet')).toBeVisible();
    await expect(page.locator('#sgx-mopt-pw')).toBeVisible();
  });

  test('锁定时抽屉 / 快捷面板按钮点不到（锁屏盖住整页，顶栏位置只有标题）', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await gotoLock(page);
    await expect(page.locator('#sgx-lock .sgx-lock-tb button, #sgx-lock .sgx-lock-tb a')).toHaveCount(0);
    for (const sel of ['.sgx-tb-nav', '[aria-controls="sgx-qp"]']) {
      const btn = page.locator(sel).first();
      expect(await btn.count()).toBeGreaterThan(0);
      const box = await btn.boundingBox();
      if (!box) continue;
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return !!(el && el.closest('#sgx-lock'));
      }, [box.x + box.width / 2, box.y + box.height / 2]);
      expect(hit).toBe(true);
    }
  });

  for (const theme of ['light', 'dark']) {
    test(`lock screen glass baseline screenshot (${theme})`, async ({ page }) => {
      await freezeTime(page);
      await page.setViewportSize({ width: 412, height: 915 });
      await page.addInitScript((t) => {
        try { localStorage.setItem('sgx-lang', 'zh'); localStorage.setItem('sgx-theme-mode', t); } catch (e) {}
      }, theme);
      await gotoLock(page);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(page.locator('#sgx-lock-stage')).not.toHaveClass(/is-pending/);
      await expect(page).toHaveScreenshot(`lock-screen-glass-${theme}.png`, { animations: 'disabled' });
    });
  }
});

test.describe('B1-2 普通解锁路径 pkAuth()（mock WebAuthn）', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
  });

  const CHALLENGE_B64 = 'dGVzdC1jaGFsbGVuZ2U';

  /** @param {import('@playwright/test').Page} page @param {'zh'|'en'} lang */
  async function setupUnlockMocks(page, lang) {
    await page.addInitScript((l) => {
      try { localStorage.setItem('sgx-lang', l); } catch (e) {}
    }, lang);
    /* /api/owner-passkey challenge 桩 */
    await page.route('**/api/owner-passkey', async (route) => {
      let body = {};
      try { body = route.request().postDataJSON() || {}; } catch (e) {}
      if (body.action === 'challenge') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, challenge: CHALLENGE_B64, allowCredentials: [], cid: 'c1' }),
        });
        return;
      }
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false }),
      });
    });
  }

  /** WebAuthn get 桩：记录参数后挂起，由测试控制 reject */
  async function stubWebauthnHang(page) {
    await page.evaluate(() => {
      window.__pkArgs = null;
      window.__pkReject = null;
      try {
        navigator.credentials.get = function (opts) {
          const pk = (opts && opts.publicKey) || {};
          window.__pkArgs = {
            timeout: pk.timeout,
            hasSignal: !!(pk.signal instanceof AbortSignal),
          };
          return new Promise(function (resolve, reject) {
            window.__pkReject = reject;
          });
        };
      } catch (e) {}
    });
  }

  for (const lang of ['zh', 'en']) {
    test(`pkAuth: get 时弹层隐藏 / timeout 30000+signal / NotAllowedError→「${lang === 'zh' ? '已取消' : 'Cancelled'}」/ 恢复可见+重试按钮 [${lang}]`, async ({ page }) => {
      const T = lang === 'zh'
        ? { cancelled: '已取消', failed: '通行密钥验证失败', retry: '重试', usePw: '使用密码' }
        : { cancelled: 'Cancelled', failed: 'Passkey verification failed', retry: 'Retry', usePw: 'Use password' };
      /* 注意：不能 freezeTime——cancelled 判定依赖 Date.now() 的真实流逝（elapsed≥2s） */
      await setupUnlockMocks(page, lang);
      await gotoLock(page);
      await stubWebauthnHang(page);
      await choosePasskey(page);
      /* 等 get 被调用（challenge 取回后） */
      await page.waitForFunction(() => !!window.__pkArgs, null, { timeout: 8000 });
      /* ① get 进行中：验证弹层不可见（visibility hidden，不是 display none） */
      const visDuring = await page.evaluate(() => {
        const d = document.querySelector('.sgx-verify-dlg');
        return d ? window.getComputedStyle(d).visibility : 'missing';
      });
      expect(visDuring, 'get 进行中弹层应隐藏').toBe('hidden');
      /* ② 传给 get 的 timeout 是 30000，并且带了 signal */
      const args = await page.evaluate(() => window.__pkArgs);
      expect(args.timeout, 'timeout 应为 30000').toBe(30000);
      expect(args.hasSignal, '应带 AbortSignal').toBe(true);
      /* ③ 2.5s 后抛 NotAllowedError（elapsed≥2s → kind cancelled） */
      await page.evaluate(() => {
        setTimeout(() => {
          window.__pkReject(new DOMException('User cancelled', 'NotAllowedError'));
        }, 2500);
      });
      const failTx = page.locator('.sgx-verify-failtx');
      await expect(failTx, '应显示已取消文案').toContainText(T.cancelled, { timeout: 10000 });
      const failText = await failTx.textContent();
      expect(failText, '不应显示旧的「通行密钥验证失败」').not.toContain(T.failed);
      /* ④ 失败后弹层恢复可见，且有「重试」和「使用密码」 */
      const visAfter = await page.evaluate(() => {
        const d = document.querySelector('.sgx-verify-dlg');
        return d ? d.style.visibility : 'missing';
      });
      expect(visAfter, '失败后弹层应恢复可见').toBe('');
      await expect(page.locator('#sgx-pk-retry'), '应有重试按钮').toContainText(T.retry);
      await expect(page.locator('#sgx-pk-topw'), '应有使用密码按钮').toContainText(T.usePw);
    });
  }
});
