/**
 * Hark：锁屏专用测试（与视觉回归/Lighthouse 分离）。
 * lock-v10 命令解锁（2026-11-08）：锁屏上没有弹层，解锁 = 在终端输入行敲命令（password / passkey / tempkey / reset / help / clear）。
 * - 未解锁时锁屏覆盖内容（无法交互）；?lock=1 强制触发锁屏
 * - 各命令的真实行为（接口 mock）：密码 / 临时钥匙 / 通行密钥 / 重置登录 / 冷却 / 出错 / 会话确认
 *
 * 注意：这些测试需要锁屏启用的构建（生产构建）；CI 的 visual/Lighthouse
 * 用 SGX_TEST_NO_LOCK=1 的构建，两者分离。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');
const { gotoLockTerm, lockCmd, lockMode, badLine } = require('../helpers/lock-term.cjs');
/* 2026-11 UI 重设计 PR-1：旧截图基线已删除（普通提交，不改历史），新精简基线在重设计最后一个 PR 重拍；
   在那之前不比截图（SHOTS = false），同一用例里的布局 / 行为断言照跑。重拍时改回 true。 */
const SHOTS = false;

/* Hark：CI 里 networkidle 可能永远等不到，改用 domcontentloaded + 等锁屏元素出现 */
async function gotoLock(page) {
  await gotoLockTerm(page, '/?lock=1');
}
const NOBYPASS = '/?lock=1&test-no-local-bypass=1';
/** 锁屏上不许出现任何弹层（底部弹层、验证对话框、<dialog>） */
async function expectNoPopups(page) {
  /* 页面自己的抽屉（导航 / 快捷面板 / AI 的 <dialog>）不算：它们在锁屏下面、打不开 */
  await expect(page.locator('#sgx-method-sheet, .sgx-verify-dlg, .sgx-sheet-backdrop, #sgx-lock dialog, dialog[open]')).toHaveCount(0);
}
/* 只在没选过语言时写 zh（测试里点底部 en 换语言后，下一次导航不再被改回去） */
const zh = async (page) => page.addInitScript(() => { try { if (!localStorage.getItem('sgx-lang')) localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });

test.describe('lock screen', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
  });

  test('?lock=1 forces lock screen on any page', async ({ page }) => {
    await freezeTime(page);
    await gotoLock(page);
    const box = await page.locator('#sgx-lock').boundingBox();
    expect(box.width).toBeGreaterThan(300);
  });

  test('lock screen baseline screenshot', async ({ page }) => {
    await freezeTime(page);
    await page.setViewportSize({ width: 412, height: 915 });
    await gotoLock(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    if (SHOTS) await expect(page).toHaveScreenshot('lock-screen.png', { animations: 'disabled' });
  });

  test('tempkey on localhost unlocks (local fallback)', async ({ page }) => {
    await freezeTime(page);
    /* localhost 本地回退：tempkey 命令直接开锁（本地没有后端，不输临时钥匙） */
    await gotoLock(page);
    await lockCmd(page, 'tempkey');
    await expect(page.locator('#sgx-lock')).toBeHidden({ timeout: 5000 });
  });

  test('password command: the same input line becomes `[sudo] password for …:` (masked, password-manager friendly), no popups', async ({ page }) => {
    await freezeTime(page);
    await gotoLock(page);
    const input = page.locator('#sgx-lock-cmd');
    await expect(input).toHaveAttribute('type', 'text');
    await expect(input).toHaveAttribute('aria-label', /.+/);
    await lockCmd(page, 'password');
    await lockMode(page, 'pw');
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveAttribute('autocomplete', 'current-password');
    await expect(input).toBeFocused();
    await expect(page.locator('#sgx-lock-pmu')).toHaveAttribute('autocomplete', 'username');
    await expect(page.locator('#sgx-lock-pmu')).toHaveValue('LockKey');
    await expect(page.locator('#sgx-lock-ps')).toHaveText(/^\[sudo\] password for \S+: $/);
    await expect(page.locator('#sgx-lock-hint')).toBeVisible();
    await expect(page.locator('#sgx-lock-log')).toContainText('styrigx@space:~$ password');
    await expectNoPopups(page);
  });

  test('wrong password prints `✗ permission denied · …` and re-prompts (mocked API)', async ({ page }) => {
    await freezeTime(page);
    await page.route('**/api/lock-password', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.action === 'verify') {
        await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'wrong' }) });
      } else {
        await route.continue();
      }
    });
    await gotoLock(page);
    await lockCmd(page, 'password');
    await lockMode(page, 'pw');
    await lockCmd(page, 'wrongpassword123');
    await expect(badLine(page)).toHaveText(/^✗ permission denied · (密码错误|Wrong password)/i, { timeout: 10000 });
    /* 像 sudo 一样再问一次：还在密码态，输入行清空；密码从不出现在终端输出里 */
    await lockMode(page, 'pw');
    await expect(page.locator('#sgx-lock-cmd')).toHaveValue('');
    await expect(page.locator('#sgx-lock-log')).not.toContainText('wrongpassword123');
    /* 读屏区域播报同样的出错文字 */
    await expect(page.locator('#sgx-lock-live')).toContainText('permission denied');
  });

  /* 2026-10-23：临时钥匙 = 输入临时钥匙（取代 Turnstile）。test-no-local-bypass 让 localhost 也走线上逻辑 */
  test('tempkey — empty / wrong key print errors, right key unlocks (mocked API)', async ({ page }) => {
    await freezeTime(page);
    const seen = [];
    await page.route('**/api/lock-tempkey-unlock', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      seen.push(body.code);
      const ok = body.code === 'abcd-efgh-jkmn';
      await route.fulfill({ status: ok ? 200 : 403, contentType: 'application/json',
        body: JSON.stringify(ok ? { ok: true } : { ok: false, error: 'wrong' }) });
    });
    await zh(page);
    await gotoLockTerm(page, NOBYPASS);
    await lockCmd(page, 'tempkey');
    await lockMode(page, 'temp');
    const input = page.locator('#sgx-lock-cmd');
    await expect(input).toHaveAttribute('autocomplete', 'off');
    await expect(input).toHaveAttribute('type', 'password');
    await expect(page.locator('#sgx-lock-ps')).toHaveText('tempkey: ');
    await expect(page.locator('#sgx-lock')).not.toContainText(/Cloudflare|机器人/);
    /* 空着回车：提示输入，不发请求 */
    await input.press('Enter');
    await expect(badLine(page)).toHaveText('✗ 请输入临时钥匙');
    expect(seen).toEqual([]);
    await lockCmd(page, 'AAAA-BBBB-CCCC');
    await expect(badLine(page)).toHaveText('✗ permission denied · 临时钥匙无效或已过期', { timeout: 10000 });
    await expect(input).toHaveValue('');
    await lockCmd(page, 'abcd-efgh-jkmn');
    expect(await page.evaluate(() => typeof window.turnstile)).toBe('undefined');
    await expect.poll(() => seen.length).toBe(2);
    await expect(page.locator('#sgx-lock-log')).not.toContainText('AAAA-BBBB-CCCC');
  });

  test('tempkey locked out (429): countdown printed in the terminal, input read-only (mocked API)', async ({ page }) => {
    await freezeTime(page);
    await page.route('**/api/lock-tempkey-unlock', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: '{"ok":false,"error":"cooldown"}' }));
    await zh(page);
    await gotoLockTerm(page, NOBYPASS);
    await lockCmd(page, 'tempkey');
    await lockCmd(page, 'AAAA-BBBB-CCCC');
    await expect(badLine(page)).toHaveText('✗ permission denied · 尝试次数过多', { timeout: 10000 });
    await expect(page.locator('#sgx-lock-log .sgx-lock-lcd')).toHaveText(/› 15 分钟后可再试/);
    await expect(page.locator('#sgx-lock-cmd')).toHaveJSProperty('readOnly', true);
    /* Ctrl+C 回命令行；再敲 tempkey 仍在冷却 */
    await page.locator('#sgx-lock-cmd').press('Control+c');
    await lockMode(page, 'cmd');
    await lockCmd(page, 'tempkey');
    await expect(page.locator('#sgx-lock-log .sgx-lock-lcd')).toHaveText(/› 15 分钟后可再试/);
  });

  test('locked out after 5 wrong attempts (mocked API)', async ({ page }) => {
    await freezeTime(page);
    let attempts = 0;
    await page.route('**/api/lock-password', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.action === 'verify') {
        attempts++;
        if (attempts >= 5) {
          await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'cooldown', retryAfter: 30 }) });
        } else {
          await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'wrong' }) });
        }
      } else {
        await route.continue();
      }
    });
    await gotoLock(page);
    await lockCmd(page, 'password');
    for (let i = 0; i < 5; i++) {
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/lock-password')),
        lockCmd(page, 'wrong' + i),
      ]);
      if (i < 4) await expect(badLine(page)).toHaveText(/密码错误|Wrong password/i);
    }
    expect(attempts).toBe(5);
    await expect(badLine(page)).toHaveText(/尝试次数过多|Too many/i, { timeout: 10000 });
    await expect(page.locator('#sgx-lock-log .sgx-lock-lcd')).toHaveText(/› ((30|29) 秒后可再试|Try again in (30|29)s)/);
    await expect(page.locator('#sgx-lock-cmd')).toHaveJSProperty('readOnly', true);
  });

  /* 2026-10-21：带 return 解锁后，前端问 /api/lock-session-check?return=，照服务端给的 next 跳 */
  test('unlock with ?return= goes to server-provided next (no reload of the lock URL)', async ({ page }) => {
    await freezeTime(page);
    let unlocked = false;
    const checks = [];
    await page.route('**/api/lock-password', async (route) => {
      unlocked = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/api/lock-session-check*', async (route) => {
      checks.push(route.request().url());
      if (!unlocked) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, by: 'password', exp: Date.now() + 43200e3, next: '/theme/' }) });
    });
    await gotoLockTerm(page, '/?lock=1&return=' + encodeURIComponent('/theme/') + '&test-no-local-bypass=1');
    await lockCmd(page, 'sudo');
    await lockMode(page, 'pw');
    await lockCmd(page, 'correctpassword');
    await page.waitForURL(/\/theme\/$/, { timeout: 10000 });
    expect(checks.some((u) => u.includes('return=' + encodeURIComponent('/theme/')))).toBe(true);
  });

  test('lock screen rechecks session on focus (401 keeps lock)', async ({ page }) => {
    await freezeTime(page);
    let fetchCount = 0;
    await page.route('**/api/lock-session-check*', async (route) => {
      fetchCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false }),
      });
    });
    const ret = encodeURIComponent('/theme/');
    await page.goto('/?lock=1&return=' + ret + '&test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    /* dispatch focus → recheckSession → fetch → 401 → 锁屏保持 */
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
    await page.waitForFunction(() => new Promise((resolve) => setTimeout(resolve, 1500)), null, { timeout: 10000 });
    expect(fetchCount).toBeGreaterThan(0);
    await expect(page.locator('#sgx-lock')).toBeVisible();
  });

  test('session-check 401 keeps lock screen (fail-closed): error printed, back to the prompt', async ({ page }) => {
    await freezeTime(page);
    await page.route('**/api/lock-password', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/api/lock-session-check*', async (route) => {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    });
    await gotoLockTerm(page, NOBYPASS);
    await lockCmd(page, 'password');
    await lockCmd(page, 'correctpassword');
    await expect(badLine(page)).toHaveText(/permission denied · (会话未生效|The session was not recognized)/, { timeout: 10000 });
    await expect(page.locator('#sgx-lock')).toBeVisible();
    await lockMode(page, 'cmd');
    await expect(page.locator('#sgx-lock-st')).toHaveAttribute('data-st', 'denied');
  });
});

test.describe('命令解锁：终端行为（help / 不认识的命令 / clear / 历史 / Tab / Ctrl+C / 快捷键）', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await freezeTime(page);
    await page.route('**/api/lock-entry', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"passkey":true,"password":true}' }));
  });

  test('help 列出命令；不认识的命令 → command not found；clear 清屏', async ({ page }) => {
    await gotoLock(page);
    await expect(page.locator('#sgx-lock-log')).toContainText('help');
    await lockCmd(page, 'help');
    const keys = page.locator('#sgx-lock-log .sgx-lock-hk');
    await expect(keys).toHaveText(['password', 'passkey', 'tempkey', 'reset', 'clear', 'help']);
    await expect(page.locator('#sgx-lock-log')).toContainText('无法登录？重置登录');
    await lockCmd(page, 'foo bar');
    await expect(badLine(page)).toHaveText('command not found: foo · try help');
    await lockCmd(page, 'clear');
    await expect(page.locator('#sgx-lock-log .sgx-lock-hk')).toHaveCount(0);
    await expect(page.locator('#sgx-lock-log')).toContainText('styrigx space os 1.0 tty1');
    await expectNoPopups(page);
  });

  test('↑ / ↓ 历史；Tab 补全；Ctrl+C 从密码态回到命令行（打印 ^C）', async ({ page }) => {
    await gotoLock(page);
    const input = page.locator('#sgx-lock-cmd');
    await lockCmd(page, 'help');
    await lockCmd(page, 'clear');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('clear');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('help');
    await input.press('ArrowDown');
    await expect(input).toHaveValue('clear');
    await input.fill('temp');
    await input.press('Tab');
    await expect(input).toHaveValue('tempkey');
    await input.fill('pas');
    await input.press('Tab');
    await expect(input).toHaveValue('pass');
    await lockCmd(page, 'password');
    await lockMode(page, 'pw');
    await expect(page.locator('#sgx-lock-title')).toHaveText('解锁屏幕');
    await input.press('Control+c');
    await lockMode(page, 'cmd');
    await expect(page.locator('#sgx-lock-log > div').last()).toContainText('^C');
    await expect(page.locator('#sgx-lock-title')).toHaveText('锁定屏幕');
    /* Esc 同样退出 */
    await lockCmd(page, 'reset');
    await lockMode(page, 'rkey');
    await input.press('Escape');
    await lockMode(page, 'cmd');
  });

  test('快捷键 = 替你敲命令：password 键 → `sudo spacekey password` → 密码态（高亮）；点了轻震 10ms', async ({ page }) => {
    await page.addInitScript(() => {
      window.__vibCalls = [];
      navigator.vibrate = (ms) => { window.__vibCalls.push(ms); return true; };
    });
    await gotoLock(page);
    await expect(page.locator('#sgx-lock-k-pw')).toBeVisible();
    await expect(page.locator('#sgx-lock-qh')).toHaveText('# 不想打命令？点一下自动输入');
    await page.click('#sgx-lock-k-pw');
    await lockMode(page, 'pw');
    await expect(page.locator('#sgx-lock-log')).toContainText('sudo spacekey password');
    await expect(page.locator('#sgx-lock-k-pw')).toHaveClass(/is-on/);
    expect(await page.evaluate(() => window.__vibCalls)).toEqual([10]);
    /* 点「Ctrl+C」（触屏没有 Ctrl 键）回命令行 */
    await page.click('#sgx-lock-cc');
    await lockMode(page, 'cmd');
    await expect(page.locator('#sgx-lock-k-pw')).not.toHaveClass(/is-on/);
  });

  test('焦点不在输入框时直接打字也进输入行', async ({ page }) => {
    await gotoLock(page);
    await page.locator('#sgx-lock-cmd').blur();
    await page.keyboard.type('help');
    await expect(page.locator('#sgx-lock-cmd')).toBeFocused();
    await expect(page.locator('#sgx-lock-cmd')).toHaveValue('help');
  });
});

test.describe('A-2 锁屏凭证清空态 / 启动站', () => {
  /* 账号拆分 PR3：lock-entry 只回锁屏自己的 passkey / password（resetOnly / accountConfigured 已删），
     「清空态」就是两项都是 false；多带的旧字段前端不认 */
  test('锁屏凭证清空：快捷键不显示，help 只剩 tempkey / reset，password / passkey 命令提示未设置', async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await freezeTime(page);
    await page.route('**/api/lock-entry', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, passkey: false, password: false, accountConfigured: true, resetOnly: true }) });
    });
    await gotoLock(page);
    await expect(page.locator('#sgx-lock-k-pw')).toBeHidden();
    await expect(page.locator('#sgx-lock-k-pk')).toBeHidden();
    await expect(page.locator('#sgx-lock-qh')).toBeHidden();
    await lockCmd(page, 'help');
    await expect(page.locator('#sgx-lock-log .sgx-lock-hk')).toHaveText(['tempkey', 'reset', 'clear', 'help']);
    await lockCmd(page, 'password');
    await expect(badLine(page)).toHaveText('✗ 尚未设置密码');
    await lockMode(page, 'cmd');
    await lockCmd(page, 'passkey');
    await expect(badLine(page)).toHaveText('✗ 通行密钥未设置，或这台设备不支持');
  });

  test('启动站（lock-entry 全 false）：reset → 进站凭证走 /api/space-auth { purpose:lock-reset } → 锁屏凭证页设第一把', async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await freezeTime(page);
    await page.route('**/api/lock-entry', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, passkey: false, password: false }) });
    });
    const calls = [];
    await page.route('**/api/space-auth', async (route) => {
      calls.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.route('**/security/lock/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p id="landed">ok</p>' }));
    await gotoLock(page);
    await lockCmd(page, 'reset');
    await lockMode(page, 'rkey');
    await expect(page.locator('#sgx-lock-log')).toContainText('重置登录');
    await lockCmd(page, 'root-key');
    await expect(page.locator('#landed')).toBeVisible({ timeout: 8000 });
    expect(calls).toEqual([{ key: 'root-key', purpose: 'lock-reset' }]);
  });
});

test.describe('PR3 锁屏：无法登录？→ reset 命令在终端里重置登录', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await freezeTime(page);
  });

  /* 账号拆分 PR3：第 2 步是锁屏凭证（lockProof；网关不读账号凭证），服务端回 needLock */
  test('进站凭证 → needLock → 列出锁屏凭证（解锁密码 / 锁屏通行密钥，不出现旧角色名和「账号」字样）→ 解锁密码通过 → /security/lock/', async ({ page }) => {
    const bodies = [];
    await page.route('**/api/lock-reset', async (route) => {
      const b = JSON.parse(route.request().postData() || '{}');
      bodies.push(b);
      if (b.lockProof) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, needLock: true, passkey: true, password: true }) });
    });
    await page.route('**/security/lock/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p id="landed">ok</p>' }));
    await gotoLock(page);
    await lockCmd(page, 'forgot');
    await lockMode(page, 'rkey');
    await expect(page.locator('#sgx-lock-pmu')).toHaveValue('SpaceKey');
    await expect(page.locator('#sgx-lock-cmd')).toHaveAttribute('type', 'password');
    await expect(page.locator('#sgx-lock-ps')).toHaveText('spacekey: ');
    await lockCmd(page, 'root-key');
    await lockMode(page, 'rpick');
    const log = page.locator('#sgx-lock-log');
    await expect(log).toContainText('[1] password 解锁密码');
    await expect(log).toContainText('[2] passkey 锁屏通行密钥');
    await expect(log).not.toContainText('管理员'); // old-name guard
    await expect(log).not.toContainText('账号');
    await expect(log).not.toContainText('root-key');
    await lockCmd(page, '9');
    await expect(badLine(page)).toHaveText('✗ 请输入列出的编号');
    await lockCmd(page, '1');
    await lockMode(page, 'rpw');
    await expect(page.locator('#sgx-lock-pmu')).toHaveValue('LockKey');
    await lockCmd(page, 'lock-pw');
    await expect(page.locator('#landed')).toBeVisible({ timeout: 8000 });
    expect(bodies[0]).toEqual({ action: 'verify', spaceKey: 'root-key' });
    expect(bodies[1]).toEqual({ action: 'verify', spaceKey: 'root-key', lockProof: { type: 'password', password: 'lock-pw' } });
    await expectNoPopups(page);
  });

  test('恢复开关有效（verify 直接 ok）→ 不要锁屏凭证，直接去锁屏凭证页；进站凭证错误 → 「验证失败」、留在这一步并清空', async ({ page }) => {
    let n = 0;
    await page.route('**/api/lock-reset', async (route) => {
      n++;
      if (n === 1) {
        await route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"auth"}' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.route('**/security/lock/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p id="landed">ok</p>' }));
    await gotoLock(page);
    await lockCmd(page, 'reset');
    await lockCmd(page, 'wrong');
    await expect(badLine(page)).toHaveText('✗ permission denied · 验证失败');
    await lockMode(page, 'rkey');
    await expect(page.locator('#sgx-lock-cmd')).toHaveValue('');
    await lockCmd(page, 'right');
    await expect(page.locator('#landed')).toBeVisible({ timeout: 8000 });
  });
});

test.describe('锁屏版面（lock-v10 设计稿 K1：头像 → 状态 → 名字 → 欢迎语 → 终端 → 底部 zh · en）', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
  });

  test('版面（2026-11 PR-A 照稿：锁屏没有顶栏）：头像（不可点）→ 欢迎回来 / 很高兴再次见到你 → 终端（命令输入行）；没有顶栏、解锁按钮、弹层、时钟和日刻', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await gotoLock(page);
    const lock = page.locator('#sgx-lock');
    await expect(lock.locator('.sgx-glass-bg')).toHaveCount(1);
    /* 标题节点还在（lock.js 照写「锁定屏幕 / 解锁屏幕」），但整条顶栏不显示 */
    await expect(page.locator('#sgx-lock-title')).toHaveText('锁定屏幕');
    await expect(lock.locator('.sgx-lock-tb')).toBeHidden();
    await expect(lock.locator('.sgx-wordmark:visible, .sgx-tb-logo:visible, .sgx-tb-btn:visible')).toHaveCount(0);
    await expect(lock).not.toContainText('Personal');
    await expect(lock.locator('.sgx-lock-welcome')).toHaveText('欢迎回来');
    await expect(lock.locator('.sgx-lock-sub')).toHaveText('很高兴再次见到你');
    await expect(page.locator('#sgx-lock-go')).toHaveCount(0);
    await expect(lock.locator('button#sgx-lock-avatar, #sgx-lock-avatar[role="button"]')).toHaveCount(0);
    await expect(page.locator('#sgx-lock-clock')).toHaveCount(0);
    await expect(page.locator('#sgx-lock-dm')).toHaveCount(0);
    await expectNoPopups(page);
    /* 点头像不会打开任何东西 */
    await page.locator('#sgx-lock-avatar').click({ force: true });
    await expectNoPopups(page);
    /* 顺序：头像在终端上面；底部 zh · en */
    const u = await page.locator('#sgx-lock-avatar').boundingBox();
    const t = await page.locator('#sgx-lock-term').boundingBox();
    expect(u.y).toBeGreaterThan(0);
    expect(u.y + u.height).toBeLessThan(t.y);
    await expect(page.locator('.sgx-lock-lang')).toHaveText(['zh', 'en']);
    await expect(page.locator('.sgx-lock-lang[data-lang="zh"]')).toHaveAttribute('aria-current', 'true');
  });

  test('英文：Lock screen / Good to see you again / 输入行英文标签', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await page.goto('/?lock=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock-title')).toHaveText('Lock screen');
    await expect(page.locator('#sgx-lock .sgx-lock-sub')).toHaveText('Good to see you again');
    await expect(page.locator('#sgx-lock-cmd')).toHaveAttribute('aria-label', /^Unlock terminal/);
  });

  test('底部 zh · en：点 en 写语言偏好并换到英文同一页（lock / return 原样）', async ({ page }) => {
    await page.goto('/zh/?lock=1&return=' + encodeURIComponent('/theme/'), { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-lock-cmd')).toBeVisible({ timeout: 15000 });
    await page.click('.sgx-lock-lang[data-lang="en"]');
    await page.waitForURL((u) => u.pathname === '/' && u.searchParams.get('lock') === '1' && u.searchParams.get('return') === '/theme/', { timeout: 10000 });
    expect(await page.evaluate(() => localStorage.getItem('sgx-lang'))).toBe('en');
    await expect(page.locator('#sgx-lock-title')).toHaveText('Lock screen');
  });

  test('锁定时 NAVIGATE / 外观 / AI 按钮点不到（锁屏盖住整页；AI 浮钮被挤出视口也算点不到）', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await gotoLock(page);
    await expect(page.locator('#sgx-lock .sgx-lock-tb button, #sgx-lock .sgx-lock-tb a')).toHaveCount(0);
    for (const sel of ['[aria-controls="sgx-nav"]', '[aria-controls="sgx-qp"]', '[aria-controls="sgx-ai"]']) {
      const btn = page.locator(sel).first();
      expect(await btn.count()).toBeGreaterThan(0);
      const box = await btn.boundingBox();
      if (!box) continue;
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        /* 点在视口外（elementFromPoint 为 null）= 点不到 */
        return !el || !!el.closest('#sgx-lock');
      }, [box.x + box.width / 2, box.y + box.height / 2]);
      expect(hit).toBe(true);
    }
  });

  test('锁屏没有顶栏（2026-11 PR-A，设计稿 02:48 定）：看不到字标 / 页名胶囊 / 外观 · 盾牌 · >_；底 = 纯色 --sgx-bg-1 + 44px 网格，没有主题色光晕', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await gotoLock(page);
    const lock = page.locator('#sgx-lock');
    await expect(lock.locator('.sgx-lock-tb')).toBeHidden();
    expect(await lock.locator('.sgx-lock-tb').evaluate((el) => getComputedStyle(el).display)).toBe('none');
    /* 整页（含锁屏下面的全站顶栏）在锁屏范围里看不到任何顶栏控件：锁屏盖住整页 */
    for (const sel of ['.sgx-tb-logo', '.sgx-tb-pill', '.sgx-tb-quick', '.sgx-tb-shield', '.sgx-tb-grid']) {
      const hits = await page.evaluate((q) => Array.from(document.querySelectorAll(q)).some((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
        const top = document.elementFromPoint(x, y);
        return !!top && (top === el || el.contains(top));
      }), sel);
      expect(hits, sel).toBe(false);
    }
    /* 底：锁屏和背景层都是 --sgx-bg-1 纯色；网格 = --sgx-grid（44px）；没有 ::after 光晕 */
    const bg = await page.evaluate(() => {
      const L = document.getElementById('sgx-lock'), g = L.querySelector('.sgx-glass-bg');
      const probe = document.createElement('div'); probe.style.background = 'var(--sgx-bg-1)'; document.body.appendChild(probe);
      const bg1 = getComputedStyle(probe).backgroundColor; probe.remove();
      const before = getComputedStyle(g, '::before'), after = getComputedStyle(g, '::after');
      return { lock: getComputedStyle(L).backgroundColor, glass: getComputedStyle(g).backgroundColor, bg1,
        img: before.backgroundImage, size: before.backgroundSize, after: after.content === 'none' || after.content === '' ? 'none' : after.backgroundImage };
    });
    expect(bg.lock).toBe(bg.bg1);
    expect(bg.glass).toBe(bg.bg1);
    expect(bg.img).toContain('linear-gradient');
    expect(bg.img).not.toContain('radial-gradient');
    expect(bg.size).toContain('44px');
    expect(bg.after).toBe('none');
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
      if (SHOTS) await expect(page).toHaveScreenshot(`lock-screen-glass-${theme}.png`, { animations: 'disabled' });
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
    await page.route('**/api/lock-passkey', async (route) => {
      let body = {};
      try { body = route.request().postDataJSON() || {}; } catch (e) {}
      if (body.action === 'challenge') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, challenge: CHALLENGE_B64, allowCredentials: [], cid: 'c1' }) });
        return;
      }
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
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
          window.__pkArgs = { timeout: pk.timeout, hasSignal: !!(opts && opts.signal instanceof AbortSignal), signalInPublicKey: 'signal' in pk };
          return new Promise(function (resolve, reject) { window.__pkReject = reject; });
        };
      } catch (e) {}
    });
  }

  for (const lang of ['zh', 'en']) {
    test(`passkey 命令：终端「等待通行密钥」/ timeout 30000+signal / NotAllowedError→「${lang === 'zh' ? '已取消' : 'Cancelled'}」/ 回到命令行可重试 [${lang}]`, async ({ page }) => {
      const T = lang === 'zh'
        ? { cancelled: '已取消', failed: '通行密钥验证失败', wait: '等待通行密钥' }
        : { cancelled: 'Cancelled', failed: 'Passkey verification failed', wait: 'waiting for passkey' };
      /* 注意：不能 freezeTime——cancelled 判定依赖 Date.now() 的真实流逝（elapsed≥2s） */
      await setupUnlockMocks(page, lang);
      await gotoLock(page);
      await stubWebauthnHang(page);
      await lockCmd(page, 'passkey');
      await page.waitForFunction(() => !!window.__pkArgs, null, { timeout: 8000 });
      /* ① get 进行中：终端显示等待（设计稿 K4），输入行收起、状态 VERIFYING；没有任何弹层 */
      await lockMode(page, 'busy');
      await expect(page.locator('#sgx-lock-log')).toContainText(T.wait);
      await expect(page.locator('#sgx-lock-st')).toHaveAttribute('data-st', 'verifying');
      await expect(page.locator('#sgx-lock-k-pk')).toHaveClass(/is-on/);
      await expectNoPopups(page);
      /* ② 传给 get 的 timeout 是 30000，并且顶层带了 signal（不在 publicKey 里） */
      const args = await page.evaluate(() => window.__pkArgs);
      expect(args.timeout, 'timeout 应为 30000').toBe(30000);
      expect(args.hasSignal, '顶层应带 AbortSignal').toBe(true);
      expect(args.signalInPublicKey, 'publicKey 里不应有 signal').toBe(false);
      /* ③ 2.5s 后抛 NotAllowedError（elapsed≥2s → kind cancelled） */
      await page.evaluate(() => {
        setTimeout(() => { window.__pkReject(new DOMException('User cancelled', 'NotAllowedError')); }, 2500);
      });
      await expect(badLine(page), '应显示已取消文案').toContainText(T.cancelled, { timeout: 10000 });
      expect(await badLine(page).textContent(), '不应显示旧的「通行密钥验证失败」').not.toContain(T.failed);
      /* ④ 回到命令行：可以再敲 passkey 或换 password */
      await lockMode(page, 'cmd');
      await expect(page.locator('#sgx-lock-k-pk')).toBeVisible();
      await lockCmd(page, 'password');
      await lockMode(page, 'pw');
    });
  }
});
