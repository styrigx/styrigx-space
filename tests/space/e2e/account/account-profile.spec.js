/**
 * 账号 → 个人资料（2026-11-07）：账号总览「个人资料」卡 + 子页 /account/profile/（头像、姓名、昵称、签名、邮箱一行一项，行内改）。
 *
 * 覆盖：
 * - 账号总览：账号卡下面独立一张「个人资料」卡（副标题「头像、姓名、昵称、签名、邮箱」），在「设备 / 账号安全 / 应用授权」组上方；点进子页
 * - 子页：五行（顺序 头像 / 姓名 / 昵称 / 签名 / 邮箱），首帧默认值 → GET /api/profile 覆盖；中英文
 * - 行内编辑：点行展开（同一时间只开一行）、字数、取消丢改动、保存只 PUT 这一项并更新这一行、前端校验错误行（空 / 邮箱格式）、
 *   接口错误（没授权 profile.write）显示在编辑框下面
 * - 没有账号会话 → 跳 /account/?return=<子页>
 * - 宽屏 / DeX 版面：账号页换头像弹层关掉后不残留（sheet.js closeSheet 去 sgx-open；关着的 dialog 永远 display:none）
 *
 * 测试构建是静态服务器：/api/account、/api/profile 用 page.route mock。
 * 运行：npx playwright test --config=tests/config/playwright.config.js account-profile.spec.js
 */
const { test, expect } = require('@playwright/test');
const { blockExternalRequests } = require('../helpers/helpers');

const RECENT = () => ({ by: 'password', authAt: Date.now() - 1000, expiresAt: Date.now() + 3600000, recent: true });
const DEF = { name: 'Sloan Gray', nickname: 'Styrigx', email: 'styrigx@gmail.com' };

/** @param {any} page @param {{session?: boolean}} [o] */
async function mockAccount(page, o = {}) {
  const loggedIn = o.session !== false;
  await page.route('**/api/account', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { ok: true, password: true, passkey: false, ready: true, session: loggedIn ? RECENT() : null } });
      return;
    }
    await route.fulfill({ json: { ok: true, keys: [] } });
  });
}

/**
 * /api/profile mock：GET 回 stored（没改过的字段 null）；PUT 记下请求体，按 putReply 回（默认合并后回 ok）。
 * @param {any} page
 * @param {{stored?: Record<string, string|null>, putReply?: (body: any) => [number, any]}} [o]
 */
async function mockProfile(page, o = {}) {
  const stored = Object.assign({ name: null, nickname: null, motto: null, email: null }, o.stored || {});
  /** @type {any[]} */
  const puts = [];
  await page.route('**/api/profile', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({ json: { ok: true, profile: stored, avatar: '', updatedAt: 0 } });
      return;
    }
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
    puts.push(body);
    if (o.putReply) {
      const [st, j] = o.putReply(body);
      await route.fulfill({ status: st, json: j });
      return;
    }
    Object.assign(stored, body);
    await route.fulfill({ json: { ok: true, profile: stored, avatar: '', updatedAt: Date.now() } });
  });
  return puts;
}

/** @param {any} page @param {'zh'|'en'} lang */
async function setLang(page, lang) {
  await blockExternalRequests(page);
  await page.addInitScript((l) => { try { localStorage.setItem('sgx-lang', l); } catch (e) {} }, lang);
}

const item = (page, id) => page.locator(`#acct-profile [data-pf-field="${id}"]`);
const row = (page, id) => page.locator(`#acct-pf-row-${id}`);
const editor = (page, id) => page.locator(`#acct-pf-ed-${id}`);
const val = (page, id) => item(page, id).locator('[data-pf-val]');

test.describe('账号总览：个人资料卡', () => {
  test.use({ viewport: { width: 412, height: 915 } });

  test('卡片顺序：账号卡 → 个人资料（独立一张）→ 设备 / 账号安全 / 应用授权 → 云同步 → AI 模型；点进 /zh/account/profile/', async ({ page }) => {
    await setLang(page, 'zh');
    await mockAccount(page);
    await mockProfile(page);
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-main')).toBeVisible();
    const groups = await page.locator('#acct-main section').evaluateAll((els) => els.map((x) => Array.from(x.querySelectorAll('.acct-row')).map((r) => r.id)));
    expect(groups).toEqual([['acct-profile-row'], ['acct-dev-row', 'acct-sec-row', 'acct-apps-row'], ['acct-sync-row'], ['acct-ai-row']]);
    /* 账号卡在个人资料卡之前 */
    const order = await page.evaluate(() => {
      const card = document.querySelector('#acct-main [data-acct-card]');
      const pf = document.getElementById('acct-profile-row');
      return !!(card && pf && (card.compareDocumentPosition(pf) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(order, '账号卡在「个人资料」上方').toBe(true);
    const pfRow = page.locator('#acct-profile-row');
    await expect(pfRow).toContainText('个人资料');
    await expect(page.locator('#acct-profile-sub')).toHaveText('头像、姓名、昵称、签名、邮箱');
    await expect(pfRow).toHaveAttribute('href', '/zh/account/profile/');
    /* 账号卡名字 / 昵称读个人资料 */
    await expect(page.locator('#acct-main [data-acct-card] .sgx-ac-name')).toHaveText(DEF.name);
    await pfRow.click();
    await page.waitForURL(/\/zh\/account\/profile\/$/);
    await expect(page.locator('#acct-profile')).toBeVisible();
  });

  test('英文：Profile / Photo, name, nickname, motto, email', async ({ page }) => {
    await setLang(page, 'en');
    await mockAccount(page);
    await mockProfile(page);
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-main')).toBeVisible();
    await expect(page.locator('#acct-profile-row')).toContainText('Profile');
    await expect(page.locator('#acct-profile-sub')).toHaveText('Photo, name, nickname, motto, email');
    await expect(page.locator('#acct-profile-row')).toHaveAttribute('href', '/account/profile/');
  });
});

test.describe('个人资料子页', () => {
  test.use({ viewport: { width: 412, height: 915 } });

  test('中文：五行（头像 / 姓名 / 昵称 / 签名 / 邮箱），默认值 → 接口值覆盖；值不翻译', async ({ page }) => {
    await setLang(page, 'zh');
    await mockAccount(page);
    await mockProfile(page, { stored: { motto: '拆开世界是为了看懂它' } });
    const res = await page.goto('/zh/account/profile/', { waitUntil: 'domcontentloaded' });
    expect(res && res.status()).toBe(200);
    await expect(page.locator('#acct-pf-h')).toHaveText('基本信息');
    /* 顶栏长条页名 */
    await expect(page.locator('.sgx-tb-title')).toHaveText('个人资料');
    const ids = await page.locator('#acct-profile [data-pf-field]').evaluateAll((els) => els.map((e) => e.getAttribute('data-pf-field')));
    expect(ids).toEqual(['photo', 'name', 'nickname', 'motto', 'email']);
    const labels = await page.locator('#acct-profile [data-pf-field] .acct-pf-row .font-medium').allTextContents();
    expect(labels.map((s) => s.trim())).toEqual(['头像', '姓名', '昵称', '签名', '邮箱']);
    await expect(item(page, 'photo').locator('img.acct-pf-av')).toBeVisible();
    await expect(val(page, 'name')).toHaveText(DEF.name);
    await expect(val(page, 'nickname')).toHaveText(DEF.nickname);
    await expect(val(page, 'email')).toHaveText(DEF.email);
    await expect(val(page, 'motto')).toHaveText('拆开世界是为了看懂它');
    for (const id of ['name', 'nickname', 'motto', 'email']) {
      await expect(val(page, id)).toHaveAttribute('translate', 'no');
    }
    /* 全部收起，行是可聚焦的按钮 */
    for (const id of ['photo', 'name', 'nickname', 'motto', 'email']) {
      await expect(row(page, id)).toHaveAttribute('aria-expanded', 'false');
      await expect(editor(page, id)).toBeHidden();
    }
    /* 不横向溢出 */
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(o.sw).toBeLessThanOrEqual(o.iw);
  });

  test('英文：标签 Photo / Name / Nickname / Motto / Email', async ({ page }) => {
    await setLang(page, 'en');
    await mockAccount(page);
    await mockProfile(page);
    await page.goto('/account/profile/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-pf-h')).toHaveText('Basic info');
    await expect(page.locator('.sgx-tb-title')).toHaveText('Profile');
    const labels = await page.locator('#acct-profile [data-pf-field] .acct-pf-row .font-medium').allTextContents();
    expect(labels.map((s) => s.trim())).toEqual(['Photo', 'Name', 'Nickname', 'Motto', 'Email']);
    await expect(val(page, 'name')).toHaveText(DEF.name);
  });

  test('行内编辑：展开 → 字数 → 保存只 PUT 这一项、行更新、收起；同一时间只开一行；再点行收起', async ({ page }) => {
    await setLang(page, 'zh');
    await mockAccount(page);
    const puts = await mockProfile(page);
    await page.goto('/zh/account/profile/', { waitUntil: 'domcontentloaded' });
    await expect(val(page, 'nickname')).toHaveText(DEF.nickname);

    await row(page, 'nickname').click();
    await expect(row(page, 'nickname')).toHaveAttribute('aria-expanded', 'true');
    const inp = editor(page, 'nickname').locator('[data-pf-in]');
    await expect(inp).toBeVisible();
    await expect(inp).toHaveValue(DEF.nickname);
    await expect(inp).toBeFocused();
    await expect(editor(page, 'nickname').locator('[data-pf-count]')).toHaveText('7/32');

    /* 换一行：前一行收起 */
    await row(page, 'name').click();
    await expect(editor(page, 'nickname')).toBeHidden();
    await expect(row(page, 'nickname')).toHaveAttribute('aria-expanded', 'false');
    await expect(editor(page, 'name')).toBeVisible();
    /* 再点同一行：收起 */
    await row(page, 'name').click();
    await expect(editor(page, 'name')).toBeHidden();

    await row(page, 'nickname').click();
    await inp.fill('Gray');
    await expect(editor(page, 'nickname').locator('[data-pf-count]')).toHaveText('4/32');
    await editor(page, 'nickname').locator('[data-pf-save]').click();
    await expect(editor(page, 'nickname')).toBeHidden();
    await expect(val(page, 'nickname')).toHaveText('Gray');
    expect(puts).toEqual([{ nickname: 'Gray' }]);
    await expect(page.getByText('已保存')).toBeVisible();
  });

  test('取消 / Esc：丢掉没保存的改动，不发请求；回车 = 保存', async ({ page }) => {
    await setLang(page, 'zh');
    await mockAccount(page);
    const puts = await mockProfile(page);
    await page.goto('/zh/account/profile/', { waitUntil: 'domcontentloaded' });
    await expect(val(page, 'name')).toHaveText(DEF.name);

    await row(page, 'name').click();
    const inp = editor(page, 'name').locator('[data-pf-in]');
    await inp.fill('Someone Else');
    await editor(page, 'name').locator('[data-pf-cancel]').click();
    await expect(editor(page, 'name')).toBeHidden();
    await expect(val(page, 'name')).toHaveText(DEF.name);
    /* 再展开：输入框回到当前值 */
    await row(page, 'name').click();
    await expect(inp).toHaveValue(DEF.name);
    await inp.fill('Another');
    await inp.press('Escape');
    await expect(editor(page, 'name')).toBeHidden();
    await expect(val(page, 'name')).toHaveText(DEF.name);
    expect(puts).toEqual([]);

    /* 回车保存 */
    await row(page, 'name').click();
    await inp.fill('Sloan G.');
    await inp.press('Enter');
    await expect(editor(page, 'name')).toBeHidden();
    await expect(val(page, 'name')).toHaveText('Sloan G.');
    expect(puts).toEqual([{ name: 'Sloan G.' }]);
  });

  test('校验错误：姓名为空、邮箱格式不对 → 编辑框下面红字，不发请求；改了输入错误行消失', async ({ page }) => {
    await setLang(page, 'zh');
    await mockAccount(page);
    const puts = await mockProfile(page);
    await page.goto('/zh/account/profile/', { waitUntil: 'domcontentloaded' });
    await expect(val(page, 'email')).toHaveText(DEF.email);

    await row(page, 'name').click();
    const nameIn = editor(page, 'name').locator('[data-pf-in]');
    await nameIn.fill('   ');
    await editor(page, 'name').locator('[data-pf-save]').click();
    const nameErr = editor(page, 'name').locator('[data-pf-err]');
    await expect(nameErr).toBeVisible();
    await expect(nameErr).toHaveText('不能为空');
    await expect(nameIn).toHaveAttribute('aria-invalid', 'true');
    await expect(editor(page, 'name')).toBeVisible();
    await nameIn.type('x');
    await expect(nameErr).toBeHidden();

    await row(page, 'email').click();
    const mailIn = editor(page, 'email').locator('[data-pf-in]');
    await mailIn.fill('not-an-email');
    await editor(page, 'email').locator('[data-pf-save]').click();
    await expect(editor(page, 'email').locator('[data-pf-err]')).toHaveText('请输入有效的邮箱地址');
    await expect(val(page, 'email')).toHaveText(DEF.email);
    expect(puts).toEqual([]);
  });

  test('接口错误：没授权 profile.write（403 scope）→ 编辑框下面提示，值不变', async ({ page }) => {
    await setLang(page, 'zh');
    await mockAccount(page);
    const puts = await mockProfile(page, { putReply: () => [403, { ok: false, error: 'scope' }] });
    await page.goto('/zh/account/profile/', { waitUntil: 'domcontentloaded' });
    await expect(val(page, 'motto')).toBeVisible();
    await row(page, 'motto').click();
    const inp = editor(page, 'motto').locator('[data-pf-in]');
    await inp.fill('新的签名');
    await editor(page, 'motto').locator('[data-pf-save]').click();
    await expect(editor(page, 'motto').locator('[data-pf-err]')).toHaveText('个人资料未获账号授权');
    await expect(editor(page, 'motto')).toBeVisible();
    expect(puts).toEqual([{ motto: '新的签名' }]);
    await expect(val(page, 'motto')).not.toHaveText('新的签名');
  });

  test('头像行：行内「选择照片…」（没自定义头像时没有「移除照片」）+ 取消，不出底部弹层', async ({ page }) => {
    await setLang(page, 'zh');
    await mockAccount(page);
    await mockProfile(page);
    await page.goto('/zh/account/profile/', { waitUntil: 'domcontentloaded' });
    await row(page, 'photo').click();
    const ed = editor(page, 'photo');
    await expect(ed).toBeVisible();
    await expect(ed.locator('[data-pf-pick]')).toHaveText('选择照片…');
    await expect(ed.locator('[data-pf-remove]')).toBeHidden();
    await expect(page.locator('#sheet-wrap[open]')).toHaveCount(0);
    await ed.locator('[data-pf-cancel]').click();
    await expect(ed).toBeHidden();
  });

  test('没有账号会话 → 跳 /zh/account/?return=%2Fzh%2Faccount%2Fprofile%2F', async ({ page }) => {
    await setLang(page, 'zh');
    await mockAccount(page, { session: false });
    await mockProfile(page);
    await page.goto('/zh/account/profile/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/account\/\?return=%2Fzh%2Faccount%2Fprofile%2F$/);
    await expect(page.locator('#acct-login')).toBeVisible();
  });
});

test.describe('宽屏 / DeX：换头像弹层关掉后不残留', () => {
  /** 账号页（已登录 + 账号会话标记，头像按钮可点）→ 开「头像」弹层 */
  async function openAvatarSheet(page) {
    await setLang(page, 'zh');
    await mockAccount(page);
    await mockProfile(page);
    await page.route('**/account/', async (route) => {
      const r = await route.fetch();
      const html = (await r.text()).replace(/<html/, '<html data-sgx-lock-session="valid" data-sgx-account-session="in"');
      await route.fulfill({ response: r, body: html });
    });
    await page.goto('/account/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#acct-main')).toBeVisible();
    await page.locator('#acct-main [data-avatar-edit]').click();
    await expect(page.locator('#sheet-wrap[open]')).toHaveCount(1);
    await expect(page.locator('#sheet-title')).toHaveText('头像');
  }

  /** 关掉后：dialog 关着、不带 sgx-open、display:none、标题不可见 */
  async function expectGone(page) {
    await expect(page.locator('#sheet-wrap[open]')).toHaveCount(0);
    await expect(page.locator('#sheet-wrap')).toBeHidden();
    await expect(page.locator('#sheet-title')).toBeHidden();
    const st = await page.locator('#sheet-wrap').evaluate((el) => ({ cls: el.className, display: getComputedStyle(el).display }));
    expect(st.cls).not.toMatch(/sgx-open|sgx-closing/);
    expect(st.display).toBe('none');
  }

  test('宽屏 1280（自动桌面版面）：Esc 关闭后弹层不留在顶栏下', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openAvatarSheet(page);
    await expect(page.locator('html')).toHaveClass(/layout-dex/);
    await page.keyboard.press('Escape');
    await expectGone(page);
  });

  test('手机宽度手动 DeX（sgx-layout=dex）：Esc 关闭、以及直接 dialog.close() 后都不残留', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await page.addInitScript(() => { try { localStorage.setItem('sgx-layout', 'pc'); } catch (e) {} });
    await openAvatarSheet(page);
    await expect(page.locator('html')).toHaveClass(/layout-dex/);
    await page.keyboard.press('Escape');
    await expectGone(page);
    /* 不经 closeSheet 直接关（浏览器强制关闭 / 别的代码 close()） */
    await page.locator('#acct-main [data-avatar-edit]').click();
    await expect(page.locator('#sheet-wrap[open]')).toHaveCount(1);
    await page.locator('#sheet-wrap').evaluate((el) => /** @type {HTMLDialogElement} */ (el).close());
    await expectGone(page);
  });
});
