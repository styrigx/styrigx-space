// styrigx-atlas-core（workers/atlas-core，Atlas 后端合并 PR1，2026-11-14）：
// - 平移的两份代码和旧目录逐字一致（旧 Worker 下线前，改业务代码要两边一起改）
// - 分流：/curio/api/* 交奇趣、/daymark/api/* 交日刻、其他 404；两边真跑在同一个 SQLite 库上（同一个 D1）
// - 迁移 0001_curio + 0002_daymark 的结构 = 旧两个库按旧迁移跑完的结构（不含种子数据）
// - HourlyJob：先奇趣后日刻，一边失败不拖另一边
// - wrangler.toml：PR1 不挂路由、不开 workers.dev、无 Cron；绑定名和旧两个 Worker 一字不差，D1 / R2 各只一个
// 运行：node --test tests/workers/atlas-core/*.test.mjs（CI 用 Node 22，node:sqlite）
import '../account/_cf-workers.mjs'; /* cloudflare:workers 替身：日刻 index.js 再导出 HourlyJob、rpc/* 用 WorkerEntrypoint */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { whoAuth } from '../_v6who.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const A = REPO + '/workers/atlas-core';
const app = await import(A + '/src/app.js');
const worker = app.default;
const { HourlyJob } = await import(A + '/src/rpc/hourly-job.js');

/** 目录下所有文件（相对路径） */
function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [path.relative(base, p)];
  }).sort();
}

/* 旧 Worker 里只管接线、在 Atlas 由 src/index.js / src/rpc/hourly-job.js 接手的文件，不平移 */
const NOT_MOVED = { curio: ['index.js', 'rpc/hourly-job.js'], daymark: [] };

for (const [name, old] of [['curio', 'curio-core'], ['daymark', 'daymark-core']]) {
  test(`平移：src/${name}/ 和 workers/${old}/src/ 逐字一致`, () => {
    const from = REPO + '/workers/' + old + '/src';
    const to = A + '/src/' + name;
    assert.deepEqual(walk(to), walk(from).filter((f) => !NOT_MOVED[name].includes(f)));
    for (const f of walk(to)) assert.equal(readFileSync(path.join(to, f), 'utf8'), readFileSync(path.join(from, f), 'utf8'), f);
  });
}

/** 按迁移文件建库，返回 { 表名: 建表语句 }（只看表和索引，去掉 sqlite 内部表） */
function schemaOf(files) {
  const db = new DatabaseSync(':memory:');
  for (const f of files) db.exec(readFileSync(f, 'utf8'));
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  return Object.fromEntries(rows.map((r) => [r.type + ' ' + r.name, String(r.sql).replace(/\s+/g, ' ').replace(/IF NOT EXISTS /g, '')]));
}
const mig = (w) => readdirSync(REPO + '/workers/' + w + '/migrations').filter((n) => n.endsWith('.sql')).sort().map((n) => REPO + '/workers/' + w + '/migrations/' + n);

test('迁移：0001_curio + 0002_daymark 的结构 = 旧两个库的结构（不含种子）', () => {
  const atlas = mig('atlas-core');
  assert.deepEqual(atlas.map((f) => path.basename(f)), ['0001_curio.sql', '0002_daymark.sql']);
  const old = { ...schemaOf(mig('curio-core')), ...schemaOf(mig('daymark-core')) };
  assert.deepEqual(schemaOf(atlas), old);
  /* 只有结构：新库建出来是空的，数据由迁移脚本从旧库拷 */
  for (const f of atlas) assert.doesNotMatch(readFileSync(f, 'utf8'), /\bINSERT\b/i, path.basename(f));
});

/** node:sqlite 包成 D1 的样子（同 tests/workers/daymark-core/core.test.mjs） */
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
      D1_FINDS: d1, D1_DEVICES: d1, D1_GAMES: d1, D1_MOVIES: d1, D1_MUSIC: d1, D1_QUOTES: d1,
      R2_PHOTOS: { async get() { return null; }, async put() {}, async delete() {}, async list() { return { objects: [], truncated: false }; } },
      R2_MUSIC: { async get() { return null; }, async put() {}, async delete() {}, async list() { return { objects: [], truncated: false }; } },
      KV_SEARCH_INDEX: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); } },
    },
    kv,
  };
}
const CTX = { waitUntil() {} };
const req = (p, init = {}) => new Request('https://styrigx.com' + p, init);

test('分流：前缀定产品；奇趣、日刻读在同一个库上照常工作，运行标记各自不变', async () => {
  assert.equal(app.productOf('/curio/api/links'), 'curio');
  assert.equal(app.productOf('/daymark/api/today'), 'daymark');
  for (const p of ['/', '/curio', '/curio/api', '/daymark/x', '/blog/api/x', '/atlas/api/x']) assert.equal(app.productOf(p), '', p);

  const { env } = atlasEnv();
  const c = await worker.fetch(req('/curio/api/links'), env, CTX);
  assert.equal(c.status, 200);
  assert.equal(c.headers.get('X-Curio-Runtime'), 'worker');
  for (const p of ['/daymark/api/quotes', '/daymark/api/collections', '/daymark/api/days']) {
    const d = await worker.fetch(req(p), env, CTX);
    assert.equal(d.status, 200, p);
    assert.equal(d.headers.get('X-Daymark-Runtime'), 'worker', p);
  }
  const m = await worker.fetch(req('/curio/api/music'), env, CTX);
  assert.equal(m.status, 200);
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
  bad.env.D1_FINDS = broken; bad.env.D1_DEVICES = broken; bad.env.D1_GAMES = broken; bad.env.D1_MOVIES = broken; bad.env.D1_MUSIC = broken;
  const r2 = await new HourlyJob({}, bad.env).run(Date.UTC(2026, 10, 14, 3));
  assert.equal(r2.daymark, true);
  assert.ok([...bad.kv.keys()].some((k) => k.includes('daymark')));
});

test('入口：index.js 只接线，导出 default / CurioReader / HourlyJob', () => {
  const src = readFileSync(A + '/src/index.js', 'utf8').split('\n').filter((l) => l.startsWith('export')).sort();
  assert.deepEqual(src, [
    "export { CurioReader } from './curio/rpc/reader.js';",
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

test('wrangler.toml：PR1 不挂路由 / 不开 workers.dev / 无 Cron；绑定名和旧两个 Worker 一致，D1、R2 各一个叫 styrigx-atlas-core', () => {
  const t = readFileSync(A + '/wrangler.toml', 'utf8');
  const curio = readFileSync(REPO + '/workers/curio-core/wrangler.toml', 'utf8');
  const daymark = readFileSync(REPO + '/workers/daymark-core/wrangler.toml', 'utf8');
  assert.match(t, /^name = "styrigx-atlas-core"$/m);
  assert.match(t, /^main = "src\/index.js"$/m);
  assert.match(t, /^workers_dev = false$/m);
  assert.match(t, /^preview_urls = false$/m);
  assert.doesNotMatch(t, /^\[\[routes\]\]/m);
  assert.match(t, /^crons = \[\]$/m);

  for (const block of ['d1_databases', 'r2_buckets', 'services', 'kv_namespaces']) {
    const want = [...bindings(curio, block), ...bindings(daymark, block)].map((b) => b.binding);
    assert.deepEqual(bindings(t, block).map((b) => b.binding).sort(), [...new Set(want)].sort(), block);
  }
  assert.deepEqual([...new Set(bindings(t, 'd1_databases').map((b) => b.database_name))], ['styrigx-atlas-core']);
  assert.equal(new Set(bindings(t, 'd1_databases').map((b) => b.database_id)).size, 1);
  assert.deepEqual([...new Set(bindings(t, 'r2_buckets').map((b) => b.bucket_name))], ['styrigx-atlas-core']);
  assert.deepEqual(bindings(t, 'services'), [{ binding: 'SPACE', service: 'styrigx-space-core', entrypoint: 'SpaceVerifier' }]);
  assert.equal(bindings(t, 'kv_namespaces')[0].id, bindings(curio, 'kv_namespaces')[0].id);
});
