// 音乐 v1.19 M4「歌手页」（7.5、十二 M4 第 1–4 条）。接口用 page.route 假数据（照 M4 接口的口径做一个小内存后端），不碰线上。
// - 不加新路由：音乐页（music 搬家第 3 步起 /music/，中文 /music/zh/）?artist=<id> 视图，页内换（pushState，不重新加载）；浏览器后退回来；直接打开 ?artist= 也行；不在的歌手有提示
// - 入口：专辑标题下的歌手名、单曲行的歌手名（不播放）；弹出播放器里的歌手名 → 主窗口切到歌手页，播放器不跳走（BroadcastChannel）。音乐页不出声（第 3 步），没有播放条里的歌手名了
// - 歌手页头部：头像（没有用默认图标）、名字、专辑数 · 单曲数；有风格 / 简介才显示；专辑一区（点了回音乐页那张）、单曲一区（点了 = 交给播放器，这位歌手的单曲当播放列表）
// - 单曲没封面：封面空 → 歌手头像 → 默认图（单曲列表、歌手页单曲区）
// - 编辑（能写才有）：名字 / 风格 / 简介只发改了的、一个 artist.edit；头像 → music-upload kind=avatar（jpeg，裁方 ≤ 1000）；重名 409 提示用合并
// - 合并（root）：选目标 → 确认卡片（确认键「合并」）→ artist.merge {id, into}（先问一次性票；root 身份直接发）→ 切到目标歌手页
// - 删除（root）：名下有作品不能删（键灰 + 说明）；没作品 → 确认 → artist.del → 回音乐页
// - 歌手栏联想：上传 / 编辑 / 批量改的歌手栏挂同一个 <datalist>；只差大小写 / 空格时提示，点一下换成已有的
const { test, expect } = require('@playwright/test');

test.use({ locale: 'zh-CN' });

/** n 秒静音 WAV（8 kHz 单声道 8 位） */
function wav(sec) {
  const rate = 8000, n = rate * sec, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
}
const WAV = wav(3);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const t = (id, no, title, extra = {}) => ({ id, no, title, duration: 200, size: 10, type: 'audio/wav', lrc: false, artist: '', artist_id: 0, ...extra });
const JONI = { artist: 'Joni Mitchell', artist_id: 2 };
const DATA = () => ({
  albums: [
    { id: 1, kind: 'album', title: 'Blue', ...JONI, year: 1971, cover: true, tracks: [t(11, 1, 'All I Want', JONI), t(12, 2, 'My Old Man', JONI)] },
    { id: 2, kind: 'album', title: 'Court and Spark', ...JONI, year: 1974, cover: false, tracks: [t(21, 1, 'Help Me', JONI)] },
    { id: 3, kind: 'album', title: 'Ammonia Avenue', artist: 'APP', artist_id: 4, year: 1984, cover: false, tracks: [t(31, 1, 'Prime Time', { artist: 'APP', artist_id: 4 })] },
    { id: 41, kind: 'single', title: 'River', ...JONI, year: 1971, cover: false, tracks: [t(51, 1, 'River', JONI)] },
    { id: 42, kind: 'single', title: '晴天', artist: '周杰伦', artist_id: 5, year: 2003, cover: false, tracks: [t(52, 1, '晴天', { artist: '周杰伦', artist_id: 5 })] },
  ],
  artists: [
    { id: 4, name: 'APP', avatar: false, bio: '', style: '' },
    { id: 2, name: 'Joni Mitchell', avatar: true, bio: '加拿大创作歌手。\n民谣、爵士。', style: '民谣' },
    { id: 6, name: 'joni  mitchell', avatar: false, bio: '', style: '' },
    { id: 5, name: '周杰伦', avatar: false, bio: '', style: '' },
  ],
});

/** opts.canManage 默认 true；opts.fail(b) 返回错误码就让这条写请求失败；opts.edit(db) 改假数据 */
async function mockMusic(page, opts = {}) {
  /* opts.ctx：装在 context 上（弹出的播放器窗口也吃得到） */
  if (opts.ctx) page = page.context();
  const canManage = opts.canManage !== false;
  await page.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/identity', (r) => { const b = r.request().postData() || ''; return canManage && b.includes('"whoami"') ? r.fulfill({ json: { ok: true, user: { root: true } } }) : r.fallback(); });
  const calls = [];
  const db = DATA();
  if (opts.edit) opts.edit(db);
  await page.route('**/api/music-cover**', (r) => { calls.push({ cover: new URL(r.request().url()).search }); return r.fulfill({ status: 200, contentType: 'image/png', body: PNG }); });
  await page.route('**/api/music', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canManage, albums: db.albums, artists: db.artists } });
    const b = req.postDataJSON();
    calls.push({ ...b, ticket: req.headers()['x-sgx-sudo'] || '' });
    const bad = opts.fail && opts.fail(b);
    if (bad) return r.fulfill({ status: bad.startsWith('artist-') ? 409 : 400, json: { ok: false, error: bad } });
    const ar = db.artists.find((x) => x.id === b.id);
    if (b.op === 'artist.edit') {
      for (const k of ['bio', 'style']) if (b[k] !== undefined) ar[k] = b[k];
      if (b.name !== undefined) { ar.name = b.name; for (const a of db.albums) if (a.artist_id === ar.id) a.artist = b.name; }
    }
    if (b.op === 'artist.merge') {
      const to = db.artists.find((x) => x.id === b.into);
      for (const a of db.albums) { if (a.artist_id === b.id) { a.artist_id = to.id; a.artist = to.name; } for (const x of a.tracks) if (x.artist_id === b.id) { x.artist_id = to.id; x.artist = to.name; } }
      db.artists = db.artists.filter((x) => x.id !== b.id);
    }
    if (b.op === 'artist.del') db.artists = db.artists.filter((x) => x.id !== b.id);
    return r.fulfill({ json: { ok: true, canManage: true, albums: db.albums, artists: db.artists } });
  });
  await page.route('**/api/music-upload**', async (r) => {
    const u = new URL(r.request().url());
    calls.push({ upload: u.searchParams.get('kind'), artist: Number(u.searchParams.get('artist')), type: r.request().headers()['content-type'] });
    const ar = db.artists.find((x) => x.id === Number(u.searchParams.get('artist')));
    if (ar) ar.avatar = true;
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/music-play', async (r) => {
    const b = r.request().postDataJSON();
    calls.push({ play: b.album });
    const a = db.albums.find((x) => x.id === b.album);
    return r.fulfill({ json: { ok: true, ttl: 600000, tracks: a.tracks.map((x) => ({ ...x, src: '/music/api/music-stream?t=' + 'A'.repeat(43) + '&id=' + x.id, lrc: '' })) } });
  });
  /* 播放器真的放（第 3 步起点播放都在播放器里）：3 秒静音 WAV */
  await page.route('**/api/music-stream**', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(WAV.length) }, body: WAV }));
  return calls;
}
const writes = (calls) => calls.filter((c) => c.op);

test('入口：专辑标题下的歌手名 → 歌手页（页内换视图，不重新加载）；头部头像 / 名字 / 专辑数 · 单曲数 / 风格 / 简介；后退回音乐页、前进回歌手页', async ({ page }) => {
  await mockMusic(page);
  await page.goto('/music/zh/');
  await page.evaluate(() => { window.__sameDoc = 1; });
  const link = page.locator('#mu-album-sub a.mu-artist-a');
  await expect(link).toHaveText('Joni Mitchell');
  await expect(link).toHaveAttribute('href', '?artist=2');
  await link.click();
  await expect(page).toHaveURL(/\/music\/zh\/\?artist=2$/);
  expect(await page.evaluate(() => window.__sameDoc)).toBe(1);
  await expect(page.locator('#mu-lib')).toBeHidden();
  await expect(page.locator('#mu-artist')).toBeVisible();
  await expect(page.locator('#mu-ar-name')).toHaveText('Joni Mitchell');
  await expect(page.locator('#mu-ar-sub')).toHaveText('2 张专辑 · 1 首单曲');
  await expect(page.locator('#mu-ar-style')).toHaveText('民谣');
  await expect(page.locator('#mu-ar-bio')).toHaveText('加拿大创作歌手。\n民谣、爵士。');
  await expect(page.locator('#mu-ar-img')).toHaveAttribute('src', '/music/api/music-cover?artist=2');
  await expect(page.locator('#mu-ar-albums .mu-single-tx b')).toHaveText(['Blue', 'Court and Spark']);
  await expect(page.locator('#mu-ar-singles .mu-single-tx b')).toHaveText(['River']);
  await page.goBack();
  await expect(page).toHaveURL(/\/music\/zh\/$/);
  await expect(page.locator('#mu-lib')).toBeVisible();
  await expect(page.locator('#mu-artist')).toBeHidden();
  await page.goForward();
  await expect(page.locator('#mu-ar-name')).toHaveText('Joni Mitchell');
  /* 返回链接 → 音乐页 */
  await page.locator('#mu-ar-back').click();
  await expect(page).toHaveURL(/\/music\/zh\/$/);
  await expect(page.locator('#mu-album-title')).toHaveText('Blue');
  expect(await page.evaluate(() => window.__sameDoc)).toBe(1);
});

test('直接打开 ?artist=：没头像用默认图标、没风格 / 简介不显示；只有单曲的歌手没有专辑区；不在的歌手提示找不到；访客没有「编辑」', async ({ page }) => {
  await mockMusic(page, { canManage: false });
  await page.goto('/music/zh/?artist=5');
  await expect(page.locator('#mu-ar-name')).toHaveText('周杰伦');
  await expect(page.locator('#mu-ar-sub')).toHaveText('0 张专辑 · 1 首单曲');
  await expect(page.locator('#mu-ar-img')).toBeHidden();
  await expect(page.locator('.mu-ar-av .mu-cover-ph svg')).toBeVisible();
  await expect(page.locator('#mu-ar-style')).toBeHidden();
  await expect(page.locator('#mu-ar-bio')).toBeHidden();
  await expect(page.locator('#mu-ar-albums-h')).toBeHidden();
  await expect(page.locator('#mu-ar-singles .mu-single-tx b')).toHaveText(['晴天']);
  await expect(page.locator('#mu-ar-edit')).toBeHidden();
  await page.goto('/music/zh/?artist=999');
  await expect(page.locator('#mu-ar-missing')).toHaveText('找不到这位歌手。');
  await expect(page.locator('#mu-ar-body')).toBeHidden();
  /* 名下没作品的歌手：提示还没有作品 */
  await page.goto('/music/zh/?artist=6');
  await expect(page.locator('#mu-ar-none')).toBeVisible();
});

test('单曲行的歌手名 → 歌手页（不播放）；歌手页点专辑 → 回音乐页那张；点单曲 → 交给播放器（?album=<单曲>&t=0），这位歌手的单曲当播放列表', async ({ page }) => {
  const calls = await mockMusic(page, { ctx: true });
  await page.goto('/music/zh/');
  await page.locator('#mu-seg [data-sec="single"]').click();
  await page.locator('#mu-singles [data-s="1"] [data-artist]').click();
  await expect(page).toHaveURL(/\?artist=5$/);
  expect(calls.filter((c) => c.play)).toEqual([]);
  await page.goto('/music/zh/?artist=2');
  await page.locator('#mu-ar-albums [data-al="2"]').click();
  await expect(page).toHaveURL(/\/music\/zh\/$/);
  await expect(page.locator('#mu-album-title')).toHaveText('Court and Spark');
  await page.goBack();
  const [pl] = await Promise.all([page.context().waitForEvent('page'), page.locator('#mu-ar-singles [data-as="0"]').click()]);
  await pl.waitForURL(/\/music\/zh\/player\/\?album=41&t=0$/);
  await expect.poll(() => calls.filter((c) => c.play).map((c) => c.play)).toEqual([41]);
  await expect(pl.locator('#mp-title')).toHaveText('River');
  /* 不标正在播（Gray 2026-11-21 14:17）；本页留在歌手页 */
  await expect(page.locator('#mu-ar-singles .mu-single.on')).toHaveCount(0);
  await expect(page).toHaveURL(/\?artist=2$/);
});

test('单曲没封面：封面空 → 歌手头像 → 默认图（单曲列表）', async ({ page }) => {
  await mockMusic(page);
  await page.goto('/music/zh/');
  await page.locator('#mu-seg [data-sec="single"]').click();
  /* River 没封面、Joni 有头像 → 用头像；晴天没封面、周杰伦没头像 → 默认图 */
  await expect(page.locator('#mu-singles [data-s="0"] .mu-single-im img')).toHaveAttribute('src', '/music/api/music-cover?artist=2');
  await expect(page.locator('#mu-singles [data-s="1"] .mu-single-im img')).toHaveCount(0);
  await expect(page.locator('#mu-singles [data-s="1"] .mu-single-im .mu-cover-ph svg')).toBeVisible();
});

test('编辑歌手：名字 / 风格 / 简介只发改了的、一个 artist.edit；头像 → music-upload kind=avatar（jpeg）；改名后专辑副标题跟着变', async ({ page }) => {
  const calls = await mockMusic(page);
  await page.goto('/music/zh/?artist=2');
  await page.locator('#mu-ar-edit').click();
  const dlg = page.locator('#mu-ar-wrap');
  await expect(dlg).toHaveJSProperty('open', true);
  await expect(dlg).toHaveClass(/sgx-up/);
  await expect(page.locator('#mu-ar-title')).toHaveText('编辑歌手');
  await expect(page.locator('#mu-ar-name-in')).toHaveValue('Joni Mitchell');
  await expect(page.locator('#mu-ar-style-in')).toHaveValue('民谣');
  await expect(page.locator('#mu-ar-av-name')).toHaveText('已有头像，选一张图替换（可选）');
  await page.locator('#mu-ar-name-in').fill('Joni');
  await page.locator('#mu-ar-bio-in').fill('简介新');
  await page.locator('#mu-ar-av').setInputFiles({ name: 'joni.png', mimeType: 'image/png', buffer: PNG });
  /* 选了图：圆框里先显示本地预览（object URL），不等上传 */
  await expect(page.locator('#mu-ar-av-name')).toHaveText('joni.png');
  await expect(page.locator('#mu-ar-av-img')).toBeVisible();
  await expect(page.locator('#mu-ar-av-img')).toHaveAttribute('src', /^blob:/);
  expect(await page.locator('#mu-ar-av-img').evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
  await page.locator('#mu-ar-save').click();
  await expect(dlg).toHaveJSProperty('open', false);
  expect(writes(calls)).toEqual([{ op: 'artist.edit', id: 2, name: 'Joni', bio: '简介新', ticket: '' }]);
  expect(calls.filter((c) => c.upload)).toEqual([{ upload: 'avatar', artist: 2, type: 'image/jpeg' }]);
  await expect(page.locator('#mu-ar-name')).toHaveText('Joni');
  await expect(page.locator('#bk-toast')).toHaveText('已保存');
  await page.locator('#mu-ar-back').click();
  await expect(page.locator('#mu-album-sub a.mu-artist-a')).toHaveText('Joni');
  /* 什么都不改：不发 */
  await page.goto('/music/zh/?artist=4');
  await page.locator('#mu-ar-edit').click();
  await page.locator('#mu-ar-save').click();
  await expect(dlg).toHaveJSProperty('open', false);
  expect(writes(calls)).toHaveLength(1);
});

test('编辑歌手：重名 409 artist-exists → 名字栏正下方提示用「合并」，不关窗；名字不能空（同一处）；一改名字提示就收', async ({ page }) => {
  await mockMusic(page, { fail: (b) => (b.op === 'artist.edit' && b.name === '周杰伦' ? 'artist-exists' : '') });
  await page.goto('/music/zh/?artist=4');
  await page.locator('#mu-ar-edit').click();
  const nameIn = page.locator('#mu-ar-name-in'), err = page.locator('#mu-ar-name-err');
  await nameIn.fill('');
  await page.locator('#mu-ar-save').click();
  await expect(err).toHaveText('给歌手起个名字。');
  await expect(nameIn).toHaveAttribute('aria-invalid', 'true');
  await nameIn.fill('周杰伦');
  await expect(err).toBeHidden();
  await page.locator('#mu-ar-save').click();
  await expect(err).toHaveText('已有同名歌手，用「合并」把两位并到一起。');
  await expect(err).toHaveClass(/text-m-error/);
  await expect(page.locator('#mu-ar-msg')).toBeHidden();
  /* 位置：名字栏下面、风格栏上面（不在简介框底下） */
  const [bi, be, bs] = await Promise.all([nameIn.boundingBox(), err.boundingBox(), page.locator('#mu-ar-style-in').boundingBox()]);
  expect(be.y).toBeGreaterThanOrEqual(bi.y + bi.height - 1);
  expect(be.y + be.height).toBeLessThanOrEqual(bs.y);
  await expect(page.locator('#mu-ar-wrap')).toHaveJSProperty('open', true);
});

test('歌手页诚实空状态：名下没有专辑 / 单曲、但别的专辑里有 TA 的曲目 → 不说「还没有」，一行提示链到那些专辑（专辑区仍只按专辑歌手列）', async ({ page }) => {
  const NASH = { artist: 'Graham Nash', artist_id: 7 };
  await mockMusic(page, { edit: (db) => {
    db.artists.push({ id: 7, name: 'Graham Nash', avatar: false, bio: '', style: '' }, { id: 8, name: 'David Crosby', avatar: false, bio: '', style: '' });
    db.albums[0].tracks.push(t(13, 3, 'Carey', NASH));
    for (const [i, id] of [[0, 14], [1, 22], [2, 32]]) db.albums[i].tracks.push(t(id, 9, 'Guest ' + id, { artist: 'David Crosby', artist_id: 8 }));
    db.albums.push({ id: 5, kind: 'album', title: 'Déjà Vu', artist: 'CSNY', artist_id: 0, year: 1970, cover: false, tracks: [t(61, 1, 'Almost Cut My Hair', { artist: 'David Crosby', artist_id: 8 })] });
    /* 单曲记录里挂着 TA 的曲目不算「专辑」 */
    db.albums[3].tracks.push(t(53, 2, 'River (Nash)', NASH));
  } });
  await page.goto('/music/zh/?artist=7');
  await expect(page.locator('#mu-ar-sub')).toHaveText('0 张专辑 · 0 首单曲');
  await expect(page.locator('#mu-ar-none')).toBeHidden();
  await expect(page.locator('#mu-ar-albums-h')).toBeHidden();
  const rel = page.locator('#mu-ar-rel');
  await expect(rel).toBeVisible();
  await expect(rel).toHaveText('还没有自己的专辑或单曲；有曲目收在「Blue」里。');
  await expect(rel.locator('a')).toHaveCount(1);
  /* 多于三张：链三张，其余说个数——中英都说「剩下几张」（总数 − 已链），不说总数 */
  await page.goto('/music/zh/?artist=8');
  await expect(rel).toHaveText('还没有自己的专辑或单曲；有曲目收在「Blue」、「Court and Spark」、「Ammonia Avenue」和另外 1 张专辑里。');
  await expect(rel.locator('a')).toHaveText(['Blue', 'Court and Spark', 'Ammonia Avenue']);
  await page.goto('/music/?artist=8');
  await expect(rel).toHaveText('No albums or singles of their own yet. Their tracks are on Blue, Court and Spark, Ammonia Avenue and 1 more.');
  /* 点链接 → 回音乐页那张专辑（页内换） */
  await page.goto('/music/zh/?artist=7');
  await page.evaluate(() => { window.__sameDoc = 1; });
  await rel.locator('a', { hasText: 'Blue' }).click();
  await expect(page).toHaveURL(/\/music\/zh\/$/);
  await expect(page.locator('#mu-album-title')).toHaveText('Blue');
  expect(await page.evaluate(() => window.__sameDoc)).toBe(1);
  /* 真的什么都没有：照旧「还没有专辑或单曲」，没有提示行 */
  await page.goto('/music/zh/?artist=6');
  await expect(page.locator('#mu-ar-none')).toHaveText('还没有专辑或单曲。');
  await expect(rel).toBeHidden();
});

test('歌手名链接常驻一条淡下划线（手机上也看得出能点），悬停换主色；别的链接不加', async ({ page }) => {
  await mockMusic(page);
  await page.goto('/music/zh/');
  const link = page.locator('#mu-album-sub a.mu-artist-a');
  const st = () => link.evaluate((a) => { const c = getComputedStyle(a); return { line: c.textDecorationLine, dc: c.textDecorationColor, color: c.color }; });
  const base = await st();
  expect(base.line).toBe('underline');
  expect(base.dc).not.toBe(base.color);
  await link.hover();
  await expect.poll(async () => (await st()).color).not.toBe(base.color);
  const hov = await st();
  expect(hov.dc).toBe(hov.color);
  /* 返回链接（别的链接）不加下划线 */
  await page.goto('/music/zh/?artist=2');
  expect(await page.locator('#mu-ar-back').evaluate((a) => getComputedStyle(a).textDecorationLine)).toBe('none');
});

test('合并（root）：选目标 → 确认卡片（确认键「合并」）→ artist.merge {id, into} → 切到目标歌手页', async ({ page }) => {
  const calls = await mockMusic(page);
  await page.goto('/music/zh/?artist=6');
  await page.locator('#mu-ar-edit').click();
  await expect(page.locator('#mu-ar-merge')).toBeDisabled();
  /* 列别的歌手（不含自己），按当前语言排序；顶上一项「选一位歌手」 */
  await expect(page.locator('#mu-ar-into option')).toHaveCount(4);
  await expect(page.locator('#mu-ar-into option').first()).toHaveText('选一位歌手');
  expect((await page.locator('#mu-ar-into option').allTextContents()).slice(1).sort()).toEqual(['APP', 'Joni Mitchell', '周杰伦']);
  await page.locator('#mu-ar-into').selectOption('2');
  await page.locator('#mu-ar-merge').click();
  await expect(page.locator('#mu-ar-wrap')).toHaveJSProperty('open', false);
  const card = page.locator('#mu-del-wrap');
  await expect(card).toHaveJSProperty('open', true);
  await expect(page.locator('#mu-del-title')).toHaveText('合并歌手');
  await expect(page.locator('#mu-del-msg')).toContainText('把「joni  mitchell」合并到「Joni Mitchell」吗？');
  await expect(page.locator('#mu-del-ok')).toHaveText('合并');
  await page.locator('#mu-del-ok').click();
  await expect(card).toHaveJSProperty('open', false);
  expect(writes(calls)).toEqual([{ op: 'artist.merge', id: 6, into: 2, ticket: '' }]);
  await expect(page).toHaveURL(/\?artist=2$/);
  await expect(page.locator('#mu-ar-name')).toHaveText('Joni Mitchell');
  await expect(page.locator('#bk-toast')).toHaveText('已合并');
  /* 卡片的确认键文案用完复原（删除照旧「删除」） */
  await page.locator('#mu-ar-back').click();
  await page.locator('#mu-seg [data-sec="single"]').click();
  await page.locator('#mu-singles [data-del="41"]').click();
  await expect(page.locator('#mu-del-ok')).toHaveText('删除');
});

test('删除歌手（root）：名下有作品 → 删除键灰、说明只能合并；没有作品 → 确认 → artist.del → 回音乐页', async ({ page }) => {
  const calls = await mockMusic(page);
  await page.goto('/music/zh/?artist=2');
  await page.locator('#mu-ar-edit').click();
  await expect(page.locator('#mu-ar-del')).toBeDisabled();
  await expect(page.locator('#mu-ar-del-note')).toHaveText('名下还有专辑或曲目，不能删除，只能合并到另一个歌手。');
  await page.locator('#mu-ar-x').click();
  await page.goto('/music/zh/?artist=6');
  await page.locator('#mu-ar-edit').click();
  await expect(page.locator('#mu-ar-del-note')).toBeHidden();
  await page.locator('#mu-ar-del').click();
  await expect(page.locator('#mu-del-title')).toHaveText('删除歌手');
  await expect(page.locator('#mu-del-msg')).toHaveText('确定删除歌手「joni  mitchell」吗？名下没有专辑或曲目。');
  await page.locator('#mu-del-ok').click();
  await expect.poll(() => writes(calls)).toEqual([{ op: 'artist.del', id: 6, ticket: '' }]);
  await expect(page).toHaveURL(/\/music\/zh\/$/);
  await expect(page.locator('#mu-lib')).toBeVisible();
});

test('歌手栏联想：上传 / 编辑 / 批量改都挂 #mu-artist-list（已有歌手）；只差大小写 / 空格时提示，点一下换成已有的', async ({ page }) => {
  await mockMusic(page);
  await page.goto('/music/zh/');
  await expect(page.locator('#mu-artist-list option')).toHaveCount(4);
  for (const id of ['mu-up-artist', 'mu-ed-artist', 'mu-ae-artist', 'mu-be-artist']) await expect(page.locator('#' + id)).toHaveAttribute('list', 'mu-artist-list');
  await page.locator('#mu-album-edit').click();
  const hint = page.locator('[data-hint-for="mu-ae-artist"]');
  await expect(hint).toBeHidden();
  await page.locator('#mu-ae-artist').fill('APP ');
  await expect(hint).toBeHidden();
  await page.locator('#mu-ae-artist').fill('app');
  await expect(hint).toHaveText('已有歌手「APP」，点一下换成它');
  await hint.click();
  await expect(page.locator('#mu-ae-artist')).toHaveValue('APP');
  await expect(hint).toBeHidden();
  await page.locator('#mu-ae-artist').fill('周杰倫');
  await expect(hint).toBeHidden();
});

test('弹出播放器：正在播的歌手名可点 → 主窗口（音乐页 /music/zh/）在页内切到歌手页，播放器不跳走', async ({ page, context }) => {
  await mockMusic(page);
  await page.goto('/music/zh/');
  await page.evaluate(() => { window.__sameDoc = 1; });
  const pl = await context.newPage();
  await mockMusic(pl);
  await pl.goto('/music/zh/player/');
  /* 打磨 6.4：没开播时显示停着等放的那首（第一张的第一首） */
  await expect(pl.locator('#mp-title')).toHaveText('All I Want');
  const a = pl.locator('#mp-artist a.mu-artist-a');
  await expect(a).toHaveText('Joni Mitchell');
  await expect(a).toHaveAttribute('href', '/music/zh/?artist=2');
  await a.click();
  await expect(page).toHaveURL(/\/music\/zh\/\?artist=2$/);
  await expect(page.locator('#mu-ar-name')).toHaveText('Joni Mitchell');
  expect(await page.evaluate(() => window.__sameDoc)).toBe(1);
  await expect(pl).toHaveURL(/\/music\/zh\/player\/$/);
  /* 播放器里单曲没封面 → 歌手头像（打磨 6.4 起播放器不选歌：?album=<单曲> 停在它那一首） */
  await pl.goto('/music/zh/player/?album=41');
  await expect(pl.locator('#mp-title')).toHaveText('River');
  await pl.locator('#mp-toggle').click();
  await expect(pl.locator('#mp-toggle')).toHaveClass(/is-playing/);
  await expect(pl.locator('#mp-cover img')).toHaveAttribute('src', '/music/api/music-cover?artist=2');
});
