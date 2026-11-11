/**
 * 进站入口测试（与视觉回归 / Lighthouse 分离；生产构建，锁屏启用）。
 * v5 S5 起没有锁屏界面；v6 P4（定稿 v5.2 §十三 P4：删 space-core 进站签发、sudo styrigx / sudo -v / 分享短链）起登录 = 全站终端里 su <用户>：
 * - 旧地址 ?entry=1 / ?entry=sudo / ?lock=1：打开终端、预填 su （不替人回车）；上锁的地方发 sgx:sudo 同样预填
 * - 访客页面不画锁屏；man 只列访客能用的命令；^C / esc 退出 su 的密码态
 * 后端都是 page.route 替身。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');
const { ENTRY_URL, SEL, gotoLockTerm, lockCmd, lockMode, badLine, lastLine } = require('../helpers/lock-term.cjs');

/* 截图基线：锁屏截图 2026-11 UI 重设计 PR-1 起不比，v5 S5 也不新拍（终端截图在 visual.spec.js 的顶栏 / 主页那几张） */
const SHOTS = false;
const out = (page) => page.locator(SEL.out);
const input = (page) => page.locator(SEL.in);
const ps = (page) => page.locator(SEL.ps);
/** 进站时不许出现任何别的弹层（底部弹层、验证对话框、终端以外的 <dialog>） */
async function expectNoPopups(page) {
  await expect(page.locator('#sgx-method-sheet, .sgx-verify-dlg, .sgx-sheet-backdrop, dialog[open]:not(#sgx-term)')).toHaveCount(0);
}
const zh = async (page) => page.addInitScript(() => { try { if (!localStorage.getItem('sgx-lang')) localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });
/** 访客页（网关标记 locked）：页面照常，只在 <html> 上加标记 */
const asVisitor = (page, path) => page.route((u) => u.pathname === path, async (route) => {
  const res = await route.fetch();
  const html = (await res.text()).replace(/<html(\s|>)/, '<html data-sgx-lock-session="locked"$1');
  await route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
});
/** su styrigx → [pick] → 1 password → 密码态（v6 身份层） @param {import('@playwright/test').Page} page */
async function toPassword(page) {
  await lockCmd(page, 'su styrigx');
  await lockMode(page, 'pick');
  await lockCmd(page, '1');
  await lockMode(page, 'pw');
}

test.describe('进站入口（v5 S5：没有锁屏界面，都进终端）', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
  });

  test('?entry=1：不画锁屏，打开终端、预填 su （不替人回车）；提示符 nobody@space:~/wild$，顶栏照常', async ({ page }) => {
    await freezeTime(page);
    let posted = 0;
    /* 只数 whoami 以外的请求（问身份不算；不替人回车 = 不发 su） */
    await page.route('**/api/identity', (r) => { if ((r.request().postDataJSON() || {}).action !== 'whoami') posted++; return r.fulfill(json({ ok: true, user: null })); });
    await gotoLockTerm(page);
    await expect(page.locator('#sgx-entry, #sgx-entry-cover')).toHaveCount(0);
    await expect(input(page)).toHaveValue('su ');
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
    await expect(input(page)).toHaveValue('su ');
    if (SHOTS) await expect(page).toHaveScreenshot('entry-terminal.png', { animations: 'disabled' });
  });

  test('?entry=sudo（旧进站直达，v6 P4 删了 sudo styrigx）：同 ?entry=1，打开终端预填 su ，不跑任何命令', async ({ page }) => {
    await gotoLockTerm(page, '/wild/?entry=sudo');
    await expect(input(page)).toHaveValue('su ');
    await lockMode(page, 'cmd');
    await expect(out(page)).not.toContainText('sudo styrigx');
  });

  test('旧 ?lock=1 也认（旧书签）', async ({ page }) => {
    await gotoLockTerm(page, '/wild/?lock=1');
    await expect(input(page)).toHaveValue('su ');
  });

  test('主页 /?entry=1：打开终端窗口（v5 S7 首屏不再嵌终端），预填在它的输入行', async ({ page }) => {
    await page.goto('/?entry=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#sgx-term-in')).toHaveValue('su ', { timeout: 15000 });
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

  test('上锁的地方发 sgx:sudo → 终端预填 su （不替人回车、不跳锁屏地址）', async ({ page }) => {
    await asVisitor(page, '/zh/wild/');
    await page.goto('/zh/wild/?test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#site-nav .sgx-topbar')).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('sgx:sudo')));
    await expect(input(page)).toHaveValue('su ', { timeout: 8000 });
    await lockMode(page, 'cmd');
    const u = new URL(page.url());
    expect(u.pathname + u.search).toBe('/zh/wild/?test-no-local-bypass=1');
  });

});

test.describe('终端：man / 不认识的命令 / clear / 历史 / ^C / esc', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await zh(page);
    await freezeTime(page);
  });

  test('访客 man（S9 全屏阅读页）列 sudo / find，不列 su / ask / lock / passwd（同 tests/space/ui/shell/terminal.test.mjs 访客索引）；help 已删 → command not found；clear 清屏', async ({ page }) => {
    await gotoLockTerm(page);
    await lockCmd(page, 'man');
    const body = page.locator('#sgx-term [data-term-man-body]');
    await expect(body).toBeVisible();
    await expect(body).toContainText('手册页');
    const lines = await body.locator('.sgx-term-ln').allTextContents();
    const names = lines.filter((l) => / — /.test(l)).map((l) => l.split(' — ')[0].trim());
    for (const n of ['sudo', 'find', 'man']) expect(names).toContain(n);
    for (const n of ['su', 'ask', 'lock', 'passwd', 'help']) expect(names).not.toContain(n);
    await page.keyboard.press('q');
    await expect(body).toBeHidden();
    await lockCmd(page, 'help');
    await expect(badLine(page)).toContainText('help');
    await lockCmd(page, 'clear');
    await expect(out(page).locator('> div')).toHaveCount(0);
    await expectNoPopups(page);
  });

  test('man sudo（v6）：SYNOPSIS 没有 sudo styrigx / sudo -v（定稿 §十三 P4 删）', async ({ page }) => {
    await gotoLockTerm(page);
    await lockCmd(page, 'man sudo');
    const body = page.locator('#sgx-term [data-term-man-body]');
    await expect(page.locator('#sgx-term [data-term-man-st]')).toContainText('SUDO(1)');
    await expect(body).not.toContainText('sudo styrigx');
    await page.keyboard.press('q');
    await expect(body).toBeHidden();
  });


  test('↑ / ↓ 历史；^C 从 su 的密码态回到命令行（打印 ^C）；esc 同样退出', async ({ page }) => {
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
    await toPassword(page);
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
