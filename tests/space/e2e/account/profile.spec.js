/**
 * 账号 › 个人资料（P1–P8）。S9（Gray 2026-11-11）：账号卡片只展示，改资料搬进全站终端 #sgx-term 的账号层（shell/account/cmd/profile.js）；
 * 旧地址 /account/profile/ 301 → 首页 #acct=profile → 终端预填 profile。
 *
 * 覆盖：
 * - 账号卡片头部 姓名 · 昵称 · ✓ 已登录 · 编辑（→ 终端预填 profile）；本机缓存 sgx-profile 改过的值盖住默认值
 * - profile：姓名 / 昵称 / 签名 / 邮箱（没改过的显示站点默认值，标「默认」）+ 头像
 * - profile set name | nick | sign | email <值>：前端校验（空 / 太长 / 邮箱格式，lib/profile.js checkValue 同 Worker）报在终端里；
 *   保存只 PUT 这一项（PUT /api/profile）；接口错误（scope）报在终端里
 *
 * 静态构建：/api/account、/api/profile 用 page.route 替身。
 */
const { test, expect } = require('@playwright/test');
const T = require('../helpers/account-term.cjs');

const { mockAccount, openTerm, openCard, log, termIn, ps, typeLine, mode } = T;

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

test('卡片头部：姓名 · 昵称 · ✓ 已登录；本机缓存盖住默认值；「编辑」→ 终端预填 profile；profile 列出五项', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('sgx-profile', JSON.stringify({ v: 1, p: { name: 'Test Name', nickname: 'tnick' }, t: 1 })); } catch (e) {} });
  await mockAccount(page, { user: T.V6_USER('styrigx') });
  await mockProfile(page);
  await T.goPage(page);
  const d = await openCard(page);
  await expect(d).toHaveAttribute('data-acct-state', 'in');
  await expect(d.locator('.sgx-pop-who b')).toHaveText('Test Name');
  await expect(d.locator('.sgx-pop-who small')).toContainText('tnick');
  await expect(d.locator('.sgx-pop-who small')).toContainText('已登录');
  /* 大字（姓名）和第二行都贴着头像右边左对齐：头部是 <button>，以前继承了居中，姓名短时会缩进（Gray 2026-11-08 截图） */
  const nameBox = await d.locator('.sgx-pop-who b').boundingBox();
  const subBox = await d.locator('.sgx-pop-who small').boundingBox();
  const imgBox = await d.locator('.sgx-pop-me-a img').boundingBox();
  const range = await d.locator('.sgx-pop-who b').evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().left; });
  expect(Math.abs(nameBox.x - subBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(range - subBox.x), '姓名文字本身从左边开始，不居中').toBeLessThanOrEqual(1);
  expect(nameBox.x).toBeGreaterThan(imgBox.x + imgBox.width);
  /* 卡片里没有命令行 */
  await expect(d.locator('input')).toHaveCount(0);
  await d.locator('.sgx-pop-edit').click();
  await expect(d).toBeHidden();
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect(termIn(page)).toHaveValue('profile');
  /* 预填，不替人回车：输出区只有欢迎行 */
  await expect(log(page)).not.toContainText('profile');
  await termIn(page).press('Enter');
  await expect(log(page)).toContainText('Test Name');
  await expect(log(page)).toContainText('profile set name');
  await expect(log(page)).toContainText('tnick');
  await expect(log(page)).toContainText('To understand the world');
  await expect(log(page)).toContainText('profile set sign');
  await expect(log(page)).toContainText('profile set email');
  await expect(log(page)).toContainText('默认头像 · profile avatar');
});

test('profile set：空 / 太长 / 邮箱格式报错不发请求；保存只 PUT 这一项；旧地址 #acct=profile → 终端预填 profile', async ({ page }) => {
  await mockAccount(page, { user: T.V6_USER('styrigx') });
  const puts = await mockProfile(page);
  await T.goPage(page, '/zh/#acct=profile');
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect(termIn(page)).toHaveValue('profile');
  await expect(page).toHaveURL(/\/zh\/$/);
  await expect(ps(page)).toHaveText('styrigx@space:~$');

  /* 没给值 → 用法 */
  await typeLine(page, 'profile set name');
  await expect(log(page)).toContainText('用法：profile [set name | nick | sign | email <值> | avatar]');
  await typeLine(page, 'profile set nick ' + 'x'.repeat(33));
  await expect(log(page)).toContainText('太长了（最多 32 个字）');
  /* 邮箱格式（checkValue：EMAIL_RE 同账号 Worker） */
  for (const bad of ['not-an-email', 'a@b', 'a b@c.com', 'a@b.c', '<a@b.com>']) {
    await typeLine(page, 'clear');
    await typeLine(page, 'profile set email ' + bad);
    await expect(log(page)).toContainText('格式不对');
  }
  expect(puts).toHaveLength(0);

  await typeLine(page, 'profile set sign 记录 · 收藏');
  await expect(log(page)).toContainText('签名已更新');
  await mode(page, 'cmd');
  await typeLine(page, 'profile set email Me@Example.com');
  await expect(log(page)).toContainText('邮箱已更新');
  await mode(page, 'cmd');
  expect(puts).toEqual([{ motto: '记录 · 收藏' }, { email: 'Me@Example.com' }]);
  await typeLine(page, 'clear');
  await typeLine(page, 'profile');
  await expect(log(page)).toContainText('记录 · 收藏');
  await expect(log(page)).toContainText('Me@Example.com');
});

test('接口出错：通用失败文案报在终端里（v6 P4 删了 scope 分支）', async ({ page }) => {
  await mockAccount(page, { user: T.V6_USER('styrigx') });
  await mockProfile(page, { putReply: () => [500, { ok: false, error: 'internal' }] });
  await T.goPage(page);
  await openTerm(page);
  await typeLine(page, 'profile set nick newnick');
  await expect(log(page)).toContainText('服务暂时不可用');
  await mode(page, 'cmd');
});

test('访客：profile 提示先 su <用户>，不发请求（v6 P4 旧 sudo root 删了）', async ({ page }) => {
  await mockAccount(page, { user: null });
  const puts = await mockProfile(page);
  await T.goPage(page);
  await page.locator('#site-nav .sgx-tb-term').click();
  await expect(ps(page)).toHaveText('nobody@space:~$');
  await typeLine(page, 'profile set nick x');
  await expect(log(page)).toContainText('su <用户>');
  expect(puts).toHaveLength(0);
});

/* 2026-11-08（Gray 截图）：什么都没填（接口全 null / 旧值空串）→ 头部大字 = 站点默认姓名 Sloan Gray、第二行默认昵称 Styrigx；
   profile 显示默认值（标「默认」），不是「未填写」。子站以前没有 #sgx-profile-default，默认值全空 → 回退写死的 Styrigx。 */
test('没填过资料：卡片头部 Sloan Gray / Styrigx；profile 显示默认值（标「默认」），不是「未填写」', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('sgx-profile', JSON.stringify({ v: 1, p: { motto: '' }, t: 1 })); } catch (e) {} });
  await mockAccount(page, { user: T.V6_USER('styrigx') });
  await mockProfile(page, { stored: { name: null, nickname: null, motto: '', email: null } });
  await T.goPage(page);
  const d = await openCard(page);
  await expect(d).toHaveAttribute('data-acct-state', 'in');
  await expect(d.locator('.sgx-pop-who b')).toHaveText('Sloan Gray');
  await expect(d.locator('.sgx-pop-who small > span').first()).toHaveText('Styrigx');
  await page.keyboard.press('Escape');
  await openTerm(page);
  await typeLine(page, 'profile');
  await expect(log(page)).toContainText('Sloan Gray · 默认');
  await expect(log(page)).toContainText('Styrigx · 默认');
  await expect(log(page)).toContainText('To understand the world');
  await expect(log(page)).not.toContainText('未填写');
});

/* 子站（截图是在奇趣上）：以前没有 #sgx-profile-default，默认值全空。账号终端的画法同主站（同一份 shell/account），这里核对默认值确实在页面上 */
for (const path of ['/blog/zh/', '/curio/zh/', '/daymark/zh/']) {
  test(`子站 ${path} 也输出站点默认资料 #sgx-profile-default`, async ({ page }) => {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    const j = JSON.parse(await page.locator('#sgx-profile-default').textContent());
    expect(j.name).toBe('Sloan Gray');
    expect(j.nickname).toBe('Styrigx');
    expect(j.motto).toContain('To understand the world');
  });
}
