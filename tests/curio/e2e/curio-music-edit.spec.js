// 音乐 v1.18 M3「导入后编辑」（十二 M3 第 1–6 条、7.4 管理、7.6 封面规则）。接口用 page.route 假数据（照 M1 接口的口径做一个小内存后端），不碰线上。
// - 曲目行 / 单曲行右侧「⋯」→ 编辑窗：歌名、歌手、所属专辑、歌词；单曲多一个封面（专辑里的曲目没有封面栏，7.6）；所有改动一个 track.edit
// - 「所属专辑」下拉只列 kind=album，按名排序，顶上「移出变单曲」；停在原处不带 album_id；选别的专辑 → album_id:N；移出 → album_id:0
// - 单曲改名 / 改年份也只发一个 track.edit（后端同一个 batch 写单曲记录，Gray 审 1、3）；单曲换封面 → music-upload kind=cover（单曲记录）；单曲选了划进专辑 → 封面栏、年份栏不可用、不传封面、不发年份
// - 歌词预填读失败（框是空的）→ 保存不带 lrc（不清掉已有歌词，Gray 审 4）
// - 专辑标题旁「编辑」：名、歌手、年份（album.edit 只带改了的）+ 封面（music-upload kind=cover）
// - 编辑窗里「删除」、单曲行删除键 → 确认卡片（同一张悬浮卡片）→ track.del（curio-write，Gray 审 2）；单曲唯一一首删了，单曲从列表消失
// - 多选 → 批量改：歌手、移专辑（专辑页有「移出变单曲」）；年份只在单曲区出现（album.edit 单曲记录）；逐条发请求，失败的列出来
// - 没有写权限：不画「⋯」「编辑」「多选」
const { test, expect } = require('@playwright/test');

test.use({ locale: 'zh-CN' });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const t = (id, no, title, extra = {}) => ({ id, no, title, duration: 200, size: 10, type: 'audio/wav', lrc: false, artist: '', ...extra });
const DATA = () => [
  { id: 1, kind: 'album', title: 'Blue', artist: 'Joni Mitchell', year: 1971, cover: true, tracks: [t(11, 1, 'All I Want', { artist: 'Joni Mitchell', lrc: true }), t(12, 2, 'My Old Man'), t(13, 3, 'Little Green')] },
  { id: 2, kind: 'album', title: 'Court and Spark', artist: 'Joni Mitchell', year: 1974, cover: false, tracks: [t(21, 1, 'Help Me')] },
  { id: 3, kind: 'album', title: 'ammonia avenue', artist: 'APP', year: 1984, cover: false, tracks: [] },
  { id: 31, kind: 'single', title: 'River', artist: 'Joni Mitchell', year: 1971, cover: true, tracks: [t(41, 1, 'River', { artist: 'Joni Mitchell' })] },
  { id: 32, kind: 'single', title: '那天下雨了 [mqms2]', artist: '', year: 0, cover: false, tracks: [t(42, 1, '那天下雨了 [mqms2]')] },
];
const LRC = '[00:01.00]I am on a lonely road';

/** opts.canWrite 默认 true；opts.fail(b) 返回错误码就让这条写请求失败 */
async function mockMusic(page, opts = {}) {
  const canWrite = opts.canWrite !== false;
  await page.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/identity', (r) => { const b = r.request().postData() || ''; return canWrite && b.includes('"whoami"') ? r.fulfill({ json: { ok: true, user: { root: true } } }) : r.fallback(); });
  const calls = [];
  let albums = DATA();
  let nextId = 100;
  const lrcs = { 11: LRC };
  const findTrack = (id) => { for (const a of albums) { const i = a.tracks.findIndex((x) => x.id === id); if (i >= 0) return { a, i, tr: a.tracks[i] }; } return null; };
  await page.route('**/api/music-cover**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/api/music', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canWrite, albums } });
    const b = req.postDataJSON();
    calls.push(b);
    const bad = opts.fail && opts.fail(b);
    if (bad) return r.fulfill({ status: bad === 'limit' ? 409 : 400, json: { ok: false, error: bad } });
    let id;
    if (b.op === 'track.edit') {
      const f = findTrack(b.id);
      if (b.year !== undefined && !(f.a.kind === 'single' && b.album_id === undefined)) return r.fulfill({ status: 400, json: { ok: false, error: 'year-not-single' } });
      if (b.title !== undefined) { f.tr.title = b.title; if (f.a.kind === 'single' && b.album_id === undefined) f.a.title = b.title; }
      if (b.year !== undefined) f.a.year = b.year;
      if (b.artist !== undefined) { f.tr.artist = b.artist; if (f.a.kind === 'single') f.a.artist = b.artist; }
      if (b.lrc !== undefined) { lrcs[b.id] = b.lrc; f.tr.lrc = !!b.lrc; }
      if (b.album_id !== undefined) {
        f.a.tracks.splice(f.i, 1);
        if (b.album_id === 0) { id = nextId++; albums.push({ id, kind: 'single', title: f.tr.title, artist: f.tr.artist, year: f.a.year, cover: f.a.cover, tracks: [f.tr] }); }
        else albums.find((x) => x.id === b.album_id).tracks.push(f.tr);
        if (f.a.kind === 'single' && !f.a.tracks.length) albums = albums.filter((x) => x !== f.a);
      }
    }
    if (b.op === 'album.edit') { const a = albums.find((x) => x.id === b.id); for (const k of ['title', 'artist', 'year']) if (b[k] !== undefined) a[k] = b[k]; }
    if (b.op === 'track.del') { const f = findTrack(b.id); f.a.tracks.splice(f.i, 1); if (f.a.kind === 'single' && !f.a.tracks.length) albums = albums.filter((x) => x !== f.a); }
    if (b.op === 'album.del') albums = albums.filter((x) => x.id !== b.id);
    return r.fulfill({ json: { ok: true, canWrite: true, id, albums } });
  });
  await page.route('**/api/music-upload**', async (r) => {
    const u = new URL(r.request().url());
    calls.push({ upload: u.searchParams.get('kind'), album: Number(u.searchParams.get('album')) });
    const a = albums.find((x) => x.id === Number(u.searchParams.get('album')));
    if (a) a.cover = true;
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/music-play', async (r) => {
    const b = r.request().postDataJSON();
    calls.push({ play: b.album });
    if (opts.playFail) return r.fulfill({ status: 500, json: { ok: false, error: 'server' } });
    const a = albums.find((x) => x.id === b.album);
    return r.fulfill({ json: { ok: true, ttl: 600000, tracks: a.tracks.map((x) => ({ ...x, src: '/curio/api/music-stream?t=' + 'A'.repeat(43) + '&id=' + x.id, lrc: lrcs[x.id] || '' })) } });
  });
  return calls;
}
const writes = (calls) => calls.filter((c) => c.op && c.op !== 'album.add');

test('专辑页曲目「⋯」：编辑窗（歌名 · 歌手 · 所属专辑 · 歌词；没有封面栏）；下拉只列专辑、按名排序、顶上「移出变单曲」；歌词读出来；只发改了的字段、一个 track.edit', async ({ page }) => {
  const calls = await mockMusic(page);
  await page.goto('/curio/zh/music/');
  await expect(page.locator('#mu-tracks .mu-more')).toHaveCount(3);
  await expect(page.locator('#mu-tracks .mu-more').first()).toHaveAttribute('aria-label', '编辑「All I Want」');
  await page.locator('#mu-tracks [data-ed="0"]').click();
  const dlg = page.locator('#mu-ed-wrap');
  await expect(dlg).toHaveJSProperty('open', true);
  await expect(dlg).toHaveClass(/sgx-qp/);
  await expect(dlg).toHaveClass(/sgx-up/);
  await expect(page.locator('#mu-ed-title')).toHaveText('编辑曲目');
  await expect(page.locator('#mu-ed-name')).toHaveValue('All I Want');
  await expect(page.locator('#mu-ed-artist')).toHaveValue('Joni Mitchell');
  await expect(page.locator('#mu-ed-cover-row')).toBeHidden();
  /* 只列 kind=album（单曲不列），按名排序（不分大小写），顶上「移出变单曲」；停在本专辑 */
  await expect(page.locator('#mu-ed-album option')).toHaveText(['移出变单曲', 'ammonia avenue', 'Blue', 'Court and Spark']);
  await expect(page.locator('#mu-ed-album')).toHaveValue('1');
  /* 歌词正文经 music-play 读出来填进去 */
  await expect(page.locator('#mu-ed-lrc')).toHaveValue(LRC);
  await expect(page.locator('#mu-ed-lrc')).toBeEnabled();
  /* 歌手栏只是文本框，不做联想（十二 M3 第 5 条） */
  expect(await page.locator('#mu-ed-artist').evaluate((i) => i.tagName + ':' + (i.getAttribute('list') || ''))).toBe('INPUT:');
  await page.locator('#mu-ed-name').fill('All I Want (2021 Remaster)');
  await page.locator('#mu-ed-lrc').fill('[00:02.00]new');
  await page.locator('#mu-ed-save').click();
  await expect(dlg).toHaveJSProperty('open', false);
  expect(writes(calls)).toEqual([{ op: 'track.edit', id: 11, title: 'All I Want (2021 Remaster)', lrc: '[00:02.00]new' }]);
  await expect(page.locator('#mu-tracks .mu-track-title').first()).toHaveText('All I Want (2021 Remaster)');
  await expect(page.locator('#bk-toast')).toHaveText('已保存');
  /* 什么都不改直接保存：不发请求 */
  await page.locator('#mu-tracks [data-ed="1"]').click();
  await expect(page.locator('#mu-ed-lrc')).toHaveValue('');
  await page.locator('#mu-ed-save').click();
  await expect(dlg).toHaveJSProperty('open', false);
  expect(writes(calls)).toHaveLength(1);
});

test('移专辑：选别的专辑 → album_id:N（曲目跟过去）；选「移出变单曲」→ album_id:0（单曲区多一首）；歌名不能空', async ({ page }) => {
  const calls = await mockMusic(page);
  await page.goto('/curio/zh/music/');
  await page.locator('#mu-tracks [data-ed="1"]').click();
  await page.locator('#mu-ed-name').fill('');
  await page.locator('#mu-ed-save').click();
  await expect(page.locator('#mu-ed-msg')).toHaveText('填一下歌名。');
  await page.locator('#mu-ed-name').fill('My Old Man');
  await page.locator('#mu-ed-album').selectOption('2');
  await page.locator('#mu-ed-save').click();
  await expect(page.locator('#mu-ed-wrap')).toHaveJSProperty('open', false);
  expect(writes(calls)).toEqual([{ op: 'track.edit', id: 12, album_id: 2 }]);
  await expect(page.locator('#mu-tracks .mu-track-title')).toHaveText(['All I Want', 'Little Green']);
  await page.locator('#mu-tracks [data-ed="1"]').click();
  await page.locator('#mu-ed-album').selectOption('0');
  await page.locator('#mu-ed-save').click();
  await expect(page.locator('#mu-ed-wrap')).toHaveJSProperty('open', false);
  expect(writes(calls)[1]).toEqual({ op: 'track.edit', id: 13, album_id: 0 });
  await expect(page.locator('#mu-tracks .mu-track-title')).toHaveText(['All I Want']);
  await page.locator('#mu-seg [data-sec="single"]').click();
  await expect(page.locator('#mu-singles .mu-single-tx b')).toHaveText(['River', '那天下雨了 [mqms2]', 'Little Green']);
});

test('单曲「⋯」：多一个封面栏、一个年份栏；改名 / 改年份 = 一个 track.edit（后端连单曲记录一起改）；换封面 = music-upload kind=cover（单曲记录）；选了划进专辑 → 封面栏不可用、不传封面', async ({ page }) => {
  const calls = await mockMusic(page);
  await page.goto('/curio/zh/music/');
  await page.locator('#mu-seg [data-sec="single"]').click();
  await expect(page.locator('#mu-singles .mu-more')).toHaveCount(2);
  await page.locator('#mu-singles [data-ed="1"]').click();
  await expect(page.locator('#mu-ed-title')).toHaveText('编辑单曲');
  await expect(page.locator('#mu-ed-name')).toHaveValue('那天下雨了 [mqms2]');
  await expect(page.locator('#mu-ed-cover-row')).toBeVisible();
  await expect(page.locator('#mu-ed-cover-name')).toHaveText('换封面（可选）');
  /* 单曲的顶项 = 不划入专辑（当前状态） */
  await expect(page.locator('#mu-ed-album option')).toHaveText(['单曲（不划入专辑）', 'ammonia avenue', 'Blue', 'Court and Spark']);
  await expect(page.locator('#mu-ed-album')).toHaveValue('0');
  await expect(page.locator('#mu-ed-year-row')).toBeVisible();
  await expect(page.locator('#mu-ed-year')).toHaveValue('');
  /* 年份校验同专辑：1900–2100，空 = 不填 */
  await page.locator('#mu-ed-year').fill('1800');
  await page.locator('#mu-ed-save').click();
  await expect(page.locator('#mu-ed-msg')).toHaveText('年份要在 1900–2100 之间。');
  expect(writes(calls)).toEqual([]);
  await page.locator('#mu-ed-year').fill('2003');
  await page.locator('#mu-ed-name').fill('那天下雨了');
  await page.locator('#mu-ed-artist').fill('周杰伦');
  await page.locator('#mu-ed-cover').setInputFiles([{ name: 'rain.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(page.locator('#mu-ed-cover-name')).toHaveText('rain.png');
  await page.locator('#mu-ed-save').click();
  await expect(page.locator('#mu-ed-wrap')).toHaveJSProperty('open', false, { timeout: 15000 });
  expect(writes(calls)).toEqual([{ op: 'track.edit', id: 42, title: '那天下雨了', artist: '周杰伦', year: 2003 }]);
  expect(calls.filter((c) => c.upload)).toEqual([{ upload: 'cover', album: 32 }]);
  await expect(page.locator('#mu-singles .mu-single-tx b')).toHaveText(['River', '那天下雨了']);
  await expect(page.locator('#mu-singles .mu-single-tx i')).toHaveText(['Joni Mitchell', '周杰伦']);
  /* 划进专辑：封面栏不可用（用专辑封面）、不传封面、不发 album.edit；空单曲记录没了 */
  await page.locator('#mu-singles [data-ed="0"]').click();
  await expect(page.locator('#mu-ed-cover-name')).toHaveText('已有封面，选图换掉（可选）');
  await expect(page.locator('#mu-ed-year')).toHaveValue('1971');
  await page.locator('#mu-ed-year').fill('1972');
  await page.locator('#mu-ed-album').selectOption('1');
  await expect(page.locator('#mu-ed-cover')).toBeDisabled();
  await expect(page.locator('#mu-ed-year')).toBeDisabled();
  await expect(page.locator('#mu-ed-cover-name')).toHaveText('划进专辑后用专辑封面');
  await page.locator('#mu-ed-name').fill('River (album)');
  await page.locator('#mu-ed-save').click();
  await expect(page.locator('#mu-ed-wrap')).toHaveJSProperty('open', false);
  expect(writes(calls).slice(1)).toEqual([{ op: 'track.edit', id: 41, title: 'River (album)', album_id: 1 }]);
  expect(calls.filter((c) => c.upload)).toHaveLength(1);
  await expect(page.locator('#mu-singles .mu-single-tx b')).toHaveText(['那天下雨了']);
});

test('专辑页「编辑」（标题旁）：名、歌手、年份、封面；album.edit 只带改了的；封面走 music-upload kind=cover；年份校验', async ({ page }) => {
  const calls = await mockMusic(page);
  await page.goto('/curio/zh/music/');
  await expect(page.locator('#mu-album-edit')).toBeVisible();
  await expect(page.locator('#mu-album-edit')).toHaveText('编辑');
  await page.locator('#mu-album-edit').click();
  const dlg = page.locator('#mu-ae-wrap');
  await expect(dlg).toHaveJSProperty('open', true);
  await expect(page.locator('#mu-ae-title')).toHaveText('编辑专辑');
  await expect(page.locator('#mu-ae-name')).toHaveValue('Blue');
  await expect(page.locator('#mu-ae-artist')).toHaveValue('Joni Mitchell');
  await expect(page.locator('#mu-ae-year')).toHaveValue('1971');
  await expect(page.locator('#mu-ae-cover-name')).toHaveText('已有封面，选图换掉（可选）');
  await page.locator('#mu-ae-year').fill('1800');
  await page.locator('#mu-ae-save').click();
  await expect(page.locator('#mu-ae-msg')).toHaveText('年份要在 1900–2100 之间。');
  await page.locator('#mu-ae-year').fill('1972');
  await page.locator('#mu-ae-name').fill('Blue (Deluxe)');
  await page.locator('#mu-ae-cover').setInputFiles([{ name: 'blue.png', mimeType: 'image/png', buffer: PNG }]);
  await page.locator('#mu-ae-save').click();
  await expect(dlg).toHaveJSProperty('open', false, { timeout: 15000 });
  expect(writes(calls)).toEqual([{ op: 'album.edit', id: 1, title: 'Blue (Deluxe)', year: 1972 }]);
  expect(calls.filter((c) => c.upload)).toEqual([{ upload: 'cover', album: 1 }]);
  await expect(page.locator('#mu-album-title')).toHaveText('Blue (Deluxe)');
  await expect(page.locator('#mu-album-sub')).toHaveText('Joni Mitchell · 1972 · 3 首');
});

test('删曲目：编辑窗「删除」→ 悬浮确认卡片（同删除单曲那张）→ track.del；取消不删；单曲唯一一首删了 → 单曲从列表消失', async ({ page }) => {
  const calls = await mockMusic(page);
  await page.goto('/curio/zh/music/');
  await page.locator('#mu-tracks [data-ed="2"]').click();
  await page.locator('#mu-ed-del').click();
  const del = page.locator('#mu-del-wrap');
  await expect(del).toHaveJSProperty('open', true);
  await expect(page.locator('#mu-ed-wrap')).toHaveJSProperty('open', false);
  await expect(page.locator('#mu-del-title')).toHaveText('删除曲目');
  await expect(page.locator('#mu-del-msg')).toHaveText('确定删除曲目「Little Green」（连同音频文件）吗？');
  await page.locator('#mu-del-cancel').click();
  await expect(del).toHaveJSProperty('open', false);
  expect(writes(calls)).toEqual([]);
  await page.locator('#mu-tracks [data-ed="2"]').click();
  await page.locator('#mu-ed-del').click();
  await page.locator('#mu-del-ok').click();
  await expect(del).toHaveJSProperty('open', false);
  expect(writes(calls)).toEqual([{ op: 'track.del', id: 13 }]);
  await expect(page.locator('#mu-tracks .mu-track-title')).toHaveText(['All I Want', 'My Old Man']);
  await expect(page.locator('#bk-toast')).toHaveText('已删除');
  /* 单曲：同一张卡片，标题「删除单曲」；发的是 track.del（删曲目那一档），不是 album.del */
  await page.locator('#mu-seg [data-sec="single"]').click();
  await page.locator('#mu-singles [data-ed="1"]').click();
  await page.locator('#mu-ed-del').click();
  await expect(page.locator('#mu-del-title')).toHaveText('删除单曲');
  await expect(page.locator('#mu-del-msg')).toHaveText('确定删除单曲「那天下雨了 [mqms2]」（连同音频文件）吗？单曲记录和它的封面也会一起删除。');
  await page.locator('#mu-del-ok').click();
  expect(writes(calls)[1]).toEqual({ op: 'track.del', id: 42 });
  await expect(page.locator('#mu-singles .mu-single-tx b')).toHaveText(['River']);
  /* 行上的删除键也走 track.del（Gray 审 2：curio-write 档，不走 album.del 的 root + 票）；文案说明单曲记录和封面一起删 */
  await page.locator('#mu-singles [data-del="31"]').click();
  await expect(page.locator('#mu-del-title')).toHaveText('删除单曲');
  await expect(page.locator('#mu-del-msg')).toHaveText('确定删除单曲「River」（连同音频文件）吗？单曲记录和它的封面也会一起删除。');
  await page.locator('#mu-del-ok').click();
  await expect(page.locator('#mu-del-wrap')).toHaveJSProperty('open', false);
  expect(writes(calls)[2]).toEqual({ op: 'track.del', id: 41 });
  expect(writes(calls).filter((c) => c.op === 'album.del')).toEqual([]);
});

test('歌词预填读失败（框是空的）：保存不带 lrc，已有歌词不被清掉；只发改了的歌名（Gray 审 4）', async ({ page }) => {
  const calls = await mockMusic(page, { playFail: true });
  await page.goto('/curio/zh/music/');
  await page.locator('#mu-tracks [data-ed="0"]').click();
  await expect(page.locator('#mu-ed-lrc-note')).toHaveText('已有歌词没读出来；不动这一栏就不改。');
  await expect(page.locator('#mu-ed-lrc')).toBeEnabled();
  await expect(page.locator('#mu-ed-lrc')).toHaveValue('');
  await page.locator('#mu-ed-name').fill('All I Want (Live)');
  await page.locator('#mu-ed-save').click();
  await expect(page.locator('#mu-ed-wrap')).toHaveJSProperty('open', false);
  expect(writes(calls)).toEqual([{ op: 'track.edit', id: 11, title: 'All I Want (Live)' }]);
  expect(writes(calls)[0]).not.toHaveProperty('lrc');
  /* 只填空白也不算改 */
  await page.locator('#mu-tracks [data-ed="0"]').click();
  await expect(page.locator('#mu-ed-lrc-note')).toHaveText('已有歌词没读出来；不动这一栏就不改。');
  await page.locator('#mu-ed-lrc').fill('   ');
  await page.locator('#mu-ed-save').click();
  await expect(page.locator('#mu-ed-wrap')).toHaveJSProperty('open', false);
  expect(writes(calls)).toHaveLength(1);
});

test('批量改（专辑页）：多选 → 点行选中（不播放、不画「⋯」）→ 批量改：歌手 + 移专辑（有「移出变单曲」，没有年份）；逐条一个 track.edit；失败的列出来', async ({ page }) => {
  const calls = await mockMusic(page, { fail: (b) => (b.op === 'track.edit' && b.id === 12 ? 'limit' : '') });
  await page.goto('/curio/zh/music/');
  await expect(page.locator('#mu-sel')).toHaveText('多选');
  await page.locator('#mu-sel').click();
  await expect(page.locator('#mu-sel-n')).toHaveText('点曲目选中');
  await expect(page.locator('#mu-tracks .mu-more')).toHaveCount(0);
  await expect(page.locator('#mu-sel-edit')).toBeDisabled();
  await page.locator('#mu-tracks [data-t="0"]').click();
  await page.locator('#mu-tracks [data-t="1"]').click();
  await expect(page.locator('#mu-sel-n')).toHaveText('已选 2 首');
  await expect(page.locator('#mu-tracks [data-t="0"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mu-tracks [data-t="2"]')).toHaveAttribute('aria-pressed', 'false');
  expect(calls.filter((c) => c.play)).toEqual([]);
  await page.locator('#mu-sel-edit').click();
  await expect(page.locator('#mu-be-wrap')).toHaveJSProperty('open', true);
  await expect(page.locator('#mu-be-year-row')).toBeHidden();
  await expect(page.locator('#mu-be-album option')).toHaveText(['不改', '移出变单曲', 'ammonia avenue', 'Blue', 'Court and Spark']);
  await page.locator('#mu-be-artist').fill('Joni');
  await page.locator('#mu-be-album').selectOption('3');
  await page.locator('#mu-be-save').click();
  await expect(page.locator('#mu-be-msg')).toHaveText('1 条没改成：\nMy Old Man：到上限了。');
  expect(writes(calls)).toEqual([{ op: 'track.edit', id: 11, artist: 'Joni', album_id: 3 }, { op: 'track.edit', id: 12, artist: 'Joni', album_id: 3 }]);
  await expect(page.locator('#mu-be-wrap')).toHaveJSProperty('open', true);
  await page.locator('#mu-be-x').click();
  await expect(page.locator('#mu-tracks .mu-track-title')).toHaveText(['My Old Man', 'Little Green']);
  await page.locator('#mu-sel-x').click();
  await expect(page.locator('#mu-sel')).toBeVisible();
  await expect(page.locator('#mu-tracks .mu-more')).toHaveCount(2);
});

test('批量改（单曲区）：年份只在这里出现（album.edit 单曲记录）；歌手走 track.edit；没有「移出变单曲」；全成功 → 关窗、退出多选、提示', async ({ page }) => {
  const calls = await mockMusic(page);
  await page.goto('/curio/zh/music/');
  await page.locator('#mu-seg [data-sec="single"]').click();
  await page.locator('#mu-sel').click();
  await page.locator('#mu-singles [data-s="0"]').click();
  await page.locator('#mu-singles [data-s="1"]').click();
  await expect(page.locator('#mu-sel-n')).toHaveText('已选 2 首');
  await page.locator('#mu-sel-edit').click();
  await expect(page.locator('#mu-be-year-row')).toBeVisible();
  await expect(page.locator('#mu-be-album option')).toHaveText(['不改', 'ammonia avenue', 'Blue', 'Court and Spark']);
  await page.locator('#mu-be-year').fill('2003');
  await page.locator('#mu-be-artist').fill('周杰伦');
  await page.locator('#mu-be-save').click();
  await expect(page.locator('#mu-be-wrap')).toHaveJSProperty('open', false);
  expect(writes(calls)).toEqual([
    { op: 'track.edit', id: 41, artist: '周杰伦' }, { op: 'album.edit', id: 31, year: 2003 },
    { op: 'track.edit', id: 42, artist: '周杰伦' }, { op: 'album.edit', id: 32, year: 2003 },
  ]);
  await expect(page.locator('#bk-toast')).toHaveText('已改 2 条');
  await expect(page.locator('#mu-sel')).toBeVisible();
  await expect(page.locator('#mu-singles .mu-single-tx i')).toHaveText(['周杰伦', '周杰伦']);
});

test('没有写权限：不画「⋯」、专辑「编辑」、「多选」', async ({ page }) => {
  await mockMusic(page, { canWrite: false });
  await page.goto('/curio/zh/music/');
  await expect(page.locator('#mu-tracks .mu-track')).toHaveCount(3);
  await expect(page.locator('#mu-tracks .mu-more')).toHaveCount(0);
  await expect(page.locator('#mu-album-edit')).toBeHidden();
  await expect(page.locator('#mu-sel-bar')).toBeHidden();
  await page.locator('#mu-seg [data-sec="single"]').click();
  await expect(page.locator('#mu-singles .mu-more')).toHaveCount(0);
});
