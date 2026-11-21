// music 搬家第 3 步（搬家设计稿 v1.1 3.3）：音乐页不出声，点播放 / 点曲目 = 交给弹出播放器。接口用 page.route 假数据（装在 context 上，弹出的播放器窗口也吃得到），不碰线上。
// - 没开播放器：同名单窗口 sgx-music-player 开 /music/player/?album=<id>&t=<i>（中文 /music/zh/player/…），播放器一打开就从那首放
// - 开着：经 BroadcastChannel「sgx-music」发 remote-cmd {cmd:'play', album, i}（单曲 {queue, i}），播放器换到那张从第 i 首放；不开第二个窗口
// - 只看模式（没进站）：点播放在页内发 sgx:sudo（顶栏终端预填 su ），不开播放器、不签令牌
// - 新开的窗口没有用户手势、浏览器拦了自动播放：停在那首、播放键亮着，点一下就放（不另想绕法）
// - 不标正在播（Gray 2026-11-21 14:17）
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
/* 30 秒：一首放着的时候不会自己接到下一首 */
const WAV = wav(30);
const t = (id, no, title) => ({ id, no, title, duration: 30, size: WAV.length, type: 'audio/wav', lrc: false });
const ALBUMS = [
  { id: 1, kind: 'album', title: 'Blue', artist: 'Joni Mitchell', year: 1971, cover: true, tracks: [t(11, 1, 'All I Want'), t(12, 2, 'My Old Man'), t(13, 3, 'Little Green')] },
  { id: 2, kind: 'album', title: 'Court and Spark', artist: 'Joni Mitchell', year: 1974, cover: false, tracks: [t(21, 1, 'Help Me'), t(22, 2, 'Free Man in Paris')] },
  { id: 31, kind: 'single', title: 'River', artist: 'Joni Mitchell', year: 1971, cover: false, tracks: [t(41, 1, 'River')] },
  { id: 32, kind: 'single', title: '晴天', artist: '周杰伦', year: 2003, cover: false, tracks: [t(42, 1, '晴天')] },
];

/** who：'entered'（进站了，能听）| 'visitor'（没进站：页面带 locked 标记，签令牌 401） */
async function mockMusic(context, who = 'entered') {
  const calls = [];
  await context.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await context.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  await context.route('**/api/music-cover**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await context.route('**/music/api/music', (r) => r.fulfill({ json: { ok: true, canManage: false, albums: ALBUMS, artists: [] } }));
  await context.route('**/music/api/music-play', async (r) => {
    if (who === 'visitor') { calls.push({ play401: true }); return r.fulfill({ status: 401, json: { ok: false, error: 'unauthorized' } }); }
    const b = r.request().postDataJSON();
    calls.push({ play: b.album });
    const a = ALBUMS.find((x) => x.id === b.album);
    return r.fulfill({ json: { ok: true, ttl: 600000, tracks: a.tracks.map((x) => ({ ...x, src: '/music/api/music-stream?t=' + 'A'.repeat(43) + '&id=' + x.id, lrc: '' })) } });
  });
  await context.route('**/music/api/music-stream**', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(WAV.length) }, body: WAV }));
  if (who === 'visitor') {
    await context.route((u) => /^\/music\/(zh\/)?$/.test(u.pathname), async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace(/<html(\s|>)/, '<html data-sgx-lock-session="locked"$1');
      await route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
    });
  }
  return calls;
}
const plays = (calls) => calls.filter((c) => c.play).map((c) => c.play);
/** 页面上收听 BroadcastChannel「sgx-music」的 remote-cmd（同源另一个频道对象收得到本页发的），记在 window.__cmds */
const spyCmds = (page) => page.evaluate(() => {
  /** @type {any} */ (window).__cmds = [];
  const ch = new BroadcastChannel('sgx-music');
  ch.onmessage = (e) => { if (e.data && e.data.type === 'remote-cmd') /** @type {any} */ (window).__cmds.push(e.data); };
});

test('没开播放器：点「播放整张」开 /music/zh/player/?album=1&t=0（同名单窗口），播放器从第 1 首放；本页不签令牌、不出声', async ({ page, context }) => {
  const calls = await mockMusic(context);
  await page.goto('/music/zh/');
  await expect(page.locator('.mu-cover')).toHaveCount(2);
  /* 本页发出的 remote-cmd：记 postMessage 本身（这一次同步开了新窗口，Chromium 里同页另一个频道对象不一定收得到，播放器还没开也没人收） */
  await page.evaluate(() => {
    /** @type {any} */ (window).__sent = [];
    const o = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (m) { if (m && m.type === 'remote-cmd') /** @type {any} */ (window).__sent.push(m); return o.call(this, m); };
  });
  const [pl] = await Promise.all([context.waitForEvent('page'), page.locator('#mu-play-all').click()]);
  await pl.waitForURL(/\/music\/zh\/player\/\?album=1&t=0$/);
  expect(await pl.evaluate(() => window.name)).toBe('sgx-music-player');
  await expect(pl.locator('#mp-title')).toHaveText('All I Want');
  await expect(pl.locator('#mp-album')).toHaveText('Blue');
  await expect.poll(() => plays(calls)).toEqual([1]);
  await expect(pl.locator('#mp-toggle')).toHaveClass(/is-playing/);
  /* 本页照样先发了一次 remote-cmd play（不等 player-hello；没开就没人收） */
  expect(await page.evaluate(() => /** @type {any} */ (window).__sent)).toEqual([{ type: 'remote-cmd', cmd: 'play', i: 0, album: 1 }]);
  await expect(page.locator('audio, #mu-player')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/music/zh/');
  /* 不标正在播 */
  await expect(page.locator('#mu-tracks .on, #mu-tracks [aria-current]')).toHaveCount(0);
});

test('没开播放器（英文页）：点第 2 首开 /music/player/?album=1&t=1，播放器从第 2 首放', async ({ page, context }) => {
  const calls = await mockMusic(context);
  await page.goto('/music/');
  await page.evaluate(() => localStorage.setItem('sgx-lang', 'en'));
  await page.goto('/music/');
  await expect(page.locator('#mu-tracks .mu-track')).toHaveCount(3);
  const [pl] = await Promise.all([context.waitForEvent('page'), page.locator('#mu-tracks [data-t="1"]').click()]);
  await pl.waitForURL(/\/music\/player\/\?album=1&t=1$/);
  await expect(pl.locator('#mp-title')).toHaveText('My Old Man');
  await expect.poll(() => plays(calls)).toEqual([1]);
});

test('播放器开着：点别的专辑 / 曲目只发 remote-cmd play，播放器换到那张从第 i 首放，不开第二个窗口；单曲发 queue + i', async ({ page, context }) => {
  const calls = await mockMusic(context);
  await page.goto('/music/zh/');
  const [pl] = await Promise.all([context.waitForEvent('page'), page.locator('#mu-play-all').click()]);
  await expect(pl.locator('#mp-title')).toHaveText('All I Want');
  await expect.poll(() => plays(calls)).toEqual([1]);
  /* 播放器窗口答 player-hello 之后再点：本页是同一个，窗口按名字找得到 */
  await spyCmds(page);
  let more = 0;
  context.on('page', () => { more++; });
  /* 切到第二张（封面横滑 / 点封面），点它的第 2 首 */
  await page.locator('.mu-cover').nth(1).click();
  await expect(page.locator('#mu-album-title')).toHaveText('Court and Spark');
  await page.locator('#mu-tracks [data-t="1"]').click();
  await expect(pl.locator('#mp-title')).toHaveText('Free Man in Paris');
  await expect(pl.locator('#mp-album')).toHaveText('Court and Spark');
  await expect.poll(() => plays(calls)).toEqual([1, 2]);
  expect(pl.url()).toMatch(/\/music\/zh\/player\/\?album=1&t=0$/);
  /* 单曲区：queue = 全部有音频的单曲，i = 点的那一行 */
  await page.locator('#mu-seg [data-sec="single"]').click();
  await page.locator('#mu-singles [data-s="1"]').click();
  await expect(pl.locator('#mp-title')).toHaveText('晴天');
  await expect(pl.locator('#mp-album')).toHaveText('');
  await expect.poll(() => plays(calls)).toEqual([1, 2, 32]);
  expect(await page.evaluate(() => /** @type {any} */ (window).__cmds)).toEqual([
    { type: 'remote-cmd', cmd: 'play', i: 1, album: 2 },
    { type: 'remote-cmd', cmd: 'play', i: 1, queue: [31, 32] },
  ]);
  await page.waitForTimeout(300);
  expect(more).toBe(0);
  expect(context.pages().length).toBe(2);
});

test('只看模式（没进站）：点播放 / 点曲目在页内发 sgx:sudo（终端预填 su ），不开播放器、不签令牌、不发 remote-cmd', async ({ page, context }) => {
  const calls = await mockMusic(context, 'visitor');
  await page.goto('/music/zh/');
  await expect(page.locator('html')).toHaveClass(/mu-view-only/);
  await spyCmds(page);
  await page.evaluate(() => { /** @type {any} */ (window).__sudo = 0; document.addEventListener('sgx:sudo', () => { /** @type {any} */ (window).__sudo++; }); window.addEventListener('sgx:sudo', () => { /** @type {any} */ (window).__sudo++; }); });
  let popups = 0;
  context.on('page', () => { popups++; });
  await page.locator('#mu-tracks [data-t="1"]').click();
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect(page.locator('#sgx-term [data-term-in]')).toHaveValue('su ');
  expect(await page.evaluate(() => /** @type {any} */ (window).__sudo)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  /* 「播放整张」带 aria-disabled（锁标）：直接派发点击 */
  await page.locator('#mu-play-all').dispatchEvent('click');
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await page.waitForTimeout(300);
  expect(popups).toBe(0);
  expect(new URL(page.url()).pathname).toBe('/music/zh/');
  expect(calls.filter((c) => c.play || c.play401)).toEqual([]);
  expect(await page.evaluate(() => /** @type {any} */ (window).__cmds)).toEqual([]);
});

test('新窗口被拦自动播放（没有用户手势）：播放器停在那首、播放键亮着，点一下就放', async ({ page, context }) => {
  const calls = await mockMusic(context);
  /* 只在播放器页：第一次 play() 按浏览器拦自动播放那样拒绝 */
  await context.addInitScript(() => {
    if (!/\/player\/$/.test(location.pathname)) return;
    const orig = HTMLMediaElement.prototype.play;
    let first = true;
    HTMLMediaElement.prototype.play = function () {
      if (first) { first = false; return Promise.reject(new DOMException('play() failed because the user didn\'t interact with the document first.', 'NotAllowedError')); }
      return orig.call(this);
    };
  });
  await page.goto('/music/zh/');
  const [pl] = await Promise.all([context.waitForEvent('page'), page.locator('#mu-tracks [data-t="2"]').click()]);
  await pl.waitForURL(/\?album=1&t=2$/);
  await expect(pl.locator('#mp-title')).toHaveText('Little Green');
  await expect.poll(() => plays(calls)).toEqual([1]);
  await pl.waitForTimeout(300);
  await expect(pl.locator('#mp-toggle')).not.toHaveClass(/is-playing/);
  await expect(pl.locator('#mp-toggle')).toBeEnabled();
  expect(await pl.locator('#mp-audio').evaluate((a) => /** @type {HTMLAudioElement} */ (a).paused)).toBe(true);
  await pl.locator('#mp-toggle').click();
  await expect(pl.locator('#mp-toggle')).toHaveClass(/is-playing/);
  await expect(pl.locator('#mp-title')).toHaveText('Little Green');
  expect(await pl.locator('#mp-audio').evaluate((a) => /** @type {HTMLAudioElement} */ (a).paused)).toBe(false);
});
