/**
 * 站点监测 styrigx-status（workers/status）：单次检查、连续失败开故障 / 恢复关故障、写库、汇总、入口。
 * 运行：node --test tests/workers/status/status.test.mjs
 *
 * 真 SQL 用 node:sqlite 跑（Node 22+；没有就跳过那几条，纯逻辑照测）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { checkOne, plan, dayOf, runOnce, summary, loadPrev, persist, aggregate, rollup, parseMinute } from '../../../workers/status/src/monitor.js';
import { TARGETS, FAIL_THRESHOLD, TIMEOUT_MS } from '../../../workers/status/src/targets.js';
import worker from '../../../workers/status/src/index.js';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch {}
/* 表结构 = migrations/0001_baseline.sql + 0002_status_minute.sql + 0003_drop_status_checks.sql（D-2 C；库 styrigx-status，表名带 status_） */
const BASELINE = readFileSync(new URL('../../../workers/status/migrations/0001_baseline.sql', import.meta.url), 'utf8');
const DROP_CHECKS = readFileSync(new URL('../../../workers/status/migrations/0003_drop_status_checks.sql', import.meta.url), 'utf8');
const SCHEMA = BASELINE + '\n' + readFileSync(new URL('../../../workers/status/migrations/0002_status_minute.sql', import.meta.url), 'utf8') + '\n' + DROP_CHECKS;

/** 用 node:sqlite 模拟 D1（prepare / bind / batch / first / all / run） */
function d1() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const mk = (sql, args = []) => ({
    sql, args,
    bind: (...a) => mk(sql, a),
    _exec() {
      const s = db.prepare(sql);
      if (/^\s*select/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { results: s.all(...args) };
      s.run(...args);
      return { results: [] };
    },
    async all() { return this._exec(); },
    async first() { return (this._exec().results || [])[0] || null; },
    async run() { return this._exec(); },
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

/** 假服务绑定：AI_SERVICE 的 /healthz 一律 200（真 SQL 那几条只关心公开地址） */
const okSvc = () => ({ fetch: async () => new Response('{"ok":true}', { status: 200 }) });
const pingSvc = () => ({ ping: async () => ({ ok: true }) });
const SVC = { AI_SERVICE: okSvc(), JOB_ATLAS: pingSvc(), JOB_ACCOUNT: pingSvc() };

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

test('地址：2 个公开（主站首页 + 规则集 healthz）+ 1 个服务绑定（P4-2 起 ai 的 /healthz，取代 search / chat），没有 book / muse-invite；旧图志那项 P4-3 PR-1 删除', () => {
  assert.deepEqual(TARGETS.map((t) => t.site), ['space', 'proxy', 'ai', 'atlas', 'account']);
  assert.deepEqual(TARGETS.filter((t) => t.binding).map((t) => [t.site, t.binding, new URL(t.url).pathname]),
    [['ai', 'AI_SERVICE', '/healthz']]);
  /* P4 R-07：atlas-core、account 走现有命名入口绑定的 ping()，不加绑定 */
  assert.deepEqual(TARGETS.filter((t) => t.rpc).map((t) => [t.site, t.rpc]), [['atlas', 'JOB_ATLAS'], ['account', 'JOB_ACCOUNT']]);
  /* 公开地址都是 styrigx.com 的；服务绑定的主机名不是公网域名（只给绑定用） */
  for (const t of TARGETS.filter((x) => !x.rpc)) assert.equal(/styrigx\.com$/.test(new URL(t.url).host), !t.binding, t.site);
  assert.ok(!TARGETS.some((t) => /book|muse-invite|blog\.|curio\.|daymark\./.test(t.url)));
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
  /* D-2 C：一轮全部结果一行；state 只在变化时写 */
  assert.deepEqual(plan(new Map(), r(false), 1).minute, { at: 1, data: [{ s: 'blog', ok: 0, code: 502, ms: 50, err: 'status' }] });
  assert.equal(plan(new Map([['blog', { fails: 0, open: null, firstFailAt: 0 }]]), r(true), 9).state.length, 0);
});

test('真 SQL：连续 3 分钟 502 开故障，第 4 分钟恢复关上；每日汇总累加；7 天前的记录整点清掉', { skip: !sqlite && '需要 node:sqlite' }, async () => {
  const db = d1();
  const env = { D1_UPTIME_MONITOR: db, D1_CLOUDFLARE_USAGE: db, ...SVC };
  const M = 60000;
  const t0 = Date.UTC(2026, 9, 22, 4, 1); // 北京 12:01
  /* 先塞一条 8 天前的旧记录（status_checks 已由 0003 删表） */
  db.raw.prepare('INSERT INTO status_minute (at, data) VALUES (?, ?)').run(t0 - 8 * 24 * 60 * M, '[]');
  await runOnce(env, t0, fakeFetch({}));
  for (let i = 1; i <= 3; i++) await runOnce(env, t0 + i * M, fakeFetch({ 'https://proxy.styrigx.com/healthz': 502 }));
  let inc = db.raw.prepare('SELECT * FROM status_incidents').all();
  assert.equal(inc.length, 1);
  assert.deepEqual([inc[0].site, inc[0].started_at, inc[0].ended_at, inc[0].cause], ['proxy', t0 + M, null, 'HTTP 502']);
  const prev = await loadPrev(db);
  assert.equal(prev.get('proxy').fails, 3);
  assert.equal(prev.get('proxy').open.id, inc[0].id);
  await runOnce(env, t0 + 4 * M, fakeFetch({}));
  inc = db.raw.prepare('SELECT * FROM status_incidents').all();
  assert.equal(inc[0].ended_at, t0 + 4 * M);
  /* 每分钟只写 status_minute 一行，不写 checks / hourly / daily */
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM status_minute WHERE at >= ?').get(t0).n, 5);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM status_daily').get().n, 0);
  /* 整点汇总（41 分那轮）：上一个已结束小时进 hourly、daily；旧记录清掉；再跑一次不重复累加 */
  await aggregate(db, Date.UTC(2026, 9, 22, 5, 41));
  await aggregate(db, Date.UTC(2026, 9, 22, 5, 41));
  const day = db.raw.prepare("SELECT * FROM status_daily WHERE site = 'proxy'").all();
  assert.deepEqual([day[0].day, day[0].total, day[0].ok_count], ['2026-10-22', 5, 2]);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM status_minute WHERE at < ?').get(t0).n, 0);
});

test('真 SQL：汇总——当前状态、24 小时 / 30 天可用率、每日、最近检查、故障', { skip: !sqlite && '需要 node:sqlite' }, async () => {
  const db = d1();
  const env = { D1_UPTIME_MONITOR: db, D1_CLOUDFLARE_USAGE: db, ...SVC };
  const M = 60000;
  const t0 = Date.UTC(2026, 9, 22, 4, 1);
  for (let i = 0; i < 4; i++) await runOnce(env, t0 + i * M, fakeFetch(i < 3 ? { 'https://proxy.styrigx.com/healthz': 'network' } : {}));
  const s = await summary(db, t0 + 4 * M);
  assert.equal(s.ok, true);
  assert.equal(s.today, '2026-10-22');
  assert.equal(s.all_up, true);
  assert.deepEqual(s.sites.map((x) => x.site), TARGETS.map((t) => t.site));
  const curio = s.sites.find((x) => x.site === 'proxy');
  assert.equal(curio.up, true);
  assert.equal(curio.uptime.h24, 25);
  /* 还没整点汇总：24 小时格由 status_minute 现算补上；30 天 / 每日要等汇总 */
  assert.equal(curio.uptime.d30, null);
  assert.deepEqual(curio.days, []);
  /* 4 次检查都在同一小时：一格，这小时有失败 → 0 */
  assert.equal(curio.recent.length, 1);
  assert.deepEqual(curio.recent.map((x) => x[1]), [0]);
  assert.deepEqual(curio.last && [curio.last.ok, curio.last.at], [true, t0 + 3 * M]);
  await aggregate(db, Date.UTC(2026, 9, 22, 5, 41));
  const s2 = await summary(db, Date.UTC(2026, 9, 22, 5, 42));
  const c2 = s2.sites.find((x) => x.site === 'proxy');
  assert.equal(c2.uptime.d30, 25);
  assert.equal(c2.recent.length, 1, '汇总后同一小时不重复');
  assert.deepEqual(c2.days.map((d) => [d.day, d.total, d.ok]), [['2026-10-22', 4, 1]]);
  assert.equal(s.incidents.length, 1);
  assert.deepEqual([s.incidents[0].site, s.incidents[0].cause, s.incidents[0].ended_at], ['proxy', 'network', t0 + 3 * M]);
  assert.equal(s.sites.find((x) => x.site === 'space').uptime.h24, 100);
});

test('真 SQL：改名兼容（2026-11-23 proxy-rules → proxy）——旧名历史行并进现名、同一天相加；旧名开着的故障这一轮能关掉；旧 state 行不算', { skip: !sqlite && '需要 node:sqlite' }, async () => {
  const db = d1();
  const M = 60000;
  const t0 = Date.UTC(2026, 9, 22, 4, 1);
  db.raw.prepare("INSERT INTO status_daily (site, day, total, ok_count, ms_sum) VALUES ('proxy-rules', '2026-10-21', 10, 9, 900), ('proxy-rules', '2026-10-22', 4, 4, 400), ('proxy', '2026-10-22', 2, 2, 200)").run();
  db.raw.prepare("INSERT INTO status_state (site, fails, first_fail_at) VALUES ('proxy-rules', 9, 1)").run();
  db.raw.prepare("INSERT INTO status_incidents (site, started_at, cause) VALUES ('proxy-rules', ?, 'HTTP 502')").run(t0 - 10 * M);
  const prev = await loadPrev(db);
  assert.equal(prev.get('proxy').fails, 0, '旧 state 行不并');
  assert.ok(prev.get('proxy').open, '旧名开着的故障并进现名');
  assert.equal(prev.has('proxy-rules'), false);
  const s = await summary(db, t0);
  assert.equal(s.sites.some((x) => x.site === 'proxy-rules'), false);
  const p = s.sites.find((x) => x.site === 'proxy');
  assert.deepEqual(p.days.map((d) => [d.day, d.total, d.ok]), [['2026-10-21', 10, 9], ['2026-10-22', 6, 6]]);
  assert.equal(s.incidents[0].site, 'proxy');
  /* 这一轮检查正常 → 那条旧名故障被关掉 */
  const env = { D1_UPTIME_MONITOR: db, D1_CLOUDFLARE_USAGE: db, ...SVC };
  await runOnce(env, t0, fakeFetch({}));
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM status_incidents WHERE ended_at IS NULL').get().n, 0);
});

test('写库：一个 batch 写完（分钟行、状态变化、开 / 关故障）', async () => {
  const seen = [];
  const db = {
    prepare: (sql) => ({ sql, bind: (...a) => ({ sql, a }) }),
    async batch(list) { seen.push(list); return []; },
  };
  const p = plan(new Map([['blog', { fails: 2, open: null, firstFailAt: 9 }]]),
    [{ site: 'blog', ok: false, code: 0, ms: 10000, err: 'timeout' }], 100);
  await persist(db, p);
  assert.equal(seen.length, 1);
  const sqls = seen[0].map((x) => x.sql.match(/^(INSERT OR REPLACE INTO|INSERT INTO) (\w+)/).slice(1).join(' '));
  assert.deepEqual(sqls, ['INSERT OR REPLACE INTO status_minute', 'INSERT INTO status_state', 'INSERT INTO status_incidents']);
  assert.deepEqual(seen[0][2].a, ['blog', 9, 'timeout']);
  /* 状态里带着这一串第一次失败的时间 */
  assert.deepEqual(seen[0][1].a, ['blog', 3, 9]);
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
  await runOnce({ D1_UPTIME_MONITOR: db, D1_CLOUDFLARE_USAGE: db, ...SVC }, Date.UTC(2026, 9, 23, 4, 1), fakeFetch({}));
  const reads = sqls.filter((q) => /^\s*select/i.test(q));
  assert.ok(reads.length > 0);
  assert.ok(reads.every((q) => !/\bchecks\b/.test(q)), reads.join(' | '));
  sqls.length = 0;
  await summary(db, Date.UTC(2026, 9, 23, 4, 1)).catch(() => {});
  assert.ok(sqls.filter((q) => /^\s*select/i.test(q)).every((q) => !/\bchecks\b/.test(q)));
});

test('真 SQL：第一次失败时间存在 state 里，恢复清零', { skip: !sqlite && '需要 node:sqlite' }, async () => {
  const db = d1();
  const env = { D1_UPTIME_MONITOR: db, D1_CLOUDFLARE_USAGE: db, ...SVC };
  const M = 60000;
  const t0 = Date.UTC(2026, 9, 23, 4, 1);
  const bad = fakeFetch({ 'https://proxy.styrigx.com/healthz': 502 });
  await runOnce(env, t0, bad);
  await runOnce(env, t0 + M, bad);
  assert.equal((await loadPrev(db)).get('proxy').firstFailAt, t0);
  await runOnce(env, t0 + 2 * M, fakeFetch({}));
  assert.equal((await loadPrev(db)).get('proxy').firstFailAt, 0);
  await aggregate(db, Date.UTC(2026, 9, 23, 5, 41));
  const h = db.raw.prepare("SELECT * FROM status_hourly WHERE site = 'proxy'").all();
  assert.deepEqual([h.length, h[0].total, h[0].ok_count], [1, 3, 1]);
});

test('服务绑定：ai 走 env 里的绑定（不走公网 fetch）；绑定 200 正常、503 记 HTTP 503；没绑记 binding', async () => {
  const seen = [];
  const svc = (status) => ({ fetch: async (u, init) => { seen.push([String(u), init.redirect]); return new Response('', { status }); } });
  const db = {
    prepare: (sql) => { const o = { sql, bind: () => o }; return o; },
    async batch(list) { return list.map(() => ({ results: [] })); },
  };
  const pub = [];
  const p = await runOnce({ D1_UPTIME_MONITOR: db, AI_SERVICE: svc(200) }, Date.UTC(2026, 9, 28, 4, 1),
    (u, init) => { pub.push(String(u)); return Promise.resolve(new Response('', { status: 200 })); });
  assert.deepEqual(seen.map((x) => x[0]), ['https://styrigx-ai/healthz']);
  assert.ok(seen.every((x) => x[1] === 'manual'));
  assert.ok(!pub.some((u) => /healthz$/.test(u) && !/proxy\.styrigx\.com/.test(u)), pub.join(' '));
  const by = Object.fromEntries(parseMinute(JSON.stringify(p.minute.data)).map((c) => [c.site, c]));
  assert.deepEqual([by.ai.ok, by.ai.code], [1, 200]);
  const p503 = await runOnce({ D1_UPTIME_MONITOR: db, AI_SERVICE: svc(503) }, Date.UTC(2026, 9, 28, 4, 2), fakeFetch({}));
  const b503 = Object.fromEntries(parseMinute(JSON.stringify(p503.minute.data)).map((c) => [c.site, c]));
  assert.deepEqual([b503.ai.ok, b503.ai.code, b503.ai.err], [0, 503, 'status']);
  const q = await runOnce({ D1_UPTIME_MONITOR: db }, Date.UTC(2026, 9, 28, 4, 3), fakeFetch({}));
  const by2 = Object.fromEntries(parseMinute(JSON.stringify(q.minute.data)).map((c) => [c.site, c]));
  assert.deepEqual([by2.ai.ok, by2.ai.code, by2.ai.err], [0, 0, 'binding']);
  assert.equal(by2.space.ok, 1);
});

test('服务绑定：抛错记 network，不拖垮别的地址', async () => {
  const t = TARGETS.find((x) => x.site === 'ai');
  const r = await checkOne(t, (u, i) => Promise.reject(new TypeError('binding gone')));
  assert.deepEqual([r.ok, r.code, r.err], [false, 0, 'network']);
  assert.deepEqual(await checkOne(t, null).then((x) => [x.ok, x.err, x.ms]), [false, 'binding', 0]);
});

test('wrangler.toml：status 绑了 AI_SERVICE → styrigx-ai，没有 SEARCH / CHAT；deploy.yml 里 status 排在 ai 之后', () => {
  const toml = readFileSync(new URL('../../../workers/status/wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[\[services\]\]\s*binding = "AI_SERVICE"\s*service = "styrigx-ai"/);
  assert.doesNotMatch(toml, /binding = "(SEARCH|CHAT)"|styrigx-search-index|styrigx-chat"/);
  const yml = readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const job = yml.slice(yml.indexOf('\n  deploy-status-worker:'));
  const needs = job.match(/\n    needs: \[([^\]]*)\]/)[1].split(',').map((x) => x.trim());
  assert.ok(needs.includes('deploy-ai-worker') && !needs.some((n) => /search|chat/.test(n)), needs.join(','));
});

test('migrations/0001_baseline：只建表建索引（status_ 前缀），没有种子 / 删表 / 删数据；旧迁移只在 migrations-archive/ 留史', () => {
  const dir = new URL('../../../workers/status/', import.meta.url);
  assert.deepEqual(readdirSync(new URL('migrations/', dir)).sort(), ['0001_baseline.sql', '0002_status_minute.sql', '0003_drop_status_checks.sql']);
  assert.deepEqual(readdirSync(new URL('migrations-archive/', dir)).sort(),
    ['0001_init.sql', '0002_usage.sql', '0003_cut_reads.sql', '0004_quota.sql', '0005_retire_sites.sql']);
  const sql = BASELINE.replace(/--[^\n]*/g, '');
  const stmts = sql.split(';').map((x) => x.trim()).filter(Boolean);
  for (const st of stmts) assert.match(st, /^CREATE (TABLE|INDEX) IF NOT EXISTS status_[a-z_]+ /, st.slice(0, 60));
  assert.doesNotMatch(sql, /\b(INSERT|DELETE|DROP|UPDATE|ALTER)\b/i);
  const names = stmts.map((st) => st.match(/IF NOT EXISTS (\w+)/)[1]).sort();
  assert.deepEqual(names, ['status_checks', 'status_checks_at', 'status_daily', 'status_hourly', 'status_incidents', 'status_incidents_site',
    'status_quota', 'status_state', 'status_usage']);
});

test('不靠代码兜底建表：src/ 里没有 CREATE / DROP；SQL 里用到的表全都在基线里、全带 status_ 前缀（库里还有网关表和短链表）', { skip: !sqlite }, () => {
  const dir = new URL('../../../workers/status/src/', import.meta.url);
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const used = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /\b(CREATE|DROP)\s+(TABLE|INDEX)\b/i, f + '：表只由迁移建，代码不许兜底建（会在新库上悄悄建出空表、掩盖没搬数据）');
    for (const m of src.matchAll(/\b(?:FROM|INTO|UPDATE)\s+([a-z_]+)\b/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 7, [...used].join(','));
  for (const t of used) {
    assert.ok(t.startsWith('status_'), t + ' 没带 status_ 前缀');
    assert.ok(have.has(t), t + ' 不在 migrations/0001_baseline.sql 里');
  }
});

test('migrations/0003：只删 status_checks 及其索引；套完后库里没有 status_checks，src/ 也不再提它', { skip: !sqlite }, () => {
  const stmts = DROP_CHECKS.replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean);
  assert.deepEqual(stmts, ['DROP INDEX IF EXISTS status_checks_at', 'DROP TABLE IF EXISTS status_checks']);
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(SCHEMA);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'status_checks%'").get().n, 0);
  const dir = new URL('../../../workers/status/src/', import.meta.url);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /status_checks/, f);
  }
});
