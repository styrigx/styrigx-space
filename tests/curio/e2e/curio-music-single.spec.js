// 音乐 v1.13 ②：单曲 / 专辑分类（Gray 2026-11-14 17:33 定）。接口用 page.route 假数据，不碰线上。
// - 上传窗：顶部分段「专辑 | 单曲」（默认专辑）；单曲 =「专辑名」改「歌名」、音频 / 歌词单选、不显示曲序说明，album.add 带 kind=single，曲名 = 歌名；仍是悬浮 <dialog class="sgx-qp sgx-up">
// - 音乐页（方案 A）：两边都有才显示分段「专辑 · 单曲」；单曲 = 列表（小封面 · 歌名 · 歌手 · 时长），点一行就播；单曲区当播放列表，放完接下一首（按需签下一首的令牌），到尾停
// - 副标题：单曲只显示歌手（奇趣页播放条、弹出播放器）；哪边为空只显示有的那边
// - 弹出播放器：专辑列表末尾多一项「单曲」；?album=<单曲 id> 落在单曲组
const { test, expect } = require('@playwright/test');

test.use({ locale: 'zh-CN' });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
function wav(sec) {
  const rate = 8000, n = rate * sec, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
}
const WAV = wav(1);
const t = (id, no, title, extra = {}) => ({ id, no, title, duration: 1, size: WAV.length, type: 'audio/wav', lrc: false, ...extra });

const ALBUM = { id: 1, kind: 'album', title: 'Blue', artist: 'Joni Mitchell', year: 1971, cover: true, tracks: [t(11, 1, 'All I Want'), t(12, 2, 'My Old Man')] };
const SINGLES = [
  { id: 31, kind: 'single', title: 'River', artist: 'Joni Mitchell', year: 1971, cover: true, tracks: [t(41, 1, 'River', { duration: 240 })] },
  { id: 32, kind: 'single', title: '晴天', artist: '周杰伦', year: 2003, cover: false, tracks: [t(42, 1, '晴天', { duration: 269 })] },
  { id: 33, kind: 'single', title: 'Both Sides Now', artist: 'Joni Mitchell', year: 1969, cover: false, tracks: [t(43, 1, 'Both Sides Now', { duration: 271 })] },
];

/** list：初始歌单；有写权限（owner） */
async function mockMusic(page, list) {
  await page.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  const calls = [];
  let albums = JSON.parse(JSON.stringify(list));
  await page.route('**/api/music-cover**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/api/music', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canWrite: true, albums } });
    const b = req.postDataJSON();
    calls.push(b);
    let id;
    if (b.op === 'album.add') { id = 90; albums.push({ id, kind: b.kind || 'album', title: b.title, artist: b.artist, year: b.year, cover: false, tracks: [] }); }
    return r.fulfill({ json: { ok: true, canWrite: true, id, albums } });
  });
  await page.route('**/api/music-upload**', async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    calls.push({ upload: u.searchParams.get('kind'), album: Number(u.searchParams.get('album')), no: Number(u.searchParams.get('no')), title: u.searchParams.get('title') });
    if (u.searchParams.get('kind') === 'track') {
      const a = albums.find((x) => x.id === Number(u.searchParams.get('album')));
      const tid = 900 + a.tracks.length;
      a.tracks.push(t(tid, Number(u.searchParams.get('no')), u.searchParams.get('title')));
      return r.fulfill({ json: { ok: true, id: tid } });
    }
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/music-play', async (r) => {
    const b = r.request().postDataJSON();
    calls.push({ play: b.album });
    const a = albums.find((x) => x.id === b.album);
    return r.fulfill({ json: { ok: true, ttl: 600000, tracks: a.tracks.map((x) => ({ ...x, src: '/curio/api/music-stream?t=' + 'A'.repeat(43) + '&id=' + x.id, lrc: '' })) } });
  });
  await page.route('**/api/music-stream**', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(WAV.length) }, body: WAV }));
  return calls;
}
const plays = (calls) => calls.filter((c) => c.play).map((c) => c.play);

test('上传窗分段：默认专辑；切单曲 =「歌名」、单选、藏曲序说明、标题「上传单曲」；切回专辑复原；仍是悬浮 dialog（sgx-qp sgx-up）', async ({ page }) => {
  await mockMusic(page, [ALBUM]);
  await page.goto('/curio/zh/music/');
  await page.locator('#mu-upload').click();
  const dlg = page.locator('#mu-up-wrap');
  await expect(dlg).toHaveJSProperty('open', true);
  await expect(dlg).toHaveClass(/sgx-qp/);
  await expect(dlg).toHaveClass(/sgx-up/);
  const seg = page.locator('#mu-up-kind [data-kind]');
  await expect(seg).toHaveText(['专辑', '单曲']);
  await expect(page.locator('#mu-up-kind [data-kind="album"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#mu-up-name-l')).toHaveText('专辑名');
  await expect(page.locator('#mu-up-note')).toBeVisible();
  expect(await page.locator('#mu-up-audio').evaluate((i) => i.multiple)).toBe(true);
  await page.locator('#mu-up-kind [data-kind="single"]').click();
  await expect(page.locator('#mu-up-kind [data-kind="single"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#mu-up-title')).toHaveText('上传单曲');
  await expect(page.locator('#mu-up-name-l')).toHaveText('歌名');
  await expect(page.locator('#mu-up-note')).toBeHidden();
  await expect(page.locator('#mu-up-audio-name')).toHaveText('选音频');
  await expect(page.locator('#mu-up-lrc-name')).toHaveText('歌词 .lrc（可选）');
  expect(await page.locator('#mu-up-audio').evaluate((i) => i.multiple)).toBe(false);
  expect(await page.locator('#mu-up-lrc').evaluate((i) => i.multiple)).toBe(false);
  await page.locator('#mu-up-go').click();
  await expect(page.locator('#mu-up-msg')).toHaveText('填一下歌名。');
  await page.locator('#mu-up-kind [data-kind="album"]').click();
  await expect(page.locator('#mu-up-title')).toHaveText('上传专辑');
  await expect(page.locator('#mu-up-name-l')).toHaveText('专辑名');
  await expect(page.locator('#mu-up-note')).toBeVisible();
  await expect(page.locator('#mu-up-msg')).toBeHidden();
  /* 重新打开回到默认专辑 */
  await page.locator('#mu-up-kind [data-kind="single"]').click();
  await page.locator('#mu-up-x').click();
  await page.locator('#mu-upload').click();
  await expect(page.locator('#mu-up-kind [data-kind="album"]')).toHaveAttribute('aria-selected', 'true');
});

test('上传单曲：album.add kind=single、曲序 1、曲名 = 歌名（不取文件名）；歌词对上这一首；传完落在单曲分段', async ({ page }) => {
  const calls = await mockMusic(page, [ALBUM]);
  await page.goto('/curio/zh/music/');
  await expect(page.locator('#mu-seg')).toBeHidden();
  await page.locator('#mu-upload').click();
  await page.locator('#mu-up-kind [data-kind="single"]').click();
  await page.locator('#mu-up-name').fill('A Case of You');
  await page.locator('#mu-up-artist').fill('Joni Mitchell');
  await page.locator('#mu-up-audio').setInputFiles([{ name: '07 - case.wav', mimeType: 'audio/wav', buffer: WAV }]);
  await expect(page.locator('#mu-up-audio-name')).toHaveText('07 - case.wav');
  await page.locator('#mu-up-lrc').setInputFiles([{ name: 'whatever.lrc', mimeType: 'text/plain', buffer: Buffer.from('[00:01.00]Just before our love got lost') }]);
  await page.locator('#mu-up-go').click();
  await expect(page.locator('#mu-up-wrap')).toHaveJSProperty('open', false, { timeout: 30000 });
  expect(calls.find((c) => c.op === 'album.add')).toMatchObject({ kind: 'single', title: 'A Case of You', artist: 'Joni Mitchell' });
  expect(calls.filter((c) => c.upload === 'track').map((u) => [u.album, u.no, u.title])).toEqual([[90, 1, 'A Case of You']]);
  expect(calls.find((c) => c.op === 'track.edit')).toMatchObject({ id: 900, lrc: '[00:01.00]Just before our love got lost' });
  await expect(page.locator('#mu-seg')).toBeVisible();
  await expect(page.locator('#mu-seg [data-sec="single"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#mu-singles .mu-single-tx b')).toHaveText(['A Case of You']);
});

test('音乐页分段：两边都有才显示；单曲列表（小封面 · 歌名 · 歌手 · 时长）；点一行开播，副标题只显示歌手；放完接下一首（按需签），到尾停', async ({ page }) => {
  const calls = await mockMusic(page, [ALBUM, ...SINGLES]);
  await page.goto('/curio/zh/music/');
  await expect(page.locator('#mu-seg')).toBeVisible();
  await expect(page.locator('#mu-seg [data-sec]')).toHaveText(['专辑', '单曲']);
  await expect(page.locator('#mu-seg [data-sec="album"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.mu-cover')).toHaveCount(1);
  await expect(page.locator('#mu-singles')).toBeHidden();
  await page.locator('#mu-seg [data-sec="single"]').click();
  await expect(page.locator('#mu-covers')).toBeHidden();
  await expect(page.locator('.mu-head')).toBeHidden();
  await expect(page.locator('#mu-singles')).toBeVisible();
  await expect(page.locator('#mu-singles .mu-single-tx b')).toHaveText(['River', '晴天', 'Both Sides Now']);
  await expect(page.locator('#mu-singles .mu-single-tx i')).toHaveText(['Joni Mitchell', '周杰伦', 'Joni Mitchell']);
  await expect(page.locator('#mu-singles .mu-track-dur')).toHaveText(['4:00', '4:29', '4:31']);
  await expect(page.locator('#mu-singles .mu-single-im img')).toHaveCount(1);
  expect(plays(calls)).toEqual([]);
  /* 点第二行：只签它 */
  await page.locator('#mu-singles [data-s="1"]').click();
  await expect.poll(() => plays(calls)).toEqual([32]);
  await expect(page.locator('#mu-now-title')).toHaveText('晴天');
  await expect(page.locator('#mu-now-sub')).toHaveText('周杰伦');
  await expect(page.locator('#mu-singles .mu-single.on .mu-single-tx b')).toHaveText('晴天');
  /* 1 秒的音频放完接下一首（这时才签第三首）；第三首放完停（不回头） */
  await expect.poll(() => plays(calls), { timeout: 10000 }).toEqual([32, 33]);
  await expect(page.locator('#mu-now-title')).toHaveText('Both Sides Now');
  await expect(page.locator('#mu-now-sub')).toHaveText('Joni Mitchell');
  await expect(page.locator('#mu-toggle')).not.toHaveClass(/is-playing/, { timeout: 10000 });
  expect(plays(calls)).toEqual([32, 33]);
  /* 回到专辑分段：专辑照旧，副标题「专辑名 · 歌手」 */
  await page.locator('#mu-seg [data-sec="album"]').click();
  await expect(page.locator('#mu-singles')).toBeHidden();
  await page.locator('#mu-tracks [data-t="0"]').click();
  await expect.poll(() => plays(calls)).toEqual([32, 33, 1]);
  await expect(page.locator('#mu-now-sub')).toHaveText('Blue · Joni Mitchell');
});

test('音乐页：只有单曲 → 不显示分段，直接是单曲列表；点一行就播、副标题只显示歌手', async ({ page }) => {
  const calls = await mockMusic(page, SINGLES);
  await page.goto('/curio/zh/music/');
  await expect(page.locator('#mu-singles')).toBeVisible();
  await expect(page.locator('#mu-seg')).toBeHidden();
  await expect(page.locator('#mu-covers')).toBeHidden();
  await expect(page.locator('#mu-empty')).toBeHidden();
  await page.locator('#mu-singles [data-s="0"]').click();
  await expect.poll(() => plays(calls)).toEqual([31]);
  await expect(page.locator('#mu-now-sub')).toHaveText('Joni Mitchell');
});

test('弹出播放器：专辑列表末尾多一项「单曲」；选它曲目表 = 全部单曲；单曲在播时副标题只显示歌手（#mp-album 空）；?album=<单曲> 落在单曲组', async ({ page }) => {
  const calls = await mockMusic(page, [ALBUM, ...SINGLES]);
  await page.goto('/curio/zh/music/player/');
  await expect(page.locator('#mp-app')).toBeVisible();
  await page.locator('#mp-albums-btn').click();
  await expect(page.locator('#mp-albums .mp-alb b')).toHaveText(['Blue', '单曲']);
  await page.locator('#mp-albums [data-a="1"]').click();
  await expect(page.locator('#mp-tracks .mu-track-title')).toHaveText([/^River/, /^晴天/, /^Both Sides Now/]);
  await page.locator('#mp-tracks [data-t="0"]').click();
  await expect.poll(() => plays(calls)).toEqual([31]);
  await expect(page.locator('#mp-title')).toHaveText('River');
  await expect(page.locator('#mp-artist')).toHaveText('Joni Mitchell');
  await expect(page.locator('#mp-album')).toHaveText('');
  await page.locator('#mp-next').click();
  await expect.poll(() => plays(calls)).toEqual([31, 32]);
  await expect(page.locator('#mp-artist')).toHaveText('周杰伦');
  await expect(page.locator('#mp-album')).toHaveText('');
  /* 换回专辑：副标题照旧带专辑名 */
  await page.locator('#mp-albums [data-a="0"]').click();
  await page.locator('#mp-tracks [data-t="0"]').click();
  await expect(page.locator('#mp-album')).toHaveText('Blue');
  await page.goto('/curio/zh/music/player/?album=32');
  await expect(page.locator('#mp-tracks .mu-track')).toHaveCount(3);
});
