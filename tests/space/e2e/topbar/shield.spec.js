/**
 * 盾牌 + 终端里的身份命令（v5 S5 终端合一：盾牌窗口 #sgx-sec 删了；v6 P4（定稿 v5.2 §六、§七、§十三 P4）起只有 v6 身份）。
 * - 盾牌（v5 S6 顶栏 E）= 打开终端：访客预填 su （不替人回车）；已登录（v6 身份）只打开终端、不预填；旧地址 #sec[=层] 只打开终端；
 *   Ctrl 点盾牌照旧按链接走（/#sec）。旧的「退出进站会话 [y/N]」随旧会话删了。
 * - 已登录：提示符 styrigx@space:~/wild$；man 列 lock / passkey / device，不列 share（分享短链整套删除，定稿 §二）
 * - lock：POST /api/identity lock（清空身份栈、删服务端会话行）→ 回访客 nobody@space；lock passwd / passkey / --all 印「已移除」
 * - 头像 = whoami（定稿 §七）：访客预填 su ；root 预填 exit
 * 测试构建（锁屏禁用、没有网关）：/api/identity 用替身（helpers/account-term.cjs mockAccount）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');
const A = require('../helpers/account-term.cjs');

/**
 * @param {import('@playwright/test').Page} page
 * @param {{user?: any, hash?: string, handlers?: Record<string, any>}} [o] user：v6 身份（默认 styrigx；null = 访客）
 */
async function go(page, o = {}) {
  await blockExternalRequests(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  const calls = await A.mockAccount(page, { user: o.user === undefined ? A.V6_USER('styrigx') : o.user, handlers: o.handlers });
  await page.goto('/zh/wild/' + (o.hash || ''), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
  return calls;
}
const term = (page) => page.locator('#sgx-term');
const tIn = (page) => page.locator('#sgx-term-in');
const tOut = (page) => page.locator('#sgx-term [data-term-out]');
const ps = (page) => page.locator('#sgx-term [data-term-ps]');
/** @param {import('@playwright/test').Page} page @param {string} text */
async function type(page, text) {
  await expect(tIn(page)).toBeEditable();
  await tIn(page).fill(text);
  await tIn(page).press('Enter');
}

test.describe('盾牌 + 身份命令（v6，在全站终端里）', () => {
  test('已登录：顶栏 >_ 打开终端（不预填），提示符 styrigx@space:~/wild$；man 列 lock / passkey / device，不列 share；没有盾牌窗口了', async ({ page }) => {
    await go(page);
    await expect(page.locator('#sgx-sec')).toHaveCount(0);
    await page.locator('#site-nav .sgx-tb-term').click();
    await expect(term(page)).toHaveAttribute('open', '');
    await expect(ps(page)).toHaveText('styrigx@space:~/wild$');
    await expect(tIn(page)).toHaveValue('');
    await type(page, 'man');
    const body = page.locator('#sgx-term [data-term-man-body]');
    await expect(body).toBeVisible();
    const lines = await body.locator('.sgx-term-ln').allTextContents();
    const names = lines.filter((l) => / — /.test(l)).map((l) => l.split(' — ')[0].trim());
    for (const n of ['lock', 'passkey', 'device']) expect(names).toContain(n);
    expect(names).not.toContain('share');
  });

  test('已登录：点盾牌只打开终端，不预填、不问 [y/N]、不发请求', async ({ page }) => {
    const calls = await go(page);
    await page.locator('.sgx-tb-shield').click();
    await expect(term(page)).toHaveAttribute('open', '');
    await expect(ps(page)).toHaveText('styrigx@space:~/wild$');
    await expect(tIn(page)).toHaveValue('');
    await expect(tOut(page)).not.toContainText('[y/N]');
    expect(calls.length).toBe(0);
  });

  test('访客：点盾牌打开终端、预填 su （不替人回车）', async ({ page }) => {
    const calls = await go(page, { user: null });
    await page.locator('.sgx-tb-shield').click();
    await expect(term(page)).toHaveAttribute('open', '');
    await expect(tIn(page)).toHaveValue('su ');
    await expect(ps(page)).toHaveText('nobody@space:~/wild$');
    expect(calls.length).toBe(0);
    expect(new URL(page.url()).pathname).toBe('/zh/wild/');
  });

  test('lock：POST /api/identity lock → 回访客（nobody@space），不跳页', async ({ page }) => {
    const calls = await go(page, { handlers: { 'identity/lock': [200, { ok: true, user: null }] } });
    await page.locator('#site-nav .sgx-tb-term').click();
    await expect(ps(page)).toHaveText('styrigx@space:~/wild$');
    await type(page, 'lock');
    await expect(ps(page)).toHaveText('nobody@space:~/wild$');
    expect(calls.filter((c) => c.action === 'identity/lock')).toHaveLength(1);
    expect(new URL(page.url()).pathname).toBe('/zh/wild/');
  });

  test('已移除的 lock passwd / lock passkey / lock --all：印一行「已移除 · v6 做法」，不发请求', async ({ page }) => {
    const calls = await go(page);
    await page.locator('#site-nav .sgx-tb-term').click();
    await type(page, 'lock passwd');
    await expect(tOut(page)).toContainText('lock passwd 已移除');
    await type(page, 'lock passkey add');
    await expect(tOut(page)).toContainText('lock passkey 已移除');
    await type(page, 'lock --all');
    await expect(tOut(page)).toContainText('lock --all 已移除');
    expect(calls.length).toBe(0);
  });

  test('旧地址 #sec=keys（/security/lock/ 301 过来）：打开终端，hash 去掉', async ({ page }) => {
    await go(page, { hash: '#sec=keys' });
    await expect(term(page)).toHaveAttribute('open', '');
    expect(new URL(page.url()).hash).toBe('');
  });

  test('Ctrl 点盾牌不开终端（照旧按链接走：/#sec）', async ({ page, context }) => {
    await go(page);
    const pop = context.waitForEvent('page');
    await page.locator('.sgx-tb-shield').click({ modifiers: ['Control'] });
    const np = await pop;
    await np.waitForLoadState('domcontentloaded');
    const u = new URL(np.url());
    expect(u.pathname + u.hash).toMatch(/^\/zh\/(#sec)?$/);
    await expect(term(page)).not.toHaveAttribute('open', '');
  });

  test('头像 = whoami：网关标了 locked（访客）= 预填 su （不开账号卡片、不跳页）；v6 root = 开账号卡片（定稿 §七 58–61）', async ({ page }) => {
    for (const [st, user, want] of [['locked', null, 'su ']]) {
      await go(page, { user });
      /* 测试构建没有网关：自己给页面打上网关的标记（后注册的 route 优先），再取一次 */
      await page.route('**/zh/wild/', async (r) => {
        const res = await r.fetch();
        const body = (await res.text()).replace(/<html /, '<html data-sgx-lock-session="' + st + '" ');
        await r.fulfill({ response: res, body });
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-sgx-lock-session', st);
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
      const av = page.locator('.sgx-tb-av');
      await expect(av).not.toHaveAttribute('aria-disabled', 'true');
      await expect.poll(async () => {
        await av.click();
        const v = await tIn(page).inputValue().catch(() => '');
        if (v !== want) { await page.keyboard.press('Escape'); }
        return v;
      }, { timeout: 10000 }).toBe(want);
      await expect(term(page)).toHaveAttribute('open', '');
      await expect(page.locator('#sgx-acct')).not.toHaveAttribute('data-state', 'open');
      expect(new URL(page.url()).pathname).toBe('/zh/wild/');
    }
    /* v6 root：点头像开账号卡片，不开终端、不预填 */
    await go(page, { user: A.V6_USER('root') });
    await page.route('**/zh/wild/', async (r) => {
      const res = await r.fetch();
      const body = (await res.text()).replace(/<html /, '<html data-sgx-lock-session="valid" ');
      await r.fulfill({ response: res, body });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
    await expect.poll(async () => {
      await page.locator('.sgx-tb-av').click();
      const st2 = await page.locator('#sgx-acct').getAttribute('data-acct-state');
      if (st2 !== 'in') await page.keyboard.press('Escape');
      return st2;
    }, { timeout: 10000 }).toBe('in');
    await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
    await expect(term(page)).not.toHaveAttribute('open', '');
    expect(new URL(page.url()).pathname).toBe('/zh/wild/');
  });
});
