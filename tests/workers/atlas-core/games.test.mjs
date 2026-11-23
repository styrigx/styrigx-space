// 游戏接口（workers/atlas-core/src/games，公开地址 /games/api/*；奇趣重组设计稿 v1.0 第三节 PR 1）：
// - 路由表与 src/games/api 接口文件一一对应；访问表快照（product 都是 games）
// - handler 复用 src/curio/api/_items.js、_items-post.js、_photo.js；奇趣重组 PR 3 删掉了旧 /curio/api/items、/curio/api/photo（和电影 /curio/api/movies）：表外路径 401
// - 校验：名字必填，状态 / 评分只收合法值；device_id 不再读写（带了忽略，回 0）
// - 封面：只收 webp / jpeg / png（看字节）、≤ 3 MB；换封面删旧的；private, no-cache + ETag，304 排在可见性之后；换封面换 ETag
//   （原 curio-items.test.mjs 设备照片那几条，PR 3 随 /curio/api/photo 删掉后搬到这里按游戏封面测）
// - 档：写访客 401、非同源 403、没组 / 只有 music-use 403；styrigx（默认组含 games-manage）、root 能写
// - 只收 game.*（device.* → 400 bad-op）；只回游戏，不回设备
// - 私密：看不到私密（没有 games-use）的拿不到私密游戏、私密游戏的封面 404
// SQL 用 node:sqlite 真跑（CI 用 Node 22）。运行：node --test tests/workers/atlas-core/games.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { whoAuth } from '../_v6who.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = REPO + '/workers/atlas-core/src';
const worker = (await import(SRC + '/curio/app.js')).default;
const GR = await import(SRC + '/games/routes.js');
const IT = await import(SRC + '/curio/api/_items.js');
const PH = await import(SRC + '/curio/api/_photo.js');

function makeD1(db = new DatabaseSync(':memory:')) {
  const isRead = (sql) => /^\s*SELECT/i.test(sql);
  const runIt = (sql, args) => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; };
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => runIt(sql, args),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) || null,
    _exec: () => (isRead(sql) ? { results: db.prepare(sql).all(...args) } : runIt(sql, args)),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      db.exec('BEGIN');
      try { const out = list.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
function makeR2() {
  const m = new Map();
  return {
    m,
    async put(key, value, opt = {}) { m.set(key, { bytes: new Uint8Array(value), httpMetadata: opt.httpMetadata || {} }); },
    async get(key) { const o = m.get(key); return o ? { body: o.bytes, httpMetadata: o.httpMetadata } : null; },
    async delete(key) { m.delete(key); },
  };
}
const ORIGIN = 'https://styrigx.com';
/* 网关 v6 替身（../_v6who.mjs）：null 访客、'lock' 有身份没组、'owner' root、'styrigx' 站长（默认组）、'noscope' 只有 music-use */
function call(p, { who = null, db, r2, method = 'GET', body, origin = ORIGIN, type, inm } = {}) {
  const headers = { Cookie: 'sgx-session=x' };
  if (inm) headers['If-None-Match'] = inm;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = type || 'application/json';
  const b = body === undefined ? undefined : body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request(ORIGIN + p, { method, headers, body: b }), { SPACE: whoAuth(who), D1_FINDS: db, D1_GAMES: db, R2_PHOTOS: r2 }, { waitUntil() {} });
}
const env = () => ({ db: makeD1(), r2: makeR2() });
const post = (e, body, who = 'styrigx') => call('/games/api/games', { ...e, who, method: 'POST', body });
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1]);

test('路由表与 src/games/api 接口文件一一对应；访问表快照（product 都是 games）', () => {
  const files = readdirSync(SRC + '/games/api').filter((n) => n.endsWith('.js') && !n.startsWith('_')).map((n) => '/api/' + n.slice(0, -3)).sort();
  assert.deepEqual([...GR.API_ROUTES.keys()].sort(), files);
  assert.deepEqual(GR.ROUTE_ACCESS.map((r) => r.method + ' ' + r.path + ' → ' + r.access + ' · ' + r.product), [
    'GET /api/games → public · games',
    'POST /api/games → entry · games',
    'GET /api/cover → public · games',
    'POST /api/cover → entry · games',
    'DELETE /api/cover → entry · games',
  ]);
  for (const r of GR.ROUTE_ACCESS) assert.ok(GR.API_ROUTES.has(r.path), r.path);
  for (const [p, mod] of GR.API_ROUTES) {
    for (const k of Object.keys(mod)) {
      const m = /^onRequest(Get|Post|Put|Delete|Head)$/.exec(k);
      if (m) assert.ok(GR.ROUTE_ACCESS.some((r) => r.path === p && r.method === m[1].toUpperCase()), p + ' ' + m[1]);
    }
  }
  assert.equal(GR.accessOf('GET', '/api/games/'), 'public');
  assert.equal(GR.accessOf('GET', '/api/games/x'), 'entry');
  assert.equal(GR.accessOf('PUT', '/api/games'), 'entry');
  assert.equal(GR.accessOf('GET', '/api/items'), 'entry');
});

test('档：读公开；写访客 401、非同源 403、没组 / 只有 music-use 403；styrigx 与 root 能写；别的产品的接口不能从 /games 前缀走', async () => {
  const e = env();
  assert.equal((await call('/games/api/games', e)).status, 200);
  const body = { op: 'game.add', title: 'Hades' };
  assert.equal((await call('/games/api/games', { ...e, method: 'POST', body })).status, 401);
  assert.equal((await call('/games/api/games', { ...e, who: 'styrigx', method: 'POST', body, origin: 'https://evil.com' })).status, 403);
  for (const who of ['lock', 'noscope']) {
    const r = await post(e, body, who);
    assert.equal(r.status, 403, who);
    assert.deepEqual(await r.json(), { ok: false, error: 'forbidden' }, who);
  }
  assert.equal((await post(e, body, 'styrigx')).status, 200, 'styrigx 默认组含 games-manage');
  assert.equal((await post(e, { op: 'game.add', title: 'Celeste' }, 'owner')).status, 200, 'root');
  assert.equal((await call('/games/api/cover?id=1', { ...e, who: 'noscope', method: 'POST', body: WEBP, type: 'image/webp' })).status, 403);
  assert.equal((await call('/games/api/cover?id=1', { ...e, method: 'DELETE' })).status, 401);
  for (const p of ['/games/api/items', '/games/api/photo?kind=game&id=1', '/games/api/links', '/games/api/nope']) {
    assert.equal((await call(p, e)).status, 401, p);
    assert.equal((await call(p, { ...e, who: 'owner' })).status, 401, p + '（账号路由表里没有）');
  }
});

test('只收 game.*，只回游戏；增改删排序；device_id 带了忽略、固定回 0', async () => {
  const e = env();
  assert.equal((await post(e, { op: 'device.add', name: 'S24' })).status, 400);
  assert.equal((await (await post(e, { op: 'device.add', name: 'S24' })).json()).error, 'bad-op');
  assert.equal((await post(e, { op: 'nope' })).status, 400);
  let r = await (await post(e, { op: 'game.add', title: '塞尔达', platform: 'Switch', status: 'playing' })).json();
  assert.ok(r.ok && r.id);
  assert.deepEqual(Object.keys(r).sort(), ['canManage', 'games', 'id', 'ok', 'showPrivate']);
  const zelda = r.id;
  r = await (await post(e, { op: 'game.add', title: 'Hades', status: 'done', rating: 5 })).json();
  const hades = r.id;
  r = await (await post(e, { op: 'game.order', ids: [hades, zelda] })).json();
  assert.deepEqual(r.games.map((g) => g.title), ['Hades', '塞尔达']);
  assert.equal((await post(e, { op: 'game.order', ids: [zelda] })).status, 409);
  r = await (await post(e, { op: 'game.edit', id: zelda, status: 'done' })).json();
  assert.equal(r.games.find((g) => g.id === zelda).status, 'done');
  assert.ok(r.games.every((g) => g.device_id === 0), 'device_id 固定回 0（列还在，奇趣重组 PR 3 起不再用）');
  r = await (await post(e, { op: 'game.add', title: 'Celeste', device_id: 77 })).json();
  assert.equal(r.games.find((g) => g.id === r.id).device_id, 0, '带 device_id 忽略（不再查设备在不在）');
  assert.equal(e.db.raw.prepare('SELECT device_id FROM games WHERE id = ?').get(r.id).device_id, 0, '库里也是 0');
  assert.equal((await post(e, { op: 'game.edit', id: zelda, device_id: 3 })).status, 400, '只带 device_id = 没有要改的（nothing）');
  assert.equal((await post(e, { op: 'game.del', id: r.id })).status, 200);
  const neu = await (await call('/games/api/games', { ...e })).json();
  assert.deepEqual(Object.keys(neu).sort(), ['canManage', 'games', 'ok', 'showPrivate']);
  assert.equal(neu.canManage, false);
  assert.equal((await (await call('/games/api/games', { ...e, who: 'styrigx' })).json()).canManage, true, 'canManage 按 games-manage 问');
  r = await (await post(e, { op: 'game.del', id: hades })).json();
  assert.deepEqual(r.games.map((g) => g.id), [zelda]);
  assert.equal((await post(e, { op: 'game.del', id: hades })).status, 404);
});

test('私密：没有 games-use 的拿不到私密游戏和它的封面（404）；封面换 / 删', async () => {
  const e = env();
  const pub = (await (await post(e, { op: 'game.add', title: '公开游戏' })).json()).id;
  const sec = (await (await post(e, { op: 'game.add', title: '私密游戏', private: true })).json()).id;
  for (const who of [null, 'lock', 'noscope']) {
    const v = await (await call('/games/api/games', { ...e, who })).json();
    assert.equal(v.showPrivate, false, String(who));
    assert.deepEqual(v.games.map((g) => g.title), ['公开游戏'], String(who));
  }
  const all = await (await call('/games/api/games', { ...e, who: 'styrigx' })).json();
  assert.equal(all.showPrivate, true);
  assert.deepEqual(all.games.map((g) => g.title), ['公开游戏', '私密游戏']);
  assert.equal((await call('/games/api/cover?id=0', e)).status, 400);
  assert.equal((await call(`/games/api/cover?id=${pub}`, e)).status, 404, '没封面');
  for (const id of [pub, sec]) {
    const up = await call(`/games/api/cover?id=${id}`, { ...e, who: 'styrigx', method: 'POST', body: WEBP, type: 'image/webp' });
    assert.equal(up.status, 200, String(id));
  }
  assert.equal((await call('/games/api/cover?id=999', { ...e, who: 'styrigx', method: 'POST', body: WEBP, type: 'image/webp' })).status, 404);
  assert.equal((await call(`/games/api/cover?id=${pub}`, { ...e, who: 'styrigx', method: 'POST', body: 'nope', type: 'image/webp' })).status, 400, '不是图片');
  assert.ok([...e.r2.m.keys()].every((k) => k.startsWith('photos/game/')), '同一个前缀（照片清扫只扫 photos/game/、认 games.cover）');
  assert.equal((await call(`/games/api/cover?id=${pub}`, e)).status, 200);
  assert.equal((await call(`/curio/api/photo?kind=game&id=${pub}`, e)).status, 401, '旧地址奇趣重组 PR 3 删了（表外路径）');
  assert.equal((await call(`/games/api/cover?id=${sec}`, e)).status, 404, '访客看不到私密封面');
  assert.equal((await call(`/games/api/cover?id=${sec}`, { ...e, who: 'noscope' })).status, 404, '只有 music-use 也看不到');
  assert.equal((await call(`/games/api/cover?id=${sec}`, { ...e, who: 'styrigx' })).status, 200);
  assert.equal((await call(`/games/api/cover?id=${pub}`, { ...e, who: 'styrigx', method: 'DELETE' })).status, 200);
  assert.equal((await call(`/games/api/cover?id=${pub}`, e)).status, 404, '删了');
  /* 删游戏连封面一起删 */
  const before = e.r2.m.size;
  assert.equal((await post(e, { op: 'game.del', id: sec })).status, 200);
  assert.equal(e.r2.m.size, before - 1);
});

test('校验（parseItemOp）：名字必填，状态 / 评分只收合法值，多行文本留换行；只认 game（device / movie → bad-op）', () => {
  assert.equal(IT.parseItemOp('game', { op: 'game.add' }).error, 'bad-title');
  assert.equal(IT.parseItemOp('game', { op: 'game.add', title: '  ' }).error, 'bad-title');
  assert.equal(IT.parseItemOp('game', { op: 'game.add', title: 'x', status: 'beaten' }).error, 'bad-status');
  assert.equal(IT.parseItemOp('game', { op: 'game.add', title: 'x', rating: 6 }).error, 'bad-rating');
  assert.equal(IT.parseItemOp('game', { op: 'game.edit', id: 1 }).error, 'nothing');
  assert.equal(IT.parseItemOp('game', { op: 'device.add', name: 'x' }).error, 'bad-op');
  assert.equal(IT.parseItemOp('device', { op: 'device.add', name: 'x' }).error, 'bad-op', '设备奇趣重组 PR 3 删了');
  assert.equal(IT.parseItemOp('movie', { op: 'movie.add', title: 'x' }).error, 'bad-op');
  assert.deepEqual(Object.keys(IT.KINDS), ['game']);
  const g = IT.parseItemOp('game', { op: 'game.add', title: 'Zel\nda ', review: 'a\r\nb\u0007', rating: 5, status: 'done', device_id: 9 });
  assert.equal(g.fields.title, 'Zel da');
  assert.equal(g.fields.review, 'a\nb');
  assert.deepEqual([g.fields.status, g.fields.rating], ['done', 5]);
  assert.equal('device_id' in g.fields, false, 'device_id 不进字段');
  assert.deepEqual(Object.keys(PH.PHOTO_KINDS), ['game'], '能带照片的只剩游戏');
  assert.equal(PH.photoKind('device'), null);
  assert.equal(PH.photoKind('movie'), null);
});

test('封面：只收 webp/jpeg/png、≤ 3 MB；换封面删旧的；列表里 cover 标记', async () => {
  const e = env();
  const id = (await (await post(e, { op: 'game.add', title: 'Hades' })).json()).id;
  const up = (i, body, type = 'image/webp') => call('/games/api/cover?id=' + i, { ...e, who: 'styrigx', method: 'POST', body, type });
  assert.equal((await up(id, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).status, 400);
  assert.equal((await up(id, new Uint8Array(PH.PHOTO_MAX_BYTES + 1))).status, 413);
  assert.equal((await up(999, WEBP)).status, 404);
  assert.equal((await up(id, WEBP)).status, 200);
  assert.equal(e.r2.m.size, 1);
  const first = [...e.r2.m.keys()][0];
  assert.match(first, new RegExp('^photos/game/' + id + '-\\d+\\.webp$'));
  await new Promise((r) => setTimeout(r, 2));
  assert.equal((await up(id, JPEG, 'image/jpeg')).status, 200);
  assert.equal(e.r2.m.size, 1, '旧封面删了');
  assert.ok(!e.r2.m.has(first));
  const g = await call('/games/api/cover?id=' + id, { ...e, who: 'lock' });
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('Content-Type'), 'image/jpeg');
  assert.equal((await (await call('/games/api/games', e)).json()).games[0].cover, true);
  assert.equal((await call('/games/api/cover?id=' + id, { ...e, who: 'styrigx', method: 'DELETE' })).status, 200);
  assert.equal(e.r2.m.size, 0);
  assert.equal((await (await call('/games/api/games', e)).json()).games[0].cover, false);
});

test('封面：公开——private, no-cache + ETag；304 排在可见性之后；换封面换 ETag', async () => {
  const e = env();
  const id = (await (await post(e, { op: 'game.add', title: 'Hades' })).json()).id;
  const pid = (await (await post(e, { op: 'game.add', title: '私', private: true })).json()).id;
  const up = (i, body) => call('/games/api/cover?id=' + i, { ...e, who: 'styrigx', method: 'POST', body, type: 'image/webp' });
  assert.equal((await up(id, WEBP)).status, 200);
  assert.equal((await up(pid, WEBP)).status, 200);
  const g = await call('/games/api/cover?id=' + id, { ...e, who: 'lock' });
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('Cache-Control'), 'private, no-cache');
  assert.equal(g.headers.get('Vary'), 'Cookie');
  const etag = g.headers.get('ETag');
  assert.match(etag || '', /^"[0-9a-f]{32}"$/);
  assert.doesNotMatch(etag, /photos|game/, 'ETag 不露 R2 key');
  /* 304 不读 R2 */
  let reads = 0;
  const realGet = e.r2.get;
  e.r2.get = async (k) => { reads++; return realGet(k); };
  const nm = await call('/games/api/cover?id=' + id, { ...e, who: 'lock', inm: etag });
  assert.equal(nm.status, 304);
  assert.equal(nm.headers.get('ETag'), etag);
  assert.equal(reads, 0);
  e.r2.get = realGet;
  /* 访客：公开游戏的封面照给；私密游戏 404，带着看得到私密的人拿到的 ETag 也是 404 */
  assert.equal((await call('/games/api/cover?id=' + id, { ...e, inm: etag })).status, 304);
  const pe = (await call('/games/api/cover?id=' + pid, { ...e, who: 'styrigx' })).headers.get('ETag');
  assert.equal((await call('/games/api/cover?id=' + pid, { ...e, who: 'lock', inm: pe })).status, 404);
  assert.equal((await call('/games/api/cover?id=' + pid, { ...e, who: 'styrigx', inm: pe })).status, 304);
  /* 换封面 → 旧 ETag 不再命中 */
  await new Promise((r) => setTimeout(r, 2));
  assert.equal((await up(id, WEBP)).status, 200);
  const after = await call('/games/api/cover?id=' + id, { ...e, who: 'lock', inm: etag });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.get('ETag'), etag);
});

test('奇趣重组 PR 3：旧 /curio/api/items、/curio/api/movies、/curio/api/photo 删了——表外路径，访客和 root 都 401（同 music 第 4 步的旧 /curio/api/music*）', async () => {
  const e = env();
  for (const [m, p] of [['GET', '/curio/api/items'], ['POST', '/curio/api/items'], ['GET', '/curio/api/movies'], ['POST', '/curio/api/movies'],
    ['GET', '/curio/api/photo?kind=game&id=1'], ['POST', '/curio/api/photo?kind=device&id=1'], ['DELETE', '/curio/api/photo?kind=movie&id=1']]) {
    const body = m === 'GET' || m === 'DELETE' ? undefined : { op: 'game.add', title: 'x' };
    assert.equal((await call(p, { ...e, method: m, body })).status, 401, m + ' ' + p + '（访客）');
    assert.equal((await call(p, { ...e, who: 'owner', method: m, body })).status, 401, m + ' ' + p + '（root：账号路由表里也没有）');
  }
});
