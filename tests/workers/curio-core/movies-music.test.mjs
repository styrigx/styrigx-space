// styrigx-curio-core 奇趣拆页（P4-3）新增的两个子页接口：
// - 电影 /api/movies：公开读（v5 S3；canWrite 按 v6 写组）；写要同源 + v6 写组（401 unauthorized / 403 forbidden / 403 origin）；
//   增改删、校验（片名必填、评分 0–5、年份、观看日期）、排序（最近看的在前）；海报走 /api/photo?kind=movie（3 MB、看字节），删电影连海报删；照片清扫认 movies.poster
// - 私人音乐三层（v5 S3）：歌单 / 封面公开（只有元数据，没有任何音频地址）；听（签令牌、取音频）要 v6 listen 组；
//   上传 / 管理要 v6 写组（没有身份 401、档不够 403 forbidden）；
//   上传（音频类型白名单、要 Content-Length、单文件 95 MB 上限、封面看字节）；播放短链（随机令牌存 D1、10 分钟过期、篡改 / 过期 / 别的专辑的曲目 403、
//   Range 206 / 416、整文件 200）；删专辑连 R2 一起删
// - 索引排除：搜索索引（= AI 召回读的 KV site:curio）不含电影 / 音乐；写电影 / 音乐不触发重建；站点地图模板不列 music / movies
// - 迁移 0004 和 MOVIE_SCHEMA / MUSIC_SCHEMA 建出来的表一致；wrangler.toml 有 D1_MOVIES / D1_MUSIC / R2_MUSIC 绑定，没有 secret
// SQL 用 node:sqlite 真跑。运行：node --test tests/workers/curio-core/movies-music.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { whoAuth } from '../_v6who.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const W = REPO + '/workers/curio-core';
const worker = (await import(W + '/src/app.js')).default;
const MV = await import(W + '/src/api/_movies.js');
const MU = await import(W + '/src/api/_music.js');
const SI = await import(W + '/src/search-index.js');
const SW = await import(W + '/src/photo-sweep.js');

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
    async put(key, value, opt = {}) {
      const bytes = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : new Uint8Array(value);
      m.set(key, { bytes, httpMetadata: opt.httpMetadata || {}, uploaded: new Date(0) });
    },
    async get(key, opt = {}) {
      const o = m.get(key);
      if (!o) return null;
      const r = opt.range;
      const body = r ? o.bytes.slice(r.offset, r.offset + r.length) : o.bytes;
      return { body, size: o.bytes.length, httpMetadata: o.httpMetadata };
    },
    async head(key) { const o = m.get(key); return o ? { size: o.bytes.length } : null; },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
    async list({ prefix }) { return { objects: [...m.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, uploaded: o.uploaded })), truncated: false }; },
  };
}
const ORIGIN = 'https://styrigx.com';
function makeEnv() {
  const db = makeD1();
  return { db, r2p: makeR2(), r2m: makeR2(), kv: { puts: 0, async put() { this.puts++; }, async get() { return null; } } };
}
function call(e, p, { who = null, method = 'GET', body, origin = ORIGIN, type, headers = {}, length } = {}) {
  const h = { Cookie: 'sgx-session=x', ...headers };
  if (origin) h.Origin = origin;
  if (body !== undefined) h['Content-Type'] = type || 'application/json';
  const b = body === undefined ? undefined : body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);
  if (length !== undefined) h['Content-Length'] = String(length);
  else if (b instanceof Uint8Array) h['Content-Length'] = String(b.length);
  const waits = [];
  const env = { SPACE: whoAuth(who), D1_FINDS: e.db, D1_DEVICES: e.db, D1_GAMES: e.db, D1_MOVIES: e.db, D1_MUSIC: e.db, R2_PHOTOS: e.r2p, R2_MUSIC: e.r2m, KV_SEARCH_INDEX: e.kv };
  return worker.fetch(new Request(ORIGIN + p, { method, headers: h, body: b }), env, { waitUntil(x) { waits.push(x); } }).then((r) => { r.waits = waits; return r; });
}
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const AUDIO = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256));

/* ================= 电影 ================= */

test('电影：访客能读（v5 S3）；写没有身份 401、档不够 403 forbidden；非同源 403；有权限 200', async () => {
  const e = makeEnv();
  assert.deepEqual(await (await call(e, '/curio/api/movies')).json(), { ok: true, canWrite: false, showPrivate: false, movies: [] });
  assert.equal((await call(e, '/curio/api/movies', { method: 'POST', body: { op: 'movie.add', title: 'x' } })).status, 401);
  const r = await call(e, '/curio/api/movies', { who: 'lock' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, canWrite: false, showPrivate: false, movies: [] });
  const add = { op: 'movie.add', title: '花样年华' };
  const na = await call(e, '/curio/api/movies', { who: 'lock', method: 'POST', body: add });
  assert.equal(na.status, 403);
  assert.equal((await na.json()).error, 'forbidden');
  const ns = await call(e, '/curio/api/movies', { who: 'noscope', method: 'POST', body: add });
  assert.equal(ns.status, 403);
  assert.deepEqual(await ns.json(), { ok: false, error: 'forbidden' });
  assert.equal((await call(e, '/curio/api/movies', { who: 'noscope' })).status, 200, '没写组也能读');
  assert.equal((await (await call(e, '/curio/api/movies', { who: 'noscope' })).json()).canWrite, false);
  assert.equal((await call(e, '/curio/api/movies', { who: 'owner', method: 'POST', body: add, origin: 'https://evil.com' })).status, 403);
  const ok = await call(e, '/curio/api/movies', { who: 'owner', method: 'POST', body: add });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.canWrite, true);
  assert.equal(j.movies.length, 1);
  assert.equal(typeof j.id, 'number');
});

test('电影 CRUD：校验、排序（最近看的在前，没日期的在后）、编辑只改给了的、删除连海报删', async () => {
  const e = makeEnv();
  const post = async (body) => call(e, '/curio/api/movies', { who: 'owner', method: 'POST', body });
  for (const [body, code] of [
    [{ op: 'movie.add' }, 'bad-title'], [{ op: 'movie.add', title: '  ' }, 'bad-title'], [{ op: 'movie.add', title: 'A', rating: 6 }, 'bad-rating'],
    [{ op: 'movie.add', title: 'A', year: 1700 }, 'bad-year'], [{ op: 'movie.add', title: 'A', watched_at: '2026-02-30' }, 'bad-watched-at'],
    [{ op: 'movie.edit', id: 0, title: 'x' }, 'bad-id'], [{ op: 'movie.edit', id: 1 }, 'nothing'], [{ op: 'nope' }, 'bad-op'],
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).error, code);
  }
  const a = await (await post({ op: 'movie.add', title: '花样年华', original_title: 'In the Mood for Love', year: 2000, director: '王家卫', rating: 5, review: '旗袍\n雨', watched_at: '2024-05-01' })).json();
  await post({ op: 'movie.add', title: '无日期' });
  const c = await (await post({ op: 'movie.add', title: '奥本海默', year: 2023, watched_at: '2025-01-02', rating: 4 })).json();
  let list = (await (await call(e, '/curio/api/movies', { who: 'lock' })).json()).movies;
  assert.deepEqual(list.map((m) => m.title), ['奥本海默', '花样年华', '无日期']);
  assert.deepEqual(list[1], { id: a.id, title: '花样年华', original_title: 'In the Mood for Love', year: 2000, director: '王家卫', rating: 5, review: '旗袍\n雨', watched_at: '2024-05-01', poster: false });
  await post({ op: 'movie.edit', id: a.id, rating: 3 });
  list = (await (await call(e, '/curio/api/movies', { who: 'lock' })).json()).movies;
  assert.equal(list[1].rating, 3);
  assert.equal(list[1].director, '王家卫');
  assert.equal((await post({ op: 'movie.edit', id: 999, title: 'x' })).status, 404);
  /* 海报：/api/photo?kind=movie */
  const up = await call(e, '/curio/api/photo?kind=movie&id=' + c.id, { who: 'owner', method: 'POST', body: WEBP, type: 'image/webp' });
  assert.equal(up.status, 200);
  const key = [...e.r2p.m.keys()][0];
  assert.match(key, new RegExp('^photos/movie/' + c.id + '-\\d+\\.webp$'));
  const pic = await call(e, '/curio/api/photo?kind=movie&id=' + c.id, { who: 'lock' });
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('Content-Type'), 'image/webp');
  assert.equal((await call(e, '/curio/api/photo?kind=movie&id=' + c.id, { who: 'lock', method: 'POST', body: WEBP, type: 'image/webp' })).status, 403);
  assert.equal((await call(e, '/curio/api/photo?kind=movie&id=' + c.id, { who: 'owner', method: 'POST', body: new Uint8Array(20), type: 'image/webp' })).status, 400);
  list = (await (await call(e, '/curio/api/movies', { who: 'lock' })).json()).movies;
  assert.equal(list[0].poster, true);
  /* 清扫认 movies.poster：引用着的海报不删 */
  e.r2p.m.set('photos/movie/orphan.webp', { bytes: WEBP, httpMetadata: {}, uploaded: new Date(0) });
  const sw = await SW.sweepPhotos({ D1_DEVICES: e.db, R2_PHOTOS: e.r2p }, Date.now());
  assert.equal(sw.ok, true);
  assert.deepEqual([...e.r2p.m.keys()], [key]);
  /* 删电影连海报删 */
  const del = await post({ op: 'movie.del', id: c.id });
  assert.equal(del.status, 200);
  assert.equal(e.r2p.m.size, 0);
  assert.deepEqual((await del.json()).movies.map((m) => m.title), ['花样年华', '无日期']);
});

/* ================= 音乐：权限 ================= */

test('音乐三层（v5 S3）：歌单 / 封面公开且不带音频地址；听要 listen 组；上传 / 管理要写组；写非同源 403', async () => {
  const e = makeEnv();
  /* 管理：没有身份 401 unauthorized、档不够 403 forbidden、非同源 403 */
  const manage = [
    ['/curio/api/music', 'POST', { op: 'album.add', title: 'A' }],
    ['/curio/api/music-upload?album=1&kind=cover', 'POST', WEBP],
  ];
  for (const [p, method, body] of manage) {
    const opt = { method, body, type: body instanceof Uint8Array ? 'image/webp' : undefined };
    const r = await call(e, p, { ...opt, who: null });
    assert.equal(r.status, 401, p);
    assert.equal((await r.json()).error, 'unauthorized', p);
    for (const who of ['lock', 'noscope']) {
      const s = await call(e, p, { ...opt, who });
      assert.equal(s.status, 403, p + ' ' + who);
      assert.equal((await s.json()).error, 'forbidden', p);
    }
    assert.equal((await call(e, p, { ...opt, who: 'owner', origin: 'https://evil.com' })).status, 403, p);
  }
  /* 有专辑、有曲目、有歌词、有封面时，访客的歌单只有元数据 */
  const id = (await (await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'album.add', title: 'Absolution', artist: 'Muse', year: 2003 } })).json()).id;
  const tid = (await (await call(e, `/curio/api/music-upload?album=${id}&kind=track&no=1&title=Intro&duration=22`, { who: 'owner', method: 'POST', body: AUDIO, type: 'audio/mpeg' })).json()).id;
  await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'track.edit', id: tid, lrc: '[00:01.00]x' } });
  assert.equal((await call(e, `/curio/api/music-upload?album=${id}&kind=cover`, { who: 'owner', method: 'POST', body: WEBP, type: 'image/webp' })).status, 200);
  for (const who of [null, 'lock', 'noscope']) {
    const r = await call(e, '/curio/api/music', { who });
    assert.equal(r.status, 200, String(who));
    const text = await r.clone().text();
    assert.deepEqual(await r.json(), { ok: true, canWrite: false, albums: [{ id, kind: 'album', title: 'Absolution', artist: 'Muse', year: 2003, cover: true, tracks: [{ id: tid, no: 1, title: 'Intro', duration: 22 }] }] }, String(who));
    assert.doesNotMatch(text, /music-stream|music\/|"src"|"key"|r2_key|token|"url"/, '歌单里没有音频地址 / R2 key / 令牌');
  }
  const own = await (await call(e, '/curio/api/music', { who: 'owner' })).json();
  assert.equal(own.canWrite, true);
  assert.deepEqual(Object.keys(own.albums[0].tracks[0]).sort(), ['duration', 'id', 'lrc', 'no', 'size', 'title', 'type']);
  /* 封面公开（和音频不是同一条路） */
  const cv = await call(e, `/curio/api/music-cover?album=${id}`);
  assert.equal(cv.status, 200);
  assert.equal(cv.headers.get('Content-Type'), 'image/webp');
  /* 听：访客签不了令牌、取不了音频；没有 listen 组 403；有 listen（alice）、站长都能听；非同源 403 */
  assert.equal((await call(e, '/curio/api/music-play', { method: 'POST', body: { album: id } })).status, 401);
  assert.equal((await call(e, '/curio/api/music-play', { who: 'lock', method: 'POST', body: { album: id } })).status, 403);
  assert.equal((await call(e, '/curio/api/music-play', { who: 'noscope', method: 'POST', body: { album: id }, origin: 'https://evil.com' })).status, 403);
  for (const who of ['noscope', 'styrigx']) {
    const play = await (await call(e, '/curio/api/music-play', { who, method: 'POST', body: { album: id } })).json();
    assert.equal(play.ok, true, who);
    const src = play.tracks[0].src;
    const r = await call(e, src, { who, origin: null });
    assert.equal(r.status, 200, who);
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(r.headers.get('CDN-Cache-Control'), 'no-store');
    /* 拿着有效令牌，但没有 v6 身份（lock / exit 之后）→ 401，不给音频 */
    const gone = await call(e, src, { origin: null });
    assert.equal(gone.status, 401, who);
    assert.equal(gone.headers.get('Content-Type'), 'application/json');
    assert.equal((await call(e, src, { origin: null, method: 'HEAD' })).status, 401);
  }
  /* 精确匹配：歌单路径后面多一段 / 换方法都不是公开的 */
  assert.equal((await call(e, '/curio/api/music/x')).status, 401);
  assert.equal((await call(e, '/curio/api/music-cover/x?album=' + id)).status, 401);
  assert.equal((await call(e, '/curio/api/music', { method: 'PUT', body: {} })).status, 401);
  assert.equal((await call(e, '/curio/api/access')).status, 401, '/api/access 已删（路由表里没有：一律 401）');
  assert.equal((await call(e, '/curio/api/access', { who: 'owner' })).status, 401);
});

/* ================= 音乐：上传 ================= */

async function album(e, extra = {}) {
  const j = await (await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'album.add', title: 'Blue', artist: 'Joni Mitchell', year: 1971, ...extra } })).json();
  return j.id;
}
const upTrack = (e, id, q, body = AUDIO, type = 'audio/mpeg', more = {}) => call(e, `/curio/api/music-upload?album=${id}&kind=track&${q}`, { who: 'owner', method: 'POST', body, type, ...more });

test('上传：音频类型白名单、要 Content-Length（411）、单文件上限 95 MB（413）、专辑不在 404；封面看字节、换封面删旧的', async () => {
  const e = makeEnv();
  const id = await album(e);
  assert.equal(MU.MUSIC_LIMITS.trackBytes, 95 * 1024 * 1024);
  assert.equal((await upTrack(e, id, 'no=1&title=All%20I%20Want&duration=212', AUDIO, 'text/html')).status, 400);
  assert.equal((await (await upTrack(e, id, 'no=1&title=x', AUDIO, 'application/octet-stream')).json()).error, 'not-audio');
  const big = await upTrack(e, id, 'no=1&title=x', new Uint8Array(10), 'audio/flac', { length: MU.MUSIC_LIMITS.trackBytes + 1 });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, 'too-large');
  assert.equal((await upTrack(e, 999, 'no=1&title=x')).status, 404);
  assert.equal((await upTrack(e, id, 'no=1&title=')).status, 400);
  assert.equal((await upTrack(e, id, 'no=abc&title=x')).status, 400);
  const ok = await upTrack(e, id, 'no=1&title=All%20I%20Want&duration=212');
  assert.equal(ok.status, 200);
  const tid = (await ok.json()).id;
  const key = [...e.r2m.m.keys()][0];
  assert.match(key, new RegExp(`^music/${id}/001-\\d+\\.mp3$`));
  assert.deepEqual(e.r2m.m.get(key).bytes, AUDIO);
  assert.equal(e.r2m.m.get(key).httpMetadata.contentType, 'audio/mpeg');
  await upTrack(e, id, 'no=2&title=My%20Old%20Man&duration=215', AUDIO, 'audio/flac');
  /* 封面 */
  assert.equal((await call(e, `/curio/api/music-upload?album=${id}&kind=cover`, { who: 'owner', method: 'POST', body: new Uint8Array(20), type: 'image/webp' })).status, 400);
  assert.equal((await call(e, `/curio/api/music-upload?album=${id}&kind=cover`, { who: 'owner', method: 'POST', body: WEBP, type: 'image/webp' })).status, 200);
  const c1 = [...e.r2m.m.keys()].find((k) => k.includes('cover-'));
  await new Promise((r) => setTimeout(r, 3));
  await call(e, `/curio/api/music-upload?album=${id}&kind=cover`, { who: 'owner', method: 'POST', body: WEBP, type: 'image/webp' });
  const covers = [...e.r2m.m.keys()].filter((k) => k.includes('cover-'));
  assert.equal(covers.length, 1);
  assert.notEqual(covers[0], c1);
  const cov = await call(e, `/curio/api/music-cover?album=${id}`, { who: 'owner' });
  assert.equal(cov.status, 200);
  assert.equal(cov.headers.get('Cache-Control'), 'private, no-cache');
  /* 列表：按曲序，歌词只给有没有 */
  await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'track.edit', id: tid, lrc: '[00:01.00]I am on a lonely road' } });
  const list = (await (await call(e, '/curio/api/music', { who: 'owner' })).json()).albums;
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0], tracks: undefined }, { id, kind: 'album', title: 'Blue', artist: 'Joni Mitchell', year: 1971, cover: true, tracks: undefined });
  assert.deepEqual(list[0].tracks.map((t) => [t.no, t.title, t.duration, t.lrc]), [[1, 'All I Want', 212, true], [2, 'My Old Man', 215, false]]);
});

/* ================= 音乐：播放短链 ================= */

test('播放短链：随机令牌（43 字符 base64url，存 D1）、整文件 200、Range 206（拖进度，同一令牌多次）、416；篡改 / 过期 / 别的专辑曲目 403', async () => {
  const e = makeEnv();
  const id = await album(e);
  const other = await album(e, { title: 'Court and Spark' });
  const t1 = (await (await upTrack(e, id, 'no=1&title=A&duration=10')).json()).id;
  const t2 = (await (await upTrack(e, other, 'no=1&title=B&duration=10')).json()).id;
  assert.equal((await call(e, '/curio/api/music-play', { who: 'owner', method: 'POST', body: { album: 999 } })).status, 404);
  await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'track.edit', id: t1, lrc: '[00:00.50]hi' } });
  const play = await (await call(e, '/curio/api/music-play', { who: 'owner', method: 'POST', body: { album: id } })).json();
  assert.equal(play.ok, true);
  assert.equal(play.ttl, 10 * 60 * 1000);
  assert.equal(play.tracks.length, 1);
  assert.equal(play.tracks[0].lrc, '[00:00.50]hi');
  const src = play.tracks[0].src;
  const tok = new URL(ORIGIN + src).searchParams.get('t');
  assert.match(tok, MU.TOKEN_RE);
  assert.equal(e.db.raw.prepare('SELECT COUNT(*) AS n FROM music_tokens').get().n, 1);
  /* 两次签发令牌不同（随机） */
  const play2 = await (await call(e, '/curio/api/music-play', { who: 'owner', method: 'POST', body: { album: id } })).json();
  assert.notEqual(new URL(ORIGIN + play2.tracks[0].src).searchParams.get('t'), tok);

  /* 播放要 listen 组 + 令牌（<audio> 也带 sgx-session）；没有身份 401（守卫在 app.js，令牌之前） */
  assert.equal((await call(e, src)).status, 401);
  const full = await call(e, src, { who: 'noscope', origin: null });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(full.headers.get('Content-Length'), '1000');
  assert.equal(full.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(full.headers.get('Content-Type'), 'audio/mpeg');
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), AUDIO);
  for (const [range, from, to] of [['bytes=0-99', 0, 99], ['bytes=900-', 900, 999], ['bytes=-10', 990, 999], ['bytes=500-5000', 500, 999]]) {
    const r = await call(e, src, { who: 'noscope', origin: null, headers: { Range: range } });
    assert.equal(r.status, 206, range);
    assert.equal(r.headers.get('Content-Range'), `bytes ${from}-${to}/1000`, range);
    assert.equal(r.headers.get('Content-Length'), String(to - from + 1), range);
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), AUDIO.slice(from, to + 1), range);
  }
  for (const range of ['bytes=1000-', 'bytes=5-2', 'items=0-1', 'bytes=0-1,5-6']) {
    const r = await call(e, src, { who: 'noscope', origin: null, headers: { Range: range } });
    assert.equal(r.status, 416, range);
    assert.equal(r.headers.get('Content-Range'), 'bytes */1000');
  }
  const head = await call(e, src, { who: 'noscope', origin: null, method: 'HEAD', headers: { Range: 'bytes=0-9' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('Content-Length'), '10');
  /* 篡改：改一个字符 / 截短 / 别的专辑的曲目 → 403 token */
  const flip = tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A');
  for (const p of [src.replace(tok, flip), src.replace(tok, tok.slice(1)), src.replace('id=' + t1, 'id=' + t2), '/curio/api/music-stream?id=' + t1, src.replace('id=' + t1, 'id=abc')]) {
    const r = await call(e, p, { who: 'noscope', origin: null });
    assert.equal(r.status, 403, p);
    assert.equal((await r.json()).error, 'token', p);
  }
  /* 过期：把令牌过期时间拨到过去 → 403；签新令牌时顺手删掉过期的 */
  e.db.raw.prepare('UPDATE music_tokens SET expires_at = ?1').run(Date.now() - 1);
  assert.equal((await call(e, src, { who: 'noscope', origin: null })).status, 403);
  assert.equal((await call(e, src, { who: 'noscope', origin: null, headers: { Range: 'bytes=0-1' } })).status, 403);
  await call(e, '/curio/api/music-play', { who: 'owner', method: 'POST', body: { album: other } });
  assert.equal(e.db.raw.prepare('SELECT COUNT(*) AS n FROM music_tokens').get().n, 1);
  /* 纯函数 */
  assert.equal(MU.parseRange(null, 10), null);
  assert.deepEqual(MU.parseRange('bytes=2-3', 10), { offset: 2, length: 2 });
  assert.equal(MU.parseRange('bytes=-0', 10), 'invalid');
});

test('删专辑：曲目、令牌、R2 里的音频和封面一起删；删曲目删它的音频', async () => {
  const e = makeEnv();
  const id = await album(e);
  const t1 = (await (await upTrack(e, id, 'no=1&title=A')).json()).id;
  await upTrack(e, id, 'no=2&title=B');
  await call(e, `/curio/api/music-upload?album=${id}&kind=cover`, { who: 'owner', method: 'POST', body: WEBP, type: 'image/webp' });
  await call(e, '/curio/api/music-play', { who: 'owner', method: 'POST', body: { album: id } });
  assert.equal(e.r2m.m.size, 3);
  await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'track.del', id: t1 } });
  assert.equal(e.r2m.m.size, 2);
  const r = await (await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'album.del', id } })).json();
  assert.deepEqual(r.albums, []);
  assert.equal(e.r2m.m.size, 0);
  assert.equal(e.db.raw.prepare('SELECT COUNT(*) AS n FROM music_tokens').get().n, 0);
  assert.equal(e.db.raw.prepare('SELECT COUNT(*) AS n FROM music_tracks').get().n, 0);
  assert.equal((await (await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'album.del', id } })).json()).error, 'not-found');
});

/* ================= 索引（2026-11 AI 语义召回：电影、音乐元数据进索引） ================= */

test('索引：电影、音乐元数据进 site:curio（不标 private，进门即可问；音频 / 封面 / 歌词不进）；写电影 / 音乐触发重建；站点地图模板只列首页', async () => {
  const e = makeEnv();
  const mv = await call(e, '/curio/api/movies', { who: 'owner', method: 'POST', body: { op: 'movie.add', title: '一部电影 moviezz', original_title: 'Orig', year: 2000, director: '王家卫', rating: 4, watched_at: '2026-10-01', review: '好看' } });
  assert.equal(mv.status, 200);
  assert.equal(mv.waits.length, 1, '写电影重建索引');
  const al = await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'album.add', title: '私人专辑 musiczz', artist: 'Joni Mitchell', year: 1971 } });
  assert.equal(al.waits.length, 1, '写音乐重建索引');
  const id = (await al.json()).id;
  const up = await upTrack(e, id, 'no=1&title=' + encodeURIComponent('All I Want') + '&duration=212');
  assert.equal(up.status, 200);
  assert.equal(up.waits.length, 1, '上传曲目重建索引');
  await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'track.edit', id: (await (await call(e, '/curio/api/music', { who: 'owner' })).json()).albums[0].tracks[0].id, lrc: '[00:01.00]lyricszz' } });
  assert.equal(SI.isContentMutation('/api/movies', 'POST', 200), true);
  assert.equal(SI.isContentMutation('/api/music', 'POST', 200), true);
  assert.equal(SI.isContentMutation('/api/music-upload', 'POST', 200), true);
  assert.equal(SI.isContentMutation('/api/music', 'GET', 200), false);
  assert.equal(SI.isContentMutation('/api/photo', 'POST', 200), false);
  const ix = await SI.buildIndex(e.db);
  const movie = ix.items.find((it) => it.id === 'movie:1');
  assert.deepEqual(movie, { id: 'movie:1', type: 'item', lang: 'zh', title: '一部电影 moviezz', url: 'https://styrigx.com/curio/zh/movies/', subtitle: '电影 · 2000 · 王家卫', text: '原名: Orig\n导演: 王家卫\n评分: 4/5\n观看日期: 2026-10-01\n好看' });
  assert.equal(ix.items.find((it) => it.id === 'movie:1:en').url, 'https://styrigx.com/curio/movies/');
  assert.match(ix.items.find((it) => it.id === 'movie:1:en').subtitle, /^Movies · 2000/);
  const album = ix.items.find((it) => it.id === 'album:' + id);
  assert.equal(album.title, '私人专辑 musiczz');
  assert.equal(album.subtitle, '音乐 · Joni Mitchell · 1971');
  assert.equal(album.text, '歌手: Joni Mitchell\n1. All I Want');
  assert.equal(album.url, 'https://styrigx.com/curio/zh/music/');
  assert.ok(ix.items.filter((it) => /^(movie|album):/.test(it.id)).every((it) => it.private === undefined), '没有私密列，不标 private');
  const all = JSON.stringify(ix);
  assert.doesNotMatch(all, /lyricszz|r2_key|music\/\d|\.mp3/, '歌词 / 音频 key 不进');
  /* 站点地图：/curio/sitemap.xml 只列首页两种语言（合站后本站首页是分区页：模板里只有 (site.GetPage "/curio").AllTranslations）；子页一律 noindex */
  const sm = readFileSync(REPO + '/space/web/layouts/curio/section.curiositemap.xml', 'utf8');
  assert.match(sm, /\(site\.GetPage "\/curio"\)\.AllTranslations/);
  assert.doesNotMatch(sm, /music|movies|RegularPages|\.Pages/);
});

/* ================= 只读固定查询（CurioReader，给 styrigx-ai） ================= */

test('reader：recentMovies 按观看日期倒序（没填日期的在后）、n 夹在 1–20；music 认问句里的专辑名 / 歌手名、回曲目表；不认的查询名 unknown；只读', async () => {
  const RD = await import(W + '/src/reader.js');
  const e = makeEnv();
  for (const [title, watched_at] of [['A', '2026-01-01'], ['B', ''], ['C', '2026-03-01'], ['D', '2026-02-01']]) {
    await call(e, '/curio/api/movies', { who: 'owner', method: 'POST', body: { op: 'movie.add', title, watched_at } });
  }
  const env = { D1_MOVIES: e.db, D1_MUSIC: e.db };
  let r = await RD.runQuery(env, 'recentMovies', { n: 3 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.movies.map((m) => m.title), ['C', 'D', 'A']);
  assert.deepEqual(Object.keys(r.movies[0]).sort(), ['director', 'original_title', 'rating', 'review', 'title', 'watched_at', 'year']);
  assert.equal((await RD.runQuery(env, 'recentMovies', { n: 99 })).movies.length, 4);
  assert.equal((await RD.runQuery(env, 'recentMovies', { n: 'x' })).movies.length, 4, '坏参数用默认 5');
  assert.equal((await RD.runQuery(env, 'recentMovies', { n: 0 })).movies.length, 1);
  const al = await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'album.add', title: 'Blue', artist: 'Joni Mitchell', year: 1971 } });
  const id = (await al.json()).id;
  await upTrack(e, id, 'no=2&title=My%20Old%20Man&duration=215');
  await upTrack(e, id, 'no=1&title=All%20I%20Want&duration=212');
  await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'album.add', title: 'Hejira', artist: 'Joni Mitchell' } });
  r = await RD.runQuery(env, 'music', { q: '专辑 blue 有哪些歌' });
  assert.deepEqual(r.albums.map((a) => a.title), ['Blue']);
  assert.deepEqual(r.albums[0].tracks, [{ no: 1, title: 'All I Want', duration: 212 }, { no: 2, title: 'My Old Man', duration: 215 }]);
  r = await RD.runQuery(env, 'music', { q: 'joni mitchell 的歌' });
  assert.deepEqual(r.albums.map((a) => a.title), ['Blue', 'Hejira']);
  assert.deepEqual((await RD.runQuery(env, 'music', { q: 'x' })).albums, []);
  assert.deepEqual((await RD.runQuery(env, 'music', { q: "'; DROP TABLE music_albums; --" })).albums, [], '参数化：问句只是 bind 的值');
  assert.equal((await RD.runQuery(env, 'music', { q: 'blue' })).albums.length, 1, '表还在');
  assert.deepEqual(await RD.runQuery(env, 'SELECT * FROM music_tracks', {}), { ok: false, error: 'unknown' });
  assert.deepEqual(RD.QUERIES, ['recentMovies', 'music']);
  const src = readFileSync(W + '/src/reader.js', 'utf8');
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/, '只读');
  for (const sel of src.match(/SELECT [^'"]+FROM \w+/g)) assert.doesNotMatch(sel, /lrc|r2_key|cover|poster|token/, sel);
  /* 入口：index.js 再导出 default 和 CurioReader；rpc/reader.js 是 WorkerEntrypoint */
  const idx = readFileSync(W + '/src/index.js', 'utf8');
  assert.match(idx, /export \{ default \} from '\.\/app\.js';/);
  assert.match(idx, /export \{ CurioReader \} from '\.\/rpc\/reader\.js';/);
  assert.match(readFileSync(W + '/src/rpc/reader.js', 'utf8'), /class CurioReader extends WorkerEntrypoint/);
});

/* ================= 迁移 / 配置 ================= */

test('迁移 0004 + 0005 和 MOVIE_SCHEMA / MUSIC_SCHEMA 建出来的表一致；wrangler.toml 有 D1_MOVIES / D1_MUSIC / R2_MUSIC，没有 secret', () => {
  const a = new DatabaseSync(':memory:');
  a.exec(readFileSync(W + '/migrations/0004_movies_music.sql', 'utf8'));
  a.exec(readFileSync(W + '/migrations/0004_movies_music.sql', 'utf8'));
  a.exec(readFileSync(W + '/migrations/0005_music_kind_artists.sql', 'utf8'));
  const b = new DatabaseSync(':memory:');
  for (const s of [...MV.MOVIE_SCHEMA, ...MU.MUSIC_SCHEMA]) b.exec(s);
  const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
  for (const t of ['movies', 'music_albums', 'music_tracks', 'music_tokens', 'music_artists']) assert.deepEqual(cols(b, t), cols(a, t), t);
  const idx = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(idx(b), idx(a));
  const t = readFileSync(W + '/wrangler.toml', 'utf8');
  const d1 = [...t.matchAll(/^\[\[d1_databases\]\]\nbinding = "([A-Z0-9_]+)"\ndatabase_name = "styrigx-curio-core"/gm)].map((m) => m[1]);
  assert.deepEqual(d1, ['D1_FINDS', 'D1_DEVICES', 'D1_GAMES', 'D1_MOVIES', 'D1_MUSIC']);
  const r2 = [...t.matchAll(/^binding = "(R2_[A-Z]+)"\nbucket_name = "styrigx-curio-core"$/gm)].map((m) => m[1]);
  assert.deepEqual(r2, ['R2_PHOTOS', 'R2_MUSIC']);
  assert.equal((t.match(/^migrations_dir = /gm) || []).length, 1, 'migrations_dir 只在 D1_FINDS 上');
  assert.doesNotMatch(t, /\[vars\]|secret|HMAC/i);
  const src = ['_music.js', 'music-play.js', 'music-stream.js'].map((f) => readFileSync(W + '/src/api/' + f, 'utf8')).join('\n');
  assert.match(src, /crypto\.getRandomValues/);
  assert.doesNotMatch(src, /env\.[A-Z_]*(SECRET|KEY|HMAC)/);
});

test('迁移 0005：现有专辑默认 album；按专辑歌手文本（去首尾空白）去重建歌手并回填 artist_id，曲目跟专辑；kind 只收 album / single', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(W + '/migrations/0004_movies_music.sql', 'utf8'));
  db.exec("INSERT INTO music_albums (title, artist) VALUES ('A', '周杰伦'), ('B', ' 周杰伦 '), ('C', ''), ('D', 'Jay Chou')");
  db.exec("INSERT INTO music_tracks (album_id, title) VALUES (1, 't1'), (2, 't2'), (3, 't3'), (4, 't4'), (99, '孤儿')");
  db.exec(readFileSync(W + '/migrations/0005_music_kind_artists.sql', 'utf8'));
  assert.deepEqual(db.prepare('SELECT id, name FROM music_artists ORDER BY id').all().map((r) => [r.id, r.name]), [[1, '周杰伦'], [2, 'Jay Chou']]);
  assert.deepEqual(db.prepare('SELECT kind, artist_id FROM music_albums ORDER BY id').all().map((r) => [r.kind, r.artist_id]), [['album', 1], ['album', 1], ['album', 0], ['album', 2]]);
  assert.deepEqual(db.prepare('SELECT artist_id FROM music_tracks ORDER BY id').all().map((r) => r.artist_id), [1, 1, 0, 2, 0]);
  assert.throws(() => db.exec("UPDATE music_albums SET kind = 'ep'"), /CHECK/);
});

test('上限按 kind 分开算：专辑 100、单曲 500；单曲记录不占专辑名额', async () => {
  assert.equal(MU.MUSIC_LIMITS.albums, 100);
  assert.equal(MU.MUSIC_LIMITS.singles, 500);
  const db = makeD1();
  await MU.ensureMusicSchema(db);
  const ins = db.raw.prepare("INSERT INTO music_albums (title, kind) VALUES (?, ?)");
  for (let i = 0; i < 99; i++) ins.run('a' + i, 'album');
  for (let i = 0; i < 5; i++) ins.run('s' + i, 'single');
  const ok = await MU.applyMusicOp(db, MU.parseMusicOp({ op: 'album.add', title: '第 100 张' }));
  assert.ok(!('error' in ok), JSON.stringify(ok));
  assert.deepEqual(await MU.applyMusicOp(db, MU.parseMusicOp({ op: 'album.add', title: '第 101 张' })), { error: 'limit' });
});

/* ================= 单曲 / 专辑分类（音乐 v1.13 ②；Gray 2026-11-14 17:33 定） ================= */

test('单曲：album.add 收 kind（缺省 album、别的值 bad-kind）；listAlbums 每条带 kind；上限按 kind 走（单曲 500 满了 409 limit）', async () => {
  assert.deepEqual(MU.parseMusicOp({ op: 'album.add', title: 'A' }).fields.kind, 'album');
  assert.deepEqual(MU.parseMusicOp({ op: 'album.add', title: 'A', kind: 'single' }).fields.kind, 'single');
  assert.deepEqual(MU.parseMusicOp({ op: 'album.add', title: 'A', kind: 'ep' }), { error: 'bad-kind' });
  const e = makeEnv();
  const a = await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'album.add', title: 'Blue', artist: 'Joni Mitchell' } });
  assert.equal(a.status, 200);
  const s = await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'album.add', title: 'Both Sides Now', artist: 'Joni Mitchell', kind: 'single' } });
  assert.equal(s.status, 200);
  const sj = await s.json();
  assert.deepEqual(sj.albums.map((x) => [x.title, x.kind]), [['Blue', 'album'], ['Both Sides Now', 'single']]);
  assert.equal((await call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'album.add', title: 'x', kind: 'ep' } })).status, 400);
  const list = await (await call(e, '/curio/api/music', { who: null })).json();
  assert.deepEqual(list.albums.map((x) => x.kind), ['album', 'single'], '访客的歌单也带 kind');
  assert.equal(e.db.raw.prepare('SELECT kind FROM music_albums WHERE id = ?').get(sj.id).kind, 'single');
  /* 单曲上限 500，专辑 100：各算各的 */
  const db = makeD1();
  await MU.ensureMusicSchema(db);
  const ins = db.raw.prepare('INSERT INTO music_albums (title, kind) VALUES (?, ?)');
  for (let i = 0; i < 100; i++) ins.run('a' + i, 'album');
  for (let i = 0; i < 499; i++) ins.run('s' + i, 'single');
  assert.deepEqual(await MU.applyMusicOp(db, MU.parseMusicOp({ op: 'album.add', title: '专辑满了' })), { error: 'limit' });
  const ok = await MU.applyMusicOp(db, MU.parseMusicOp({ op: 'album.add', title: '第 500 首', kind: 'single' }));
  assert.ok(ok.id, '专辑满了不挡单曲');
  assert.deepEqual(await MU.applyMusicOp(db, MU.parseMusicOp({ op: 'album.add', title: '第 501 首', kind: 'single' })), { error: 'limit' });
});

test('单曲：只能有 1 首，第 2 首 409 single-full（不写 R2）；专辑照旧多首；封面不受影响', async () => {
  const e = makeEnv();
  const sid = await album(e, { kind: 'single', title: 'River' });
  const r1 = await upTrack(e, sid, 'no=1&title=River&duration=240');
  assert.equal(r1.status, 200);
  const keys = e.r2m.m.size;
  const r2 = await upTrack(e, sid, 'no=2&title=Again&duration=10');
  assert.equal(r2.status, 409);
  assert.deepEqual(await r2.json(), { ok: false, error: 'single-full' });
  assert.equal(e.r2m.m.size, keys, '被拒的那首没写进 R2');
  assert.equal((await call(e, `/curio/api/music-upload?album=${sid}&kind=cover`, { who: 'owner', method: 'POST', body: WEBP, type: 'image/webp' })).status, 200);
  const aid = await album(e);
  assert.equal((await upTrack(e, aid, 'no=1&title=a')).status, 200);
  assert.equal((await upTrack(e, aid, 'no=2&title=b')).status, 200);
  const list = await (await call(e, '/curio/api/music', { who: 'owner' })).json();
  assert.deepEqual(list.albums.map((x) => [x.kind, x.tracks.length]), [['single', 1], ['album', 2]]);
});

test('album.edit 改 kind：专辑 ≤1 首才能转单曲（否则 409 single-tracks）；单曲转专辑直接转；两个方向都按目标上限（超限 409 limit）；坏值 bad-kind', async () => {
  assert.deepEqual(MU.parseMusicOp({ op: 'album.edit', id: 1, kind: 'x' }), { error: 'bad-kind' });
  assert.deepEqual(MU.parseMusicOp({ op: 'album.edit', id: 1, kind: 'single' }), { op: 'album.edit', id: 1, fields: { kind: 'single' } });
  const e = makeEnv();
  const edit = (body) => call(e, '/curio/api/music', { who: 'owner', method: 'POST', body: { op: 'album.edit', ...body } });
  const kindOf = (id) => e.db.raw.prepare('SELECT kind FROM music_albums WHERE id = ?').get(id).kind;
  /* 空专辑、1 首的专辑 → 单曲可以 */
  const a0 = await album(e, { title: 'Empty' });
  assert.equal((await edit({ id: a0, kind: 'single' })).status, 200);
  assert.equal(kindOf(a0), 'single');
  const a1 = await album(e, { title: 'One' });
  await upTrack(e, a1, 'no=1&title=x');
  const r = await edit({ id: a1, kind: 'single', title: 'One (single)' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).albums.find((x) => x.id === a1).kind, 'single');
  assert.equal(e.db.raw.prepare('SELECT title FROM music_albums WHERE id = ?').get(a1).title, 'One (single)', '同时改别的字段照常');
  /* 2 首的专辑 → 单曲 409 single-tracks，没改 */
  const a2 = await album(e, { title: 'Two' });
  await upTrack(e, a2, 'no=1&title=x');
  await upTrack(e, a2, 'no=2&title=y');
  const bad = await edit({ id: a2, kind: 'single' });
  assert.equal(bad.status, 409);
  assert.equal((await bad.json()).error, 'single-tracks');
  assert.equal(kindOf(a2), 'album');
  /* 单曲 → 专辑直接转；转了以后能再传第 2 首 */
  assert.equal((await edit({ id: a1, kind: 'album' })).status, 200);
  assert.equal(kindOf(a1), 'album');
  assert.equal((await upTrack(e, a1, 'no=2&title=z')).status, 200);
  /* 一样的 kind 当没改；不在 404 */
  assert.equal((await edit({ id: a2, kind: 'album' })).status, 200);
  assert.equal((await edit({ id: 999, kind: 'album' })).status, 404);
  /* 按目标上限：专辑满 100 时单曲转不了专辑；单曲满 500 时专辑转不了单曲 */
  const db = makeD1();
  await MU.ensureMusicSchema(db);
  const ins = db.raw.prepare('INSERT INTO music_albums (title, kind) VALUES (?, ?)');
  for (let i = 0; i < 100; i++) ins.run('a' + i, 'album');
  for (let i = 0; i < 500; i++) ins.run('s' + i, 'single');
  const sId = Number(db.raw.prepare("SELECT id FROM music_albums WHERE kind = 'single' LIMIT 1").get().id);
  const aId = Number(db.raw.prepare("SELECT id FROM music_albums WHERE kind = 'album' LIMIT 1").get().id);
  assert.deepEqual(await MU.applyMusicOp(db, MU.parseMusicOp({ op: 'album.edit', id: sId, kind: 'album' })), { error: 'limit' });
  assert.deepEqual(await MU.applyMusicOp(db, MU.parseMusicOp({ op: 'album.edit', id: aId, kind: 'single' })), { error: 'limit' });
  db.raw.prepare('DELETE FROM music_albums WHERE id = ?').run(aId);
  assert.deepEqual(await MU.applyMusicOp(db, MU.parseMusicOp({ op: 'album.edit', id: sId, kind: 'album' })), { removed: [] }, '专辑有空位就能转');
});

test('单曲进索引 / AI 读接口带 kind：索引副标题标「单曲」/ Single；reader 每条带 kind', async () => {
  const e = makeEnv();
  const sid = await album(e, { kind: 'single', title: 'Big Yellow Taxi' });
  await upTrack(e, sid, 'no=1&title=' + encodeURIComponent('Big Yellow Taxi') + '&duration=135');
  const aid = await album(e);
  const ix = await SI.buildIndex(e.db);
  assert.equal(ix.items.find((it) => it.id === 'album:' + sid).subtitle, '音乐 · 单曲 · Joni Mitchell · 1971');
  assert.equal(ix.items.find((it) => it.id === 'album:' + sid + ':en').subtitle, 'Music · Single · Joni Mitchell · 1971');
  assert.equal(ix.items.find((it) => it.id === 'album:' + aid).subtitle, '音乐 · Joni Mitchell · 1971', '专辑照旧');
  const RD = await import(W + '/src/reader.js');
  const r = await RD.runQuery({ D1_MUSIC: e.db }, 'music', { q: 'joni mitchell 的单曲' });
  assert.deepEqual(r.albums.map((a) => [a.title, a.kind]), [['Big Yellow Taxi', 'single'], ['Blue', 'album']]);
});
