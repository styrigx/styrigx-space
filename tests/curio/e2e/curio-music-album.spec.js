// 音乐页 ?album=<专辑 id> 直达（2026-11-21，主页 [03] 音乐的专辑格子链过来）。接口用 page.route 假数据，不碰线上。
// - 打开 /music/zh/?album=<id>：横滑选中那张专辑、详情显示（同点了那张封面），不自动播放、不改地址
// - 之后点别的封面：不改地址、不加历史（同原来）
// - 对不上（没有这张 / 是单曲 / 编号不对）：照常默认视图（第一张），不报错
// - 同时带 ?artist= ：歌手页优先
const { test, expect } = require('@playwright/test');

test.use({ locale: 'zh-CN' });

const t = (id, no, title) => ({ id, no, title, duration: 200, size: 10, type: 'audio/wav', lrc: false, artist: '', artist_id: 0 });
const JONI = { artist: 'Joni Mitchell', artist_id: 2 };
const DATA = () => ({
  albums: [
    { id: 1, kind: 'album', title: 'Blue', ...JONI, year: 1971, cover: false, tracks: [t(11, 1, 'All I Want'), t(12, 2, 'My Old Man')] },
    { id: 2, kind: 'album', title: 'Court and Spark', ...JONI, year: 1974, cover: false, tracks: [t(21, 1, 'Help Me')] },
    { id: 3, kind: 'album', title: 'Ammonia Avenue', artist: 'APP', artist_id: 4, year: 1984, cover: false, tracks: [t(31, 1, 'Prime Time'), t(32, 2, "Don't Answer Me"), t(33, 3, 'Dancing on the Highway')] },
    { id: 41, kind: 'single', title: 'River', ...JONI, year: 1971, cover: false, tracks: [t(51, 1, 'River')] },
  ],
  artists: [{ id: 2, name: 'Joni Mitchell', avatar: false, bio: '', style: '' }, { id: 4, name: 'APP', avatar: false, bio: '', style: '' }],
});

async function mockMusic(page) {
  const calls = [];
  const db = DATA();
  await page.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/music-cover**', (r) => r.fulfill({ status: 404, body: '' }));
  await page.route('**/api/music', (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { ok: true, canManage: false, albums: db.albums, artists: db.artists } });
    calls.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true, canManage: false, albums: db.albums, artists: db.artists } });
  });
  await page.route('**/api/music-play', (r) => { calls.push({ play: r.request().postDataJSON().album }); return r.fulfill({ json: { ok: false } }); });
  return calls;
}

test('打开 ?album=<id>：横滑选中那张、详情显示（不自动播放、不改地址）；之后点别的封面不改地址、不加历史', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  const calls = await mockMusic(page);
  await page.goto('/music/zh/?album=3');
  await expect(page.locator('#mu-album-title')).toHaveText('Ammonia Avenue');
  await expect(page.locator('#mu-album-sub')).toContainText('APP');
  await expect(page.locator('#mu-tracks .mu-track-title')).toHaveText(['Prime Time', "Don't Answer Me", 'Dancing on the Highway']);
  await expect(page.locator('.mu-cover.on')).toHaveAttribute('data-i', '2');
  /* 横滑停下来的判定（90ms）过后还是这张 */
  await page.waitForTimeout(500);
  await expect(page.locator('#mu-album-title')).toHaveText('Ammonia Avenue');
  await expect(page.locator('.mu-cover.on')).toHaveAttribute('data-i', '2');
  await expect(page).toHaveURL(/\/music\/zh\/\?album=3$/);
  expect(calls.filter((c) => c.play !== undefined)).toEqual([]);
  /* 点第一张：换专辑，地址、历史都不变 */
  const len = await page.evaluate(() => history.length);
  await page.locator('.mu-cover[data-i="0"]').click();
  await expect(page.locator('#mu-album-title')).toHaveText('Blue');
  await expect(page).toHaveURL(/\/music\/zh\/\?album=3$/);
  expect(await page.evaluate(() => history.length)).toBe(len);
  expect(errs).toEqual([]);
});

test('?album= 对不上（没有这张 / 是单曲 / 编号不对）→ 照常默认视图（第一张）；同时带 ?artist= → 歌手页优先', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await mockMusic(page);
  for (const q of ['?album=999', '?album=41', '?album=0', '?album=abc', '?album=2147483648']) {
    await page.goto('/music/zh/' + q);
    await expect(page.locator('#mu-album-title'), q).toHaveText('Blue');
    await expect(page.locator('.mu-cover.on'), q).toHaveAttribute('data-i', '0');
    await expect(page.locator('#mu-lib'), q).toBeVisible();
  }
  await page.goto('/music/zh/?artist=4&album=2');
  await expect(page.locator('#mu-artist')).toBeVisible();
  await expect(page.locator('#mu-ar-name')).toHaveText('APP');
  await expect(page.locator('#mu-lib')).toBeHidden();
  /* 英文页一样 */
  await page.goto('/music/?album=2');
  await expect(page.locator('#mu-album-title')).toHaveText('Court and Spark');
  expect(errs).toEqual([]);
});
