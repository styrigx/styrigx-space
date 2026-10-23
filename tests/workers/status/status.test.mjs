/**
 * 站点监测 styrigx-status（workers/status）：单次检查、连续失败开故障 / 恢复关故障、写库、汇总、入口。
 * 运行：node --test tests/workers/status/status.test.mjs
 *
 * 真 SQL 用 node:sqlite 跑（Node 22+；没有就跳过那几条，纯逻辑照测）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkOne, plan, dayOf, runOnce, summary, loadPrev, persist } from '../../../workers/status/src/monitor.js';
import { TARGETS, FAIL_THRESHOLD, TIMEOUT_MS } from '../../../workers/status/src/targets.js';
import worker from '../../../workers/status/src/index.js';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch {}
const SCHEMA = ['0001_init.sql', '0002_usage.sql', '0003_cut_reads.sql']
  .map((f) => readFileSync(new URL('../../../workers/status/migrations/' + f, import.meta.url), 'utf8')).join('\n');

/** 用 node:sqlite 模拟 D1（prepare / bind / batch / first / all / run） */
function d1() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const mk = (sql, args = []) => ({
    sql, args,
    bind: (...a) => mk(sql, a),
    _exec() {
      const s = db.prepare(sql);
      if (/^\s*select/i.test(sql)) return { results: s.all(...args) };
      s.run(...args);
      return { results: [] };
    },
  });
  return {
    raw: db,
    prepare: (sql) => mk(sql),
    async batch(list) {
      db.exec('BEGIN');
      try { const r = list.map((x) => x._exec()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

/** 假 fetch：按 url 回状态码；'timeout' 一直不回（等 abort）；'network' 直接抛 */
function fakeFetch(map) {
  return (url, init) => new Promise((resolve, reject) => {
    const v = map[url] ?? 200;
    if (v === 'network') return reject(new TypeError('fetch failed'));
    if (v === 'timeout') {
      init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      return;
    }
    resolve(new Response('x', { status: v }));
  });
}

test('地址：5 个（主站首页 + 三个子站 robots.txt + 规则集 healthz），没有 book / muse-invite', () => {
  assert.deepEqual(TARGETS.map((t) => t.site), ['space', 'blog', 'daymark', 'curio', 'proxy-rules']);
  assert.equal(TARGETS.find((t) => t.site === 'blog').url, 'https://blog.styrigx.com/robots.txt');
  assert.ok(!TARGETS.some((t) => /book|muse-invite/.test(t.url)));
  assert.equal(FAIL_THRESHOLD, 3);
  assert.equal(TIMEOUT_MS, 10000);
});

test('北京时间日期：UTC 16:00 已是第二天', () => {
  assert.equal(dayOf(Date.UTC(2026, 9, 22, 15, 59)), '2026-10-22');
  assert.equal(dayOf(Date.UTC(2026, 9, 22, 16, 0)), '2026-10-23');
});

test('单次检查：200 正常；502 / 302 失败记状态码；连不上 network；不跟随跳转', async () => {
  const t = { site: 'x', url: 'https://x/', expect: [200] };
  let seen;
  const ok = await checkOne(t, (u, init) => { seen = init; return Promise.resolve(new Response('', { status: 200 })); });
  assert.deepEqual({ ...ok, ms: 0 }, { site: 'x', ok: true, code: 200, ms: 0, err: null });
  assert.equal(seen.redirect, 'manual');
  assert.deepEqual(await checkOne(t, fakeFetch({ 'https://x/': 502 })).then((r) => [r.ok, r.code, r.err]), [false, 502, 'status']);
  assert.deepEqual(await checkOne(t, fakeFetch({ 'https://x/': 302 })).then((r) => [r.ok, r.code, r.err]), [false, 302, 'status']);
  assert.deepEqual(await checkOne(t, fakeFetch({ 'https://x/': 'network' })).then((r) => [r.ok, r.code, r.err]), [false, 0, 'network']);
});

test('单次检查：10 秒没回应算超时，耗时记 10000', { timeout: 15000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = checkOne({ site: 'x', url: 'https://x/', expect: [200] }, fakeFetch({ 'https://x/': 'timeout' }));
  t.mock.timers.tick(TIMEOUT_MS);
  const r = await p;
  assert.deepEqual([r.ok, r.code, r.ms, r.err], [false, 0, 10000, 'timeout']);
});

test('计划：失败 1、2 次不开故障；第 3 次开，起点是第一次失败；恢复时关', () => {
  const r = (ok) => [{ site: 'blog', ok, code: ok ? 200 : 502, ms: 50, err: ok ? null : 'status' }];
  let prev = new Map([['blog', { fails: 0, open: null, firstFailAt: 0 }]]);
  let p = plan(prev, r(false), 1000);
  assert.equal(p.state[0].fails, 1);
  assert.equal(p.open.length, 0);
  prev = new Map([['blog', { fails: 2, open: null, firstFailAt: 500 }]]);
  p = plan(prev, r(false), 1000);
  assert.deepEqual(p.open, [{ site: 'blog', started_at: 500, cause: 'HTTP 502' }]);
  /* 故障开着时继续失败，不重复开 */
  prev = new Map([['blog', { fails: 5, open: { id: 7 }, firstFailAt: 500 }]]);
  assert.equal(plan(prev, r(false), 2000).open.length, 0);
  p = plan(prev, r(true), 3000);
  assert.deepEqual(p.close, [{ id: 7, ended_at: 3000 }]);
  assert.equal(p.state[0].fails, 0);
  /* 失败不计耗时进日均 */
  assert.equal(plan(new Map(), r(false), 1).daily[0].ms, 0);
});

test('真 SQL：连续 3 分钟 502 开故障，第 4 分钟恢复关上；每日汇总累加；7 天前的记录整点清掉', { skip: !sqlite && '需要 node:sqlite' }, async () => {
  const db = d1();
  const env = { D1_UPTIME_MONITOR: db, D1_CLOUDFLARE_USAGE: db };
  const M = 60000;
  const t0 = Date.UTC(2026, 9, 22, 4, 1); // 北京 12:01
  /* 先塞一条 8 天前的旧记录 */
  db.raw.prepare('INSERT INTO checks (site, at, ok, code, ms) VALUES (?, ?, 1, 200, 10)').run('space', t0 - 8 * 24 * 60 * M);
  await runOnce(env, t0, fakeFetch({}));
  for (let i = 1; i <= 3; i++) await runOnce(env, t0 + i * M, fakeFetch({ 'https://blog.styrigx.com/robots.txt': 502 }));
  let inc = db.raw.prepare('SELECT * FROM incidents').all();
  assert.equal(inc.length, 1);
  assert.deepEqual([inc[0].site, inc[0].started_at, inc[0].ended_at, inc[0].cause], ['blog', t0 + M, null, 'HTTP 502']);
  const prev = await loadPrev(db);
  assert.equal(prev.get('blog').fails, 3);
  assert.equal(prev.get('blog').open.id, inc[0].id);
  await runOnce(env, t0 + 4 * M, fakeFetch({}));
  inc = db.raw.prepare('SELECT * FROM incidents').all();
  assert.equal(inc[0].ended_at, t0 + 4 * M);
  const day = db.raw.prepare("SELECT * FROM daily WHERE site = 'blog'").all();
  assert.deepEqual([day[0].day, day[0].total, day[0].ok_count], ['2026-10-22', 5, 2]);
  /* 不是整点：旧记录还在；整点：清掉 */
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM checks WHERE at < ?').get(t0).n, 1);
  await runOnce(env, Date.UTC(2026, 9, 22, 5, 0), fakeFetch({}));
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM checks WHERE at < ?').get(t0).n, 0);
});

test('真 SQL：汇总——当前状态、24 小时 / 30 天可用率、每日、最近检查、故障', { skip: !sqlite && '需要 node:sqlite' }, async () => {
  const db = d1();
  const env = { D1_UPTIME_MONITOR: db, D1_CLOUDFLARE_USAGE: db };
  const M = 60000;
  const t0 = Date.UTC(2026, 9, 22, 4, 1);
  for (let i = 0; i < 4; i++) await runOnce(env, t0 + i * M, fakeFetch(i < 3 ? { 'https://curio.styrigx.com/robots.txt': 'network' } : {}));
  const s = await summary(db, t0 + 4 * M);
  assert.equal(s.ok, true);
  assert.equal(s.today, '2026-10-22');
  assert.equal(s.all_up, true);
  assert.deepEqual(s.sites.map((x) => x.site), TARGETS.map((t) => t.site));
  const curio = s.sites.find((x) => x.site === 'curio');
  assert.equal(curio.up, true);
  assert.equal(curio.uptime.h24, 25);
  assert.equal(curio.uptime.d30, 25);
  /* 4 次检查都在同一小时：一格，这小时有失败 → 0 */
  assert.equal(curio.recent.length, 1);
  assert.deepEqual(curio.recent.map((x) => x[1]), [0]);
  assert.deepEqual(curio.days.map((d) => [d.day, d.total, d.ok]), [['2026-10-22', 4, 1]]);
  assert.equal(s.incidents.length, 1);
  assert.deepEqual([s.incidents[0].site, s.incidents[0].cause, s.incidents[0].ended_at], ['curio', 'network', t0 + 3 * M]);
  assert.equal(s.sites.find((x) => x.site === 'space').uptime.h24, 100);
});

test('写库：一个 batch 写完（检查、每日、状态、开 / 关故障）', async () => {
  const seen = [];
  const db = {
    prepare: (sql) => ({ sql, bind: (...a) => ({ sql, a }) }),
    async batch(list) { seen.push(list); return []; },
  };
  const p = plan(new Map([['blog', { fails: 2, open: null, firstFailAt: 9 }]]),
    [{ site: 'blog', ok: false, code: 0, ms: 10000, err: 'timeout' }], 100);
  await persist(db, p, { prune: 1 });
  assert.equal(seen.length, 1);
  const sqls = seen[0].map((x) => x.sql.split(' ').slice(0, 3).join(' '));
  assert.deepEqual(sqls, ['INSERT INTO checks', 'INSERT INTO daily', 'INSERT INTO hourly', 'INSERT INTO state', 'INSERT INTO incidents', 'DELETE FROM checks']);
  assert.deepEqual(seen[0][4].a, ['blog', 9, 'timeout']);
  /* 状态里带着这一串第一次失败的时间 */
  assert.equal(seen[0][3].a[2], 9);
});

test('入口：只认 GET /summary；库出错 503；scheduled 交给 waitUntil', async () => {
  assert.equal((await worker.fetch(new Request('https://status/x'), {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://status/summary', { method: 'POST' }), {})).status, 405);
  const bad = { D1_UPTIME_MONITOR: { prepare() { throw new Error('boom'); }, batch() { throw new Error('boom'); } } };
  const r = await worker.fetch(new Request('https://status/summary'), bad);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, error: 'db' });
  let waited = null;
  await worker.scheduled({ scheduledTime: 1 }, bad, { waitUntil: (p) => { waited = p; } });
  assert.ok(waited instanceof Promise);
  await waited; /* 出错只记日志，不抛 */
});

test('读取量：每分钟一轮只读 state 和开着的故障，不读 checks；汇总也不读 checks', async () => {
  const sqls = [];
  const db = {
    prepare: (sql) => { sqls.push(sql); const o = { sql, bind: () => o }; return o; },
    async batch(list) { return list.map(() => ({ results: [] })); },
  };
  await runOnce({ D1_UPTIME_MONITOR: db, D1_CLOUDFLARE_USAGE: db }, Date.UTC(2026, 9, 23, 4, 1), fakeFetch({}));
  const reads = sqls.filter((q) => /^\s*select/i.test(q));
  assert.ok(reads.length > 0);
  assert.ok(reads.every((q) => !/\bchecks\b/.test(q)), reads.join(' | '));
  sqls.length = 0;
  await summary(db, Date.UTC(2026, 9, 23, 4, 1)).catch(() => {});
  assert.ok(sqls.filter((q) => /^\s*select/i.test(q)).every((q) => !/\bchecks\b/.test(q)));
});

test('真 SQL：第一次失败时间存在 state 里，恢复清零', { skip: !sqlite && '需要 node:sqlite' }, async () => {
  const db = d1();
  const env = { D1_UPTIME_MONITOR: db, D1_CLOUDFLARE_USAGE: db };
  const M = 60000;
  const t0 = Date.UTC(2026, 9, 23, 4, 1);
  const bad = fakeFetch({ 'https://blog.styrigx.com/robots.txt': 502 });
  await runOnce(env, t0, bad);
  await runOnce(env, t0 + M, bad);
  assert.equal((await loadPrev(db)).get('blog').firstFailAt, t0);
  await runOnce(env, t0 + 2 * M, fakeFetch({}));
  assert.equal((await loadPrev(db)).get('blog').firstFailAt, 0);
  const h = db.raw.prepare("SELECT * FROM hourly WHERE site = 'blog'").all();
  assert.deepEqual([h.length, h[0].total, h[0].ok_count], [1, 3, 1]);
});
