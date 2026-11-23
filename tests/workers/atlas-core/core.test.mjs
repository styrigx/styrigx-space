// styrigx-atlas-core（workers/atlas-core，Atlas 后端合并 PR1，2026-11-14）：
// - 旧 workers/curio-core、workers/daymark-core 2026-11-14 下线后删目录；两边业务用例迁到本目录 curio*.test.mjs / daymark*.test.mjs
// - 分流：/curio/api/* 交奇趣、/daymark/api/* 交日刻、其他 404；两边真跑在同一个 SQLite 库上（同一个 D1）
// - 迁移 0001_curio + 0002_daymark，再跑奇趣重组 PR 3 的手动 SQL docs/ops/2026-11-23-drop-devices-movies.sql（删 devices、movies），
//   结构 = 代码里的建表语句（SCHEMA / ITEM_SCHEMA / MUSIC_SCHEMA、日刻 SCHEMA），不含种子数据；那份 SQL 不在 migrations/ 里（deploy.yml 会自动跑 migrations/）
// - HourlyJob：先奇趣后日刻，一边失败不拖另一边
// - wrangler.toml：挂 /curio/api/*、/daymark/api/*，不开 workers.dev、无 Cron；绑定名沿用旧两个 Worker 的，D1 / R2 各只一个
// 运行：node --test tests/workers/atlas-core/*.test.mjs（CI 用 Node 22，node:sqlite）
import '../account/_cf-workers.mjs'; /* cloudflare:workers 替身：日刻 index.js 再导出 HourlyJob、rpc/* 用 WorkerEntrypoint */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { whoAuth } from '../_v6who.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const A = REPO + '/workers/atlas-core';
const app = await import(A + '/src/app.js');
const worker = app.default;
const { HourlyJob } = await import(A + '/src/rpc/hourly-job.js');
const DR = await import(A + '/src/rpc/daymark-reader.js');

/** 按迁移文件建库，返回 { 表名: 建表语句 }（只看表和索引，去掉 sqlite 内部表） */
function schemaOf(files) {
  const db = new DatabaseSync(':memory:');
  for (const f of files) db.exec(readFileSync(f, 'utf8'));
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  return Object.fromEntries(rows.map((r) => [r.type + ' ' + r.name, String(r.sql).replace(/\s+/g, ' ').replace(/IF NOT EXISTS /g, '').replace(/\( /g, '(').replace(/ (?=[),])/g, '')]));
}
const mig = (w) => readdirSync(REPO + '/workers/' + w + '/migrations').filter((n) => n.endsWith('.sql')).sort().map((n) => REPO + '/workers/' + w + '/migrations/' + n);

/* 奇趣重组 PR 3：删设备、电影两张表的 SQL（手动执行，Gray 批了才跑；见文件注释） */
const DROP_SQL = REPO + '/docs/ops/2026-11-23-drop-devices-movies.sql';

test('迁移：只有 0001_curio + 0002_daymark；再跑 docs/ops 删表 SQL 后结构 = 代码里的建表语句（不含种子）', async () => {
  const atlas = mig('atlas-core');
  assert.deepEqual(atlas.map((f) => path.basename(f)), ['0001_curio.sql', '0002_daymark.sql']);
  for (const f of atlas) assert.doesNotMatch(readFileSync(f, 'utf8'), /\bDROP\s+TABLE\b/i, path.basename(f) + '：删表不放 migrations/');
  const C = A + '/src/curio/api/';
  const code = [
    ...(await import(C + '_store.js')).SCHEMA, ...(await import(C + '_items.js')).ITEM_SCHEMA,
    ...(await import(C + '_music.js')).MUSIC_SCHEMA,
    ...(await import(A + '/src/daymark/api/_quotes.js')).SCHEMA,
  ];
  const db = new DatabaseSync(':memory:');
  for (const s of code) db.exec(s);
  const fromCode = Object.fromEntries(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .map((r) => [r.type + ' ' + r.name, String(r.sql).replace(/\s+/g, ' ').replace(/IF NOT EXISTS /g, '').replace(/\( /g, '(').replace(/ (?=[),])/g, '')]));
  assert.deepEqual(schemaOf([...atlas, DROP_SQL]), fromCode);
  /* 删表 SQL 只做三件事：DROP devices、DROP movies、games.device_id 清零（列留着） */
  const drop = readFileSync(DROP_SQL, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
  assert.deepEqual(drop, ['DROP TABLE IF EXISTS devices;', 'DROP TABLE IF EXISTS movies;', 'UPDATE games SET device_id = 0;']);
  assert.ok('table games' in fromCode && /device_id/.test(fromCode['table games']), 'games.device_id 列留着');
  for (const t of ['table devices', 'table movies']) assert.equal(t in fromCode, false, t);
  /* 只有结构：新库建出来是空的，数据 2026-11-14 从旧库拷入 */
  for (const f of atlas) assert.doesNotMatch(readFileSync(f, 'utf8'), /\bINSERT\b/i, path.basename(f));
});

/** node:sqlite 包成 D1 的样子（同 daymark.test.mjs） */
function makeD1(db) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) || null,
    raw: async () => db.prepare(sql).all(...args).map((r) => Object.values(r)),
    _exec: () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql) => stmt(sql),
    exec: async (sql) => { db.exec(sql); return { count: 1 }; },
    batch: async (list) => {
      db.exec('BEGIN');
      try { const out = list.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

/** Atlas 的 env：所有 D1 绑定名指同一个库（线上同一个 D1 styrigx-atlas-core） */
function atlasEnv(who = null) {
  const db = new DatabaseSync(':memory:');
  for (const f of mig('atlas-core')) db.exec(readFileSync(f, 'utf8'));
  const d1 = makeD1(db);
  const kv = new Map();
  return {
    db,
    env: {
      SPACE: whoAuth(who),
      D1_FINDS: d1, D1_GAMES: d1, D1_MUSIC: d1, D1_QUOTES: d1,
      R2_PHOTOS: { async get() { return null; }, async put() {}, async delete() {}, async list() { return { objects: [], truncated: false }; } },
      R2_MUSIC: { async get() { return null; }, async put() {}, async delete() {}, async list() { return { objects: [], truncated: false }; } },
      KV_SEARCH_INDEX: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); } },
    },
    kv,
  };
}
const CTX = { waitUntil() {} };
const req = (p, init = {}) => new Request('https://styrigx.com' + p, init);

test('分流：前缀定产品；奇趣、日刻读在同一个库上照常工作，运行标记各自不变，另加 X-Atlas-Runtime', async () => {
  assert.equal(app.productOf('/curio/api/links'), 'curio');
  assert.equal(app.productOf('/daymark/api/today'), 'daymark');
  assert.equal(app.productOf('/music/api/music'), 'music');
  assert.equal(app.productOf('/games/api/games'), 'games', '奇趣重组 PR 1');
  for (const p of ['/', '/curio', '/curio/api', '/daymark/x', '/blog/api/x', '/atlas/api/x']) assert.equal(app.productOf(p), '', p);

  const { env } = atlasEnv();
  const c = await worker.fetch(req('/curio/api/links'), env, CTX);
  assert.equal(c.status, 200);
  assert.equal(c.headers.get('X-Curio-Runtime'), 'worker');
  assert.equal(c.headers.get('X-Atlas-Runtime'), 'worker', '切换后外部靠这个头认出走了 atlas-core');
  for (const p of ['/daymark/api/quotes', '/daymark/api/collections', '/daymark/api/days']) {
    const d = await worker.fetch(req(p), env, CTX);
    assert.equal(d.status, 200, p);
    assert.equal(d.headers.get('X-Daymark-Runtime'), 'worker', p);
    assert.equal(d.headers.get('X-Atlas-Runtime'), 'worker', p);
  }
  const m = await worker.fetch(req('/music/api/music'), env, CTX);
  assert.equal(m.status, 200);
  const g = await worker.fetch(req('/games/api/games'), env, CTX);
  assert.equal(g.status, 200, '奇趣重组 PR 1：/games/api/games 交给 curio/app.js');
  assert.equal(g.headers.get('X-Atlas-Runtime'), 'worker');
  assert.deepEqual(Object.keys(await g.json()).sort(), ['canManage', 'games', 'ok', 'showPrivate'], '只回游戏，不回设备');
});

test('分流：不是两个产品的路径 404，带 Atlas 运行标记和安全头，不问网关', async () => {
  let asked = 0;
  const env = { SPACE: { async admit() { asked++; return null; } } };
  for (const p of ['/', '/api/links', '/blog/api/x', '/curio/links', '/daymark']) {
    const r = await worker.fetch(req(p), env, CTX);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get('X-Atlas-Runtime'), 'worker');
    assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(r.headers.get('Strict-Transport-Security'), 'max-age=31536000');
    assert.equal((await r.json()).error, 'not-found');
  }
  assert.equal(asked, 0);
});

test('分流：守卫照旧——写接口访客 401（奇趣、日刻都一样）', async () => {
  const { env } = atlasEnv();
  for (const p of ['/curio/api/links', '/daymark/api/quotes']) {
    const r = await worker.fetch(req(p, { method: 'POST', headers: { Origin: 'https://styrigx.com', 'Content-Type': 'application/json' }, body: '{}' }), env, CTX);
    assert.equal(r.status, 401, p);
  }
});

test('HourlyJob：一轮写两个产品的搜索索引；一边失败另一边照跑', async () => {
  const { env, kv } = atlasEnv();
  const r = await new HourlyJob({}, env).run(Date.UTC(2026, 10, 14, 3));
  assert.deepEqual(r, { ok: true, curio: true, daymark: true });
  const keys = [...kv.keys()];
  assert.ok(keys.some((k) => k.includes('curio')), keys.join());
  assert.ok(keys.some((k) => k.includes('daymark')), keys.join());

  const bad = atlasEnv();
  const broken = { prepare() { throw new Error('boom'); } };
  bad.env.D1_FINDS = broken; bad.env.D1_GAMES = broken; bad.env.D1_MUSIC = broken;
  const r2 = await new HourlyJob({}, bad.env).run(Date.UTC(2026, 10, 14, 3));
  assert.equal(r2.daymark, true);
  assert.ok([...bad.kv.keys()].some((k) => k.includes('daymark')));
});

test('入口：index.js 只接线，导出 default / CurioReader / DaymarkReader / HourlyJob', () => {
  const src = readFileSync(A + '/src/index.js', 'utf8').split('\n').filter((l) => l.startsWith('export')).sort();
  assert.deepEqual(src, [
    "export { CurioReader } from './curio/rpc/reader.js';",
    "export { DaymarkReader } from './rpc/daymark-reader.js';",
    "export { HourlyJob } from './rpc/hourly-job.js';",
    "export { default } from './app.js';",
  ]);
});

/** wrangler.toml 里某类块的 binding = 值 */
function bindings(toml, block) {
  const out = [];
  for (const part of toml.split(/\n(?=\[)/)) {
    if (!part.startsWith('[[' + block + ']]')) continue;
    const kv = Object.fromEntries([...part.matchAll(/^(\w+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1], m[2]]));
    out.push(kv);
  }
  return out;
}

test('wrangler.toml：挂 /curio/api/*、/daymark/api/*、/music/api/*（music 搬家第 2 步）、/games/api/*（奇趣重组 PR 1）四条路由 / 不开 workers.dev / 无 Cron；绑定名沿用旧两个 Worker 的，D1、R2 各一个叫 styrigx-atlas-core', () => {
  const t = readFileSync(A + '/wrangler.toml', 'utf8');
  assert.match(t, /^name = "styrigx-atlas-core"$/m);
  assert.match(t, /^main = "src\/index.js"$/m);
  assert.match(t, /^workers_dev = false$/m);
  assert.match(t, /^preview_urls = false$/m);
  assert.deepEqual([...t.matchAll(/^pattern = "([^"]+)"$/gm)].map((m) => m[1]), ['styrigx.com/curio/api/*', 'styrigx.com/daymark/api/*', 'styrigx.com/music/api/*', 'styrigx.com/games/api/*']);
  assert.equal([...t.matchAll(/^zone_name = "styrigx\.com"$/gm)].length, 4);
  assert.match(t, /^crons = \[\]$/m);

  /* 绑定名沿用旧两个 Worker 的（业务代码按这些名字取） */
  const want = {
    d1_databases: ['D1_FINDS', 'D1_GAMES', 'D1_MUSIC', 'D1_QUOTES'], /* D1_DEVICES、D1_MOVIES 奇趣重组 PR 3 删 */
    r2_buckets: ['R2_MUSIC', 'R2_PHOTOS'], services: ['SPACE'], kv_namespaces: ['KV_SEARCH_INDEX'],
  };
  for (const [block, names] of Object.entries(want)) assert.deepEqual(bindings(t, block).map((b) => b.binding).sort(), names, block);
  assert.equal(bindings(t, 'd1_databases').filter((b) => b.migrations_dir).length, 1, 'migrations_dir 只配一次');
  assert.deepEqual([...new Set(bindings(t, 'd1_databases').map((b) => b.database_name))], ['styrigx-atlas-core']);
  assert.equal(new Set(bindings(t, 'd1_databases').map((b) => b.database_id)).size, 1);
  assert.deepEqual([...new Set(bindings(t, 'r2_buckets').map((b) => b.bucket_name))], ['styrigx-atlas-core']);
  assert.deepEqual(bindings(t, 'services'), [{ binding: 'SPACE', service: 'styrigx-space-core', entrypoint: 'SpaceVerifier' }]);
  assert.equal(bindings(t, 'kv_namespaces')[0].id, '4bcdb84f205541b9b6c8d230bc2b106f', '全站搜索索引 KV（styrigx-space-core），ai 读的同一个');
  assert.doesNotMatch(t, /secret|api_key|token/i, '不持钥匙');
});

test('DaymarkReader.today（R-35，给 styrigx-ai）：和 GET /daymark/api/today 同一句；只出公开句子，不带 note / 可见性；没绑库 → ok:false 不抛', async () => {
  const { db, env } = atlasEnv();
  let r = await DR.todayPick(env);
  assert.equal(r.ok, true);
  assert.equal(r.quote, null, '一句都没有 → null');
  db.exec("INSERT INTO quotes (id, text, trans, author, source, visibility, note) VALUES ('q1', '公开一句', 'one', '甲', '书', 'public', '秘密笔记'), ('q2', '私密一句', '', '', '', 'private', 'n')");
  r = await DR.todayPick(env);
  assert.equal(r.ok, true);
  assert.match(r.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.quote.id, 'q1');
  assert.equal(r.quote.text, '公开一句');
  assert.equal('note' in r.quote, false);
  assert.equal('visibility' in r.quote, false);
  const g = await (await worker.fetch(req('/daymark/api/today'), env, CTX)).json();
  assert.equal(g.quote.id, r.quote.id, '同 GET 接口锁住的那句');
  assert.deepEqual(await DR.todayPick({}), { ok: false, error: 'db-binding-missing' });
  assert.equal(typeof DR.DaymarkReader, 'function');
});
