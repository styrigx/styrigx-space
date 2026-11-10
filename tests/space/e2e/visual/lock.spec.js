/**
 * Hark：锁屏专用测试（与视觉回归/Lighthouse 分离）。
 * 进站 v3 L1（SPACE-V3 §2.2 A / B，2026-11-09）：锁屏 = 全屏终端 entry@space:~$，没有弹层、没有快捷键按钮。
 * - `sudo styrigx` → [pick] 只列设了的 passkey / password，tempkey 一直在；`sudo styrigx passkey|password|tempkey` 直达
 * - `sudo styrigx reset` → `[sudo] recovery key:` → reset 终端 reset@space:~#（passwd / passkey ls|add|rm / exit），第一次改动后两选
 * - help / man styrigx / clear；不认识的（含旧别名 password / tempkey / reset / cd ..）→ command not found
 * - 三次规则：输错 `Sorry, try again.` 再问；第 3 次 `sudo: 3 incorrect password attempts` 回命令行
 * DOM 是 entry：#sgx-entry*、.sgx-entry-*（shell/space/entry.js、term.js）。接口照旧（/api/lock-*，L2 换 /api/space/*）。
 *
 * 注意：这些测试需要锁屏启用的构建（生产构建）；CI 的 visual/Lighthouse
 * 用 SGX_TEST_NO_LOCK=1 的构建，两者分离。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');
const { ENTRY_URL, gotoLockTerm, lockCmd, lockMode, lockPick, badLine, lastLine } = require('../helpers/lock-term.cjs');
/* 2026-11 UI 重设计 PR-1：旧截图基线已删除（普通提交，不改历史），新精简基线在重设计最后一个 PR 重拍；
   在那之前不比截图（SHOTS = false），同一用例里的布局 / 行为断言照跑。重拍时改回 true。 */
const SHOTS = false;

/* Hark：CI 里 networkidle 可能永远等不到，改用 domcontentloaded + 等锁屏元素出现 */
async function gotoLock(page) {
  await gotoLockTerm(page, ENTRY_URL);
}
const NOBYPASS = ENTRY_URL + '&test-no-local-bypass=1';
const log = (page) => page.locator('#sgx-entry-log');
/** 锁屏上不许出现任何弹层（底部弹层、验证对话框、<dialog>） */
async function expectNoPopups(page) {
  /* 页面自己的抽屉（导航 / 快捷面板 / AI 的 <dialog>）不算：它们在锁屏下面、打不开 */
  await expect(page.locator('#sgx-method-sheet, .sgx-verify-dlg, .sgx-sheet-backdrop, #sgx-entry dialog, dialog[open]')).toHaveCount(0);
}
/* 只在没选过语言时写 zh（测试里点底部 en 换语言后，下一次导航不再被改回去） */
const zh = async (page) => page.addInitScript(() => { try { if (!localStorage.getItem('sgx-lang')) localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

test.describe('lock screen', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
  });

  test('?entry=1 forces lock screen on any page', async ({ page }) => {
    await freezeTime(page);
    await gotoLock(page);
    const box = await page.locator('#sgx-entry').boundingBox();
    expect(box.width).toBeGreaterThan(300);
    await expect(page.locator('#sgx-entry-ps')).toHaveText('entry@space:~$');
  });

  /* v5 S3 整站放开：访客页（网关标记 locked）内容照常、顶栏照常，不画锁屏；锁屏只在 ?entry 时出现 */
  const asVisitor = (page, path) => page.route((u) => u.pathname === path, async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace(/<html(\s|>)/, '<html data-sgx-lock-session="locked"$1');
    await route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });

  test('v5 S3：访客页面不画锁屏（没有遮罩、顶栏可见、内容可读）', async ({ page }) => {
    await asVisitor(page, '/wild/');
    await page.goto('/wild/?test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
    await expect(page.locator('#site-nav .sgx-topbar')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#screen-time')).toBeVisible();
    await expect(page.locator('#sgx-entry, #sgx-entry-cover')).toHaveCount(0);
  });

  test('v5 S3：访客在顶栏终端敲 sudo styrigx → 锁屏（?entry=sudo&return=原页）自动接着跑 sudo styrigx', async ({ page }) => {
    await zh(page);
    await asVisitor(page, '/zh/wild/');
    await page.route('**/api/lock-entry', (r) => r.fulfill(json({ ok: true, passkey: true, password: true })));
    await page.route('**/api/lock-session-check*', (r) => r.fulfill(json({ ok: false }, 401)));
    await page.goto('/zh/wild/?test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#site-nav .sgx-topbar')).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('sgx:sudo')));
    const inp = page.locator('#sgx-term [data-term-in]');
    await expect(inp).toHaveValue('sudo styrigx', { timeout: 8000 });
    await inp.press('Enter');
    await page.waitForURL((u) => u.searchParams.get('entry') === 'sudo', { timeout: 10000 });
    expect(new URL(page.url()).searchParams.get('return')).toBe('/zh/wild/?test-no-local-bypass=1');
    await expect(page.locator('#sgx-entry')).toBeVisible({ timeout: 15000 });
    await lockMode(page, 'pick');
    await expect(log(page)).toContainText('sudo styrigx');
  });

  test('lock screen baseline screenshot', async ({ page }) => {
    await freezeTime(page);
    await page.setViewportSize({ width: 412, height: 915 });
    await gotoLock(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    if (SHOTS) await expect(page).toHaveScreenshot('lock-screen.png', { animations: 'disabled' });
  });

  test('sudo styrigx tempkey on localhost unlocks (local fallback)', async ({ page }) => {
    await freezeTime(page);
    /* localhost 本地回退：tempkey 直接进站（本地没有后端，不输临时钥匙） */
    await gotoLock(page);
    await lockCmd(page, 'sudo styrigx tempkey');
    await expect(page.locator('#sgx-entry')).toBeHidden({ timeout: 5000 });
  });

  test('sudo styrigx password: the same input line becomes `[sudo] password for …:` (masked, password-manager friendly), no popups', async ({ page }) => {
    await freezeTime(page);
    await gotoLock(page);
    const input = page.locator('#sgx-entry-cmd');
    await expect(input).toHaveAttribute('type', 'text');
    await expect(input).toHaveAttribute('aria-label', /.+/);
    await lockCmd(page, 'sudo styrigx password');
    await lockMode(page, 'pw');
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveAttribute('autocomplete', 'current-password');
    await expect(input).toBeFocused();
    await expect(page.locator('#sgx-entry-pmu')).toHaveAttribute('autocomplete', 'username');
    await expect(page.locator('#sgx-entry-pmu')).toHaveValue('SpacePassword');
    await expect(page.locator('#sgx-entry-ps')).toHaveText(/^\[sudo\] password for \S+:\s?$/);
    await expect(page.locator('#sgx-entry-hint')).toBeVisible();
    await expect(log(page)).toContainText('entry@space:~$ sudo styrigx password');
    await expectNoPopups(page);
  });

  test('sudo styrigx: [pick] lists passkey / password / tempkey as clickable options; picking 2 asks for the password', async ({ page }) => {
    await zh(page);
    await page.route('**/api/lock-entry', (r) => r.fulfill(json({ ok: true, passkey: true, password: true })));
    await gotoLock(page);
    await lockCmd(page, 'sudo styrigx');
    await lockMode(page, 'pick');
    await expect(log(page).locator('[data-term-pick]')).toHaveText(['[1] passkey', '[2] password', '[3] tempkey']);
    await expect(page.locator('#sgx-entry-ps')).toHaveText('选择方式 [1/2/3]:');
    /* 不在选项里的：说一声、接着选 */
    await lockCmd(page, '9');
    await expect(badLine(page)).toHaveText('没有这个选项');
    await lockMode(page, 'pick');
    await lockPick(page, '2');
    await lockMode(page, 'pw');
  });

  test('wrong password: `Sorry, try again.` and re-prompts; 3rd → `sudo: 3 incorrect password attempts` (mocked API)', async ({ page }) => {
    await freezeTime(page);
    let n = 0;
    await page.route('**/api/lock-password', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.action === 'verify') { n++; await route.fulfill(json({ ok: false, error: 'wrong' }, 403)); } else await route.continue();
    });
    await gotoLockTerm(page, NOBYPASS);
    await lockCmd(page, 'sudo styrigx password');
    await lockMode(page, 'pw');
    await lockCmd(page, 'wrongpassword123');
    await expect(badLine(page)).toHaveText('Sorry, try again.', { timeout: 10000 });
    /* 像 sudo 一样再问一次：还在密码态，输入行清空；密码从不出现在终端输出里 */
    await lockMode(page, 'pw');
    await expect(page.locator('#sgx-entry-cmd')).toHaveValue('');
    await expect(log(page)).not.toContainText('wrongpassword123');
    await expect(page.locator('#sgx-entry-st')).toHaveAttribute('data-st', 'sudo');
    await lockCmd(page, 'wrong2');
    await expect(badLine(page)).toHaveText('Sorry, try again.');
    await lockMode(page, 'pw');
    await lockCmd(page, 'wrong3');
    await expect(badLine(page)).toHaveText('sudo: 3 incorrect password attempts');
    await lockMode(page, 'cmd');
    expect(n).toBe(3);
    /* 读屏区域播报同样的出错文字 */
    await expect(page.locator('#sgx-entry-live')).toContainText('incorrect password attempts');
  });

  /* 临时钥匙：test-no-local-bypass 让 localhost 也走线上逻辑 */
  test('sudo styrigx tempkey — empty re-asks, wrong key `Sorry, try again.`, right key unlocks (mocked API)', async ({ page }) => {
    await freezeTime(page);
    const seen = [];
    await page.route('**/api/lock-tempkey-unlock', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      seen.push(body.code);
      const ok = body.code === 'abcd-efgh-jkmn';
      await route.fulfill(json(ok ? { ok: true } : { ok: false, error: 'wrong' }, ok ? 200 : 403));
    });
    await zh(page);
    await gotoLockTerm(page, NOBYPASS);
    await lockCmd(page, 'sudo styrigx tempkey');
    await lockMode(page, 'temp');
    const input = page.locator('#sgx-entry-cmd');
    await expect(input).toHaveAttribute('type', 'password');
    await expect(page.locator('#sgx-entry-ps')).toHaveText('tempkey:');
    await expect(page.locator('#sgx-entry-hint')).toContainText('XXXX-XXXX-XXXX');
    /* 空着回车：不发请求，还在 tempkey: */
    await input.press('Enter');
    await lockMode(page, 'temp');
    expect(seen).toEqual([]);
    await lockCmd(page, 'AAAA-BBBB-CCCC');
    await expect(badLine(page)).toHaveText('Sorry, try again.', { timeout: 10000 });
    await lockMode(page, 'temp');
    await expect(input).toHaveValue('');
    await lockCmd(page, 'abcd-efgh-jkmn');
    await expect.poll(() => seen.length).toBe(2);
    await expect(log(page)).not.toContainText('AAAA-BBBB-CCCC');
  });

  test('tempkey cooldown (429): `sudo: 尝试次数太多` + countdown line, back to the prompt (mocked API)', async ({ page }) => {
    await freezeTime(page);
    await page.route('**/api/lock-tempkey-unlock', (route) => route.fulfill(json({ ok: false, error: 'cooldown' }, 429)));
    await zh(page);
    await gotoLockTerm(page, NOBYPASS);
    await lockCmd(page, 'sudo styrigx tempkey');
    await lockCmd(page, 'AAAA-BBBB-CCCC');
    await expect(log(page)).toContainText('sudo: 尝试次数太多', { timeout: 10000 });
    await expect(log(page).locator('.sgx-entry-l--d').last()).toHaveText(/› 15 分钟后可再试/);
    await lockMode(page, 'cmd');
    await expect(page.locator('#sgx-entry-st')).toHaveAttribute('data-st', 'denied');
  });

  test('password cooldown (429 retryAfter 30) → countdown in seconds (mocked API)', async ({ page }) => {
    await freezeTime(page);
    await page.route('**/api/lock-password', (route) => route.fulfill(json({ ok: false, error: 'cooldown', retryAfter: 30 }, 429)));
    await zh(page);
    await gotoLockTerm(page, NOBYPASS);
    await lockCmd(page, 'sudo styrigx password');
    await lockCmd(page, 'whatever');
    await expect(log(page).locator('.sgx-entry-l--d').last()).toHaveText(/› (30|29) 秒后可再试/, { timeout: 10000 });
    await lockMode(page, 'cmd');
  });

  /* 带 return 进站后，前端问 /api/lock-session-check?return=，照服务端给的 next 跳 */
  test('unlock with ?return= goes to server-provided next (no reload of the lock URL)', async ({ page }) => {
    await freezeTime(page);
    let unlocked = false;
    const checks = [];
    await page.route('**/api/lock-password', async (route) => {
      unlocked = true;
      await route.fulfill(json({ ok: true }));
    });
    await page.route('**/api/lock-session-check*', async (route) => {
      checks.push(route.request().url());
      if (!unlocked) return route.fulfill(json({ ok: false }, 401));
      await route.fulfill(json({ ok: true, by: 'password', exp: Date.now() + 43200e3, next: '/wild/' }));
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoLockTerm(page, ENTRY_URL + '&return=' + encodeURIComponent('/wild/') + '&test-no-local-bypass=1');
    await lockCmd(page, 'sudo styrigx password');
    await lockMode(page, 'pw');
    await lockCmd(page, 'correctpassword');
    await page.waitForURL(/\/wild\/$/, { timeout: 10000 });
    expect(checks.some((u) => u.includes('return=' + encodeURIComponent('/wild/')))).toBe(true);
  });

  test('old ?lock=1 is still read by the guard (old bookmarks)', async ({ page }) => {
    await page.route('**/api/lock-session-check*', (route) => route.fulfill(json({ ok: false }, 401)));
    await page.goto('/?lock=1&test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-entry')).toBeVisible({ timeout: 15000 });
  });

  test('lock screen rechecks session on focus (401 keeps lock)', async ({ page }) => {
    await freezeTime(page);
    let fetchCount = 0;
    await page.route('**/api/lock-session-check*', async (route) => {
      fetchCount++;
      await route.fulfill(json({ ok: false }));
    });
    const ret = encodeURIComponent('/wild/');
    await page.goto(ENTRY_URL + '&return=' + ret + '&test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-entry')).toBeVisible({ timeout: 15000 });
    /* dispatch focus → recheckSession → fetch → 401 → 锁屏保持 */
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
    await page.waitForFunction(() => new Promise((resolve) => setTimeout(resolve, 1500)), null, { timeout: 10000 });
    expect(fetchCount).toBeGreaterThan(0);
    await expect(page.locator('#sgx-entry')).toBeVisible();
  });

  test('session-check 401 keeps lock screen (fail-closed): error printed, back to the prompt', async ({ page }) => {
    await freezeTime(page);
    await zh(page);
    await page.route('**/api/lock-password', (route) => route.fulfill(json({ ok: true })));
    await page.route('**/api/lock-session-check*', (route) => route.fulfill(json({ ok: false }, 401)));
    await gotoLockTerm(page, NOBYPASS);
    await lockCmd(page, 'sudo styrigx password');
    await lockCmd(page, 'correctpassword');
    await expect(badLine(page)).toHaveText('会话没有生效，请再试一次', { timeout: 10000 });
    await expect(page.locator('#sgx-entry')).toBeVisible();
    await lockMode(page, 'cmd');
    await expect(page.locator('#sgx-entry-st')).toHaveAttribute('data-st', 'denied');
  });
});

test.describe('锁屏终端：help / man styrigx / 不认识的命令 / clear / 历史 / ^C / esc', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await freezeTime(page);
    await page.route('**/api/lock-entry', (r) => r.fulfill(json({ ok: true, passkey: true, password: true })));
  });

  test('开屏两行；help 列出 sudo styrigx / sudo styrigx reset / man styrigx；旧别名 → command not found；clear 回到开屏', async ({ page }) => {
    await gotoLock(page);
    await expect(log(page).locator('> div')).toHaveText(['styrigx space os 1.0 tty1', '# 输入 sudo styrigx 进站 · help 查看全部命令']);
    await lockCmd(page, 'help');
    await expect(log(page).locator('.sgx-entry-w')).toHaveText(['help', 'sudo styrigx', 'sudo styrigx reset', 'man styrigx', 'clear']);
    await expect(log(page)).toContainText('恢复钥匙只用于 sudo styrigx reset');
    for (const old of ['password', 'tempkey', 'reset', 'sudo spacekey password', 'cd ..', 'foo bar']) {
      await lockCmd(page, old);
      await expect(badLine(page)).toHaveText('command not found: ' + old.split(' ')[0] + ' · try help');
    }
    await lockCmd(page, 'clear');
    await expect(log(page).locator('> div')).toHaveText(['styrigx space os 1.0 tty1', '# 输入 sudo styrigx 进站 · help 查看全部命令']);
    await expectNoPopups(page);
  });

  test('man styrigx：STYRIGX(1) NAME / SYNOPSIS（三条命令）/ (END)', async ({ page }) => {
    await gotoLock(page);
    await lockCmd(page, 'man styrigx');
    await expect(log(page)).toContainText('STYRIGX(1)');
    await expect(log(page)).toContainText('sudo styrigx [passkey | password | tempkey]');
    await expect(log(page)).toContainText('sudo styrigx reauth [passkey | password]');
    await expect(lastLine(page)).toHaveText('(END)');
    await lockMode(page, 'cmd');
  });

  test('↑ / ↓ 历史；^C 从密码态回到命令行（打印 ^C、标题回「锁定屏幕」）；esc 退出 recovery key', async ({ page }) => {
    await gotoLock(page);
    const input = page.locator('#sgx-entry-cmd');
    await lockCmd(page, 'help');
    await lockCmd(page, 'clear');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('clear');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('help');
    await input.press('ArrowDown');
    await expect(input).toHaveValue('clear');
    await input.fill('');
    await lockCmd(page, 'sudo styrigx password');
    await lockMode(page, 'pw');
    await expect(page.locator('#sgx-entry-title')).toHaveText('解锁屏幕');
    await input.press('Control+c');
    await lockMode(page, 'cmd');
    await expect(lastLine(page)).toContainText('^C');
    await expect(page.locator('#sgx-entry-title')).toHaveText('锁定屏幕');
    await lockCmd(page, 'sudo styrigx reset');
    await lockMode(page, 'rkey');
    await input.press('Escape');
    await lockMode(page, 'cmd');
  });

  test('触屏 ^C 键（输入行下面；只在粗指针上显示）= 退出当前命令', async ({ page }) => {
    await gotoLock(page);
    await lockCmd(page, 'sudo styrigx password');
    await lockMode(page, 'pw');
    await expect(page.locator('#sgx-entry-hint [data-term-cc]')).toBeAttached();
    await page.locator('#sgx-entry-hint [data-term-cc]').dispatchEvent('click');
    await lockMode(page, 'cmd');
  });

  test('焦点不在输入框时直接打字也进输入行', async ({ page }) => {
    await gotoLock(page);
    await page.locator('#sgx-entry-cmd').blur();
    await page.keyboard.type('help');
    await expect(page.locator('#sgx-entry-cmd')).toBeFocused();
    await expect(page.locator('#sgx-entry-cmd')).toHaveValue('help');
  });
});

test.describe('进站凭证清空态 / 启动站', () => {
  test('凭证清空（lock-entry 全 false）：sudo styrigx 只列 tempkey + 提示 reset；sudo styrigx password → 未设置 + 可用方式', async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await freezeTime(page);
    await page.route('**/api/lock-entry', (route) => route.fulfill(json({ ok: true, passkey: false, password: false })));
    await gotoLock(page);
    await lockCmd(page, 'sudo styrigx');
    await lockMode(page, 'pick');
    await expect(log(page)).toContainText('还没有进站凭证 · sudo styrigx reset');
    await expect(log(page).locator('[data-term-pick]')).toHaveText(['[1] tempkey']);
    await page.locator('#sgx-entry-cmd').press('Control+c');
    await lockMode(page, 'cmd');
    await lockCmd(page, 'sudo styrigx password');
    await expect(badLine(page)).toHaveText('password：未设置');
    await expect(log(page)).toContainText('可用：sudo styrigx tempkey');
    await lockMode(page, 'cmd');
  });
});

test.describe('sudo styrigx reset：恢复钥匙 → reset@space:~# → 改 → 两选 → 回锁屏', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await freezeTime(page);
  });

  test('恢复钥匙（SpaceRecoveryKey，不回显）错 → Sorry, try again.；对 → reset@space:~#（不签进站会话）；passwd 两次 → 两选 [1] 全部回锁屏 → finish all → 回 entry@space', async ({ page }) => {
    const resetBodies = [];
    const pwBodies = [];
    await page.route('**/api/lock-reset', async (route) => {
      const b = JSON.parse(route.request().postData() || '{}');
      resetBodies.push(b);
      if (b.action === 'verify' && b.spaceKey !== 'sk-right') return route.fulfill(json({ ok: false, error: 'auth' }, 401));
      await route.fulfill(json({ ok: true }));
    });
    await page.route('**/api/lock-password', async (route) => {
      pwBodies.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill(json({ ok: true }));
    });
    await gotoLock(page);
    await lockCmd(page, 'sudo styrigx reset');
    await lockMode(page, 'rkey');
    await expect(page.locator('#sgx-entry-pmu')).toHaveValue('SpaceRecoveryKey');
    await expect(page.locator('#sgx-entry-cmd')).toHaveAttribute('type', 'password');
    await expect(page.locator('#sgx-entry-ps')).toHaveText('[sudo] recovery key:');
    await lockCmd(page, 'sk-wrong');
    await expect(badLine(page)).toHaveText('Sorry, try again.');
    await lockMode(page, 'rkey');
    await lockCmd(page, 'sk-right');
    await expect(log(page)).toContainText('✓ verified');
    await lockMode(page, 'cmd');
    await expect(page.locator('#sgx-entry-ps')).toHaveText('reset@space:~#');
    await expect(page.locator('#sgx-entry-st')).toHaveAttribute('data-st', 'reset');
    await expect(page.locator('#sgx-entry-tty')).toHaveText(/^reset · [23]:\d\d$/);
    await expect(log(page)).not.toContainText('sk-right');
    await lockCmd(page, 'passwd');
    await lockMode(page, 'newpw');
    await lockCmd(page, 'new-pass-123');
    await lockMode(page, 'newpw2');
    await lockCmd(page, 'new-pass-123');
    await lockMode(page, 'pick');
    await expect(log(page).locator('[data-term-pick]').last()).toHaveText('[2] 不动');
    await page.locator('#sgx-entry-cmd').press('Enter'); /* 回车 = [1] 全部回锁屏 */
    await expect(log(page)).toContainText('所有设备都回锁屏了');
    await lockMode(page, 'cmd');
    await expect(page.locator('#sgx-entry-ps')).toHaveText('entry@space:~$');
    expect(resetBodies).toEqual([
      { action: 'verify', spaceKey: 'sk-wrong' },
      { action: 'verify', spaceKey: 'sk-right' },
      { action: 'finish', signOut: 'all' },
    ]);
    expect(pwBodies).toEqual([{ action: 'change', password: 'new-pass-123' }]);
    await expectNoPopups(page);
  });

  test('reset 里没改就 exit → reset end，回锁屏命令行', async ({ page }) => {
    const bodies = [];
    await page.route('**/api/lock-reset', async (route) => {
      bodies.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill(json({ ok: true }));
    });
    await gotoLock(page);
    await lockCmd(page, 'sudo styrigx reset');
    await lockCmd(page, 'sk');
    await expect(page.locator('#sgx-entry-ps')).toHaveText('reset@space:~#');
    await lockCmd(page, 'help');
    await expect(log(page)).toContainText('passkey rm <n>');
    await lockCmd(page, 'exit');
    await expect(page.locator('#sgx-entry-ps')).toHaveText('entry@space:~$');
    await expect.poll(() => bodies.map((b) => b.action)).toEqual(['verify', 'end']);
  });
});

test.describe('锁屏版面（头像 → 状态 → 名字 → 欢迎语 → 终端 → 底部 zh · en）', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
  });

  test('版面（锁屏没有顶栏）：头像（不可点）→ 欢迎回来 / 很高兴再次见到你 → 终端（命令输入行）；没有解锁按钮、弹层、时钟', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await gotoLock(page);
    const lock = page.locator('#sgx-entry');
    await expect(lock.locator('.sgx-glass-bg')).toHaveCount(1);
    /* 标题节点还在（entry.js 照写「锁定屏幕 / 解锁屏幕」），但整条顶栏不显示 */
    await expect(page.locator('#sgx-entry-title')).toHaveText('锁定屏幕');
    await expect(lock.locator('.sgx-entry-tb')).toBeHidden();
    await expect(lock.locator('.sgx-wordmark:visible, .sgx-tb-logo:visible, .sgx-tb-btn:visible')).toHaveCount(0);
    await expect(lock.locator('.sgx-entry-welcome')).toHaveText('欢迎回来');
    await expect(lock.locator('.sgx-entry-sub')).toHaveText('很高兴再次见到你');
    await expect(page.locator('#sgx-entry-st')).toHaveAttribute('data-st', 'locked');
    await expect(lock.locator('button#sgx-entry-avatar, #sgx-entry-avatar[role="button"]')).toHaveCount(0);
    await expect(lock.locator('[id*="clock"], #sgx-lock')).toHaveCount(0);
    await expectNoPopups(page);
    await page.locator('#sgx-entry-avatar').click({ force: true });
    await expectNoPopups(page);
    const u = await page.locator('#sgx-entry-avatar').boundingBox();
    const t = await page.locator('#sgx-entry-term').boundingBox();
    expect(u.y).toBeGreaterThan(0);
    expect(u.y + u.height).toBeLessThan(t.y);
    await expect(page.locator('.sgx-entry-lang')).toHaveText(['zh', 'en']);
    await expect(page.locator('.sgx-entry-lang[data-lang="zh"]')).toHaveAttribute('aria-current', 'true');
    /* 提示符不翻译 */
    await expect(page.locator('#sgx-entry-ps')).toHaveAttribute('translate', 'no');
  });

  test('英文：Lock screen / Good to see you again / 输入行英文标签', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
    await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-entry-title')).toHaveText('Lock screen');
    await expect(page.locator('#sgx-entry .sgx-entry-sub')).toHaveText('Good to see you again');
    await expect(page.locator('#sgx-entry-cmd')).toHaveAttribute('aria-label', /^Lock screen terminal/);
  });

  test('底部 zh · en：点 en 写语言偏好并换到英文同一页（entry / return 原样）', async ({ page }) => {
    await page.goto('/zh/?entry=1&return=' + encodeURIComponent('/wild/'), { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-entry-cmd')).toBeVisible({ timeout: 15000 });
    await page.click('.sgx-entry-lang[data-lang="en"]');
    await page.waitForURL((u) => u.pathname === '/' && u.searchParams.get('entry') === '1' && u.searchParams.get('return') === '/wild/', { timeout: 10000 });
    expect(await page.evaluate(() => localStorage.getItem('sgx-lang'))).toBe('en');
    await expect(page.locator('#sgx-entry-title')).toHaveText('Lock screen');
  });

  test('锁定时 NAVIGATE / 外观 / AI 按钮点不到（锁屏盖住整页；AI 浮钮被挤出视口也算点不到）', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await gotoLock(page);
    await expect(page.locator('#sgx-entry .sgx-entry-tb button, #sgx-entry .sgx-entry-tb a')).toHaveCount(0);
    for (const sel of ['[aria-controls="sgx-nav"]', '[aria-controls="sgx-qp"]', '[aria-controls="sgx-ai"]', '[aria-controls="sgx-sec"]']) {
      const btn = page.locator(sel).first();
      expect(await btn.count()).toBeGreaterThan(0);
      const box = await btn.boundingBox();
      if (!box) continue;
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return !el || !!el.closest('#sgx-entry');
      }, [box.x + box.width / 2, box.y + box.height / 2]);
      expect(hit, sel).toBe(true);
    }
  });

  test('锁屏底 = 纯色 --sgx-bg-1 + 44px 网格，没有主题色光晕', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await gotoLock(page);
    const bg = await page.evaluate(() => {
      const L = document.getElementById('sgx-entry'), g = L.querySelector('.sgx-glass-bg');
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
      if (SHOTS) await expect(page).toHaveScreenshot(`lock-screen-glass-${theme}.png`, { animations: 'disabled' });
    });
  }
});

test.describe('sudo styrigx passkey（mock WebAuthn）', () => {
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
        await route.fulfill(json({ ok: true, challenge: CHALLENGE_B64, allowCredentials: [], cid: 'c1' }));
        return;
      }
      await route.fulfill(json({ ok: false }, 400));
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
    test(`等待通行密钥（busy + ^C）/ timeout 30000+signal / NotAllowedError →「${lang === 'zh' ? '已取消' : 'cancelled'}」/ 回命令行可重试 [${lang}]`, async ({ page }) => {
      const T = lang === 'zh' ? { cancelled: '已取消', wait: '正在唤起通行密钥' } : { cancelled: 'cancelled', wait: 'waiting for passkey' };
      /* 注意：不能 freezeTime——cancelled 判定依赖 Date.now() 的真实流逝（elapsed≥2s） */
      await setupUnlockMocks(page, lang);
      await gotoLock(page);
      await stubWebauthnHang(page);
      await lockCmd(page, 'sudo styrigx passkey');
      await page.waitForFunction(() => !!window.__pkArgs, null, { timeout: 8000 });
      /* ① get 进行中：终端显示等待，输入行收起（busy），状态 VERIFYING，^C 键在；没有任何弹层 */
      await lockMode(page, 'busy');
      await expect(log(page)).toContainText(T.wait);
      await expect(page.locator('#sgx-entry-st')).toHaveAttribute('data-st', 'verifying');
      await expect(page.locator('#sgx-entry-hint [data-term-cc]')).toBeAttached(); /* 触屏才显示（pointer: coarse） */
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
      await expect(log(page)).toContainText(T.cancelled, { timeout: 10000 });
      /* ④ 直达（sudo styrigx passkey）失败回命令行：可以再敲 sudo styrigx password */
      await lockMode(page, 'cmd');
      await lockCmd(page, 'sudo styrigx password');
      await lockMode(page, 'pw');
    });
  }
});

/* 解锁后开机动画（设计稿 entry-v2/boot.html?from=1）：逐行打印 → 淡入主页；减少动态效果不放；按键 / 点击跳过；没敲凭证（首帧对账）不放。
   这组不冻结时钟：会话时长 = 接口 exp − 页面 Date.now()。 */
test.describe('解锁后开机动画（unlock boot）', () => {
  const H12 = 12 * 3600e3;
  /** @param {import('@playwright/test').Page} page @param {{by?:string, ttl?:number, valid?:boolean}} [o] */
  async function mockUnlock(page, o = {}) {
    const st = { unlocked: !!o.valid };
    const ok = (route) => route.fulfill(json({ ok: true }));
    await page.route('**/api/lock-password', async (r) => { st.unlocked = true; await ok(r); });
    await page.route('**/api/lock-tempkey-unlock', async (r) => { st.unlocked = true; await ok(r); });
    await page.route('**/api/lock-session-check*', async (route) => {
      if (!st.unlocked) return route.fulfill(json({ ok: false }, 401));
      await route.fulfill(json({ ok: true, by: o.by || 'password', exp: Date.now() + (o.ttl || H12), next: null }));
    });
  }
  /** 记下开机层出现过几次、每次的行数序列（解锁后锁屏整块会被移除，事后查 DOM 查不到） @param {import('@playwright/test').Page} page */
  async function watchBoot(page) {
    await page.addInitScript(() => {
      /** @type {any} */ (window).__boot = { seen: 0, lines: [], text: '' };
      new MutationObserver(() => {
        const b = document.getElementById('sgx-entry-boot');
        const w = /** @type {any} */ (window).__boot;
        if (b && !b.__seen) { b.__seen = true; w.seen++; }
        const n = b ? Number(b.getAttribute('data-lines') || 0) : -1;
        if (b && w.lines[w.lines.length - 1] !== n) w.lines.push(n);
        if (b) w.text = b.textContent;
      }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-lines'] });
    });
  }
  const boot = (page) => page.evaluate(() => /** @type {any} */ (window).__boot);

  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await watchBoot(page);
  });

  test('密码进站 → ✓ access granted → 开机层逐行打印（真实方式与会话时长）→ 淡入主页，焦点回到页面', async ({ page }) => {
    await mockUnlock(page, { by: 'password' });
    await gotoLockTerm(page, NOBYPASS);
    await lockCmd(page, 'sudo styrigx password');
    await lockMode(page, 'pw');
    await lockCmd(page, 'correctpassword');
    const layer = page.locator('#sgx-entry-boot');
    await expect(layer).toBeAttached({ timeout: 10000 });
    await expect(layer).toHaveAttribute('aria-hidden', 'true');
    await expect(log(page)).toContainText('✓ access granted');
    await expect(page.locator('#sgx-entry')).toHaveCount(0, { timeout: 8000 });
    const rec = await boot(page);
    for (const l of ['> styrigx space os — styrigx@space', '> password verified · session 12h', '> mounting /space/blog ... ok',
      '> mounting /space/curio ... ok', '> mounting /space/daymark ... ok', '> mounting /space/wild ... ok', '> loading gray-ai ... ok', '> welcome back, sloan_']) {
      expect(rec.text).toContain(l);
    }
    await expect(page.locator('body')).not.toHaveClass(/sgx-entry/);
    await expect(page.locator('main')).toBeVisible();
    expect(rec.lines.slice(0, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await page.evaluate(() => document.activeElement === document.body || !!(document.activeElement && document.activeElement.isConnected))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement && document.activeElement !== document.body && !document.activeElement.closest('#sgx-entry'))).toBe(true);
  });

  test('临时钥匙：写 tempkey verified 和接口给的剩余时长', async ({ page }) => {
    await mockUnlock(page, { by: 'tempkey', ttl: 2 * 3600e3 });
    await gotoLockTerm(page, NOBYPASS);
    await lockCmd(page, 'sudo styrigx tempkey');
    await lockMode(page, 'temp');
    await lockCmd(page, 'abcd-efgh-jkmn');
    await expect(page.locator('#sgx-entry-boot')).toBeAttached({ timeout: 10000 });
    await expect(page.locator('#sgx-entry')).toHaveCount(0, { timeout: 8000 });
    expect((await boot(page)).text).toContain('> tempkey verified · session 2h');
  });

  test('减少动态效果：不出开机层、不逐行，直接短淡出', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockUnlock(page);
    await gotoLockTerm(page, NOBYPASS);
    await lockCmd(page, 'sudo styrigx password');
    await lockMode(page, 'pw');
    await lockCmd(page, 'correctpassword');
    await expect(page.locator('#sgx-entry')).toHaveCount(0, { timeout: 5000 });
    expect((await boot(page)).seen).toBe(0);
    await expect(page.locator('body')).not.toHaveClass(/sgx-entry/);
  });

  for (const how of ['key', 'click']) {
    test(`动画期间${how === 'key' ? '按任意键' : '点击'}跳过：立刻打完并进主页`, async ({ page }) => {
      await mockUnlock(page);
      await gotoLockTerm(page, NOBYPASS);
      await lockCmd(page, 'sudo styrigx password');
      await lockMode(page, 'pw');
      await lockCmd(page, 'correctpassword');
      await page.waitForFunction(() => {
        const b = document.getElementById('sgx-entry-boot');
        const n = b ? Number(b.getAttribute('data-lines') || 0) : 0;
        return n >= 1 && n <= 3;
      }, null, { polling: 'raf', timeout: 10000 });
      const t0 = Date.now();
      if (how === 'key') await page.keyboard.press('x');
      else await page.mouse.click(200, 200);
      await expect(page.locator('#sgx-entry')).toHaveCount(0, { timeout: 2000 });
      expect(Date.now() - t0).toBeLessThan(1500);
      const lines = (await boot(page)).lines;
      expect(lines[lines.length - 1]).toBe(8);
      expect(lines).not.toContain(7);
      await expect(page.locator('main')).toBeVisible();
    });
  }

  test('进站前不放：会话本来有效（首帧对账直接通过，没敲凭证）→ 不出开机层', async ({ page }) => {
    await mockUnlock(page, { valid: true });
    await page.goto(NOBYPASS, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-entry')).toHaveCount(0, { timeout: 10000 });
    expect((await boot(page)).seen).toBe(0);
  });
});
