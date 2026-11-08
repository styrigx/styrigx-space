// 奇趣拆页（P4-3）新增的两个子页（手机）：电影 /curio/movies/、私人音乐 /curio/music/。接口用 page.route 假数据，不碰线上。
// - 电影：无权限（canWrite=false）只读，没有「电影」按钮、详情没有编辑；有权限：添加（海报「移动和缩放」→ 2:3、长边 ≤1600、webp 上传 kind=movie）、编辑、删除要确认
// - 音乐：没权限（401 account / 403 scope）首页不显示入口、子页只显示「仅本人可见」、没有上传按钮；
//   有权限：首页露出入口；封面横滑切专辑；整张按曲序播放（POST music-play 拿短链，<audio> 走 music-stream）；歌词跟着亮；倍速循环；下一首；
//   上传专辑（album.add → 音频按文件名排序逐个直传、曲序 / 曲名取自文件名 → .lrc 按文件名对上 track.edit）
const { test, expect } = require('@playwright/test');

/* 语言清理（2026-11-07）起奇趣 / 日刻也「跟随系统」每页都跳（四站同一份首帧跳转 lang-boot.js），Playwright 默认 en-US 会把 /<站>/zh/… 换到英文页。
   本文件的中文用例按中文浏览器跑（同 ui-cookie.spec.js）；要看英文页的地方先明确选英文（同源 localStorage sgx-lang=en），见 chooseLang。 */
test.use({ locale: 'zh-CN' });
/** 明确选语言（同源 localStorage sgx-lang；'system' = 回到跟随系统）。页面已在本站时用。 @param {import('@playwright/test').Page} page @param {string} l */
const chooseLang = (page, l) => page.evaluate((v) => { localStorage.setItem('sgx-lang', v); }, l);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** 一段 n 秒的静音 WAV（8 kHz 单声道 8 位），给 <audio> 真的能放 */
function wav(sec) {
  const rate = 8000, n = rate * sec, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
}
const WAV = wav(3);

async function base(page, can) {
  await page.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/access', (r) => r.fulfill({ json: { ok: true, canWrite: can, showPrivate: can, music: can } }));
}

/* ================= 电影 ================= */

async function mockMovies(page, can) {
  await base(page, can);
  const calls = [];
  let movies = [
    { id: 1, title: '花样年华', original_title: 'In the Mood for Love', year: 2000, director: '王家卫', rating: 5, review: '旗袍和雨', watched_at: '2025-06-01', poster: true },
    { id: 2, title: '奥本海默', original_title: 'Oppenheimer', year: 2023, director: '诺兰', rating: 4, review: '', watched_at: '', poster: false },
  ];
  let next = 10;
  await page.route('**/api/photo**', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    calls.push({ photo: req.method(), url: req.url(), type: req.headers()['content-type'], size: (req.postDataBuffer() || Buffer.alloc(0)).length });
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/movies', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canWrite: can, showPrivate: can, movies } });
    if (!can) return r.fulfill({ status: 403, json: { ok: false, error: 'scope', scope: 'curio.write' } });
    const b = req.postDataJSON();
    calls.push(b);
    let id;
    if (b.op === 'movie.add') { id = next++; movies = [{ poster: false, ...b, id, op: undefined }, ...movies]; }
    if (b.op === 'movie.edit') movies = movies.map((m) => (m.id === b.id ? { ...m, ...b, op: undefined } : m));
    if (b.op === 'movie.del') movies = movies.filter((m) => m.id !== b.id);
    return r.fulfill({ json: { ok: true, canWrite: true, showPrivate: true, id, movies } });
  });
  return calls;
}

test('电影（无权限）：只读封面卡——没有新建命令、条目页没有编辑；命令链「sudo login · 登录账号后可编辑」；胶囊 = 电影', async ({ page }) => {
  await mockMovies(page, false);
  await page.goto('/curio/zh/');
  await page.locator('#cu-tabs [data-ctab="movies"]').click();
  await expect(page).toHaveURL(/\/curio\/zh\/movies\/$/);
  await expect(page.locator('.sgx-tb-title')).toHaveText('电影');
  await expect(page.locator('#mv-list .it-name')).toHaveText(['花样年华', '奥本海默']);
  await expect(page.locator('#mv-list [data-movie="1"] .sgx-cc-m')).toHaveText('movies · 2000 · 王家卫');
  await expect(page.locator('#mv-list [data-movie="1"] .it-stars-ro')).toHaveText('★★★★★');
  await expect(page.locator('#mv-list [data-movie="1"] .sgx-cc-im img')).toHaveCount(1);
  await expect(page.locator('#cu-tabs [data-cu-count="movies"]')).toHaveText('2');
  await expect(page.locator('#mv-fab')).toBeHidden();
  await expect(page.locator('#cu-signin [data-signin-text]')).toHaveText('登录账号后可编辑');
  await page.locator('#mv-list [data-movie="1"]').click();
  await expect(page).toHaveURL(/\/curio\/zh\/movies\/\?id=1$/);
  await expect(page.locator('#cu-item .sgx-crumb')).toContainText('cat ~/curio/movies/');
  await expect(page.locator('#cu-item .sgx-item-t')).toHaveText('花样年华');
  await expect(page.locator('#cu-item .sgx-spec')).toContainText('In the Mood for Love');
  await expect(page.locator('#cu-item .sgx-spec')).toContainText('2025-06-01');
  await expect(page.locator('#cu-item .sgx-item-p')).toHaveText('旗袍和雨');
  await expect(page.locator('#cu-item [data-item-edit]')).toHaveCount(0);
  /* 底部两卡：第一个是 cd ..（回列表），右边 cd ../next 下一部 */
  await expect(page.locator('#cu-item .sgx-nx-a')).toHaveText([/cd \.\./, /cd \.\.\/next.*奥本海默/]);
  await page.locator('#cu-item .sgx-nx-a.is-next').click();
  await expect(page).toHaveURL(/\?id=2$/);
  await expect(page.locator('#cu-item .sgx-item-t')).toHaveText('奥本海默');
  await page.locator('#cu-item .sgx-nx-a').first().click();
  await expect(page.locator('#cu-item .sgx-item-t')).toHaveText('花样年华');
});

test('电影（有权限）：添加（海报裁成 2:3、长边 ≤1600、webp 上传 kind=movie）、详情里编辑、删除要确认', async ({ page }) => {
  const calls = await mockMovies(page, true);
  await page.goto('/curio/zh/movies/');
  await expect(page.locator('#mv-fab')).toBeVisible();
  await expect(page.locator('#cu-signin')).toBeHidden();
  await page.locator('#mv-fab').click();
  await expect(page.locator('#mv-edit-wrap')).toHaveClass(/open/);
  await expect(page.locator('#mv-edit-title')).toHaveText('添加电影');
  await page.locator('#mv-save').click();
  await expect(page.locator('#mv-err')).toHaveText('填一下片名。');
  await page.locator('#mv-title').fill('千与千寻');
  await page.locator('#mv-original').fill('千と千尋の神隠し');
  await page.locator('#mv-year').fill('2001');
  await page.locator('#mv-director').fill('宫崎骏');
  await page.locator('#mv-watched').fill('2026-10-01');
  await page.locator('#mv-rating [data-r="5"]').click();
  await page.locator('#mv-review').fill('重看一遍还是哭');
  const big = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 3000; c.height = 4000; const g = c.getContext('2d'); g.fillStyle = '#a53'; g.fillRect(0, 0, 3000, 4000); return c.toDataURL('image/png').split(',')[1]; });
  await page.locator('#mv-photo').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: Buffer.from(big, 'base64') });
  await expect(page.locator('dialog.cu-crop')).toBeVisible();
  const fb = await page.locator('.cu-crop-frame').boundingBox();
  expect(Math.abs(fb.width / fb.height - 2 / 3)).toBeLessThan(0.01);
  await page.locator('[data-crop-done]').click();
  await expect(page.locator('dialog.cu-crop')).toBeHidden();
  await expect.poll(() => page.locator('#mv-photo-prev img').evaluate((i) => i.naturalWidth + 'x' + i.naturalHeight)).toBe('1067x1600');
  await page.locator('#mv-save').click();
  await expect(page.locator('#mv-edit-wrap')).not.toHaveClass(/open/);
  expect(calls.find((c) => c.op === 'movie.add')).toMatchObject({ title: '千与千寻', original_title: '千と千尋の神隠し', year: 2001, director: '宫崎骏', watched_at: '2026-10-01', rating: 5, review: '重看一遍还是哭' });
  await expect.poll(() => calls.find((c) => c.photo === 'POST')).toBeTruthy();
  const up = calls.find((c) => c.photo === 'POST');
  expect(up.url).toContain('kind=movie&id=10');
  expect(up.type).toBe('image/webp');
  await expect(page.locator('#bk-toast')).toHaveText('已保存');
  await expect(page.locator('#mv-list .it-name').first()).toHaveText('千与千寻');

  /* 编辑：从条目页进 */
  await page.locator('#mv-list [data-movie="2"]').click();
  await page.locator('#cu-item [data-item-edit]').click();
  await expect(page.locator('#mv-edit-title')).toHaveText('编辑电影');
  await expect(page.locator('#mv-title')).toHaveValue('奥本海默');
  await page.locator('#mv-year').fill('1800');
  await page.locator('#mv-save').click();
  await expect(page.locator('#mv-err')).toHaveText('年份不对，检查一下。');
  await page.locator('#mv-year').fill('2023');
  await page.locator('#mv-rating [data-r="3"]').click();
  await page.locator('#mv-save').click();
  await expect(page.locator('#mv-edit-wrap')).not.toHaveClass(/open/);
  expect(calls.find((c) => c.op === 'movie.edit')).toMatchObject({ id: 2, rating: 3, year: 2023 });

  /* 删除（删完回列表） */
  await page.goBack();
  await page.locator('#mv-list [data-movie="1"]').click();
  await page.locator('#cu-item [data-item-edit]').click();
  await page.locator('#mv-del').click();
  await expect(page.locator('#confirm-msg')).toHaveText('确定删除这部电影吗？');
  await page.locator('#confirm-ok').click();
  await expect.poll(() => calls.some((c) => c.op === 'movie.del' && c.id === 1)).toBe(true);
  await expect(page.locator('#mv-list [data-movie="1"]')).toHaveCount(0);
});

/* ================= 音乐 ================= */

const ALBUMS = [
  { id: 1, title: 'Blue', artist: 'Joni Mitchell', year: 1971, cover: true, tracks: [
    { id: 11, no: 1, title: 'All I Want', duration: 3, size: WAV.length, type: 'audio/wav', lrc: true },
    { id: 12, no: 2, title: 'My Old Man', duration: 3, size: WAV.length, type: 'audio/wav', lrc: false },
  ] },
  { id: 2, title: '范特西', artist: '周杰伦', year: 2001, cover: false, tracks: [
    { id: 21, no: 1, title: '爱在西元前', duration: 3, size: WAV.length, type: 'audio/wav', lrc: false },
  ] },
];

async function mockMusic(page, who) {
  const can = who === 'owner';
  await base(page, can);
  const calls = [];
  let albums = JSON.parse(JSON.stringify(ALBUMS));
  const deny = (r) => r.fulfill(who === 'noscope' ? { status: 403, json: { ok: false, error: 'scope', scope: 'curio.write' } } : { status: 401, json: { ok: false, error: 'account' } });
  await page.route('**/api/music-cover**', (r) => (can ? r.fulfill({ status: 200, contentType: 'image/png', body: PNG }) : deny(r)));
  await page.route('**/api/music', async (r) => {
    if (!can) return deny(r);
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, albums } });
    const b = req.postDataJSON();
    calls.push(b);
    let id;
    if (b.op === 'album.add') { id = 9; albums.push({ id, title: b.title, artist: b.artist, year: b.year, cover: false, tracks: [] }); }
    if (b.op === 'album.del') albums = albums.filter((a) => a.id !== b.id);
    return r.fulfill({ json: { ok: true, id, albums } });
  });
  await page.route('**/api/music-upload**', async (r) => {
    if (!can) return deny(r);
    const req = r.request();
    const u = new URL(req.url());
    calls.push({ upload: u.searchParams.get('kind'), no: Number(u.searchParams.get('no')), title: u.searchParams.get('title'), type: req.headers()['content-type'], size: (req.postDataBuffer() || Buffer.alloc(0)).length });
    if (u.searchParams.get('kind') === 'track') {
      const a = albums.find((x) => x.id === Number(u.searchParams.get('album')));
      const tid = 900 + a.tracks.length;
      a.tracks.push({ id: tid, no: Number(u.searchParams.get('no')), title: u.searchParams.get('title'), duration: Number(u.searchParams.get('duration')), lrc: false });
      return r.fulfill({ json: { ok: true, id: tid } });
    }
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/music-play', async (r) => {
    if (!can) return deny(r);
    const b = r.request().postDataJSON();
    calls.push({ play: b.album });
    const a = albums.find((x) => x.id === b.album);
    return r.fulfill({ json: { ok: true, ttl: 600000, expires: Date.now() + 600000, tracks: a.tracks.map((t) => ({ ...t, src: '/curio/api/music-stream?t=' + 'A'.repeat(43) + '&id=' + t.id, lrc: t.id === 11 ? '[00:00.00]第一句\n[00:01.00]第二句\n[00:02.00]第三句' : '' })) } });
  });
  await page.route('**/api/music-stream**', async (r) => {
    const range = r.request().headers().range;
    const m = /bytes=(\d+)-(\d*)/.exec(range || '');
    if (!m) return r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(WAV.length) }, body: WAV });
    const a = Number(m[1]), b = m[2] ? Math.min(Number(m[2]), WAV.length - 1) : WAV.length - 1;
    return r.fulfill({ status: 206, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${WAV.length}`, 'Content-Length': String(b - a + 1) }, body: WAV.subarray(a, b + 1) });
  });
  return calls;
}

for (const who of ['lock', 'noscope']) {
  test(`音乐（没权限：${who === 'lock' ? '没登录账号 401 account' : '没授权 403 scope'}）：首页没有音乐 tab；直接打开子页只显示「仅本人可见」，没有上传命令和播放器`, async ({ page }) => {
    await mockMusic(page, who);
    await page.goto('/curio/zh/');
    await expect(page.locator('#cu-tabs .sgx-ctab-a:visible')).toHaveText([/^finds\//, /^devices\//, /^games\//, /^movies\//]);
    await expect(page.locator('#cu-tabs [data-ctab="music"]')).toBeHidden();
    await page.goto('/curio/zh/music/');
    await expect(page.locator('#mu-denied')).toBeVisible();
    await expect(page.locator('#mu-denied .mu-denied-title')).toHaveText('仅本人可见');
    await expect(page.locator('#mu-denied-link')).toHaveAttribute('href', who === 'noscope' ? 'https://styrigx.com/zh/account/apps/' : 'https://styrigx.com/zh/account/');
    await expect(page.locator('#mu-app')).toBeHidden();
    await expect(page.locator('#mu-upload')).toBeHidden();
    await expect(page.locator('#mu-player')).toBeHidden();
    await expect(page.locator('.mu-cover')).toHaveCount(0);
  });
}

test('音乐（有权限）：首页露出 music/ tab；封面横滑切专辑；整张按曲序播放走短链；歌词跟着亮；倍速 1 → 1.25 → … 循环；下一首；胶囊 = 音乐', async ({ page }) => {
  const calls = await mockMusic(page, 'owner');
  await page.goto('/curio/zh/');
  await expect(page.locator('#cu-tabs [data-ctab="music"]')).toBeVisible();
  await page.locator('#cu-tabs [data-ctab="music"]').click();
  await expect(page).toHaveURL(/\/curio\/zh\/music\/$/);
  await expect(page.locator('.sgx-tb-title')).toHaveText('音乐');
  await expect(page.locator('#mu-denied')).toBeHidden();
  await expect(page.locator('.mu-cover')).toHaveCount(2);
  await expect(page.locator('#mu-album-title')).toHaveText('Blue');
  await expect(page.locator('#mu-album-sub')).toHaveText('Joni Mitchell · 1971 · 2 首');
  await expect(page.locator('#mu-tracks .mu-track-title')).toHaveText(['All I Want', 'My Old Man']);
  await expect(page.locator('#mu-upload')).toBeVisible();
  /* 横滑到第二张 → 当前专辑换成范特西 */
  await page.locator('#mu-covers').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect(page.locator('#mu-album-title')).toHaveText('范特西');
  await expect(page.locator('#mu-dots i.on')).toHaveCount(1);
  /* 点第一张封面回去 */
  await page.locator('.mu-cover[data-i="0"]').click();
  await expect(page.locator('#mu-album-title')).toHaveText('Blue');
  /* 播放整张：先签短链，再从第 1 首放 */
  await page.locator('#mu-play-all').click();
  await expect.poll(() => calls.filter((c) => c.play === 1).length).toBe(1);
  await expect(page.locator('#mu-player')).toBeVisible();
  await expect(page.locator('#mu-now-title')).toHaveText('All I Want');
  await expect(page.locator('#mu-now-sub')).toHaveText('Blue · Joni Mitchell');
  expect(await page.locator('#mu-audio').evaluate((a) => a.src)).toMatch(/\/curio\/api\/music-stream\?t=A{43}&id=11$/);
  await expect(page.locator('#mu-toggle')).toHaveClass(/is-playing/);
  await expect(page.locator('#mu-tracks .mu-track.on .mu-track-title')).toHaveText('All I Want');
  /* 歌词：有 LRC 就显示，当前行高亮，随时间往下走 */
  await expect(page.locator('#mu-lyrics')).toBeVisible();
  await expect(page.locator('#mu-lyrics-in p')).toHaveText(['第一句', '第二句', '第三句']);
  await expect(page.locator('#mu-lyrics-in p.on')).toHaveText(/第[一二三]句/);
  await expect.poll(() => page.locator('#mu-lyrics-in p.on').textContent(), { timeout: 8000 }).not.toBe('第一句');
  /* 倍速循环 */
  await expect(page.locator('#mu-speed')).toHaveText('1×');
  const seen = [];
  for (let i = 0; i < 5; i++) { await page.locator('#mu-speed').click(); seen.push(await page.locator('#mu-speed').textContent()); }
  expect(seen).toEqual(['1.25×', '1.5×', '2×', '0.75×', '1×']);
  await page.locator('#mu-speed').click();
  expect(await page.locator('#mu-audio').evaluate((a) => a.playbackRate)).toBe(1.25);
  /* 下一首：同一张专辑、令牌还新，不重签；倍速保持；没歌词就收起歌词 */
  await page.locator('#mu-next').click();
  await expect(page.locator('#mu-now-title')).toHaveText('My Old Man');
  expect(calls.filter((c) => c.play === 1).length).toBe(1);
  expect(await page.locator('#mu-audio').evaluate((a) => a.playbackRate)).toBe(1.25);
  await expect(page.locator('#mu-lyrics')).toBeHidden();
  /* 暂停 */
  await page.locator('#mu-toggle').click();
  await expect(page.locator('#mu-toggle')).not.toHaveClass(/is-playing/);
  await expect(page.locator('#mu-toggle')).toHaveAttribute('aria-label', '播放');
});

test('音乐（有权限）：上传专辑——音频按文件名排序逐个直传（曲序 / 曲名取自文件名），.lrc 按文件名对上；超过 95 MB 的不传', async ({ page }) => {
  const calls = await mockMusic(page, 'owner');
  await page.goto('/curio/zh/music/');
  await page.locator('#mu-upload').click();
  await expect(page.locator('#mu-up-wrap')).toHaveClass(/open/);
  await expect(page.locator('#mu-up-form')).toContainText('95 MB');
  await page.locator('#mu-up-go').click();
  await expect(page.locator('#mu-up-msg')).toHaveText('填一下专辑名。');
  await page.locator('#mu-up-name').fill('Court and Spark');
  await page.locator('#mu-up-artist').fill('Joni Mitchell');
  await page.locator('#mu-up-year').fill('1974');
  await page.locator('#mu-up-go').click();
  await expect(page.locator('#mu-up-msg')).toHaveText('至少选一个音频文件。');
  await page.locator('#mu-up-audio').setInputFiles([
    { name: '02 - Help Me.wav', mimeType: 'audio/wav', buffer: WAV },
    { name: '01 - Court and Spark.wav', mimeType: 'audio/wav', buffer: WAV },
    { name: '10 - Twisted.wav', mimeType: 'audio/wav', buffer: WAV },
  ]);
  await expect(page.locator('#mu-up-audio-name')).toHaveText('已选 3 个');
  await page.locator('#mu-up-lrc').setInputFiles([{ name: '02 - Help Me.lrc', mimeType: 'text/plain', buffer: Buffer.from('[00:01.00]Help me') }]);
  await page.locator('#mu-up-go').click();
  await expect(page.locator('#mu-up-wrap')).not.toHaveClass(/open/, { timeout: 30000 });
  await expect(page.locator('#bk-toast')).toHaveText('已上传');
  expect(calls.find((c) => c.op === 'album.add')).toMatchObject({ title: 'Court and Spark', artist: 'Joni Mitchell', year: 1974 });
  const ups = calls.filter((c) => c.upload === 'track');
  expect(ups.map((u) => [u.no, u.title])).toEqual([[1, 'Court and Spark'], [2, 'Help Me'], [10, 'Twisted']]);
  expect(ups.every((u) => u.type === 'audio/wav' && u.size === WAV.length)).toBe(true);
  expect(calls.find((c) => c.op === 'track.edit')).toMatchObject({ id: 901, lrc: '[00:01.00]Help me' });
  /* 新专辑成了当前专辑 */
  await expect(page.locator('#mu-album-title')).toHaveText('Court and Spark');
  await expect(page.locator('#mu-tracks .mu-track-title')).toHaveText(['Court and Spark', 'Help Me', 'Twisted']);
});
