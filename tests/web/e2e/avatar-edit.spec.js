/**
 * 账号页换头像（账号卡已从设置页移到账号总览 /account/）：管理员会话下点账号卡头像 → 选择照片 → 裁剪（拖动、滚轮缩放）→ 完成，
 * PUT /api/avatar 带 512 / 192 / 96 / 32 四张 WebP，成功后页面头像换成带 ?v= 的新地址。
 * 访客：头像按钮 disabled，没有铅笔。
 * 测试构建是静态服务器：管理员身份靠改写 HTML 注入 data-sgx-role，/api/avatar 用 mock。
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { nextFrames, armNavProbe } = require('./helpers');

test.use({ locale: 'zh-CN', viewport: { width: 412, height: 915 } });

/* 生成一张 1200×800 的测试 PNG（纯色即可，裁剪逻辑不看内容） */
async function makePhoto(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 800;
    const x = c.getContext('2d');
    x.fillStyle = 'rgb(200,40,60)';
    x.fillRect(0, 0, 1200, 800);
    x.fillStyle = 'rgb(40,60,200)';
    x.fillRect(600, 0, 600, 800);
    return c.toDataURL('image/png').split(',')[1];
  });
  const p = path.join(os.tmpdir(), 'sgx-avatar-test.png');
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
}

async function asRole(page, role) {
  /* 账号总览：已登录账号（账号卡在登录后的总览里） */
  await page.route('**/api/account', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { ok: true, password: true, passkey: true, ready: true, session: { by: 'password', authAt: Date.now(), expiresAt: Date.now() + 3600000, recent: true } } });
      return;
    }
    await route.fulfill({ json: { ok: true, keys: [] } });
  });
  await page.route('**/account/', async (route) => {
    const r = await route.fetch();
    const html = (await r.text()).replace(/<html/, '<html data-sgx-role="' + role + '" data-sgx-lock-session="valid"');
    await route.fulfill({ response: r, body: html });
  });
}

test('管理员：选择照片 → 裁剪 → 完成，上传四个尺寸并刷新页面头像', async ({ page }) => {
  await asRole(page, 'admin');
  /** @type {{method:string, body:Buffer}|null} */
  let put = null;
  await page.route('**/api/avatar', async (route) => {
    put = { method: route.request().method(), body: route.request().postDataBuffer() || Buffer.alloc(0) };
    await route.fulfill({ json: { ok: true, ver: 'abc' } });
  });
  await page.goto('/account/');
  const photo = await makePhoto(page);
  const btn = page.locator('#acct-main [data-avatar-edit]');
  await expect(btn).toBeEnabled();
  await expect(btn.locator('.sgx-ac-pen')).toBeVisible();

  await btn.click();
  /* 没有自定义头像：只有「选择照片…」 */
  await expect(page.locator('#sheet-body .sheet-opt')).toHaveCount(1);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#sheet-body .sheet-opt').first().click()]);
  await chooser.setFiles(photo);
  await expect(page.locator('.sgx-avc')).toBeVisible();

  /* 拖动 + 滚轮放大，不报错 */
  await page.mouse.move(200, 420);
  await page.mouse.down();
  await page.mouse.move(140, 440, { steps: 5 });
  await page.mouse.up();
  await page.mouse.wheel(0, -300);

  await page.locator('[data-avc-done]').click();
  await expect(page.locator('.sgx-avc')).toBeHidden();
  expect(put).not.toBeNull();
  expect(put.method).toBe('PUT');
  const body = put.body.toString('latin1');
  for (const s of ['512', '192', '96', '32']) expect(body).toContain('name="' + s + '"');
  expect((body.match(/WEBP/g) || []).length).toBe(4);
  await expect(page.locator('#acct-main .sgx-ac-img')).toHaveAttribute('src', '/avatar/192.webp?v=abc');
  await expect(page.locator('.sgx-tb-avatar')).toHaveAttribute('src', '/avatar/192.webp?v=abc');
});

test('管理员：裁剪时点取消，不上传', async ({ page }) => {
  await asRole(page, 'admin');
  let called = false;
  await page.route('**/api/avatar', async (route) => {
    called = true;
    await route.fulfill({ json: { ok: true, ver: 'x' } });
  });
  await page.goto('/account/');
  const photo = await makePhoto(page);
  await page.locator('#acct-main [data-avatar-edit]').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#sheet-body .sheet-opt').first().click()]);
  await chooser.setFiles(photo);
  await expect(page.locator('.sgx-avc')).toBeVisible();
  await page.locator('[data-avc-cancel]').click();
  await expect(page.locator('.sgx-avc')).toBeHidden();
  expect(called).toBe(false);
});

test('访客：头像按钮不可点，没有铅笔', async ({ page }) => {
  await asRole(page, 'visitor');
  await page.goto('/account/');
  const btn = page.locator('#acct-main [data-avatar-edit]');
  await expect(btn).toBeDisabled();
  await expect(btn.locator('.sgx-ac-pen')).toBeHidden();
});

test('设置页不再有账号卡（已移到账号页）', async ({ page }) => {
  await asRole(page, 'admin');
  await page.goto('/settings/');
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('.sgx-account-card')).toHaveCount(0);
  await expect(page.locator('[data-avatar-edit]')).toHaveCount(0);
});

/* 2026-10-24 PR4：账号卡只是展示（兼作个人资料卡）——显示「已登录」，卡片不能点、没有详情页；点头像直接换头像 */
test('账号卡：显示「已登录」；卡片本身不能点（不跳页、没有 link 角色）；点头像直接出换头像弹层', async ({ page }) => {
  await asRole(page, 'admin');
  await page.goto('/account/');
  const card = page.locator('#acct-main [data-acct-card]');
  await expect(card).toBeVisible();
  await expect(card.locator('.sgx-ac-state')).toHaveText('已登录');
  expect(await card.getAttribute('role')).toBeNull();
  expect(await card.getAttribute('tabindex')).toBeNull();
  expect(await card.evaluate((el) => getComputedStyle(el).cursor)).not.toBe('pointer');
  /* 点名字 / 已登录 / 卡片空白：都留在账号页，不出弹层 */
  const navs = await armNavProbe(page);
  await card.locator('.sgx-ac-name').click();
  await card.locator('.sgx-ac-state').click();
  /* 点击处理同步：要跳转 / 开弹层的话此时已经发生；再等两帧让 rAF 里的反应落地 */
  await nextFrames(page);
  expect(await navs(), '点账号卡不触发任何导航').toEqual([]);
  expect(new URL(page.url()).pathname).toBe('/account/');
  await expect(page.locator('#sheet-wrap[open]')).toHaveCount(0);
  /* 点头像：直接是换头像的弹层（选择照片…），页面不动 */
  await card.locator('[data-avatar-edit]').click();
  await expect(page.locator('#sheet-title')).toHaveText('头像');
  await expect(page.locator('#sheet-body .sheet-opt').first()).toHaveText('选择照片…');
  expect(new URL(page.url()).pathname).toBe('/account/');
});

test('英文账号卡：Signed in', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
  await asRole(page, 'admin');
  await page.goto('/en/account/');
  await expect(page.locator('#acct-main [data-acct-card] .sgx-ac-state')).toHaveText('Signed in');
});

test('「账号信息」子页删除：/account/profile/、/en/account/profile/ 404，不跳转', async ({ page }) => {
  for (const p of ['/account/profile/', '/en/account/profile/']) {
    const res = await page.request.get(p, { maxRedirects: 0 });
    expect(res.status(), p).toBe(404);
  }
});
