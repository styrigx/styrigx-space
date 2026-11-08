/**
 * 换头像 / 移除头像（2026-11-08 账号 UI 改版：账号卡和 /account/ 整页删除，入口在头像下拉 #sgx-acct › 个人资料 › 「头像」一行，
 * shell/account/profile.js + avatar-edit.js；O7：裁剪交互不变）。
 *
 * - 「头像」一行展开：选择照片…（没有自定义头像时只有这一项）/ 移除照片（ETag 不是默认图 "d-32" 时才有）
 * - 选择照片 → 全屏裁剪（拖动、滚轮缩放）→ 完成：PUT /api/avatar 带 512 / 192 / 96 / 32 四张 WebP，页面上的头像换成带 ?v= 的新地址；取消不上传
 * - 移除照片：DELETE /api/avatar
 * 静态构建：/api/account、/api/avatar 用替身。
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const T = require('../helpers/account-term.cjs');

const { SESSION, STATUS, mockAccount, layer } = T;

test.use({ viewport: { width: 412, height: 915 } });
test.beforeEach(async ({ page }) => { await T.zh(page); });

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

/** 已登录，打开个人资料层，展开「头像」一行 @param {any} page */
async function openPhotoRow(page) {
  await mockAccount(page, { status: STATUS({ session: SESSION() }) });
  await T.goPage(page, '/zh/#acct=profile');
  await layer(page, 'profile');
  await page.locator('#sgx-acct [data-at-act="photo"]').click();
  await expect(page.locator('#sgx-acct [data-at-act="photo-pick"]')).toHaveText('选择照片…');
}

test('选择照片 → 裁剪 → 完成：上传四个尺寸，页面头像换新地址', async ({ page }) => {
  /** @type {{method:string, body:Buffer}|null} */
  let put = null;
  await page.route('**/api/avatar', async (route) => {
    put = { method: route.request().method(), body: route.request().postDataBuffer() || Buffer.alloc(0) };
    await route.fulfill({ json: { ok: true, ver: 'abc' } });
  });
  await openPhotoRow(page);
  /* 没有自定义头像：只有「选择照片…」 */
  await expect(page.locator('#sgx-acct [data-at-act="photo-rm"]')).toHaveCount(0);
  const photo = await makePhoto(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#sgx-acct [data-at-act="photo-pick"]').click()]);
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
  await expect(page.locator('.sgx-tb-avatar')).toHaveAttribute('src', '/avatar/192.webp?v=abc');
});

test('裁剪时点取消，不上传', async ({ page }) => {
  let called = false;
  await page.route('**/api/avatar', async (route) => { called = true; await route.fulfill({ json: { ok: true, ver: 'x' } }); });
  await openPhotoRow(page);
  const photo = await makePhoto(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#sgx-acct [data-at-act="photo-pick"]').click()]);
  await chooser.setFiles(photo);
  await expect(page.locator('.sgx-avc')).toBeVisible();
  await page.locator('[data-avc-cancel]').click();
  await expect(page.locator('.sgx-avc')).toBeHidden();
  expect(called).toBe(false);
});

test('有自定义头像（ETag 不是 "d-32"）：多一项「移除照片」→ DELETE /api/avatar', async ({ page }) => {
  await page.route('**/avatar/32.webp', (r) => r.fulfill({ status: 200, contentType: 'image/webp', headers: { ETag: '"abc-32"' }, body: Buffer.from('RIFF') }));
  let method = '';
  await page.route('**/api/avatar', async (route) => { method = route.request().method(); await route.fulfill({ json: { ok: true } }); });
  await openPhotoRow(page);
  const rm = page.locator('#sgx-acct [data-at-act="photo-rm"]');
  await expect(rm).toHaveText('移除照片');
  await rm.click();
  await expect.poll(() => method).toBe('DELETE');
  await expect(page.locator('#sgx-acct [data-at-act="photo-rm"]')).toHaveCount(0);
});
