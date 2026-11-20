// 音乐 M2 PR-a（音乐分层方案 v1.19 7.3 / 7.4 / 7.5 / 十二 M2）：上传预填 + 专辑选择。接口用 page.route 假数据，不碰线上；音频是真文件（tests/curio/fixtures/music-tags，ffmpeg 生成）。
// - 单首：选了音频按标签预填歌名 / 歌手（没有标签按文件名清理 + 拆「 - 」）；用户亲手改过的栏不被覆盖；预填的歌手只差大小写时出近似名提示（M4 联想）
// - 单首「所属专辑」：不划 = album.add kind=single；新建 = album.add kind=album（专辑封面）；已有专辑 = 接在最后、不传封面、年份不可填
// - 批量「这批划入哪个专辑」：不划 = 每首一条单曲（封面 / 歌词按文件名对上，内嵌封面兜底）；已有专辑；新建（歌手默认取多数）；右栏列出每首会传成什么、没对上的文件
// - 每首传完一个 track.edit 写歌手（artist_id）/ 歌词；封面（选的、内嵌的）都裁方、≤ 1000、jpeg
// - 412 宽：上传窗开着时右下角 AI 浮钮藏起来（不压「上传」键），关窗回来
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

test.use({ locale: 'zh-CN' });

const FX = (n) => fs.readFileSync(path.join(__dirname, '../fixtures/music-tags', n));
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** w × h 的纯色 PNG（量裁切后的尺寸用） */
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let r = 0xffffffff; for (const x of b) r = crcT[(r ^ x) & 0xff] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** jpeg 的宽高（找 SOF 段）；不是 jpeg null */
function jpegSize(b) {
  if (!b || b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let p = 2; p + 9 < b.length;) {
    if (b[p] !== 0xff) return null;
    const m = b[p + 1], len = b.readUInt16BE(p + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7) };
    p += 2 + len;
  }
  return null;
}
const t = (id, no, title, extra = {}) => ({ id, no, title, duration: 1, size: 10, type: 'audio/mpeg', lrc: false, artist: '', artist_id: 0, ...extra });
const JAY = { artist: '周杰伦', artist_id: 5 };
const LIST = () => [
  { id: 1, kind: 'album', title: '叶惠美', ...JAY, year: 2003, cover: true, tracks: [t(11, 1, '以父之名', JAY), t(12, 2, '晴天', JAY)] },
  { id: 2, kind: 'album', title: 'Blue', artist: 'Joni Mitchell', artist_id: 2, year: 1971, cover: false, tracks: [] },
];
const ARTISTS = [{ id: 2, name: 'Joni Mitchell', avatar: false, bio: '', style: '' }, { id: 5, name: '周杰伦', avatar: false, bio: '', style: '' }, { id: 8, name: 'Jay Chou', avatar: false, bio: '', style: '' }];

async function mockMusic(page) {
  await page.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/identity', (r) => { const b = r.request().postData() || ''; return b.includes('"whoami"') ? r.fulfill({ json: { ok: true, user: { root: true } } }) : r.fallback(); });
  const calls = [];
  const albums = LIST();
  let nextAlbum = 90, nextTrack = 900;
  await page.route('**/api/music-cover**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG1 }));
  await page.route('**/api/music', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canWrite: true, albums, artists: ARTISTS } });
    const b = req.postDataJSON();
    calls.push(b);
    let id;
    if (b.op === 'album.add') { id = nextAlbum++; albums.push({ id, kind: b.kind || 'album', title: b.title, artist: b.artist, artist_id: 0, year: b.year, cover: false, tracks: [] }); }
    return r.fulfill({ json: { ok: true, canWrite: true, id, albums, artists: ARTISTS } });
  });
  await page.route('**/api/music-upload**', async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const kind = u.searchParams.get('kind'), album = Number(u.searchParams.get('album'));
    const body = req.postDataBuffer() || Buffer.alloc(0);
    if (kind === 'track') {
      const a = albums.find((x) => x.id === album);
      const tid = nextTrack++;
      a.tracks.push(t(tid, Number(u.searchParams.get('no')), u.searchParams.get('title')));
      calls.push({ upload: 'track', album, no: Number(u.searchParams.get('no')), title: u.searchParams.get('title'), id: tid });
      return r.fulfill({ json: { ok: true, id: tid } });
    }
    calls.push({ upload: kind, album, type: req.headers()['content-type'], size: jpegSize(body) });
    return r.fulfill({ json: { ok: true } });
  });
  return calls;
}
const open = async (page) => {
  await page.goto('/curio/zh/music/');
  await page.locator('#mu-upload').click();
  await expect(page.locator('#mu-up-wrap')).toHaveAttribute('data-state', 'open');
};
const audio = (name, fx, type = 'audio/mpeg') => ({ name, mimeType: type, buffer: FX(fx) });
const done = async (page) => expect(page.locator('#mu-up-wrap')).toHaveJSProperty('open', false, { timeout: 30000 });

test('单首预填：标签优先（ID3v2.3 UTF-16 + 内嵌封面）；没标签按文件名清理 + 拆「 - 」；亲手改过的栏不被覆盖；只差大小写的歌手出近似名提示', async ({ page }) => {
  await mockMusic(page);
  await open(page);
  /* 标签 */
  await page.locator('#mu-up-audio').setInputFiles([audio('whatever.mp3', 'v23-cover.mp3')]);
  await expect(page.locator('#mu-up-name')).toHaveValue('那天下雨了');
  await expect(page.locator('#mu-up-artist')).toHaveValue('周杰伦');
  await expect(page.locator('#mu-up-cover-name')).toHaveText('用音频里的封面（可另选）');
  await expect(page.locator('#mu-up-cover-img')).toBeVisible();
  await expect(page.locator('[data-hint-for="mu-up-artist"]')).toBeHidden();
  /* 没标签：文件名（QQ 音乐那种） */
  await page.locator('#mu-up-audio').setInputFiles([audio('周杰伦 - 那天下雨了 [mqms2].mp3', 'notag.mp3')]);
  await expect(page.locator('#mu-up-name')).toHaveValue('那天下雨了');
  await expect(page.locator('#mu-up-artist')).toHaveValue('周杰伦');
  await expect(page.locator('#mu-up-cover-name')).toHaveText('封面（可选）');
  await expect(page.locator('#mu-up-cover-img')).toBeHidden();
  /* 没有「 - 」：整段当歌名、歌手空 */
  await page.locator('#mu-up-audio').setInputFiles([audio('晴天 [mqms2].mp3', 'notag.mp3')]);
  await expect(page.locator('#mu-up-name')).toHaveValue('晴天');
  await expect(page.locator('#mu-up-artist')).toHaveValue('');
  /* 亲手改过歌名：再换文件只填歌手 */
  await page.locator('#mu-up-name').fill('我自己起的');
  await page.locator('#mu-up-audio').setInputFiles([audio('jay chou - Rainy.mp3', 'notag.mp3')]);
  await expect(page.locator('#mu-up-name')).toHaveValue('我自己起的');
  await expect(page.locator('#mu-up-artist')).toHaveValue('jay chou');
  /* 预填的歌手只差大小写 → M4 的近似名提示，点一下换成已有的 */
  const hint = page.locator('[data-hint-for="mu-up-artist"]');
  await expect(hint).toHaveText('已有歌手「Jay Chou」，点一下换成它');
  await hint.click();
  await expect(page.locator('#mu-up-artist')).toHaveValue('Jay Chou');
  await expect(page.locator('#mu-up-artist')).toHaveAttribute('list', 'mu-artist-list');
  await expect(page.locator('#mu-artist-list option')).toHaveCount(3);
});

test('单首 · 不划入专辑：album.add kind=single（歌名 / 歌手 / 年份）→ 内嵌封面裁方 jpeg → 音频 → 一个 track.edit 写歌手；落在单曲分段', async ({ page }) => {
  const calls = await mockMusic(page);
  await open(page);
  await page.locator('#mu-up-audio').setInputFiles([audio('x.mp3', 'v23-cover.mp3')]);
  await expect(page.locator('#mu-up-name')).toHaveValue('那天下雨了');
  await page.locator('#mu-up-year').fill('2016');
  await page.locator('#mu-up-go').click();
  await done(page);
  expect(calls.filter((c) => c.op === 'album.add')).toEqual([{ op: 'album.add', kind: 'single', title: '那天下雨了', artist: '周杰伦', year: 2016 }]);
  /* 夹具内嵌封面 40×24 → 中间 24×24 的 jpeg */
  expect(calls.filter((c) => c.upload === 'cover')).toEqual([{ upload: 'cover', album: 90, type: 'image/jpeg', size: { w: 24, h: 24 } }]);
  expect(calls.filter((c) => c.upload === 'track').map((c) => [c.album, c.no, c.title])).toEqual([[90, 1, '那天下雨了']]);
  expect(calls.filter((c) => c.op === 'track.edit')).toEqual([{ op: 'track.edit', id: 900, artist: '周杰伦' }]);
  await expect(page.locator('#mu-seg [data-sec="single"]')).toHaveAttribute('aria-selected', 'true');
});

test('单首 · 新建专辑：album.add kind=album（新专辑名、这首的歌手、年份）→ 选的封面裁成 ≤ 1000 的正方形 jpeg 当专辑封面 → 曲序 1', async ({ page }) => {
  const calls = await mockMusic(page);
  await open(page);
  await page.locator('#mu-up-audio').setInputFiles([audio('周杰伦 - 告白气球.mp3', 'notag.mp3')]);
  await page.locator('#mu-up-album').selectOption('new');
  await expect(page.locator('#mu-up-aname')).toBeVisible();
  await page.locator('#mu-up-go').click();
  await expect(page.locator('#mu-up-msg')).toHaveText('填一下新专辑名。');
  await page.locator('#mu-up-aname').fill('周杰伦的床边故事');
  await page.locator('#mu-up-cover').setInputFiles([{ name: 'big.png', mimeType: 'image/png', buffer: png(2400, 1200) }]);
  await page.locator('#mu-up-go').click();
  await done(page);
  expect(calls.filter((c) => c.op === 'album.add')).toEqual([{ op: 'album.add', kind: 'album', title: '周杰伦的床边故事', artist: '周杰伦', year: 0 }]);
  expect(calls.filter((c) => c.upload === 'cover')).toEqual([{ upload: 'cover', album: 90, type: 'image/jpeg', size: { w: 1000, h: 1000 } }]);
  expect(calls.filter((c) => c.upload === 'track').map((c) => [c.album, c.no, c.title])).toEqual([[90, 1, '告白气球']]);
  await expect(page.locator('#mu-album-title')).toHaveText('周杰伦的床边故事');
});

test('单首 · 已有专辑：接在最后（max(no)+1）、不建记录、不传封面（内嵌的也不传）、年份不可填；歌手照写', async ({ page }) => {
  const calls = await mockMusic(page);
  await open(page);
  await page.locator('#mu-up-audio').setInputFiles([audio('x.mp3', 'v23-cover.mp3')]);
  await expect(page.locator('#mu-up-name')).toHaveValue('那天下雨了');
  await page.locator('#mu-up-album').selectOption('1');
  await expect(page.locator('#mu-up-year')).toBeDisabled();
  await expect(page.locator('#mu-up-cover')).toBeDisabled();
  await expect(page.locator('#mu-up-cover-name')).toHaveText('划进专辑后用专辑封面');
  await expect(page.locator('#mu-up-cover-img')).toBeHidden();
  await page.locator('#mu-up-go').click();
  await done(page);
  expect(calls.filter((c) => c.op === 'album.add')).toEqual([]);
  expect(calls.filter((c) => c.upload === 'cover')).toEqual([]);
  expect(calls.filter((c) => c.upload === 'track').map((c) => [c.album, c.no, c.title])).toEqual([[1, 3, '那天下雨了']]);
  expect(calls.filter((c) => c.op === 'track.edit')).toEqual([{ op: 'track.edit', id: 900, artist: '周杰伦' }]);
  await expect(page.locator('#mu-album-title')).toHaveText('叶惠美');
});

const BATCH = () => [
  audio('01 - 周杰伦 - 那天下雨了 [mqms2].mp3', 'notag.mp3'),
  audio('02.flac', 'tagged.flac', 'audio/flac'),
  audio('03 晴天.mp3', 'v24.mp3'),
  audio('04 - Rainy.mp3', 'v23-latin1.mp3'),
];

test('批量 · 不划：右栏列出每首（标签 / 文件名预填，新歌手标「新」）和没对上的文件；每首一条单曲；歌词按文件名对上；只有带内嵌封面的那首传封面', async ({ page }) => {
  const calls = await mockMusic(page);
  await open(page);
  await page.locator('#mu-up-kind [data-kind="batch"]').click();
  await expect(page.locator('#mu-up-album')).toHaveValue('0');
  await page.locator('#mu-up-audio').setInputFiles(BATCH());
  await page.locator('#mu-up-lrc').setInputFiles([{ name: '03 晴天.lrc', mimeType: 'text/plain', buffer: Buffer.from('[00:01.00]晴') }, { name: 'stray.lrc', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
  const rows = page.locator('#mu-up-list li');
  await expect(rows).toHaveCount(4);
  await expect(rows.locator('b')).toHaveText(['那天下雨了', '稻香', '晴天', 'Rainy Day']);
  await expect(rows.nth(3)).toContainText('Jay Chou');
  await expect(rows.nth(3).locator('.mu-up-new')).toHaveCount(0);
  await expect(page.locator('#mu-up-list .mu-up-miss')).toHaveText('没对上：stray.lrc');
  await page.locator('#mu-up-go').click();
  await done(page);
  expect(calls.filter((c) => c.op === 'album.add').map((c) => [c.kind, c.title, c.artist])).toEqual([
    ['single', '那天下雨了', '周杰伦'], ['single', '稻香', '周杰伦'], ['single', '晴天', '周杰伦'], ['single', 'Rainy Day', 'Jay Chou'],
  ]);
  expect(calls.filter((c) => c.upload === 'cover')).toEqual([{ upload: 'cover', album: 91, type: 'image/jpeg', size: { w: 24, h: 24 } }]);
  expect(calls.filter((c) => c.upload === 'track').map((c) => [c.album, c.no])).toEqual([[90, 1], [91, 1], [92, 1], [93, 1]]);
  expect(calls.filter((c) => c.op === 'track.edit')).toEqual([
    { op: 'track.edit', id: 900, artist: '周杰伦' }, { op: 'track.edit', id: 901, artist: '周杰伦' },
    { op: 'track.edit', id: 902, artist: '周杰伦', lrc: '[00:01.00]晴' }, { op: 'track.edit', id: 903, artist: 'Jay Chou' },
  ]);
  await expect(page.locator('#bk-toast')).toHaveText('已上传');
});

test('批量 · 已有专辑：接在最后、不建记录、不传封面；没歌手的曲目用专辑歌手；新歌手在列表里标「新歌手」', async ({ page }) => {
  const calls = await mockMusic(page);
  await open(page);
  await page.locator('#mu-up-kind [data-kind="batch"]').click();
  await page.locator('#mu-up-audio').setInputFiles([audio('x - 新人.mp3', 'notag.mp3'), audio('b.mp3', 'notag.mp3')]);
  await page.locator('#mu-up-album').selectOption('1');
  /* 按文件名排序：b.mp3 在前 */
  await expect(page.locator('#mu-up-list li').nth(0)).toContainText('周杰伦');
  await expect(page.locator('#mu-up-list li').nth(1)).toContainText('新歌手');
  await page.locator('#mu-up-go').click();
  await done(page);
  expect(calls.filter((c) => c.op === 'album.add')).toEqual([]);
  expect(calls.filter((c) => c.upload === 'cover')).toEqual([]);
  expect(calls.filter((c) => c.upload === 'track').map((c) => [c.album, c.no, c.title])).toEqual([[1, 3, 'b'], [1, 4, '新人']]);
  expect(calls.filter((c) => c.op === 'track.edit')).toEqual([{ op: 'track.edit', id: 900, artist: '周杰伦' }, { op: 'track.edit', id: 901, artist: 'x' }]);
});

test('批量 · 新建专辑：专辑歌手默认取多数（亲手改过就不动）；专辑封面用第一首的内嵌封面；曲序取文件名开头的数字', async ({ page }) => {
  const calls = await mockMusic(page);
  await open(page);
  await page.locator('#mu-up-kind [data-kind="batch"]').click();
  await page.locator('#mu-up-audio').setInputFiles(BATCH());
  await page.locator('#mu-up-album').selectOption('new');
  await expect(page.locator('#mu-up-artist')).toHaveValue('周杰伦');
  await expect(page.locator('#mu-up-cover-name')).toHaveText('专辑封面用第一首里的封面（可另选）');
  await page.locator('#mu-up-aname').fill('合集');
  await page.locator('#mu-up-go').click();
  await done(page);
  expect(calls.filter((c) => c.op === 'album.add')).toEqual([{ op: 'album.add', kind: 'album', title: '合集', artist: '周杰伦', year: 0 }]);
  expect(calls.filter((c) => c.upload === 'cover')).toEqual([{ upload: 'cover', album: 90, type: 'image/jpeg', size: { w: 24, h: 24 } }]);
  expect(calls.filter((c) => c.upload === 'track').map((c) => [c.no, c.title])).toEqual([[1, '那天下雨了'], [2, '稻香'], [3, '晴天'], [4, 'Rainy Day']]);
  /* 亲手改过专辑歌手：换一批文件不再覆盖 */
  await page.locator('#mu-upload').click();
  await page.locator('#mu-up-kind [data-kind="batch"]').click();
  await page.locator('#mu-up-album').selectOption('new');
  await page.locator('#mu-up-artist').fill('群星');
  await page.locator('#mu-up-audio').setInputFiles(BATCH());
  await expect(page.locator('#mu-up-list li')).toHaveCount(4);
  await expect(page.locator('#mu-up-artist')).toHaveValue('群星');
});

test('412 / 360 宽：上传窗开着时 AI 浮钮藏起来（不压底部「上传」键），关窗回来', async ({ page }) => {
  await mockMusic(page);
  await page.goto('/curio/zh/music/');
  const fab = page.locator('.sgx-tb-ai');
  await expect(fab).toBeVisible();
  await page.locator('#mu-upload').click();
  await expect(page.locator('#mu-up-wrap')).toHaveAttribute('data-state', 'open');
  await expect(fab).toBeHidden();
  await page.locator('#mu-up-x').click();
  await expect(page.locator('#mu-up-wrap')).toHaveJSProperty('open', false);
  await expect(fab).toBeVisible();
});
