// 奇趣拆页（P4-3）新增的两个子页（手机）：电影 /curio/movies/、私人音乐（music 搬家第 3 步起是第四个子站 /music/，中文 /music/zh/）。接口用 page.route 假数据，不碰线上。
// - 电影：无权限（canManage=false）只读，没有「电影」按钮、详情没有编辑；有权限：添加（海报「移动和缩放」→ 2:3、长边 ≤1600、webp 上传 kind=movie）、编辑、删除要确认
// - 音乐（v5 S3 三层；接口 /music/api/*）：歌单谁都能看（奇趣的 tab 一直在，链到 /music/）；访客（没进站）= 只看模式：「播放整张」是锁，点播放 / 曲目打开终端预填 su 、不开播放器；
//   进站了能听，没账号 + music-manage 看不到上传 / 删除；有权限：封面横滑切专辑；上传专辑（album.add → 音频按文件名排序逐个直传、曲序 / 曲名取自文件名 → .lrc 按文件名对上 track.edit）。
//   第 3 步起音乐页不出声：点播放 = 交给弹出播放器（没开就开 /music/zh/player/?album=<id>&t=<i>，开着发 remote-cmd play），见 curio-music-handoff.spec.js；
//   本文件下半是播放器本身（/music/zh/player/）。
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
}
/** 访客（没进站）：页面过网关时带的标记 <html data-sgx-lock-session="locked">（本地静态服务器没有网关，这里改写 HTML） @param {import('@playwright/test').Page} page */
async function asVisitor(page) {
  await page.route((u) => /^\/music\/(zh\/)?$/.test(u.pathname), async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace(/<html(\s|>)/, '<html data-sgx-lock-session="locked"$1');
    await route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
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
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canManage: can, showPrivate: can, movies } });
    if (!can) return r.fulfill({ status: 403, json: { ok: false, error: 'forbidden' } });
    const b = req.postDataJSON();
    calls.push(b);
    let id;
    if (b.op === 'movie.add') { id = next++; movies = [{ poster: false, ...b, id, op: undefined }, ...movies]; }
    if (b.op === 'movie.edit') movies = movies.map((m) => (m.id === b.id ? { ...m, ...b, op: undefined } : m));
    if (b.op === 'movie.del') movies = movies.filter((m) => m.id !== b.id);
    return r.fulfill({ json: { ok: true, canManage: true, showPrivate: true, id, movies } });
  });
  return calls;
}

test('电影（无权限）：只读封面卡——没有新建命令、条目页没有编辑；命令链「su · su 登录后可编辑」；胶囊 = 电影', async ({ page }) => {
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
  await expect(page.locator('#cu-signin [data-signin-text]')).toHaveText('su 登录后可编辑');
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

/** page 也可以传 context（弹出的播放器窗口也要吃到假后端时）。who：owner（进站 + 账号 + music-manage）· entered（进站，没写权限）· visitor（没进站：签令牌 401）。路由只认新接口 /music/api/*（旧 /curio/api/music* 不接，页面还在调旧地址就会挂） */
async function mockMusic(page, who) {
  const can = who === 'owner';
  await base(page, can);
  const calls = [];
  let albums = JSON.parse(JSON.stringify(ALBUMS));
  const deny = (r) => r.fulfill({ status: 403, json: { ok: false, error: 'forbidden' } });
  await page.route('**/music/api/music-cover**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/music/api/music', async (r) => {
    const req = r.request();
    /* 歌单公开：只有元数据（访客也一样）；canManage 才多给 size / type / lrc */
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canManage: can, albums: can ? albums : albums.map((a) => ({ ...a, tracks: a.tracks.map(({ id, no, title, duration }) => ({ id, no, title, duration })) })) } });
    if (!can) return deny(r);
    const b = req.postDataJSON();
    calls.push(b);
    let id;
    if (b.op === 'album.add') { id = 9; albums.push({ id, title: b.title, artist: b.artist, year: b.year, cover: false, tracks: [] }); }
    if (b.op === 'album.del') albums = albums.filter((a) => a.id !== b.id);
    return r.fulfill({ json: { ok: true, canManage: true, id, albums } });
  });
  await page.route('**/music/api/music-upload**', async (r) => {
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
  await page.route('**/music/api/music-play', async (r) => {
    if (who === 'visitor') { calls.push({ play401: true }); return r.fulfill({ status: 401, json: { ok: false, error: 'unauthorized' } }); }
    const b = r.request().postDataJSON();
    calls.push({ play: b.album });
    const a = albums.find((x) => x.id === b.album);
    return r.fulfill({ json: { ok: true, ttl: 600000, expires: Date.now() + 600000, tracks: a.tracks.map((t) => ({ ...t, src: '/music/api/music-stream?t=' + 'A'.repeat(43) + '&id=' + t.id, lrc: t.id === 11 ? '[00:00.00]第一句\n[00:01.00]第二句\n[00:02.00]第三句' : '' })) } });
  });
  await page.route('**/music/api/music-stream**', async (r) => {
    const range = r.request().headers().range;
    const m = /bytes=(\d+)-(\d*)/.exec(range || '');
    if (!m) return r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(WAV.length) }, body: WAV });
    const a = Number(m[1]), b = m[2] ? Math.min(Number(m[2]), WAV.length - 1) : WAV.length - 1;
    return r.fulfill({ status: 206, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${WAV.length}`, 'Content-Length': String(b - a + 1) }, body: WAV.subarray(a, b + 1) });
  });
  return calls;
}

test('音乐（访客，没进站）：奇趣 tab 在、链到 /music/zh/；歌单 / 封面照常；只看模式——播放键是锁；点播放 / 曲目不签令牌、不开播放器，打开终端预填 su ；没有上传 / 删除；页面没有播放条', async ({ page }) => {
  const calls = await mockMusic(page, 'visitor');
  await asVisitor(page);
  await page.goto('/curio/zh/');
  await expect(page.locator('#cu-tabs .sgx-ctab-a')).toHaveText([/^finds\//, /^devices\//, /^games\//, /^movies\//, /^music\//]);
  await expect(page.locator('#cu-tabs [data-ctab="music"]')).toHaveAttribute('href', '/music/zh/');
  await page.goto('/music/zh/');
  await expect(page.locator('html')).toHaveClass(/mu-view-only/);
  await expect(page.locator('.mu-cover')).toHaveCount(2);
  await expect(page.locator('#mu-tracks .mu-track-title')).toHaveText(['All I Want', 'My Old Man']);
  await expect(page.locator('#mu-upload')).toBeHidden();
  await expect(page.locator('.mu-album-acts')).toBeHidden();
  await expect(page.locator('#mu-player, #mu-audio, #mu-lyrics, audio')).toHaveCount(0);
  await expect(page.locator('#mu-play-all .mu-ic-lock')).toBeVisible();
  await expect(page.locator('#mu-play-all')).toHaveAttribute('aria-label', '登录后可听');
  let popups = 0;
  page.context().on('page', () => { popups++; });
  await page.locator('#mu-tracks .mu-track').first().click();
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect(page.locator('#sgx-term [data-term-in]')).toHaveValue('su ');
  /* 关掉终端再点「播放整张」：同样只开终端，不开播放器 */
  await page.keyboard.press('Escape');
  await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
  /* aria-disabled="true"：Playwright 当它不可点，直接派发点击（真人点得到，页面接住发 sgx:sudo） */
  await page.locator('#mu-play-all').dispatchEvent('click');
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await page.waitForTimeout(300);
  expect(popups).toBe(0);
  expect(new URL(page.url()).pathname).toBe('/music/zh/');
  expect(calls.filter((c) => c.play401 || c.play).length).toBe(0);
});

test('音乐（进站了，没账号写权限）：没有上传 / 删除专辑；本页不签令牌，点「播放整张」开播放器、播放器从第 1 首放', async ({ page }) => {
  /* 假后端装在 context 上：弹出的播放器窗口也吃得到 */
  const calls = await mockMusic(page.context(), 'entered');
  await page.goto('/music/zh/');
  await expect(page.locator('.mu-cover')).toHaveCount(2);
  await expect(page.locator('#mu-upload')).toBeHidden();
  await expect(page.locator('.mu-album-acts')).toBeHidden();
  const [pl] = await Promise.all([page.context().waitForEvent('page'), page.locator('#mu-play-all').click()]);
  await pl.waitForURL(/\/music\/zh\/player\/\?album=1&t=0$/);
  await expect(pl.locator('#mp-title')).toHaveText('All I Want');
  /* 令牌是播放器签的（一次，album 1），音乐页自己没签 */
  await expect.poll(() => calls.filter((c) => c.play === 1).length).toBe(1);
});

test('音乐（有权限）：奇趣首页有 music/ tab、点了到 /music/zh/；封面横滑切专辑；胶囊 = 音乐；上传 / 删除专辑都在', async ({ page }) => {
  await mockMusic(page, 'owner');
  await page.goto('/curio/zh/');
  await expect(page.locator('#cu-tabs [data-ctab="music"]')).toBeVisible();
  await page.locator('#cu-tabs [data-ctab="music"]').click();
  await expect(page).toHaveURL(/\/music\/zh\/$/);
  await expect(page.locator('.sgx-tb-title')).toHaveText('音乐');
  await expect(page.locator('.mu-cover')).toHaveCount(2);
  await expect(page.locator('#mu-album-title')).toHaveText('Blue');
  await expect(page.locator('#mu-album-sub')).toHaveText('Joni Mitchell · 1971 · 2 首');
  await expect(page.locator('#mu-tracks .mu-track-title')).toHaveText(['All I Want', 'My Old Man']);
  await expect(page.locator('#mu-upload')).toBeVisible();
  await expect(page.locator('.mu-album-acts')).toBeVisible();
  /* 横滑到第二张 → 当前专辑换成范特西 */
  await page.locator('#mu-covers').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect(page.locator('#mu-album-title')).toHaveText('范特西');
  await expect(page.locator('#mu-dots i.on')).toHaveCount(1);
  /* 点第一张封面回去 */
  await page.locator('.mu-cover[data-i="0"]').click();
  await expect(page.locator('#mu-album-title')).toHaveText('Blue');
  await expect(page.locator('#mu-player, #mu-audio')).toHaveCount(0);
});

test('音乐（有权限）：批量上传到新建专辑（M2）——音频按文件名排序逐个直传（曲序 / 曲名取自文件名），.lrc 按文件名对上；每首一个 track.edit 写歌手（没歌手的用专辑歌手）', async ({ page }) => {
  const calls = await mockMusic(page, 'owner');
  await page.goto('/music/zh/');
  await page.locator('#mu-upload').click();
  await expect(page.locator('#mu-up-wrap')).toHaveJSProperty('open', true);
  await expect(page.locator('#mu-up-wrap')).toHaveAttribute('data-state', 'open');
  await expect(page.locator('#mu-up-form')).toContainText('95 MB');
  await page.locator('#mu-up-kind [data-kind="batch"]').click();
  await page.locator('#mu-up-album').selectOption('new');
  await page.locator('#mu-up-go').click();
  await expect(page.locator('#mu-up-msg')).toHaveText('填一下新专辑名。');
  await page.locator('#mu-up-aname').fill('Court and Spark');
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
  await expect(page.locator('#mu-up-wrap')).toHaveJSProperty('open', false, { timeout: 30000 });
  await expect(page.locator('#bk-toast')).toHaveText('已上传');
  expect(calls.find((c) => c.op === 'album.add')).toMatchObject({ title: 'Court and Spark', artist: 'Joni Mitchell', year: 1974 });
  const ups = calls.filter((c) => c.upload === 'track');
  expect(ups.map((u) => [u.no, u.title])).toEqual([[1, 'Court and Spark'], [2, 'Help Me'], [10, 'Twisted']]);
  expect(ups.every((u) => u.type === 'audio/wav' && u.size === WAV.length)).toBe(true);
  expect(calls.filter((c) => c.op === 'track.edit')).toEqual([
    { op: 'track.edit', id: 900, artist: 'Joni Mitchell' },
    { op: 'track.edit', id: 901, artist: 'Joni Mitchell', lrc: '[00:01.00]Help me' },
    { op: 'track.edit', id: 902, artist: 'Joni Mitchell' },
  ]);
  /* 新专辑成了当前专辑 */
  await expect(page.locator('#mu-album-title')).toHaveText('Court and Spark');
  await expect(page.locator('#mu-tracks .mu-track-title')).toHaveText(['Court and Spark', 'Help Me', 'Twisted']);
});

test('音乐（有权限）：上传窗是 AI 窗口那种悬浮卡片（非模态 <dialog class=sgx-qp>）——关闭按钮 / Esc / 系统返回 / 点遮罩都只关窗、留在本页；开着时页面不能滚；点顶栏按钮先关它再开顶栏窗口', async ({ page }) => {
  await mockMusic(page, 'owner');
  await page.goto('/music/zh/');
  const dlg = page.locator('#mu-up-wrap');
  const openIt = async () => {
    await page.locator('#mu-upload').click();
    await expect(dlg).toHaveJSProperty('open', true);
    await expect(dlg).toHaveAttribute('data-state', 'open');
  };
  expect(await dlg.evaluate((d) => d.tagName)).toBe('DIALOG');
  /* 关闭按钮 */
  await openIt();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await expect(page.locator('#mu-upload')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#mu-up-x').click();
  await expect(dlg).toHaveJSProperty('open', false);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  /* Esc */
  await openIt();
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveJSProperty('open', false);
  /* 系统返回：只关窗，不离开音乐页 */
  await openIt();
  await page.goBack();
  await expect(dlg).toHaveJSProperty('open', false);
  expect(new URL(page.url()).pathname).toBe('/music/zh/');
  /* 点遮罩（卡片下方的空白处） */
  await openIt();
  const vp = page.viewportSize();
  await page.mouse.click(vp.width / 2, vp.height - 4);
  await expect(dlg).toHaveJSProperty('open', false);
  expect(new URL(page.url()).pathname).toBe('/music/zh/');
  /* 顶栏仍可点、和顶栏窗口互斥：点导航按钮 → 上传窗关、导航面板开且停住（不被迟到的返回事件关掉） */
  await openIt();
  await page.locator('#site-nav [aria-controls="sgx-nav"]').click();
  await expect(dlg).toHaveJSProperty('open', false);
  await expect(page.locator('#sgx-nav')).toHaveAttribute('data-state', 'open');
  await page.waitForTimeout(400);
  await expect(page.locator('#sgx-nav')).toHaveJSProperty('open', true);
});

/* ================= 弹出播放器（音乐第二步 2b；music 搬家第 3 步起 /music/player/，中文 /music/zh/player/） ================= */

test('播放器（有权限）：点曲目开播走短链；随机按钮记到本地；倍速 1 → 1.25 → 1.5 → 2 → 1；歌词点开全部；专辑列表收起 / 换专辑；静音', async ({ page }) => {
  const calls = await mockMusic(page, 'owner');
  await page.goto('/music/zh/player/');
  await expect(page.locator('#mp-app')).toBeVisible();
  await expect(page.locator('#mp-title')).toHaveText('Blue');
  await expect(page.locator('#mp-tracks .mu-track-title')).toHaveText(['All I Want', 'My Old Man']);
  await expect(page.locator('#mp-upload, #mu-upload')).toHaveCount(0);
  await page.locator('#mp-tracks [data-t="0"]').click();
  await expect.poll(() => calls.filter((c) => c.play === 1).length).toBe(1);
  await expect(page.locator('#mp-toggle')).toHaveClass(/is-playing/);
  await expect(page.locator('#mp-title')).toHaveText('All I Want');
  await expect(page.locator('#mp-artist')).toHaveText('Joni Mitchell');
  await expect(page.locator('#mp-album')).toHaveText('Blue');
  expect(await page.locator('#mp-audio').evaluate((a) => a.src)).toMatch(/\/music\/api\/music-stream\?t=A{43}&id=11$/);
  await expect(page.locator('#mp-tracks .mu-track.on .mu-track-title')).toHaveText('All I Want');
  await expect(page).toHaveTitle(/^All I Want \| /);
  /* 随机：按下、记到本地 */
  await page.locator('#mp-shuffle').click();
  await expect(page.locator('#mp-shuffle')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('sgx-music-mode'))).toBe('shuffle');
  /* 倍速 */
  const sp = page.locator('#mp-speed');
  for (const want of ['1.25×', '1.5×', '2×', '1×']) { await sp.click(); await expect(sp).toHaveText(want); }
  await sp.click();
  expect(await page.locator('#mp-audio').evaluate((a) => a.playbackRate)).toBe(1.25);
  /* 歌词：默认只一句，点开全部 */
  await expect(page.locator('#mp-lyrics')).toBeVisible();
  await expect(page.locator('#mp-lyrics')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#mp-lyrics').click();
  await expect(page.locator('#mp-lyrics')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#mp-lyrics-in > span:visible')).toHaveCount(3);
  /* 静音 */
  await page.locator('#mp-mute').click();
  expect(await page.locator('#mp-audio').evaluate((a) => a.muted)).toBe(true);
  /* 专辑列表：收起 → 展开 → 换专辑（换列表，不自动开播） */
  await expect(page.locator('#mp-albums')).toBeHidden();
  await page.locator('#mp-albums-btn').click();
  await expect(page.locator('#mp-albums .mp-alb')).toHaveCount(2);
  await page.locator('#mp-albums [data-a="1"]').click();
  await expect(page.locator('#mp-tracks .mu-track-title')).toHaveText(['爱在西元前']);
  expect(calls.filter((c) => c.play === 2).length).toBe(0);
  await page.locator('#mp-tracks [data-t="0"]').click();
  await expect.poll(() => calls.filter((c) => c.play === 2).length).toBe(1);
  await expect(page.locator('#mp-title')).toHaveText('爱在西元前');
});

test('播放器：随机模式下次打开还在；?album= 先显示那张', async ({ page }) => {
  await mockMusic(page, 'owner');
  await page.addInitScript(() => localStorage.setItem('sgx-music-mode', 'shuffle'));
  await page.goto('/music/zh/player/?album=2');
  await expect(page.locator('#mp-app')).toBeVisible();
  await expect(page.locator('#mp-shuffle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mp-tracks .mu-track-title')).toHaveText(['爱在西元前']);
});

test('播放器（登录过期 / 没进站，签令牌 401）：给一句提示和「登录」，不静默卡住；点「登录」打开终端预填 su ', async ({ page }) => {
  const calls = await mockMusic(page, 'visitor');
  await page.goto('/music/zh/player/');
  await expect(page.locator('#mp-app')).toBeVisible();
  await page.locator('#mp-tracks [data-t="0"]').click();
  await expect.poll(() => calls.filter((c) => c.play401).length).toBe(1);
  await expect(page.locator('#mp-note')).toBeVisible();
  await expect(page.locator('#mp-note-tx')).toHaveText('登录已过期，重新登录后才能继续听。');
  await expect(page.locator('#mp-signin')).toBeVisible();
  await expect(page.locator('#mp-toggle')).not.toHaveClass(/is-playing/);
  await page.locator('#mp-signin').click();
  await expect(page.locator('#sgx-term [data-term-in]')).toHaveValue('su ');
});

test('播放器 ?album=<id>&t=<i>（第 3 步）：打开就从那张的第 i 首放；t 越界 = 只显示那张、不放；没有 t = 照旧只显示', async ({ page }) => {
  const calls = await mockMusic(page, 'owner');
  await page.goto('/music/zh/player/?album=1&t=1');
  await expect(page.locator('#mp-title')).toHaveText('My Old Man');
  await expect.poll(() => calls.filter((c) => c.play === 1).length).toBe(1);
  expect(await page.locator('#mp-audio').evaluate((a) => a.src)).toMatch(/&id=12$/);
  await page.goto('/music/zh/player/?album=1&t=9');
  await expect(page.locator('#mp-app')).toBeVisible();
  await expect(page.locator('#mp-title')).toHaveText('Blue');
  await page.goto('/music/zh/player/?album=2');
  await expect(page.locator('#mp-title')).toHaveText('范特西');
  await expect(page.locator('#mp-toggle')).not.toHaveClass(/is-playing/);
});

test('随机播放：播放器的随机按钮记到本地（sgx-music-mode），两个播放器窗口之间同步；音乐页没有随机按钮（第 3 步删了）', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const a = await ctx.newPage(), b = await ctx.newPage();
  await mockMusic(a, 'owner'); await mockMusic(b, 'owner');
  await a.goto('/music/zh/');
  await expect(a.locator('.mu-cover')).toHaveCount(2);
  await expect(a.locator('#mu-shuffle')).toHaveCount(0);
  await b.goto('/music/zh/player/');
  await expect(b.locator('#mp-app')).toBeVisible();
  const sb = b.locator('#mp-shuffle');
  await expect(sb).toHaveAttribute('aria-pressed', 'false');
  await sb.dispatchEvent('click');
  await expect(sb).toHaveAttribute('aria-pressed', 'true');
  expect(await b.evaluate(() => localStorage.getItem('sgx-music-mode'))).toBe('shuffle');
  const c = await ctx.newPage();
  await mockMusic(c, 'owner');
  await c.goto('/music/zh/player/');
  await expect(c.locator('#mp-shuffle')).toHaveAttribute('aria-pressed', 'true');
  await sb.dispatchEvent('click');
  await expect(c.locator('#mp-shuffle')).toHaveAttribute('aria-pressed', 'false');
  await ctx.close();
});
