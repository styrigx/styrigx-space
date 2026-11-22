// 游戏接口（workers/atlas-core/src/games，公开地址 /games/api/*；奇趣重组设计稿 v1.0 第三节 PR 1）：
// - 路由表与 src/games/api 接口文件一一对应；访问表快照（product 都是 games）
// - 和奇趣 /curio/api/items、/curio/api/photo 是同一张表、同一份封面（handler 复用 _items.js、_items-post.js、_photo.js）；旧路径照常
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
function call(p, { who = null, db, r2, method = 'GET', body, origin = ORIGIN, type } = {}) {
  const headers = { Cookie: 'sgx-session=x' };
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = type || 'application/json';
  const b = body === undefined ? undefined : body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request(ORIGIN + p, { method, headers, body: b }), { SPACE: whoAuth(who), D1_FINDS: db, D1_DEVICES: db, D1_GAMES: db, R2_PHOTOS: r2 }, { waitUntil() {} });
}
const env = () => ({ db: makeD1(), r2: makeR2() });
const post = (e, body, who = 'styrigx') => call('/games/api/games', { ...e, who, method: 'POST', body });
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

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

test('只收 game.*，只回游戏；和 /curio/api/items 同一张表；增改删排序', async () => {
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
  /* 旧地址读到同一份（PR 3 之前两边都在） */
  const old = await (await call('/curio/api/items', { ...e, who: 'styrigx' })).json();
  assert.deepEqual(old.games, r.games);
  const neu = await (await call('/games/api/games', { ...e })).json();
  assert.deepEqual(Object.keys(neu).sort(), ['canManage', 'games', 'ok', 'showPrivate']);
  assert.equal(neu.canManage, false);
  assert.equal((await (await call('/games/api/games', { ...e, who: 'styrigx' })).json()).canManage, true, 'canManage 按 games-manage 问');
  r = await (await post(e, { op: 'game.del', id: hades })).json();
  assert.deepEqual(r.games.map((g) => g.id), [zelda]);
  assert.equal((await post(e, { op: 'game.del', id: hades })).status, 404);
});

test('私密：没有 games-use 的拿不到私密游戏和它的封面（404）；封面换 / 删与 /curio/api/photo?kind=game 同一份', async () => {
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
  assert.ok([...e.r2.m.keys()].every((k) => k.startsWith('photos/game/')), '同一个前缀（照片清扫照旧认 games.cover）');
  assert.equal((await call(`/games/api/cover?id=${pub}`, e)).status, 200);
  assert.equal((await call(`/curio/api/photo?kind=game&id=${pub}`, e)).status, 200, '旧地址同一张图');
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
