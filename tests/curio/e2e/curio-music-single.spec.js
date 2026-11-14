// 音乐 v1.13 ②：单曲 / 专辑分类（Gray 2026-11-14 17:33 定）。接口用 page.route 假数据，不碰线上。
// - 上传窗：顶部分段「专辑 | 单曲」（默认专辑）；单曲 =「专辑名」改「歌名」、音频 / 歌词单选、不显示曲序说明，album.add 带 kind=single，曲名 = 歌名；仍是悬浮 <dialog class="sgx-qp sgx-up">
// - 音乐页（方案 A）：两边都有才显示分段「专辑 · 单曲」；单曲 = 列表（小封面 · 歌名 · 歌手 · 时长），点一行就播；单曲区当播放列表，放完接下一首（按需签下一首的令牌），到尾停
// - 副标题：单曲只显示歌手（奇趣页播放条、弹出播放器）；哪边为空只显示有的那边
// - 弹出播放器：专辑列表末尾多一项「单曲」；?album=<单曲 id> 落在单曲组
// - 删除单曲（Gray 2026-11-14 18:40）：能写才有每行删除键；先弹确认（悬浮 <dialog class="sgx-qp sgx-up mu-del">，不从底部升起），确认后 album.del、列表刷新，单曲删光分段隐藏
// - 播放条总时长：音频元数据到之前用曲目已知时长（列表里那个），到了换成真实 duration（夹具音频只有 1 秒，所以到了以后是 0:01）
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

/** list：初始歌单；opts.canWrite 默认 true（站长） */
async function mockMusic(page, list, opts = {}) {
  const canWrite = opts.canWrite !== false;
  await page.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  const calls = [];
  let albums = JSON.parse(JSON.stringify(list));
  await page.route('**/api/music-cover**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/api/music', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canWrite, albums } });
    const b = req.postDataJSON();
    calls.push(b);
    let id;
    if (b.op === 'album.add') { id = 90; albums.push({ id, kind: b.kind || 'album', title: b.title, artist: b.artist, year: b.year, cover: false, tracks: [] }); }
    if (b.op === 'album.del') albums = albums.filter((x) => x.id !== b.id);
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

test('删除单曲：每行删除键（仅能写）；先弹悬浮确认卡片（不从底部升起），取消不删；确认 → album.del、列表刷新、提示「已删除」；正在放的被删就停；删光后分段隐藏回到专辑', async ({ page }) => {
  const calls = await mockMusic(page, [ALBUM, ...SINGLES]);
  /* 这条用 30 秒的音频：River 删之前一直在放（1 秒的会自己接到下一首） */
  const LONG = wav(30);
  await page.route('**/api/music-stream**', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(LONG.length) }, body: LONG }));
  await page.goto('/curio/zh/music/');
  await page.locator('#mu-seg [data-sec="single"]').click();
  await expect(page.locator('#mu-singles .mu-single-del')).toHaveCount(3);
  await expect(page.locator('#mu-singles .mu-single-del').nth(1)).toHaveAttribute('aria-label', '删除单曲「晴天」');
  /* 先放 River，等会儿删它 */
  await page.locator('#mu-singles [data-s="0"]').click();
  await expect.poll(() => plays(calls)).toEqual([31]);
  await expect(page.locator('#mu-player')).toBeVisible();
  /* 删除键不触发播放 */
  await page.locator('#mu-singles [data-del="32"]').click();
  const dlg = page.locator('#mu-del-wrap');
  await expect(dlg).toHaveJSProperty('open', true);
  await expect(dlg).toHaveClass(/sgx-qp/);
  await expect(dlg).toHaveClass(/sgx-up/);
  await expect(page.locator('#mu-del-msg')).toHaveText('确定删除单曲「晴天」（连同音频文件）吗？');
  expect(plays(calls)).toEqual([31]);
  /* 悬浮卡片：贴近顶部、四周留白，不是贴底的底部弹层 */
  const vp = page.viewportSize();
  await expect(dlg.locator('.sgx-qp-sheet')).toHaveCSS('opacity', '1');
  const box = await dlg.locator('.sgx-qp-sheet').boundingBox();
  expect(box.y).toBeLessThan(vp.height / 2);
  expect(box.y + box.height).toBeLessThan(vp.height - 40);
  expect(box.x).toBeGreaterThan(0);
  /* 取消：不删 */
  await page.locator('#mu-del-cancel').click();
  await expect(dlg).toHaveJSProperty('open', false);
  expect(calls.filter((c) => c.op === 'album.del')).toEqual([]);
  await expect(page.locator('#mu-singles .mu-single-tx b')).toHaveText(['River', '晴天', 'Both Sides Now']);
  /* 确认：删晴天（不在放），播放条不动 */
  await page.locator('#mu-singles [data-del="32"]').click();
  await page.locator('#mu-del-ok').click();
  await expect(dlg).toHaveJSProperty('open', false);
  expect(calls.filter((c) => c.op === 'album.del')).toEqual([{ op: 'album.del', id: 32 }]);
  await expect(page.locator('#mu-singles .mu-single-tx b')).toHaveText(['River', 'Both Sides Now']);
  await expect(page.locator('#bk-toast')).toHaveText('已删除');
  await expect(page.locator('#mu-player')).toBeVisible();
  /* 删正在放的 River：播放条收起 */
  await page.locator('#mu-singles [data-del="31"]').click();
  await page.locator('#mu-del-ok').click();
  await expect(page.locator('#mu-singles .mu-single-tx b')).toHaveText(['Both Sides Now']);
  await expect(page.locator('#mu-player')).toBeHidden();
  /* 删光：单曲区空了 → 分段隐藏，回到专辑 */
  await page.locator('#mu-singles [data-del="33"]').click();
  await page.locator('#mu-del-ok').click();
  await expect(page.locator('#mu-seg')).toBeHidden();
  await expect(page.locator('#mu-singles')).toBeHidden();
  await expect(page.locator('.mu-cover')).toHaveCount(1);
  await expect(page.locator('#mu-album-title')).toHaveText('Blue');
  expect(calls.filter((c) => c.op === 'album.del').map((c) => c.id)).toEqual([32, 31, 33]);
});

test('删除单曲：没有写权限（canWrite=false）不画删除键', async ({ page }) => {
  await mockMusic(page, SINGLES, { canWrite: false });
  await page.goto('/curio/zh/music/');
  await expect(page.locator('#mu-singles .mu-single')).toHaveCount(3);
  await expect(page.locator('#mu-singles .mu-single-del')).toHaveCount(0);
});

test('播放条总时长：音频元数据到之前显示曲目已知时长（4:00），到了换真实 duration（夹具 1 秒 → 0:01）；奇趣页和弹出播放器一样', async ({ page }) => {
  await mockMusic(page, [ALBUM, ...SINGLES]);
  /* 先扣住音频流：元数据到不了 */
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/api/music-stream**', async (r) => { await gate; await r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(WAV.length) }, body: WAV }); });
  await page.goto('/curio/zh/music/');
  await page.locator('#mu-seg [data-sec="single"]').click();
  await page.locator('#mu-singles [data-s="0"]').click();
  await expect(page.locator('#mu-now-title')).toHaveText('River');
  await expect(page.locator('#mu-dur')).toHaveText('4:00');
  await expect(page.locator('#mu-time')).toHaveText('0:00');
  release();
  await expect(page.locator('#mu-dur')).toHaveText('0:01');

  let release2;
  const gate2 = new Promise((r) => { release2 = r; });
  await page.unroute('**/api/music-stream**');
  await page.route('**/api/music-stream**', async (r) => { await gate2; await r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(WAV.length) }, body: WAV }); });
  await page.goto('/curio/zh/music/player/?album=32');
  await page.locator('#mp-tracks [data-t="1"]').click();
  await expect(page.locator('#mp-title')).toHaveText('晴天');
  await expect(page.locator('#mp-dur')).toHaveText('4:29');
  release2();
  await expect(page.locator('#mp-dur')).toHaveText('0:01');
});
