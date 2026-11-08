/**
 * 账号终端 › 个人资料（P1–P8）。2026-11-08 账号 UI 改版：/account/profile/ 整页删除，改在头像下拉 #sgx-acct 的「个人资料」层（shell/account/profile.js）；
 * 旧地址 301 → 首页 #acct=profile。
 *
 * 覆盖：
 * - 主页头部 姓名 · 昵称 · ✓ 已登录 · 编辑（→ 个人资料层）；本机缓存 sgx-profile 改过的值盖住默认值
 * - 个人资料层：五行（头像 / 姓名 / 昵称 / 签名 / 邮箱），头部 ~/account/profile
 * - 行下展开 `> 值` + 字数 + esc 取消 / enter 保存，每次只开一行；前端校验（空 / 太长 / 邮箱格式）显示在展开区；
 *   保存只 PUT 这一项（PUT /api/profile），成功后这一行换新值；接口错误（scope）显示在展开区
 *
 * 静态构建：/api/account、/api/profile 用 page.route 替身。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { SESSION, STATUS, mockAccount, openTerm, layer } = T;

test.use({ viewport: { width: 412, height: 915 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

/**
 * /api/profile 替身：GET 回 stored；PUT 记下请求体，按 putReply 回（默认合并后回 ok）。
 * @param {any} page @param {{stored?: Record<string, string|null>, putReply?: (body: any) => [number, any]}} [o]
 */
async function mockProfile(page, o = {}) {
  const stored = Object.assign({ name: null, nickname: null, motto: null, email: null }, o.stored || {});
  /** @type {any[]} */
  const puts = [];
  await page.route('**/api/profile', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') { await route.fulfill({ json: { ok: true, profile: stored, avatar: '', updatedAt: 0 } }); return; }
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    puts.push(body);
    if (o.putReply) { const [st, j] = o.putReply(body); await route.fulfill({ status: st, json: j }); return; }
    Object.assign(stored, body);
    await route.fulfill({ json: { ok: true, profile: stored, avatar: '', updatedAt: Date.now() } });
  });
  return puts;
}

const row = (page, id) => page.locator(`#sgx-acct [data-at-act="edit:${id}"]`);
const ein = (page) => page.locator('#sgx-acct [data-at-ein]');
const ems = (page) => page.locator('#sgx-acct [data-at-ems]');

test('主页头部：姓名 · 昵称 · ✓ 已登录；本机缓存盖住默认值；「编辑」进个人资料层（五行，头部 ~/account/profile）', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('sgx-profile', JSON.stringify({ v: 1, p: { name: 'Test Name', nickname: 'tnick' }, t: 1 })); } catch (e) {} });
  await mockAccount(page, { status: STATUS({ session: SESSION() }) });
  await mockProfile(page);
  await T.goPage(page);
  const d = await openTerm(page);
  await layer(page, 'home');
  await expect(d.locator('.sgx-pop-who b')).toHaveText('Test Name');
  await expect(d.locator('.sgx-pop-who small')).toContainText('tnick');
  await expect(d.locator('.sgx-pop-who small')).toContainText('已登录');
  await d.locator('.sgx-pop-edit').click();
  await layer(page, 'profile');
  await expect(d.locator('.sgx-at-h')).toHaveText('个人资料');
  await expect(d.locator('.sgx-at-hv')).toHaveText('~/account/profile');
  await expect(d.locator('[data-at-view] .sgx-pop-k')).toHaveText(['头像', '姓名', '昵称', '签名', '邮箱']);
  await expect(row(page, 'name')).toContainText('Test Name');
  await expect(row(page, 'motto')).toContainText('To understand the world');
});

test('行内编辑：每次只开一行；字数；esc 丢改动；空值 / 邮箱格式报错；保存只 PUT 这一项并更新这一行', async ({ page }) => {
  await mockAccount(page, { status: STATUS({ session: SESSION() }) });
  const puts = await mockProfile(page);
  await T.goPage(page, '/zh/#acct=profile');
  const d = page.locator('#sgx-acct');
  await layer(page, 'profile');
  await expect(page).toHaveURL(/\/zh\/$/);

  await row(page, 'nickname').click();
  await expect(ein(page)).toHaveAttribute('data-at-ein', 'nickname');
  await expect(ein(page)).toBeFocused();
  await row(page, 'name').click();
  await expect(ein(page)).toHaveCount(1);
  await expect(ein(page)).toHaveAttribute('data-at-ein', 'name');
  await ein(page).fill('abc');
  await expect(d.locator('[data-at-ct]')).toHaveText('3/40');
  await ein(page).press('Escape');
  await expect(ein(page)).toHaveCount(0);
  await expect(d).toBeVisible();
  await expect(row(page, 'name')).not.toContainText('abc');

  await row(page, 'name').click();
  await ein(page).fill('   ');
  await d.locator('[data-at-act="ed-save"]').click();
  await expect(ems(page)).toHaveText('不能为空');
  expect(puts).toHaveLength(0);

  await row(page, 'email').click();
  await ein(page).fill('not-an-email');
  await ein(page).press('Enter');
  await expect(ems(page)).toHaveText('格式不对');
  expect(puts).toHaveLength(0);

  await row(page, 'motto').click();
  await ein(page).fill('记录 · 收藏');
  await ein(page).press('Enter');
  await expect(ein(page)).toHaveCount(0);
  await expect(row(page, 'motto')).toContainText('记录 · 收藏');
  expect(puts).toEqual([{ motto: '记录 · 收藏' }]);
});

test('接口错误（没授权 profile.write）：显示在展开区，输入框还能改', async ({ page }) => {
  await mockAccount(page, { status: STATUS({ session: SESSION() }) });
  await mockProfile(page, { putReply: () => [403, { ok: false, error: 'scope' }] });
  await T.goPage(page, '/zh/#acct=profile');
  await layer(page, 'profile');
  await row(page, 'nickname').click();
  await ein(page).fill('newnick');
  await ein(page).press('Enter');
  await expect(ems(page)).toHaveText('个人资料未获账号授权');
  await expect(ein(page)).toBeEnabled();
});
