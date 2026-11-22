// 打磨 6.4（v2 稿，Gray 2026-11-22）：播放器两页 / 两栏、队列 / ⋯ 悬浮卡片、⋯ 的三个链接、音乐页迷你播放条。接口用 context.route 假数据（弹出的播放器窗口也吃得到），不碰线上。
// - 手机：两页左右滑（拖过 22% 或甩一下翻页；拖进度条不翻页），页点切页；队列 / ⋯ 是居中的悬浮卡片（不是底部抽屉），关闭键 / Esc / 系统返回 / 点遮罩关
// - ⋯ 只有三行：专辑 → /music/?album=、歌手 → /music/?artist=、回到曲库 → /music/（单曲没有专辑行）；开着音乐页就在它那里页内换，播放器不跳走；没有就开新标签页
// - 音乐页：有播放器在放时底部迷你播放条（封面、歌名 – 歌手、播放 / 暂停、队列），点它回到播放器；AI 浮钮不压住它；播放器关了就收起
// - 桌面：左播放右歌词（1440 / 1024），队列是右侧抽屉、⋯ 是按钮下的小浮层
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
/* 30 秒：放着的时候不会自己接到下一首 */
const WAV = wav(30);
const JONI = { artist: 'Joni Mitchell', artist_id: 2 };
const t = (id, no, title) => ({ id, no, title, duration: 30, size: WAV.length, type: 'audio/wav', lrc: false });
const ALBUMS = [
  { id: 1, kind: 'album', title: 'Blue', ...JONI, year: 1971, cover: true, tracks: [t(11, 1, 'All I Want'), t(12, 2, 'My Old Man'), t(13, 3, 'Little Green')] },
  { id: 2, kind: 'album', title: 'Court and Spark', ...JONI, year: 1974, cover: false, tracks: [t(21, 1, 'Help Me'), t(22, 2, 'Free Man in Paris')] },
  { id: 31, kind: 'single', title: 'River', ...JONI, year: 1971, cover: false, tracks: [t(41, 1, 'River')] },
];
const ARTISTS = [{ id: 2, name: 'Joni Mitchell', avatar: false, bio: '', style: '' }];
const LRC = '[00:00.00]第一句\n[00:01.00]第二句\n[00:02.00]第三句\n[00:20.00]第四句';

async function mockMusic(context) {
  const calls = [];
  await context.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await context.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  await context.route('**/api/music-cover**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await context.route('**/music/api/music', (r) => r.fulfill({ json: { ok: true, canManage: false, albums: ALBUMS, artists: ARTISTS } }));
  await context.route('**/music/api/music-play', async (r) => {
    const b = r.request().postDataJSON();
    calls.push({ play: b.album });
    const a = ALBUMS.find((x) => x.id === b.album);
    return r.fulfill({ json: { ok: true, ttl: 600000, tracks: a.tracks.map((x) => ({ ...x, src: '/music/api/music-stream?t=' + 'A'.repeat(43) + '&id=' + x.id, lrc: x.id === 11 ? LRC : '' })) } });
  });
  await context.route('**/music/api/music-stream**', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(WAV.length) }, body: WAV }));
  return calls;
}
const isDesk = (info) => info.project.name.startsWith('desktop');
/** 播放器（地址栏打开）并开播 */
async function openPlayer(page, url) {
  await page.goto(url || '/music/zh/player/?album=1');
  await expect(page.locator('#mp-app')).toBeVisible();
  await page.locator('#mp-toggle').click();
  await expect(page.locator('#mp-toggle')).toHaveClass(/is-playing/);
}
/** 在翻页区按住横拖 dx（像素），steps 步、每步隔 ms 毫秒 */
async function drag(page, x, y, dx, steps = 8, ms = 30) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x + (dx * i) / steps, y + i); await page.waitForTimeout(ms); }
  await page.mouse.up();
}

test('手机两页：页点切页；左滑过 22% → 歌词页、右滑回来；拖不够回原页；拖进度条不翻页；没开播前点当前一句也能去歌词页', async ({ page, context }, info) => {
  test.skip(isDesk(info), '桌面两栏并排，不翻页');
  await mockMusic(context);
  await openPlayer(page);
  const app = page.locator('#mp-app');
  await expect(app).toHaveAttribute('data-page', '0');
  const vw = page.viewportSize().width;
  const box = await page.locator('#mp-cover').boundingBox();
  const y = box.y + box.height / 2;
  /* 拖 15%：慢慢拖（不算甩），回到播放页 */
  await drag(page, vw * 0.7, y, -vw * 0.15, 10, 60);
  await expect(app).toHaveAttribute('data-page', '0');
  /* 拖 40%：翻到歌词页；页点跟着换（当前 = 主色胶囊） */
  await drag(page, vw * 0.8, y, -vw * 0.4);
  await expect(app).toHaveAttribute('data-page', '1');
  await expect(page.locator('#mp-dots [data-go="1"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#mp-lyrics-in p.on')).toHaveCount(1);
  await expect(page.locator('#mp-pg-lyrics')).toBeInViewport({ ratio: 0.9 });
  await expect(page.locator('#mp-pg-player')).not.toBeInViewport();
  const dot = await page.locator('#mp-dots [data-go="1"]').boundingBox();
  expect(dot.width).toBeGreaterThan(16);
  /* 右滑回播放页 */
  const lb = await page.locator('#mp-lyrics').boundingBox();
  await drag(page, vw * 0.2, lb.y + lb.height / 2, vw * 0.4);
  await expect(app).toHaveAttribute('data-page', '0');
  /* 甩一下（短而快）也翻 */
  await drag(page, vw * 0.7, y, -60, 3, 5);
  await expect(app).toHaveAttribute('data-page', '1');
  await page.locator('#mp-dots [data-go="0"]').click();
  await expect(app).toHaveAttribute('data-page', '0');
  /* 进度条上横拖：只拖进度，不翻页 */
  const sk = await page.locator('#mp-seek').boundingBox();
  await drag(page, sk.x + 10, sk.y + sk.height / 2, sk.width * 0.5);
  await expect(app).toHaveAttribute('data-page', '0');
  /* 当前一句 → 歌词页 */
  await page.locator('#mp-line').click();
  await expect(app).toHaveAttribute('data-page', '1');
  /* 歌词页小播放条：暂停 / 播放 */
  await page.locator('#mp-d-toggle').click();
  await expect(page.locator('#mp-d-toggle')).not.toHaveClass(/is-playing/);
  await expect(page.locator('#mp-toggle')).not.toHaveClass(/is-playing/);
  await page.locator('#mp-d-toggle').click();
  await expect(page.locator('#mp-toggle')).toHaveClass(/is-playing/);
});

test('队列 / ⋯：手机是居中的悬浮卡片（非模态 <dialog class="sgx-qp">，不贴底）；关闭键 / Esc / 系统返回 / 点遮罩都能关，返回只关卡片不离开播放器', async ({ page, context }, info) => {
  test.skip(isDesk(info), '桌面另测（右侧抽屉 / 小浮层）');
  await mockMusic(context);
  await openPlayer(page);
  const vh = page.viewportSize().height;
  const url = page.url();
  for (const [btn, dlg, x] of [['#mp-queue-btn', '#mp-queue', '#mp-q-x'], ['#mp-more-btn', '#mp-more', '#mp-m-x']]) {
    const d = page.locator(dlg), sheet = page.locator(dlg + ' .sgx-qp-sheet');
    await page.locator(btn).click();
    await expect(d).toHaveAttribute('data-state', 'open');
    expect(await d.evaluate((el) => el.matches('dialog.sgx-qp') && el.open && !el.matches(':modal'))).toBe(true);
    const sb = await sheet.boundingBox(), db = await d.boundingBox();
    /* 居中：卡片中线 ≈ 卡片所在区域（顶栏下方）的中线；下沿离屏幕底还远（不是底部抽屉） */
    expect(Math.abs(sb.y + sb.height / 2 - (db.y + db.height / 2))).toBeLessThan(3);
    expect(Math.abs(sb.x + sb.width / 2 - (db.x + db.width / 2))).toBeLessThan(3);
    expect(sb.y + sb.height).toBeLessThan(vh - 40);
    expect(sb.y).toBeGreaterThan(db.y + 8);
    await expect(page.locator(btn)).toHaveAttribute('aria-expanded', 'true');
    /* 关闭键 */
    await page.locator(x).click();
    await expect(d).toHaveAttribute('data-state', 'closed');
    await expect(d).not.toHaveAttribute('open', '');
    /* Esc */
    await page.locator(btn).click();
    await expect(d).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expect(d).toHaveAttribute('data-state', 'closed');
    /* 系统返回：只关卡片，还在播放器 */
    await page.locator(btn).click();
    await expect(d).toHaveAttribute('data-state', 'open');
    await page.goBack();
    await expect(d).toHaveAttribute('data-state', 'closed');
    expect(page.url()).toBe(url);
    await expect(page.locator('#mp-toggle')).toHaveClass(/is-playing/);
    /* 点遮罩（dialog 本身，卡片外面） */
    await page.locator(btn).click();
    await expect(d).toHaveAttribute('data-state', 'open');
    await page.mouse.click(8, db.y + 12);
    await expect(d).toHaveAttribute('data-state', 'closed');
  }
  /* 队列头部切模式 = 同一个模式键 */
  await page.locator('#mp-queue-btn').click();
  await page.locator('#mp-q-mode').click();
  await expect(page.locator('#mp-shuffle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mp-q-mode')).toHaveText('随机播放');
  expect(await page.evaluate(() => localStorage.getItem('sgx-music-mode'))).toBe('shuffle');
});

test('⋯ 只有三行（专辑 / 歌手 / 回到曲库），单曲没有专辑行；开着音乐页 → 在它那里页内换（专辑、歌手、曲库），播放器不跳走、不断', async ({ page, context }) => {
  await mockMusic(context);
  await page.goto('/music/zh/');
  await expect(page.locator('.mu-cover')).toHaveCount(2);
  await page.evaluate(() => { window.__sameDoc = 1; });
  const pl = await context.newPage();
  await openPlayer(pl, '/music/zh/player/?album=2');
  await pl.locator('#mp-more-btn').click();
  const rows = pl.locator('#mp-m-list a.mp-mr');
  await expect(rows).toHaveCount(3);
  await expect(rows.locator('b')).toHaveText(['专辑：Court and Spark', '歌手：Joni Mitchell', '回到曲库']);
  expect(await rows.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(['/music/zh/?album=2', '/music/zh/?artist=2', '/music/zh/']);
  await expect(pl.locator('#mp-more')).not.toContainText(/VIP|会员|铃声|音质|投屏|购买/);
  /* 专辑 → 音乐页页内换到那张 */
  await rows.nth(0).click();
  await expect(pl.locator('#mp-more')).toHaveAttribute('data-state', 'closed');
  await expect(page.locator('#mu-album-title')).toHaveText('Court and Spark');
  /* 歌手 → 歌手页 */
  await pl.locator('#mp-more-btn').click();
  await rows.nth(1).click();
  await expect(page).toHaveURL(/\/music\/zh\/\?artist=2$/);
  await expect(page.locator('#mu-ar-name')).toHaveText('Joni Mitchell');
  /* 回到曲库 */
  await pl.locator('#mp-more-btn').click();
  await rows.nth(2).click();
  await expect(page.locator('#mu-artist')).toBeHidden();
  await expect(page.locator('#mu-lib')).toBeVisible();
  expect(await page.evaluate(() => window.__sameDoc)).toBe(1);
  /* 顶行「选歌」同一条路 */
  await page.locator('.mu-cover').nth(1).click();
  await expect(page.locator('#mu-album-title')).toHaveText('Court and Spark');
  await pl.locator('#mp-pick').click();
  await expect(page).toHaveURL(/\/music\/zh\/$/);
  expect(await page.evaluate(() => window.__sameDoc)).toBe(1);
  /* 播放器一直在原地放着 */
  await expect(pl).toHaveURL(/\/music\/zh\/player\/\?album=2$/);
  await expect(pl.locator('#mp-toggle')).toHaveClass(/is-playing/);
  /* 单曲：没有专辑行 */
  await pl.goto('/music/zh/player/?album=31');
  await expect(pl.locator('#mp-title')).toHaveText('River');
  await pl.locator('#mp-more-btn').click();
  await expect(pl.locator('#mp-m-list a.mp-mr b')).toHaveText(['歌手：Joni Mitchell', '回到曲库']);
});

test('⋯ 没有开着的音乐页（播放器是唯一的标签页）：链接开新标签页，播放器自己不跳走', async ({ page, context }) => {
  await mockMusic(context);
  await openPlayer(page);
  await page.locator('#mp-more-btn').click();
  const [np] = await Promise.all([context.waitForEvent('page'), page.locator('#mp-m-list a[data-more="album"]').click()]);
  await np.waitForURL(/\/music\/zh\/\?album=1$/);
  await expect(page).toHaveURL(/\/music\/zh\/player\/\?album=1$/);
  await expect(page.locator('#mp-toggle')).toHaveClass(/is-playing/);
});

test('音乐页迷你播放条：播放器在放才出现（封面、歌名 – 歌手、播放 / 暂停）；正在播的曲目高亮；暂停是遥控；点它回到播放器（不开第二个窗口），队列键让播放器开队列；AI 浮钮不压住它；播放器关了就收起', async ({ page, context }, info) => {
  await mockMusic(context);
  await page.goto('/music/zh/');
  await expect(page.locator('.mu-cover')).toHaveCount(2);
  const dock = page.locator('#mu-dock');
  await expect(dock).toBeHidden();
  const [pl] = await Promise.all([context.waitForEvent('page'), page.locator('#mu-tracks [data-t="1"]').click()]);
  await expect(pl.locator('#mp-title')).toHaveText('My Old Man');
  await expect(dock).toBeVisible();
  await expect(page.locator('#mu-dock-title')).toHaveText('My Old Man');
  await expect(page.locator('#mu-dock-artist')).toHaveText(' – Joni Mitchell');
  await expect(page.locator('#mu-dock-img')).toHaveAttribute('src', '/music/api/music-cover?album=1');
  await expect(page.locator('#mu-tracks [data-t="1"]')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#mu-tracks .mu-track.on')).toHaveCount(1);
  /* 贴底：在视口底部；手机布局 AI 浮钮抬到它上面（不重叠） */
  const vh = page.viewportSize().height;
  const db = await dock.boundingBox();
  expect(db.y + db.height).toBeGreaterThan(vh - 40);
  const fab = page.locator('.sgx-tb-ai');
  if (await fab.isVisible()) {
    const fb = await fab.boundingBox();
    const overlap = !(fb.x + fb.width <= db.x || db.x + db.width <= fb.x || fb.y + fb.height <= db.y || db.y + db.height <= fb.y);
    expect(overlap, 'AI 浮钮不压迷你播放条').toBe(false);
  }
  /* 暂停 / 播放 = 遥控 */
  await page.locator('#mu-dock-toggle').click();
  await expect(pl.locator('#mp-toggle')).not.toHaveClass(/is-playing/);
  await expect(page.locator('#mu-dock-toggle')).not.toHaveClass(/is-playing/);
  await page.locator('#mu-dock-toggle').click();
  await expect(pl.locator('#mp-toggle')).toHaveClass(/is-playing/);
  /* 播放器换了一首：播放条和高亮跟着换 */
  await pl.locator('#mp-next').click();
  await expect(page.locator('#mu-dock-title')).toHaveText('Little Green');
  await expect(page.locator('#mu-tracks [data-t="2"]')).toHaveAttribute('aria-current', 'true');
  /* 点歌名 = 回到播放器（本页开的：同名窗口切过去，不开新的、不重新加载） */
  let more = 0;
  context.on('page', () => { more++; });
  await pl.evaluate(() => { window.__same = 1; });
  await page.locator('#mu-dock-open').click();
  await page.waitForTimeout(400);
  expect(more).toBe(0);
  expect(await pl.evaluate(() => window.__same)).toBe(1);
  /* 队列键：播放器开自己的队列 */
  await page.locator('#mu-dock-queue').click();
  await expect(pl.locator('#mp-queue')).toHaveAttribute('data-state', 'open');
  await expect(pl.locator('#mp-q-list .mp-q.on b')).toHaveText('Little Green');
  expect(more).toBe(0);
  /* 播放器关了 → 收起、不再高亮 */
  await pl.close();
  await expect(dock).toBeHidden();
  await expect(page.locator('#mu-tracks .mu-track.on')).toHaveCount(0);
  if (!isDesk(info)) await expect(page.locator('html')).not.toHaveClass(/mu-dock-on/);
});

test('桌面：左播放右歌词（1440 / 1024 两栏并排，都看得见、不翻页）；有音量；队列是右侧抽屉、⋯ 是 ⋯ 按钮下的小浮层', async ({ page, context }, info) => {
  test.skip(!isDesk(info), '桌面布局');
  await mockMusic(context);
  for (const w of [1440, 1024]) {
    await page.setViewportSize({ width: w, height: w === 1440 ? 900 : 768 });
    await openPlayer(page);
    await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'desktop');
    const pb = await page.locator('#mp-pg-player').boundingBox(), lb = await page.locator('#mp-pg-lyrics').boundingBox();
    expect(lb.x).toBeGreaterThan(pb.x + pb.width + 24);
    await expect(page.locator('#mp-pg-player')).toBeInViewport();
    await expect(page.locator('#mp-pg-lyrics')).toBeInViewport();
    await expect(page.locator('#mp-lyrics-in p.on')).toHaveCount(1);
    await expect(page.locator('#mp-dots')).toBeHidden();
    await expect(page.locator('#mp-line')).toBeHidden();
    await expect(page.locator('#mp-volume')).toBeVisible();
    await expect(page.locator('#mp-util #mp-speed')).toBeVisible();
    await expect(page.locator('#mp-pick')).toContainText('选歌');
    /* 播放器栏不出右边界、不比视口高（控件都在一屏里） */
    const ctrl = await page.locator('.mp-ctrl').boundingBox();
    expect(ctrl.y + ctrl.height).toBeLessThan(page.viewportSize().height);
    /* 点一句歌词 = 跳到那里 */
    await page.locator('#mp-lyrics-in p').nth(3).click();
    await expect.poll(() => page.locator('#mp-audio').evaluate((a) => Math.round(a.currentTime))).toBeGreaterThanOrEqual(20);
    /* 队列：右侧抽屉（贴右、几乎通高） */
    await page.locator('#mp-queue-btn').click();
    await expect(page.locator('#mp-queue')).toHaveAttribute('data-state', 'open');
    const vw = page.viewportSize().width, vh = page.viewportSize().height;
    const qb = await page.locator('#mp-queue .sgx-qp-sheet').boundingBox();
    expect(Math.abs(qb.x + qb.width - (vw - 12))).toBeLessThan(3);
    expect(qb.height).toBeGreaterThan(vh * 0.6);
    await page.keyboard.press('Escape');
    await expect(page.locator('#mp-queue')).toHaveAttribute('data-state', 'closed');
    /* ⋯：按钮下面的小浮层，右缘对着按钮 */
    await page.locator('#mp-more-btn').click();
    await expect(page.locator('#mp-more')).toHaveAttribute('data-state', 'open');
    const mb = await page.locator('#mp-more-btn').boundingBox(), ob = await page.locator('#mp-more .sgx-qp-sheet').boundingBox();
    expect(ob.y).toBeGreaterThan(mb.y + mb.height - 2);
    expect(ob.y).toBeLessThan(mb.y + mb.height + 20);
    expect(Math.abs(ob.x + ob.width - (mb.x + mb.width + 8))).toBeLessThan(4);
    expect(ob.width).toBeLessThan(400);
    await page.keyboard.press('Escape');
    await expect(page.locator('#mp-more')).toHaveAttribute('data-state', 'closed');
  }
});
