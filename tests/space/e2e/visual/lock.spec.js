/**
 * 进站测试（与视觉回归 / Lighthouse 分离；生产构建，锁屏启用）。
 * v5 S5 终端合一（term-design-v5「解锁流程」）：锁屏界面 #sgx-entry 删了，进站 = 全站终端里敲 `sudo styrigx`：
 * - 旧地址 ?entry=1 / ?lock=1：打开终端、预填 sudo styrigx（不替人回车）；?entry=sudo 直接跑；上锁的地方发 sgx:sudo 同样预填
 * - `sudo styrigx` → [pick] 只列设了的 [1] passkey [2] password（没有 tempkey，也没有 `sudo styrigx password` 直达）
 * - 验过 → 向服务端确认（/api/lock-session-check）→ 终端收起 → 原进站开机动画 → 回原页（next / 访客态页面重新取一次 / 原地）
 * - 三次规则：输错 `Sorry, try again.` 再问；第 3 次 `sudo: 3 incorrect password attempts` 回命令行；服务端冷却 → 倒计时行
 * - `sudo styrigx reset` → `[sudo] recovery key:` → reset@space:~#（passwd / passkey ls|add|rm / man / exit），第一次改动后两选
 * - 分享链接进来的会话（by=link）：提示符 nobody@space:~#，钥匙命令先拦一句；服务端 403 link → 同一句
 * 后端都是 page.route 替身；localhost 本地回退（不问服务端）用 ?test-no-local-bypass=1 关掉。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');
const { ENTRY_URL, SEL, gotoLockTerm, lockCmd, lockMode, lockPick, badLine, lastLine } = require('../helpers/lock-term.cjs');

/* 截图基线：锁屏截图 2026-11 UI 重设计 PR-1 起不比，v5 S5 也不新拍（终端截图在 visual.spec.js 的顶栏 / 主页那几张） */
const SHOTS = false;
const NOBYPASS = ENTRY_URL + '&test-no-local-bypass=1';
const out = (page) => page.locator(SEL.out);
const input = (page) => page.locator(SEL.in);
const ps = (page) => page.locator(SEL.ps);
/** 进站时不许出现任何别的弹层（底部弹层、验证对话框、终端以外的 <dialog>） */
async function expectNoPopups(page) {
  await expect(page.locator('#sgx-method-sheet, .sgx-verify-dlg, .sgx-sheet-backdrop, dialog[open]:not(#sgx-term)')).toHaveCount(0);
}
const zh = async (page) => page.addInitScript(() => { try { if (!localStorage.getItem('sgx-lang')) localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });
const ENTRY_CFG = (page, cfg = { ok: true, passkey: true, password: true }) => page.route('**/api/lock-entry', (r) => r.fulfill(json(cfg)));
/** 访客页（网关标记 locked）：页面照常，只在 <html> 上加标记 */
const asVisitor = (page, path) => page.route((u) => u.pathname === path, async (route) => {
  const res = await route.fetch();
  const html = (await res.text()).replace(/<html(\s|>)/, '<html data-sgx-lock-session="locked"$1');
  await route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
});
/** 已进站页（网关标记 valid） */
const asEntered = (page, path) => page.route((u) => u.pathname === path, async (route) => {
  const res = await route.fetch();
  const html = (await res.text()).replace(/<html(\s|>)/, '<html data-sgx-lock-session="valid"$1');
  await route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
});
/** sudo styrigx → [pick] → password → 密码态 @param {import('@playwright/test').Page} page */
async function toPassword(page) {
  await lockCmd(page, 'sudo styrigx');
  await lockMode(page, 'pick');
  await lockCmd(page, '2');
  await lockMode(page, 'pw');
}

test.describe('进站入口（v5 S5：没有锁屏界面，都进终端）', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
  });

  test('?entry=1：不画锁屏，打开终端、预填 sudo styrigx（不替人回车）；提示符 nobody@space:~/wild$，顶栏照常', async ({ page }) => {
    await freezeTime(page);
    let posted = 0;
    await page.route('**/api/lock-password', (r) => { posted++; return r.fulfill(json({ ok: true })); });
    await gotoLockTerm(page);
    await expect(page.locator('#sgx-entry, #sgx-entry-cover')).toHaveCount(0);
    await expect(input(page)).toHaveValue('sudo styrigx');
    await expect(input(page)).toBeFocused();
    await expect(ps(page)).toHaveText('nobody@space:~/wild$');
    await expect(ps(page)).toHaveAttribute('translate', 'no');
    await expect(lockMode(page, 'cmd')).resolves.toBeUndefined();
    await expect(page.locator('#site-nav .sgx-topbar')).toBeVisible();
    await expectNoPopups(page);
    expect(posted).toBe(0);
  });

  /* 2026-11 UI 重设计 PR-1 起锁屏截图基线不比（SHOTS = false）；CI「Lock screen baseline screenshot」那一步按名字跑这条 */
  test('entry terminal baseline screenshot', async ({ page }) => {
    await freezeTime(page);
    await page.setViewportSize({ width: 412, height: 915 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoLockTerm(page);
    await expect(input(page)).toHaveValue('sudo styrigx');
    if (SHOTS) await expect(page).toHaveScreenshot('entry-terminal.png', { animations: 'disabled' });
  });

  test('?entry=sudo：直接跑 sudo styrigx → [pick]', async ({ page }) => {
    await ENTRY_CFG(page);
    await gotoLockTerm(page, '/wild/?entry=sudo');
    await lockMode(page, 'pick');
    await expect(out(page)).toContainText('sudo styrigx');
    await expect(out(page).locator('[data-term-pick]')).toHaveText(['[1] passkey', '[2] password']);
  });

  test('旧 ?lock=1 也认（旧书签）', async ({ page }) => {
    await gotoLockTerm(page, '/wild/?lock=1');
    await expect(input(page)).toHaveValue('sudo styrigx');
  });

  test('主页 /?entry=1：打开终端窗口（v5 S7 首屏不再嵌终端），预填在它的输入行', async ({ page }) => {
    await page.goto('/?entry=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-term-in')).toHaveValue('sudo styrigx', { timeout: 15000 });
    await expect(page.locator('#sgx-entry')).toHaveCount(0);
  });

  test('v5 S3：访客页面不画锁屏（没有遮罩、顶栏可见、内容可读）', async ({ page }) => {
    await asVisitor(page, '/zh/wild/');
    await page.goto('/zh/wild/?test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', 'locked');
    await expect(page.locator('#site-nav .sgx-topbar')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#screen-time')).toBeVisible();
    await expect(page.locator('#sgx-entry, #sgx-entry-cover')).toHaveCount(0);
    await expect(page.locator(SEL.dlg)).not.toHaveAttribute('open', '');
  });

  test('上锁的地方发 sgx:sudo → 终端预填 sudo styrigx → 回车就在这个终端里选方式（不跳锁屏地址）', async ({ page }) => {
    await asVisitor(page, '/zh/wild/');
    await ENTRY_CFG(page);
    await page.route('**/api/lock-session-check*', (r) => r.fulfill(json({ ok: false }, 401)));
    await page.goto('/zh/wild/?test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#site-nav .sgx-topbar')).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('sgx:sudo')));
    await expect(input(page)).toHaveValue('sudo styrigx', { timeout: 8000 });
    await input(page).press('Enter');
    await lockMode(page, 'pick');
    const u = new URL(page.url());
    expect(u.pathname + u.search).toBe('/zh/wild/?test-no-local-bypass=1');
  });
});

test.describe('sudo styrigx：选方式 / 密码 / 三次规则 / 冷却', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await ENTRY_CFG(page);
  });

  test('[pick] 列出 passkey / password（可点）；不在选项里的说一声接着选；点 2 问密码', async ({ page }) => {
    await gotoLockTerm(page);
    await lockCmd(page, 'sudo styrigx');
    await lockMode(page, 'pick');
    await expect(out(page).locator('[data-term-pick]')).toHaveText(['[1] passkey', '[2] password']);
    await expect(out(page)).not.toContainText('tempkey');
    await expect(ps(page)).toHaveText('选择方式 [1/2]:');
    await lockCmd(page, '9');
    await expect(badLine(page)).toHaveText('没有这个选项');
    await lockMode(page, 'pick');
    await lockPick(page, '2');
    await lockMode(page, 'pw');
  });

  test('密码：同一个输入行变成 `[sudo] password for …:`（遮住、密码管理器认得），没有弹层；旧直达 sudo styrigx password → 用法', async ({ page }) => {
    await freezeTime(page);
    await gotoLockTerm(page);
    await expect(input(page)).toHaveAttribute('type', 'text');
    await expect(input(page)).toHaveAttribute('aria-label', /.+/);
    await lockCmd(page, 'sudo styrigx password');
    await expect(lastLine(page)).toContainText('用法：sudo styrigx [reset]');
    await lockMode(page, 'cmd');
    await toPassword(page);
    await expect(input(page)).toHaveAttribute('type', 'password');
    await expect(input(page)).toHaveAttribute('autocomplete', 'current-password');
    await expect(input(page)).toBeFocused();
    await expect(page.locator(SEL.pmu)).toHaveAttribute('autocomplete', 'username');
    await expect(page.locator(SEL.pmu)).toHaveValue('SpacePassword');
    await expect(ps(page)).toHaveText(/^\[sudo\] password for \S+:\s?$/);
    await expect(page.locator(SEL.hint)).toBeVisible();
    await expect(out(page)).toContainText('nobody@space:~/wild$ sudo styrigx');
    await expectNoPopups(page);
  });

  test('输错：`Sorry, try again.` 再问；第 3 次 `sudo: 3 incorrect password attempts` 回命令行；密码不进输出', async ({ page }) => {
    await freezeTime(page);
    let n = 0;
    await page.route('**/api/lock-password', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.action === 'verify') { n++; await route.fulfill(json({ ok: false, error: 'wrong' }, 403)); } else await route.continue();
    });
    await gotoLockTerm(page, NOBYPASS);
    await toPassword(page);
    await lockCmd(page, 'wrongpassword123');
    await expect(badLine(page)).toHaveText('Sorry, try again.', { timeout: 10000 });
    await lockMode(page, 'pw');
    await expect(input(page)).toHaveValue('');
    await expect(out(page)).not.toContainText('wrongpassword123');
    await lockCmd(page, 'wrong2');
    await expect(badLine(page)).toHaveText('Sorry, try again.');
    await lockMode(page, 'pw');
    await lockCmd(page, 'wrong3');
    await expect(badLine(page)).toHaveText('sudo: 3 incorrect password attempts');
    await lockMode(page, 'cmd');
    expect(n).toBe(3);
    /* 输出区本身是 role=log：读屏会念出错那一行 */
    await expect(out(page)).toHaveAttribute('role', 'log');
    await expect(page.locator(SEL.dlg)).toHaveAttribute('open', '');
  });

  test('空密码回车：不发请求，还在密码态', async ({ page }) => {
    let posted = 0;
    await page.route('**/api/lock-password', (r) => { posted++; return r.fulfill(json({ ok: false, error: 'wrong' })); });
    await gotoLockTerm(page, NOBYPASS);
    await toPassword(page);
    await input(page).press('Enter');
    await lockMode(page, 'pw');
    await expect(input(page)).toBeFocused();
    expect(posted).toBe(0);
  });

  test('冷却（429 retryAfter 30）→ `sudo: 尝试次数太多` + 秒数倒计时，回命令行', async ({ page }) => {
    await freezeTime(page);
    await page.route('**/api/lock-password', (route) => route.fulfill(json({ ok: false, error: 'cooldown', retryAfter: 30 }, 429)));
    await gotoLockTerm(page, NOBYPASS);
    await toPassword(page);
    await lockCmd(page, 'whatever');
    await expect(out(page)).toContainText('sudo: 尝试次数太多', { timeout: 10000 });
    await expect(out(page).locator('.sgx-at-l--d').last()).toHaveText(/› (30|29) 秒后可再试/, { timeout: 10000 });
    await lockMode(page, 'cmd');
  });

  test('凭证清空（lock-entry 全 false）：sudo styrigx 说没设、提示 sudo styrigx reset，回命令行', async ({ page }) => {
    await page.unroute('**/api/lock-entry');
    await ENTRY_CFG(page, { ok: true, passkey: false, password: false });
    await gotoLockTerm(page);
    await lockCmd(page, 'sudo styrigx');
    await expect(badLine(page)).toHaveText('还没设解锁密码或通行密钥');
    await expect(out(page)).toContainText('还没有进站凭证 · sudo styrigx reset');
    await lockMode(page, 'cmd');
    await expect(out(page).locator('[data-term-pick]')).toHaveCount(0);
  });
});

test.describe('验过之后：服务端确认 → 回原页', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await ENTRY_CFG(page);
  });

  test('带 ?return=：问 /api/lock-session-check?return=，照服务端给的 next 跳', async ({ page }) => {
    await freezeTime(page);
    let unlocked = false;
    const checks = [];
    await page.route('**/api/lock-password', async (route) => { unlocked = true; await route.fulfill(json({ ok: true })); });
    await page.route('**/api/lock-session-check*', async (route) => {
      checks.push(route.request().url());
      if (!unlocked) return route.fulfill(json({ ok: false }, 401));
      await route.fulfill(json({ ok: true, by: 'password', exp: Date.now() + 43200e3, next: '/blog/' }));
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoLockTerm(page, ENTRY_URL + '&return=' + encodeURIComponent('/blog/') + '&test-no-local-bypass=1');
    await toPassword(page);
    await lockCmd(page, 'correctpassword');
    await page.waitForURL((u) => u.pathname.startsWith('/blog/'), { timeout: 10000 });
    expect(checks.some((u) => u.includes('return=' + encodeURIComponent('/blog/')))).toBe(true);
  });

  test('访客页上进站（没有 next）：终端收起，同一页重新取一次（服务端画进站态），地址去掉 entry', async ({ page }) => {
    let unlocked = false;
    await asVisitor(page, '/zh/wild/');
    await page.route('**/api/lock-password', async (route) => { unlocked = true; await route.fulfill(json({ ok: true })); });
    await page.route('**/api/lock-session-check*', (route) => (unlocked ? route.fulfill(json({ ok: true, by: 'password', exp: Date.now() + 43200e3, next: null })) : route.fulfill(json({ ok: false }, 401))));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoLockTerm(page, '/zh/wild/?entry=1&test-no-local-bypass=1');
    await toPassword(page);
    await lockCmd(page, 'correctpassword');
    await page.waitForURL((u) => !u.searchParams.has('entry'), { timeout: 10000 });
    const u = new URL(page.url());
    expect(u.pathname + u.search).toBe('/zh/wild/?test-no-local-bypass=1');
  });

  test('服务端没确认（session-check 401，fail-closed）：报错、留在终端、不跳页', async ({ page }) => {
    await freezeTime(page);
    await page.route('**/api/lock-password', (route) => route.fulfill(json({ ok: true })));
    await page.route('**/api/lock-session-check*', (route) => route.fulfill(json({ ok: false }, 401)));
    await gotoLockTerm(page, NOBYPASS);
    const before = page.url();
    await toPassword(page);
    await lockCmd(page, 'correctpassword');
    await expect(badLine(page)).toHaveText('会话没有生效，请再试一次', { timeout: 10000 });
    await lockMode(page, 'cmd');
    await expect(page.locator(SEL.dlg)).toHaveAttribute('open', '');
    await expect(page.locator('#sgx-entry')).toHaveCount(0);
    expect(page.url()).toBe(before);
  });

  test('已进站页面切回前台：问服务端，401 → 重新取这一页（服务端画访客态）', async ({ page }) => {
    let checks = 0;
    await asEntered(page, '/zh/wild/');
    await page.route('**/api/lock-session-check*', async (route) => { checks++; await route.fulfill(json({ ok: false }, 401)); });
    await page.goto('/zh/wild/?test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#site-nav .sgx-topbar')).toBeVisible({ timeout: 15000 });
    const nav = page.waitForEvent('framenavigated', { timeout: 10000 });
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
    await nav;
    expect(checks).toBeGreaterThan(0);
  });

  test('本地回退（localhost，不问服务端）：验过 → 终端收起 → 开机动画放完收掉', async ({ page }) => {
    await page.route('**/api/lock-password', (route) => route.fulfill(json({ ok: true })));
    await gotoLockTerm(page);
    await toPassword(page);
    await lockCmd(page, 'pw');
    await expect(out(page)).toContainText('✓ access granted');
    await expect(page.locator(SEL.dlg)).not.toHaveAttribute('open', '', { timeout: 5000 });
    await expect(page.locator('#sgx-entry')).toHaveCount(0, { timeout: 8000 });
  });
});

test.describe('终端：man / 不认识的命令 / clear / 历史 / ^C / esc', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await freezeTime(page);
    await ENTRY_CFG(page);
  });

  test('访客 man（S9 全屏阅读页）列 sudo / find，不列 ask / lock / passwd；help 已删 → command not found；clear 清屏', async ({ page }) => {
    await gotoLockTerm(page);
    await lockCmd(page, 'man');
    const body = page.locator('#sgx-term [data-term-man-body]');
    await expect(body).toBeVisible();
    await expect(body).toContainText('手册页');
    const lines = await body.locator('.sgx-term-ln').allTextContents();
    const names = lines.filter((l) => / — /.test(l)).map((l) => l.split(' — ')[0].trim());
    for (const n of ['sudo', 'find', 'man']) expect(names).toContain(n);
    for (const n of ['ask', 'lock', 'passwd', 'help']) expect(names).not.toContain(n);
    await page.keyboard.press('q');
    await expect(body).toBeHidden();
    await lockCmd(page, 'help');
    await expect(badLine(page)).toContainText('help');
    await lockCmd(page, 'clear');
    await expect(out(page).locator('> div')).toHaveCount(0);
    await expectNoPopups(page);
  });

  test('man sudo：SYNOPSIS 有 sudo styrigx / sudo styrigx reset / sudo -v', async ({ page }) => {
    await gotoLockTerm(page);
    await lockCmd(page, 'man sudo');
    const body = page.locator('#sgx-term [data-term-man-body]');
    await expect(page.locator('#sgx-term [data-term-man-st]')).toContainText('SUDO(1)');
    await expect(body).toContainText('sudo styrigx reset');
    await expect(body).toContainText('sudo -v');
    await page.keyboard.press('q');
    await expect(body).toBeHidden();
  });

  test('↑ / ↓ 历史；^C 从密码态回到命令行（打印 ^C）；esc 退出 recovery key', async ({ page }) => {
    await gotoLockTerm(page);
    await lockCmd(page, 'pwd');
    await lockCmd(page, 'clear');
    await input(page).press('ArrowUp');
    await expect(input(page)).toHaveValue('clear');
    await input(page).press('ArrowUp');
    await expect(input(page)).toHaveValue('pwd');
    await input(page).press('ArrowDown');
    await expect(input(page)).toHaveValue('clear');
    await input(page).fill('');
    await toPassword(page);
    await input(page).press('Control+c');
    await lockMode(page, 'cmd');
    await expect(lastLine(page)).toContainText('^C');
    await lockCmd(page, 'sudo styrigx reset');
    await lockMode(page, 'rkey');
    await input(page).press('Escape');
    await lockMode(page, 'cmd');
    await expect(page.locator(SEL.dlg)).toHaveAttribute('open', '');
  });

  test('触屏 ^C 键（输入行下面的注释里）= 退出当前命令', async ({ page }) => {
    await gotoLockTerm(page);
    await toPassword(page);
    await expect(page.locator(SEL.hint + ' [data-term-cc]')).toBeAttached();
    await page.locator(SEL.hint + ' [data-term-cc]').dispatchEvent('click');
    await lockMode(page, 'cmd');
  });
});

test.describe('sudo styrigx reset：恢复钥匙 → reset@space:~# → 改 → 两选 → 回 nobody', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await freezeTime(page);
  });

  test('恢复钥匙（SpaceRecoveryKey，不回显）错 → Sorry, try again.；对 → reset@space:~#；passwd 两次 → 两选 [1] 全部回访客 → finish all → 回 nobody@space', async ({ page }) => {
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
    await gotoLockTerm(page);
    await lockCmd(page, 'sudo styrigx reset');
    await lockMode(page, 'rkey');
    await expect(page.locator(SEL.pmu)).toHaveValue('SpaceRecoveryKey');
    await expect(input(page)).toHaveAttribute('type', 'password');
    await expect(ps(page)).toHaveText('[sudo] recovery key:');
    await lockCmd(page, 'sk-wrong');
    await expect(badLine(page)).toHaveText('Sorry, try again.');
    await lockMode(page, 'rkey');
    await lockCmd(page, 'sk-right');
    await expect(out(page)).toContainText('✓ verified');
    await lockMode(page, 'cmd');
    await expect(ps(page)).toHaveText('reset@space:~#');
    await expect(out(page)).not.toContainText('sk-right');
    await lockCmd(page, 'passwd');
    await lockMode(page, 'newpw');
    await lockCmd(page, 'new-pass-123');
    await lockMode(page, 'newpw2');
    await lockCmd(page, 'new-pass-123');
    await lockMode(page, 'pick');
    await expect(out(page).locator('[data-term-pick]').last()).toHaveText('[2] 不动');
    await input(page).press('Enter'); /* 回车 = [1] 全部回访客 */
    await expect(out(page)).toContainText('所有设备都回锁屏了');
    await lockMode(page, 'cmd');
    await expect(ps(page)).toHaveText('nobody@space:~/wild$');
    expect(resetBodies).toEqual([
      { action: 'verify', spaceKey: 'sk-wrong' },
      { action: 'verify', spaceKey: 'sk-right' },
      { action: 'finish', signOut: 'all' },
    ]);
    expect(pwBodies).toEqual([{ action: 'change', password: 'new-pass-123' }]);
    await expectNoPopups(page);
  });

  test('reset 里 man 列 passkey rm <n>；没改就 exit → reset end，回 nobody 命令行', async ({ page }) => {
    const bodies = [];
    await page.route('**/api/lock-reset', async (route) => {
      bodies.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill(json({ ok: true }));
    });
    await gotoLockTerm(page);
    await lockCmd(page, 'sudo styrigx reset');
    await lockCmd(page, 'sk');
    await expect(ps(page)).toHaveText('reset@space:~#');
    await lockCmd(page, 'man');
    await expect(out(page)).toContainText('passkey rm <n>');
    await lockCmd(page, 'exit');
    await expect(ps(page)).toHaveText('nobody@space:~/wild$');
    await expect.poll(() => bodies.map((b) => b.action)).toEqual(['verify', 'end']);
  });
});

test.describe('分享链接进来的会话（by=link）', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
  });

  test('提示符 nobody@space:~#；sudo -v / share / lock passwd 先拦一句；sudo styrigx 说已进站', async ({ page }) => {
    await page.route('**/api/lock-session-check*', (r) => r.fulfill(json({ ok: true, by: 'link', exp: Date.now() + 3600e3 })));
    await gotoLockTerm(page, '/wild/?test-no-local-bypass=1#sec');
    await expect(ps(page)).toHaveText('nobody@space:~/wild#');
    for (const c of ['sudo -v', 'share', 'lock passwd']) {
      await lockCmd(page, c);
      await expect(badLine(page)).toHaveText('分享链接进来的会话不能这样做 · 用自己的钥匙进站');
    }
    await lockCmd(page, 'sudo styrigx');
    await expect(badLine(page)).toContainText('sudo -v');
  });

  test('服务端回 403 link（前端以为是自己的钥匙）：share 报「分享链接进来的会话不能这样做」', async ({ page }) => {
    await page.route('**/api/lock-session-check*', (r) => r.fulfill(json({ ok: true, by: 'password', exp: Date.now() + 3600e3 })));
    await page.route('**/api/lock-reauth', (r) => r.fulfill(json({ ok: true, valid: true, ticket: 'lock-reauth', expiresAt: Date.now() + 170000, password: true, passkey: false })));
    await page.route('**/api/share', (r) => r.fulfill(json({ ok: false, error: 'link' }, 403)));
    await gotoLockTerm(page, '/wild/?test-no-local-bypass=1#sec');
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    await lockCmd(page, 'share');
    await expect(badLine(page)).toHaveText('分享链接进来的会话不能这样做');
    await lockMode(page, 'cmd');
  });
});

test.describe('sudo styrigx → passkey（mock WebAuthn）', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
  });

  const CHALLENGE_B64 = 'dGVzdC1jaGFsbGVuZ2U';

  /** @param {import('@playwright/test').Page} page @param {'zh'|'en'} lang */
  async function setupUnlockMocks(page, lang) {
    await page.addInitScript((l) => { try { localStorage.setItem('sgx-lang', l); } catch (e) {} }, lang);
    await ENTRY_CFG(page);
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
    test(`等待通行密钥（busy + ^C）/ timeout 30000+signal / NotAllowedError →「${lang === 'zh' ? '已取消' : 'cancelled'}」/ 回到选择可改用密码 [${lang}]`, async ({ page }) => {
      const T = lang === 'zh' ? { cancelled: '已取消', wait: '正在唤起通行密钥' } : { cancelled: 'cancelled', wait: 'waiting for passkey' };
      /* 不能 freezeTime：cancelled 判定依赖 Date.now() 的真实流逝（elapsed≥2s） */
      await setupUnlockMocks(page, lang);
      await gotoLockTerm(page);
      await stubWebauthnHang(page);
      await lockCmd(page, 'sudo styrigx');
      await lockMode(page, 'pick');
      await lockCmd(page, '1');
      await page.waitForFunction(() => !!window.__pkArgs, null, { timeout: 8000 });
      /* ① get 进行中：终端显示等待，输入行收起（busy），^C 键在；没有任何弹层 */
      await lockMode(page, 'busy');
      await expect(out(page)).toContainText(T.wait);
      await expect(page.locator(SEL.hint + ' [data-term-cc]')).toBeAttached();
      await expectNoPopups(page);
      /* ② 传给 get 的 timeout 是 30000，并且顶层带了 signal（不在 publicKey 里） */
      const args = await page.evaluate(() => window.__pkArgs);
      expect(args.timeout, 'timeout 应为 30000').toBe(30000);
      expect(args.hasSignal, '顶层应带 AbortSignal').toBe(true);
      expect(args.signalInPublicKey, 'publicKey 里不应有 signal').toBe(false);
      /* ③ 2.5s 后抛 NotAllowedError（elapsed≥2s → cancelled） */
      await page.evaluate(() => { setTimeout(() => { window.__pkReject(new DOMException('User cancelled', 'NotAllowedError')); }, 2500); });
      await expect(out(page)).toContainText(T.cancelled, { timeout: 10000 });
      /* ④ 从选择进来的：失败回到选择（还在这一轮），可以改选 password */
      await lockMode(page, 'pick');
      await lockCmd(page, '2');
      await lockMode(page, 'pw');
    });
  }
});

/* 解锁后开机动画（原锁屏那一段，v5 S5 起在终端收起之后放）：逐行打印 → 收掉；减少动态效果不放；按键 / 点击跳过；没敲凭证不放。
   这组不冻结时钟：会话时长 = 接口 exp − 页面 Date.now()。 */
test.describe('解锁后开机动画（unlock boot）', () => {
  const H12 = 12 * 3600e3;
  /** @param {import('@playwright/test').Page} page @param {{by?:string, ttl?:number, valid?:boolean}} [o] */
  async function mockUnlock(page, o = {}) {
    const st = { unlocked: !!o.valid };
    await ENTRY_CFG(page);
    await page.route('**/api/lock-password', async (r) => { st.unlocked = true; await r.fulfill(json({ ok: true })); });
    await page.route('**/api/lock-session-check*', async (route) => {
      if (!st.unlocked) return route.fulfill(json({ ok: false }, 401));
      await route.fulfill(json({ ok: true, by: o.by || 'password', exp: Date.now() + (o.ttl || H12), next: null }));
    });
  }
  /** 记下开机层出现过几次、每次的行数序列（放完整块会被移除，事后查 DOM 查不到） @param {import('@playwright/test').Page} page */
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

  test('密码进站 → ✓ access granted → 终端收起 → 开机层逐行打印（真实方式与会话时长）→ 收掉', async ({ page }) => {
    await mockUnlock(page, { by: 'password' });
    await gotoLockTerm(page, NOBYPASS);
    await toPassword(page);
    await lockCmd(page, 'correctpassword');
    await expect(out(page)).toContainText('✓ access granted');
    const layer = page.locator('#sgx-entry-boot');
    await expect(layer).toBeAttached({ timeout: 10000 });
    await expect(page.locator('#sgx-entry')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator(SEL.dlg)).not.toHaveAttribute('open', '');
    await expect(page.locator('#sgx-entry')).toHaveCount(0, { timeout: 8000 });
    const rec = await boot(page);
    for (const l of ['> styrigx space os — styrigx@space', '> password verified · session 12h', '> mounting /space/blog ... ok',
      '> mounting /space/curio ... ok', '> mounting /space/daymark ... ok', '> mounting /space/wild ... ok', '> loading gray-ai ... ok', '> welcome back, sloan_']) {
      expect(rec.text).toContain(l);
    }
    await expect(page.locator('body')).not.toHaveClass(/sgx-entry/);
    expect(rec.lines.slice(0, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('减少动态效果：不出开机层', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockUnlock(page);
    await gotoLockTerm(page, NOBYPASS);
    await toPassword(page);
    await lockCmd(page, 'correctpassword');
    await expect(page.locator(SEL.dlg)).not.toHaveAttribute('open', '', { timeout: 5000 });
    await expect(page.locator('#sgx-entry')).toHaveCount(0, { timeout: 5000 });
    expect((await boot(page)).seen).toBe(0);
    await expect(page.locator('body')).not.toHaveClass(/sgx-entry/);
  });

  for (const how of ['key', 'click']) {
    test(`动画期间${how === 'key' ? '按任意键' : '点击'}跳过：立刻打完并收掉`, async ({ page }) => {
      await mockUnlock(page);
      await gotoLockTerm(page, NOBYPASS);
      await toPassword(page);
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

  test('会话本来有效（没敲凭证）→ 不出开机层', async ({ page }) => {
    await mockUnlock(page, { valid: true });
    let checked = 0;
    await page.route('**/api/lock-session-check*', async (route) => { checked++; await route.fallback(); });
    await page.goto('/wild/?test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#site-nav .sgx-topbar')).toBeVisible({ timeout: 10000 });
    await page.locator('.sgx-tb-term').click();
    await expect(ps(page)).toHaveText('styrigx@space:~/wild#');
    expect(checked).toBeGreaterThan(0);
    expect((await boot(page)).seen).toBe(0);
  });
});
