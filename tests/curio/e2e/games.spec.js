// 游戏子站 /games/（中文 /games/zh/；奇趣重组设计稿 v1.0 PR 2，原奇趣 › 游戏 /curio/games/）手机 e2e：接口用 page.route 假数据，不碰线上。
// 从 curio.spec.js 搬来的游戏用例，接口换成 /games/api/games、封面 /games/api/cover?id=；条目页 ?game=<id>；「在哪台设备上」去掉了。
// - 账号没登录（canManage=false）：只读，没有「touch games/ +」；状态 chips 筛选；默认按最近（编号大的在前）
// - 能编辑：添加游戏（状态、评分、平台联想）；封面「移动和缩放」3:4，保存才上传到 /games/api/cover
const { test, expect } = require('@playwright/test');

test.use({ locale: 'zh-CN' });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** signedIn = true：canManage / showPrivate 都是 true（games-manage）；false：都是 false */
async function mock(page, signedIn) {
  const manage = signedIn === true;
  const calls = [];
  await page.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/identity', (r) => { const b = r.request().postData() || ''; return manage && b.includes('"whoami"') ? r.fulfill({ json: { ok: true, user: { root: true } } }) : r.fallback(); });
  let games = [
    { id: 7, title: '塞尔达传说 王国之泪', platform: 'Switch', device_id: 0, edition: '实体版', status: 'done', rating: 5, review: '神作', cover: false, private: false },
    { id: 8, title: 'Hades II', platform: 'PC', device_id: 0, edition: '', status: 'playing', rating: 0, review: '', cover: false, private: false },
  ];
  let nextId = 100;
  await page.route('**/games/api/cover**', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    calls.push({ photo: req.method(), url: req.url(), type: req.headers()['content-type'], size: (req.postDataBuffer() || Buffer.alloc(0)).length });
    const id = Number(new URL(req.url()).searchParams.get('id'));
    games = games.map((g) => (g.id === id ? { ...g, cover: req.method() === 'POST' } : g));
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/games/api/games**', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canManage: manage, showPrivate: manage, games } });
    const body = req.postDataJSON();
    calls.push(body);
    let id;
    if (body.op === 'game.add') { id = nextId++; games.push({ cover: false, device_id: 0, ...body, id, op: undefined }); }
    if (body.op === 'game.edit') games = games.map((g) => (g.id === body.id ? { ...g, ...body, op: undefined } : g));
    if (body.op === 'game.del') games = games.filter((g) => g.id !== body.id);
    return r.fulfill({ json: { ok: true, canManage: true, showPrivate: true, id, games } });
  });
  return calls;
}

test('账号未登录：游戏只读（没有新建 / 调整顺序命令）；默认按最近；状态 chips 筛选；条目页 ?game=<id>、面包屑 cat ~/games/<名字>、没有编辑', async ({ page }) => {
  await mock(page, false);
  await page.goto('/games/zh/');
  await expect(page.locator('.sgx-ph-cmd')).toHaveText('nobody@space:~$ ls games/', { useInnerText: true });
  /* 游戏列表默认按「最近」排（编号大的在前，games-list.js） */
  await expect(page.locator('#gm-list .it-name')).toHaveText(['Hades II', '塞尔达传说 王国之泪']);
  await expect(page.locator('#gm-list [data-game="7"] .it-stars-ro')).toHaveText('★★★★★');
  await expect(page.locator('#gm-list [data-game="7"] .sgx-cc-m')).toHaveText('games · Switch');
  /* Gray 2026-11-23：卡片封面竖版 3:4（同裁剪框）；状态分颜色（通关 = 橙 --sgx-warning、在玩 = 绿 --sgx-success） */
  const im = await page.locator('#gm-list [data-game="7"] .sgx-cc-im').boundingBox();
  expect(Math.abs(im.height - im.width * 4 / 3), `封面 ${im.width}×${im.height} 不是 3:4`).toBeLessThanOrEqual(1);
  const col = await page.evaluate(() => {
    const v = (n) => { const e = document.createElement('i'); e.style.color = `var(${n})`; document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; };
    const c = (sel) => getComputedStyle(document.querySelector(sel)).color;
    return { done: c('#gm-list [data-game="7"] .it-status'), playing: c('#gm-list [data-game="8"] .it-status'), warn: v('--sgx-warning'), ok: v('--sgx-success') };
  });
  expect(col.done).toBe(col.warn);
  expect(col.playing).toBe(col.ok);
  await page.locator('#gm-chips [data-f="playing"]').click();
  await expect(page.locator('#gm-list .it-name')).toHaveText(['Hades II']);
  await expect(page.locator('#gm-fab')).toBeHidden();
  await expect(page.locator('#gm-order-open')).toBeHidden();
  await page.locator('#gm-list [data-game="8"]').click();
  await expect(page).toHaveURL(/\/games\/zh\/\?game=8$/);
  await expect(page.locator('#cu-item')).toBeVisible();
  await expect(page.locator('#cu-item .sgx-crumb')).toHaveText('$cat ~/games/hades-ii');
  await expect(page.locator('#cu-item .sgx-item-t')).toHaveText('Hades II');
  await expect(page.locator('#cu-item [data-item-edit]')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/games\/zh\/$/);
  await expect(page.locator('#cu-item')).toBeHidden();
  /* 直接打开条目页地址也行（主页 [05]、搜索索引都链 ?game=） */
  await page.goto('/games/zh/?game=7');
  await expect(page.locator('#cu-item .sgx-item-t')).toHaveText('塞尔达传说 王国之泪');
  /* 顶栏 NAVIGATE：05 游戏是当前项 */
  await page.locator('.sgx-tb-grid').click();
  await expect(page.locator('#sgx-nav [data-nav="games"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#sgx-nav [data-nav-count]')).toHaveText('05/05');
  await page.keyboard.press('Escape');
  await expect(page.locator('footer.sgx-foot .sgx-foot-win a[aria-current="page"]')).toHaveAttribute('data-win', 'games');
});

test('账号已登录（可写）：添加游戏（状态、评分、平台联想），没有「在哪台设备上」', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/games/zh/');
  await expect(page.locator('#gm-fab .sgx-cmd-k')).toHaveText('touch games/ +');
  await page.locator('#gm-fab').click();
  await expect(page.locator('#gm-edit-title')).toHaveText('添加游戏');
  await expect(page.locator('#gm-status [aria-checked="true"]')).toHaveText('想玩');
  await expect(page.locator('#gm-platforms option')).toHaveCount(2);
  await expect(page.locator('#gm-device')).toHaveCount(0);
  await page.locator('#gm-title').fill('绝区零');
  await page.locator('#gm-status [data-s="playing"]').click();
  await page.locator('#gm-platform').fill('Android');
  await page.locator('#gm-rating [data-r="4"]').click();
  await expect(page.locator('#gm-rating .it-star-btn.on')).toHaveCount(4);
  await page.locator('#gm-rating [data-r="4"]').click();
  await expect(page.locator('#gm-rating .it-star-btn.on')).toHaveCount(0);
  await page.locator('#gm-rating [data-r="3"]').click();
  await page.locator('#gm-review').fill('上头');
  await page.locator('#gm-save').click();
  await expect(page.locator('#gm-edit-wrap')).not.toHaveClass(/open/);
  expect(calls.find((c) => c.op === 'game.add')).toMatchObject({ title: '绝区零', status: 'playing', rating: 3, platform: 'Android', review: '上头', private: false });
  expect(calls.some((c) => c.photo)).toBe(false);
  const card = page.locator('#gm-list .it-cc').filter({ hasText: '绝区零' });
  await expect(card).toHaveCount(1);
  await expect(card.locator('.sgx-cc-m')).toHaveText('games · Android');
  await expect(card.locator('.it-status')).toHaveText('在玩');
});

/* 一张左右两半不同色的图：裁剪后看缩略图左上角的颜色就知道框住了哪一块 */
async function halves(page, w, h) {
  const b64 = await page.evaluate(([w, h]) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#d33'; g.fillRect(0, 0, w / 2, h); g.fillStyle = '#33d'; g.fillRect(w / 2, 0, w / 2, h); return c.toDataURL('image/png').split(',')[1]; }, [w, h]);
  return Buffer.from(b64, 'base64');
}
const frameBox = (page) => page.locator('.cu-crop-frame').boundingBox();

test('账号已登录（可写）：游戏封面「移动和缩放」——框是卡片的 3:4；拖动换位置；取消不改；Esc 只关裁剪；保存才传 /games/api/cover', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/games/zh/');
  await page.locator('#gm-list [data-game="8"]').click();
  await page.locator('#cu-item [data-item-edit]').click();
  await expect(page.locator('#gm-photo-prev')).toBeDisabled();
  const png = await halves(page, 2000, 1000); /* 3:4 框按高盖满：框住 750×1000，只占一半宽 */
  await page.locator('#gm-photo').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('dialog.cu-crop')).toBeVisible();
  const fb = await frameBox(page);
  expect(Math.abs(fb.width / fb.height - 3 / 4)).toBeLessThan(0.01);
  const cx = fb.x + fb.width / 2, cy = fb.y + fb.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 300, cy, { steps: 6 }); await page.mouse.up();
  await page.locator('[data-crop-done]').click();
  await expect(page.locator('dialog.cu-crop')).toBeHidden();
  const px = (sel) => page.locator(sel).evaluate((i) => new Promise((ok) => {
    const go = () => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext('2d'); g.drawImage(i, 0, 0);
      const d = g.getImageData(2, 2, 1, 1).data, e = g.getImageData(c.width - 3, 2, 1, 1).data; ok({ size: c.width + 'x' + c.height, left: d[0] > d[2] ? 'red' : 'blue', right: e[0] > e[2] ? 'red' : 'blue' }); };
    i.complete && i.naturalWidth ? go() : (i.onload = go);
  }));
  expect(await px('#gm-photo-prev img')).toEqual({ size: '750x1000', left: 'red', right: 'red' });
  await expect(page.locator('#gm-photo-prev')).toBeEnabled();
  await expect(page.locator('#gm-photo-prev')).toHaveAttribute('aria-label', '调整封面');
  const before = await page.locator('#gm-photo-prev img').getAttribute('src');
  await page.locator('#gm-photo-prev').click();
  await expect(page.locator('dialog.cu-crop')).toBeVisible();
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 300, cy, { steps: 6 }); await page.mouse.up();
  await page.locator('[data-crop-cancel]').click();
  await expect(page.locator('dialog.cu-crop')).toBeHidden();
  expect(await page.locator('#gm-photo-prev img').getAttribute('src')).toBe(before);
  await page.locator('#gm-photo-prev').click();
  await expect(page.locator('dialog.cu-crop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.cu-crop')).toBeHidden();
  await expect(page.locator('#gm-edit-wrap')).toHaveClass(/open/);
  expect(await page.locator('#gm-photo-prev img').getAttribute('src')).toBe(before);
  expect(calls.some((c) => c.photo)).toBe(false);
  await page.locator('#gm-save').click();
  await expect.poll(() => calls.find((c) => c.photo === 'POST')).toBeTruthy();
  expect(calls.find((c) => c.photo === 'POST').url).toMatch(/\/games\/api\/cover\?id=8(&|$)/);
  await expect(page.locator('#gm-list [data-game="8"] .sgx-cc-im img')).toHaveCount(1);
  await expect(page.locator('#cu-item .sgx-item-im img')).toHaveCount(1);
  await page.locator('#cu-item [data-item-edit]').click();
  await expect(page.locator('#gm-photo-prev')).toBeDisabled();
});
