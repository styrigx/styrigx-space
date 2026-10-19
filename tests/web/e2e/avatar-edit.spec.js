/**
 * 账号页换头像（账号卡已从设置页移到账号总览 /settings/account/）：主人会话下点账号卡头像 → 选择照片 → 裁剪（拖动、滚轮缩放）→ 完成，
 * PUT /api/avatar 带 512 / 192 / 96 / 32 四张 WebP，成功后页面头像换成带 ?v= 的新地址。
 * 访客：头像按钮 disabled，没有铅笔。
 * 测试构建是静态服务器：主人身份靠改写 HTML 注入 data-sgx-role，/api/avatar 用 mock。
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  await page.route('**/settings/account/', async (route) => {
    const r = await route.fetch();
    const html = (await r.text()).replace(/<html/, '<html data-sgx-role="' + role + '" data-sgx-session="valid"');
    await route.fulfill({ response: r, body: html });
  });
}

test('主人：选择照片 → 裁剪 → 完成，上传四个尺寸并刷新页面头像', async ({ page }) => {
  await asRole(page, 'owner');
  /** @type {{method:string, body:Buffer}|null} */
  let put = null;
  await page.route('**/api/avatar', async (route) => {
    put = { method: route.request().method(), body: route.request().postDataBuffer() || Buffer.alloc(0) };
    await route.fulfill({ json: { ok: true, ver: 'abc' } });
  });
  await page.goto('/settings/account/');
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

test('主人：裁剪时点取消，不上传', async ({ page }) => {
  await asRole(page, 'owner');
  let called = false;
  await page.route('**/api/avatar', async (route) => {
    called = true;
    await route.fulfill({ json: { ok: true, ver: 'x' } });
  });
  await page.goto('/settings/account/');
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
  await page.goto('/settings/account/');
  const btn = page.locator('#acct-main [data-avatar-edit]');
  await expect(btn).toBeDisabled();
  await expect(btn.locator('.sgx-ac-pen')).toBeHidden();
});

test('设置页不再有账号卡（已移到账号页）', async ({ page }) => {
  await asRole(page, 'owner');
  await page.goto('/settings/');
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('.sgx-account-card')).toHaveCount(0);
  await expect(page.locator('[data-avatar-edit]')).toHaveCount(0);
});
