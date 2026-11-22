// 音乐空记录清理（workers/atlas-core/src/music/janitor.js）：
// - 空 = 0 首、created_at > 0、created_at / updated_at 都早于 24 小时、没有未过期令牌
// - 开关 MUSIC_JANITOR：缺省 / 写错 = report（只报不删）；singles 只删空单曲；all 空单曲 + 空专辑连封面一起删
// - 删的时候 DELETE 再核一遍条件；D1 提交后才删 R2 封面，有人引用的封面不删；每轮最多 20 条
// - 缺音频的曲目只报不删；D1 读不到整轮不删；R2 列不到只少报缺音频
// - 只在清扫时段（UTC 19 点）随每小时任务跑
// 运行：node --test tests/workers/atlas-core/music-janitor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const A = REPO + '/workers/atlas-core/src';
const J = await import(A + '/music/janitor.js');
const M = await import(A + '/curio/api/_music.js');
const worker = (await import(A + '/curio/app.js')).default;

/** D1 形状的假库：run / batch 回 {results, meta: {changes, last_row_id}}；hook(sql) 给失败注入 */
function makeD1(hook = null) {
  const db = new DatabaseSync(':memory:');
  const exec = (sql, args) => {
    if (hook) hook(sql);
    if (/^\s*SELECT/i.test(sql)) return { results: db.prepare(sql).all(...args), meta: { changes: 0 } };
    const r = db.prepare(sql).run(...args);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  const stmt = (sql, args = []) => ({
    sql,
    bind: (...a) => stmt(sql, a),
    run: async () => exec(sql, args),
    all: async () => exec(sql, args),
    first: async () => { if (hook) hook(sql); return db.prepare(sql).get(...args) || null; },
    _exec: () => exec(sql, args),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (l) => {
      db.exec('BEGIN');
      try { const out = l.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
function makeR2(keys) {
  const m = new Set(keys);
  return {
    m, deletes: /** @type {string[]} */ ([]), failList: false, failDelete: false,
    async list({ prefix = '', cursor } = {}) {
      if (this.failList) throw new Error('r2 down');
      const ks = [...m].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = ks.slice(start, start + 2);
      const next = start + page.length;
      return { objects: page.map((key) => ({ key })), truncated: next < ks.length, cursor: String(next) };
    },
    async delete(k) { if (this.failDelete) throw new Error('r2 down'); for (const x of [].concat(k)) { this.deletes.push(x); m.delete(x); } },
  };
}

const NOW = Date.UTC(2026, 10, 22, 19, 41);
const H = 3600e3;
const OLD = NOW - 48 * H;
const FRESH = NOW - 2 * H;

/** 建表 + 种数据：返回各行 id */
async function seed(db) {
  await M.ensureMusicSchema(db);
  const al = (title, kind, created, updated = created, cover = '') =>
    Number(db.raw.prepare('INSERT INTO music_albums (title, kind, created_at, updated_at, cover) VALUES (?, ?, ?, ?, ?)').run(title, kind, created, updated, cover).lastInsertRowid);
  const tr = (album, key, created) =>
    Number(db.raw.prepare('INSERT INTO music_tracks (album_id, no, title, r2_key, created_at) VALUES (?, 1, ?, ?, ?)').run(album, 't', key, created).lastInsertRowid);
  const ids = {
    emptySingle: al('放弃的单曲', 'single', OLD, OLD, 'music/1/cover-1.jpg'),
    emptyAlbum: al('放弃的专辑', 'album', OLD, OLD, 'music/2/cover-2.jpg'),
    freshSingle: al('正在传', 'single', FRESH),
    touchedSingle: al('刚换过封面', 'single', OLD, FRESH),
    unknownAge: al('老数据', 'single', 0, 0),
    fullSingle: al('有歌', 'single', OLD),
    fullAlbum: al('有歌专辑', 'album', OLD),
    playing: al('有人在听', 'single', OLD),
  };
  ids.okTrack = tr(ids.fullSingle, 'music/6/1-1.mp3', OLD);
  ids.lostTrack = tr(ids.fullAlbum, 'music/7/1-1.mp3', OLD);
  ids.noKeyTrack = tr(ids.fullAlbum, '', OLD);
  ids.freshLost = tr(ids.fullAlbum, 'music/7/2-2.mp3', FRESH);
  db.raw.prepare('INSERT INTO music_tokens (token, album_id, expires_at) VALUES (?, ?, ?)').run('live', ids.playing, NOW + 5 * 60e3);
  db.raw.prepare('INSERT INTO music_tokens (token, album_id, expires_at) VALUES (?, ?, ?)').run('dead', ids.emptySingle, NOW - 60e3);
  return ids;
}
const albumIds = (db) => db.raw.prepare('SELECT id FROM music_albums ORDER BY id').all().map((r) => r.id);
const R2_KEYS = ['music/1/cover-1.jpg', 'music/2/cover-2.jpg', 'music/6/1-1.mp3', 'photos/x.webp'];

test('开关：只认 report / singles / all；缺省 / 写错 = report（大小写、空格不论）', () => {
  assert.deepEqual([...J.MODES], ['report', 'singles', 'all']);
  assert.equal(J.janitorMode(undefined), 'report');
  assert.equal(J.janitorMode({}), 'report');
  assert.equal(J.janitorMode({ MUSIC_JANITOR: 'delete' }), 'report');
  assert.equal(J.janitorMode({ MUSIC_JANITOR: ' Singles ' }), 'singles');
  assert.equal(J.janitorMode({ MUSIC_JANITOR: 'all' }), 'all');
  assert.equal(J.janitorMode({ MUSIC_JANITOR: ' ALL ' }), 'all');
  assert.equal(J.janitorMode({ MUSIC_JANITOR: 'albums' }), 'report');
  assert.equal(J.deletable('report', 'single'), false);
  assert.equal(J.deletable('report', 'album'), false);
  assert.equal(J.deletable('singles', 'album'), false);
  assert.equal(J.deletable('singles', 'single'), true);
  assert.equal(J.deletable('all', 'album'), true);
  assert.equal(J.deletable('all', 'single'), true);
  assert.equal(J.deletable('all', 'other'), false);
  assert.equal(J.MIN_AGE_MS, 24 * 3600e3);
});

test('report（缺省）：找出空单曲 / 空专辑 / 年龄不明 / 缺音频，什么都不删', async () => {
  const db = makeD1();
  const ids = await seed(db);
  const r2 = makeR2(R2_KEYS);
  const before = albumIds(db);
  const r = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2 }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'report');
  assert.deepEqual(r.emptySingles, [ids.emptySingle]);
  assert.deepEqual(r.emptyAlbums, [ids.emptyAlbum]);
  assert.deepEqual(r.unknownAge, [ids.unknownAge]);
  assert.deepEqual(r.missingAudio, [ids.lostTrack, ids.noKeyTrack]);
  assert.deepEqual([r.deleted, r.deferred], [[], []]);
  assert.deepEqual(albumIds(db), before);
  assert.equal(r2.deletes.length, 0);
  assert.equal(r2.m.size, R2_KEYS.length);
});

test('singles：只删空单曲 + 它的过期令牌 + 封面；空专辑、正在传、刚改过、年龄不明、有歌、在听的都留着', async () => {
  const db = makeD1();
  const ids = await seed(db);
  const r2 = makeR2(R2_KEYS);
  const r = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'singles' }, NOW);
  assert.deepEqual(r.deleted, [ids.emptySingle]);
  const left = albumIds(db);
  assert.ok(!left.includes(ids.emptySingle));
  for (const k of ['emptyAlbum', 'freshSingle', 'touchedSingle', 'unknownAge', 'fullSingle', 'fullAlbum', 'playing']) assert.ok(left.includes(ids[k]), k);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM music_tokens WHERE album_id = ?').get(ids.emptySingle).n, 0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM music_tokens').get().n, 1);
  assert.deepEqual(r2.deletes, ['music/1/cover-1.jpg']);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM music_tracks').get().n, 4, '曲目（含缺音频的）一首不删');
});

test('all：空单曲 + 空专辑都删，连各自封面和过期令牌；正在传、刚改过、年龄不明、有歌、在听的都留着；再跑幂等', async () => {
  const db = makeD1();
  const ids = await seed(db);
  const r2 = makeR2(R2_KEYS);
  const r = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'all' }, NOW);
  assert.equal(r.mode, 'all');
  assert.deepEqual(r.deleted, [ids.emptySingle, ids.emptyAlbum]);
  assert.deepEqual([r.emptySingles, r.emptyAlbums], [[ids.emptySingle], [ids.emptyAlbum]]);
  const left = albumIds(db);
  assert.ok(!left.includes(ids.emptySingle) && !left.includes(ids.emptyAlbum));
  for (const k of ['freshSingle', 'touchedSingle', 'unknownAge', 'fullSingle', 'fullAlbum', 'playing']) assert.ok(left.includes(ids[k]), k);
  assert.deepEqual(r2.deletes, ['music/1/cover-1.jpg', 'music/2/cover-2.jpg']);
  assert.ok(!r2.m.has('music/2/cover-2.jpg'), '空专辑封面删掉');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM music_tokens').get().n, 1, '只剩在听的那张令牌');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM music_tracks').get().n, 4, '曲目一首不删');
  const again = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'all' }, NOW);
  assert.deepEqual([again.deleted, again.emptySingles, again.emptyAlbums], [[], [], []]);
  assert.equal(r2.deletes.length, 2);
});

test('singles 不碰空专辑：跑两轮空专辑和它的封面都还在；opts.mode 可覆盖成 all', async () => {
  const db = makeD1();
  const ids = await seed(db);
  const r2 = makeR2(R2_KEYS);
  await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'singles' }, NOW);
  const r2nd = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'singles' }, NOW);
  assert.deepEqual([r2nd.deleted, r2nd.emptySingles, r2nd.emptyAlbums], [[], [], [ids.emptyAlbum]]);
  assert.ok(albumIds(db).includes(ids.emptyAlbum));
  assert.ok(r2.m.has('music/2/cover-2.jpg'));
  assert.deepEqual(r2.deletes, ['music/1/cover-1.jpg'], '空专辑的封面不删');
  const ro = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'singles' }, NOW, { mode: 'all' });
  assert.equal(ro.mode, 'all');
  assert.deepEqual(ro.deleted, [ids.emptyAlbum]);
  assert.deepEqual(r2.deletes, ['music/1/cover-1.jpg', 'music/2/cover-2.jpg']);
});

test('report：写错的值也当 report，什么都不删（含空专辑和封面）', async () => {
  const db = makeD1();
  await seed(db);
  const r2 = makeR2(R2_KEYS);
  const before = albumIds(db);
  for (const v of [undefined, 'report', 'delete', 'albums']) {
    const r = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: v }, NOW);
    assert.equal(r.mode, 'report', String(v));
    assert.deepEqual(r.deleted, []);
  }
  assert.deepEqual(albumIds(db), before);
  assert.equal(r2.deletes.length, 0);
});

test('24 小时边界：正好 24 小时算，差 1 毫秒不算', async () => {
  const db = makeD1();
  await M.ensureMusicSchema(db);
  db.raw.prepare("INSERT INTO music_albums (title, kind, created_at, updated_at) VALUES ('a', 'single', ?, ?)").run(NOW - J.MIN_AGE_MS, NOW - J.MIN_AGE_MS);
  db.raw.prepare("INSERT INTO music_albums (title, kind, created_at, updated_at) VALUES ('b', 'single', ?, ?)").run(NOW - J.MIN_AGE_MS + 1, NOW - J.MIN_AGE_MS + 1);
  const r = await J.runMusicJanitor({ D1_MUSIC: db }, NOW, { mode: 'singles' });
  assert.deepEqual(r.deleted, [1]);
  assert.deepEqual(albumIds(db), [2]);
  assert.equal(r.missingAudio, null, '没绑 R2：缺音频不报');
});

test('扫完到删之间有人传了歌：DELETE 再核条件，删 0 行 → skipped，封面不删', async () => {
  const db = makeD1();
  const ids = await seed(db);
  const r2 = makeR2(R2_KEYS);
  let once = false;
  db.prepare = ((orig) => (sql) => {
    if (!once && /^DELETE FROM music_albums/.test(sql)) {
      once = true;
      db.raw.prepare("INSERT INTO music_tracks (album_id, no, title, r2_key, created_at) VALUES (?, 1, 'new', 'music/1/1-9.mp3', ?)").run(ids.emptySingle, NOW);
    }
    return orig(sql);
  })(db.prepare);
  const r = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'singles' }, NOW);
  assert.deepEqual([r.deleted, r.skipped], [[], [ids.emptySingle]]);
  assert.ok(albumIds(db).includes(ids.emptySingle));
  assert.equal(r2.deletes.length, 0);
});

test('封面还被别的记录 / 歌手头像引用：记录删、封面留', async () => {
  const db = makeD1();
  await M.ensureMusicSchema(db);
  db.raw.prepare("INSERT INTO music_albums (title, kind, created_at, updated_at, cover) VALUES ('e', 'single', ?, ?, 'music/9/cover-9.jpg')").run(OLD, OLD);
  db.raw.prepare("INSERT INTO music_albums (title, kind, created_at, updated_at, cover) VALUES ('f', 'album', ?, ?, 'music/9/cover-9.jpg')").run(OLD, OLD);
  db.raw.prepare("INSERT INTO music_tracks (album_id, no, title, r2_key, created_at) VALUES (2, 1, 't', 'music/2/1.mp3', ?)").run(OLD);
  db.raw.prepare("INSERT INTO music_albums (title, kind, created_at, updated_at, cover) VALUES ('g', 'single', ?, ?, 'music/artist/1/avatar-1.jpg')").run(OLD, OLD);
  db.raw.prepare("INSERT INTO music_artists (name, avatar) VALUES ('x', 'music/artist/1/avatar-1.jpg')").run();
  db.raw.prepare("INSERT INTO music_albums (title, kind, created_at, updated_at, cover) VALUES ('h', 'single', ?, ?, 'photos/not-music.jpg')").run(OLD, OLD);
  const r2 = makeR2(['music/9/cover-9.jpg', 'music/2/1.mp3', 'music/artist/1/avatar-1.jpg', 'photos/not-music.jpg']);
  const r = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'singles' }, NOW);
  assert.deepEqual(r.deleted, [1, 3, 4]);
  assert.deepEqual(r2.deletes, [], '被引用的、不在 music/ 下的封面都不删');
});

test('R2 删封面失败：记录照删，只打日志；R2 列不到：缺音频报 null，空记录照常', async () => {
  const db = makeD1();
  const ids = await seed(db);
  const r2 = makeR2(R2_KEYS);
  r2.failDelete = true;
  r2.failList = true;
  const r = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'singles' }, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.deleted, [ids.emptySingle]);
  assert.equal(r.missingAudio, null);
  assert.ok(r2.m.has('music/1/cover-1.jpg'));
});

test('D1 读不到：整轮不删；没绑 D1：unbound', async () => {
  const db = makeD1();
  await seed(db);
  const r2 = makeR2(R2_KEYS);
  const bad = { prepare() { throw new Error('boom'); }, batch() { throw new Error('boom'); } };
  const r = await J.runMusicJanitor({ D1_MUSIC: bad, R2_MUSIC: r2, MUSIC_JANITOR: 'singles' }, NOW);
  assert.deepEqual([r.ok, r.reason, r.deleted], [false, 'db', []]);
  assert.equal(r2.deletes.length, 0);
  const u = await J.runMusicJanitor({ R2_MUSIC: r2, MUSIC_JANITOR: 'singles' }, NOW);
  assert.deepEqual([u.ok, u.reason], [false, 'unbound']);
});

test('删的那句 D1 出错：这条记 failed，其余照删，R2 不动', async () => {
  let n = 0;
  const db = makeD1((sql) => { if (/^DELETE FROM music_albums/.test(sql) && ++n === 1) throw new Error('d1 busy'); });
  const ids = await seed(db);
  const second = Number(db.raw.prepare("INSERT INTO music_albums (title, kind, created_at, updated_at, cover) VALUES ('又一首', 'single', ?, ?, 'music/9/cover-9.jpg')").run(OLD, OLD).lastInsertRowid);
  const r2 = makeR2([...R2_KEYS, 'music/9/cover-9.jpg']);
  const r = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'singles' }, NOW);
  assert.deepEqual([r.failed, r.deleted], [[ids.emptySingle], [second]]);
  assert.ok(albumIds(db).includes(ids.emptySingle));
  assert.deepEqual(r2.deletes, ['music/9/cover-9.jpg']);
});

test('每轮最多删 20 条，多的 deferred 下一轮', async () => {
  const db = makeD1();
  await M.ensureMusicSchema(db);
  for (let i = 0; i < 25; i++) db.raw.prepare("INSERT INTO music_albums (title, kind, created_at, updated_at) VALUES ('e', 'single', ?, ?)").run(OLD, OLD);
  const r = await J.runMusicJanitor({ D1_MUSIC: db, MUSIC_JANITOR: 'singles' }, NOW);
  assert.equal(r.deleted.length, J.MAX_DELETE);
  assert.equal(r.deferred.length, 5);
  assert.equal(albumIds(db).length, 5);
  const again = await J.runMusicJanitor({ D1_MUSIC: db, MUSIC_JANITOR: 'singles' }, NOW);
  assert.deepEqual([again.deleted.length, again.deferred.length, albumIds(db).length], [5, 0, 0]);
});

test('all：空专辑封面被别的专辑 / 歌手头像共用就不删，记录照删；不在 music/ 下的封面不删', async () => {
  const db = makeD1();
  await M.ensureMusicSchema(db);
  const ins = (t, kind, cover) => Number(db.raw.prepare('INSERT INTO music_albums (title, kind, created_at, updated_at, cover) VALUES (?, ?, ?, ?, ?)').run(t, kind, OLD, OLD, cover).lastInsertRowid);
  const a1 = ins('空专辑甲', 'album', 'music/9/cover-9.jpg');
  const a2 = ins('有歌专辑', 'album', 'music/9/cover-9.jpg');
  db.raw.prepare("INSERT INTO music_tracks (album_id, no, title, r2_key, created_at) VALUES (?, 1, 't', 'music/2/1.mp3', ?)").run(a2, OLD);
  const a3 = ins('空专辑乙', 'album', 'music/artist/1/avatar-1.jpg');
  db.raw.prepare("INSERT INTO music_artists (name, avatar) VALUES ('x', 'music/artist/1/avatar-1.jpg')").run();
  const a4 = ins('空专辑丙', 'album', 'photos/not-music.jpg');
  /* 两张空专辑共用一个封面：先删的那张时另一张还引用 → 留；后删的那张时已没人引用 → 删 */
  const a5 = ins('空专辑丁', 'album', 'music/8/cover-8.jpg');
  const a6 = ins('空单曲戊', 'single', 'music/8/cover-8.jpg');
  const r2 = makeR2(['music/9/cover-9.jpg', 'music/2/1.mp3', 'music/artist/1/avatar-1.jpg', 'photos/not-music.jpg', 'music/8/cover-8.jpg']);
  const r = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'all' }, NOW);
  assert.deepEqual(r.deleted, [a1, a3, a4, a5, a6]);
  assert.deepEqual(albumIds(db), [a2]);
  assert.deepEqual(r2.deletes, ['music/8/cover-8.jpg'], '只有最后一个引用也删了的那张封面才删');
  for (const k of ['music/9/cover-9.jpg', 'music/artist/1/avatar-1.jpg', 'photos/not-music.jpg']) assert.ok(r2.m.has(k), k);
});

test('all：删空专辑的 D1 出错 / 删 0 行 → 专辑留着、封面不动，其余照删', async () => {
  let n = 0;
  const db = makeD1((sql) => { if (/^DELETE FROM music_albums/.test(sql) && ++n === 2) throw new Error('d1 busy'); });
  const ids = await seed(db);
  const r2 = makeR2(R2_KEYS);
  const r = await J.runMusicJanitor({ D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'all' }, NOW);
  assert.deepEqual([r.deleted, r.failed], [[ids.emptySingle], [ids.emptyAlbum]]);
  assert.ok(albumIds(db).includes(ids.emptyAlbum));
  assert.ok(r2.m.has('music/2/cover-2.jpg'), 'D1 失败 R2 不删');
  assert.deepEqual(r2.deletes, ['music/1/cover-1.jpg']);
  /* 扫完到删之间空专辑换了封面（updated_at 刷新）：DELETE 再核条件删 0 行 → skipped，封面不删 */
  const db2 = makeD1();
  const ids2 = await seed(db2);
  const r2b = makeR2(R2_KEYS);
  db2.prepare = ((orig) => (sql) => {
    if (/^DELETE FROM music_albums/.test(sql)) db2.raw.prepare('UPDATE music_albums SET updated_at = ? WHERE id = ?').run(NOW, ids2.emptyAlbum);
    return orig(sql);
  })(db2.prepare);
  const rs = await J.runMusicJanitor({ D1_MUSIC: db2, R2_MUSIC: r2b, MUSIC_JANITOR: 'all' }, NOW);
  assert.deepEqual([rs.deleted, rs.skipped], [[ids2.emptySingle], [ids2.emptyAlbum]]);
  assert.ok(r2b.m.has('music/2/cover-2.jpg'));
});

test('all：每轮合计最多 20 条（单曲 + 专辑），多的 deferred', async () => {
  const db = makeD1();
  await M.ensureMusicSchema(db);
  for (let i = 0; i < 26; i++) db.raw.prepare('INSERT INTO music_albums (title, kind, created_at, updated_at) VALUES (?, ?, ?, ?)').run('e', i % 2 ? 'album' : 'single', OLD, OLD);
  const r = await J.runMusicJanitor({ D1_MUSIC: db, MUSIC_JANITOR: 'all' }, NOW);
  assert.equal(r.deleted.length, J.MAX_DELETE);
  assert.equal(r.deferred.length, 6);
  assert.deepEqual(albumIds(db), r.deferred);
  const again = await J.runMusicJanitor({ D1_MUSIC: db, MUSIC_JANITOR: 'all' }, NOW);
  assert.deepEqual([again.deleted.length, again.deferred.length, albumIds(db).length], [6, 0, 0]);
});

test('每小时任务：只有清扫时段（UTC 19 点）跑；开了 singles 才删', async () => {
  const db = makeD1();
  const ids = await seed(db);
  const r2 = makeR2(R2_KEYS);
  const env = { D1_MUSIC: db, R2_MUSIC: r2, MUSIC_JANITOR: 'singles' };
  await worker.scheduled({ scheduledTime: NOW - H }, env, { waitUntil() {} });
  assert.ok(albumIds(db).includes(ids.emptySingle), '18 点那轮不跑');
  await worker.scheduled({ scheduledTime: NOW }, env, { waitUntil() {} });
  assert.ok(!albumIds(db).includes(ids.emptySingle), '19 点那轮跑');
  const db2 = makeD1();
  const ids2 = await seed(db2);
  await worker.scheduled({ scheduledTime: NOW }, { D1_MUSIC: db2, R2_MUSIC: makeR2(R2_KEYS) }, { waitUntil() {} });
  assert.ok(albumIds(db2).includes(ids2.emptySingle), '没开关 = report，不删');
});
