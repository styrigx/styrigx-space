/**
 * styrigx-status 免费额度（workers/status/src/quota.js，2026-10-27）：mock Cloudflare GraphQL。
 *   额度常量 · 成功（五个数据集）· 部分失败 · 全部失败 · 超时 · 没配 token / 没表 · 5 分钟缓存 · 失败退避 + stale ·
 *   跨 UTC 零点不显示昨天 · GET /summary 带 quota、额度挂了不影响站点数据。
 * 运行：node --test tests/workers/status/quota.test.mjs
 * 真 SQL 用 node:sqlite（Node 22+；没有就跳过用库的那几条）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectQuota, readQuota, quotaWindow, QUOTA_LIMITS, QUOTA_TTL_MS, QUOTA_DEADLINE_MS, R2_CLASS_A, R2_CLASS_B,
  Q_Q_WORKERS, Q_Q_PAGES, Q_Q_KV, Q_Q_D1, Q_Q_R2,
} from '../../../workers/status/src/quota.js';
import { CF_API } from '../../../workers/status/src/usage.js';
import worker from '../../../workers/status/src/index.js';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch {}
const MIGRATIONS = ['0001_init.sql', '0002_usage.sql', '0003_cut_reads.sql', '0004_quota.sql'];
const schema = (files) => files.map((f) => readFileSync(new URL('../../../workers/status/migrations/' + f, import.meta.url), 'utf8')).join('\n');

/** node:sqlite 模拟 D1（prepare / bind / first / run / batch） */
function d1(sql = schema(MIGRATIONS)) {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(sql);
  const mk = (q, args = []) => ({
    bind: (...a) => mk(q, a),
    _exec() {
      const s = db.prepare(q);
      if (/^\s*select/i.test(q)) return { results: s.all(...args) };
      s.run(...args);
      return { results: [] };
    },
    async first() { return db.prepare(q).get(...args) ?? null; },
    async run() { db.prepare(q).run(...args); return { success: true }; },
  });
  return {
    raw: db,
    prepare: (q) => mk(q),
    async batch(list) {
      db.exec('BEGIN');
      try { const r = list.map((x) => x._exec()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

const ACC = 'acc123';
const TOKEN = 'test-token-not-real';
const ENV = { SGX_CF_USAGE_TOKEN: TOKEN, CF_ACCOUNT_ID: ACC };
/* 2026-10-27 01:28 北京时间 = 10-26 17:28Z：UTC 日还是 10-26（北京 08:00 才换） */
const NOW = Date.parse('2026-10-26T17:28:00Z');

const gqlOk = (acc) => new Response(JSON.stringify({ data: { viewer: { accounts: [acc] } }, errors: null }), { status: 200 });
const gqlErr = () => new Response(JSON.stringify({ data: null, errors: [{ message: 'not authorized for that account' }] }), { status: 200 });

/** 假 GraphQL：按查询文本分派；over 覆盖某个数据集。记下每次调用。 */
function cfMock(over = {}) {
  const calls = [];
  const handlers = {
    workers: () => gqlOk({ workersInvocationsAdaptive: [{ sum: { requests: 1500 } }, { sum: { requests: 500 } }] }),
    pages: () => gqlOk({ pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 80000 } }] }),
    kv: () => gqlOk({ kvOperationsAdaptiveGroups: [
      { sum: { requests: 42000 }, dimensions: { actionType: 'read' } },
      { sum: { requests: 850 }, dimensions: { actionType: 'write' } },
      { sum: { requests: 12 }, dimensions: { actionType: 'delete' } },
      { sum: { requests: 3 }, dimensions: { actionType: 'list' } },
      { sum: { requests: 7 }, dimensions: { actionType: 'readMetadata' } },
    ] }),
    d1: () => gqlOk({ d1AnalyticsAdaptiveGroups: [
      { sum: { rowsRead: 3_000_000, rowsWritten: 40_000 } },
      { sum: { rowsRead: 1_200_000, rowsWritten: 2_000 } },
    ] }),
    r2: () => gqlOk({ r2OperationsAdaptiveGroups: [
      { sum: { requests: 900 }, dimensions: { actionType: 'PutObject' } },
      { sum: { requests: 100 }, dimensions: { actionType: 'ListObjects' } },
      { sum: { requests: 52_000 }, dimensions: { actionType: 'GetObject' } },
      { sum: { requests: 3_000 }, dimensions: { actionType: 'HeadObject' } },
      { sum: { requests: 40 }, dimensions: { actionType: 'DeleteObject' } },
      { sum: { requests: 2 }, dimensions: { actionType: 'SomethingNew' } },
    ] }),
    ...over,
  };
  const doFetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method, auth: init.headers && init.headers.Authorization, vars: body && body.variables, query: body && body.query });
    if (String(url) !== CF_API + '/graphql') return new Response('{}', { status: 404 });
    const by = { [Q_Q_WORKERS]: 'workers', [Q_Q_PAGES]: 'pages', [Q_Q_KV]: 'kv', [Q_Q_D1]: 'd1', [Q_Q_R2]: 'r2' }[body.query];
    if (!by) return new Response('{}', { status: 400 });
    return handlers[by](body.variables);
  };
  return { doFetch, calls };
}

test('免费额度常量（2026-10-27 对过文档）：Workers 10 万/天；KV 读 10 万、写 / 删 / 列各 1000/天；D1 读 500 万行、写 10 万行/天；R2 A 100 万、B 1000 万/月', () => {
  assert.equal(QUOTA_LIMITS.workersRequests, 100000);
  assert.deepEqual({ ...QUOTA_LIMITS.kv }, { read: 100000, write: 1000, delete: 1000, list: 1000 });
  assert.deepEqual({ ...QUOTA_LIMITS.d1 }, { rows_read: 5000000, rows_written: 100000 });
  assert.deepEqual({ ...QUOTA_LIMITS.r2 }, { class_a: 1000000, class_b: 10000000 });
  assert.equal(QUOTA_TTL_MS, 300000);
  assert.ok(R2_CLASS_A.includes('PutObject') && R2_CLASS_A.includes('ListObjects'));
  assert.ok(R2_CLASS_B.includes('GetObject') && R2_CLASS_B.includes('HeadObject'));
  assert.ok(!R2_CLASS_A.includes('DeleteObject') && !R2_CLASS_B.includes('DeleteObject'));
});

test('时间窗按 UTC：北京 01:28 还是 UTC 前一天；R2 从本月 1 日 UTC 零点起', () => {
  assert.deepEqual(quotaWindow(NOW), {
    day: '2026-10-26', month: '2026-10', dayStart: '2026-10-26T00:00:00Z', monthStart: '2026-10-01T00:00:00Z', end: '2026-10-26T17:28:00.000Z',
  });
  /* 北京 08:00 = UTC 零点：换日 */
  assert.equal(quotaWindow(Date.parse('2026-10-27T00:00:00Z')).day, '2026-10-27');
});

test('成功：五个数据集；Workers + Pages Functions 合计；KV 按 actionType；D1 合计行数；R2 按 A / B / 免费归类', async () => {
  const m = cfMock();
  const r = await collectQuota(TOKEN, ACC, NOW, m.doFetch);
  assert.equal(r.ok, true);
  const s = r.snapshot;
  assert.equal(s.day, '2026-10-26');
  assert.deepEqual(s.workers, { requests: 82000, workers: 2000, pages: 80000, limit: 100000 });
  assert.deepEqual({ ...s.kv, limits: { ...s.kv.limits } }, { read: 42000, write: 850, delete: 12, list: 3, other: 7, limits: { read: 100000, write: 1000, delete: 1000, list: 1000 } });
  assert.equal(s.d1.rows_read, 4_200_000);
  assert.equal(s.d1.rows_written, 42_000);
  assert.equal(s.r2.class_a, 1000);
  assert.equal(s.r2.class_b, 55_000);
  assert.equal(s.r2.free, 40);
  assert.equal(s.r2.other, 2);
  assert.equal(s.r2.since, '2026-10-01');
  assert.deepEqual(s.errors, {});
  /* 5 个 GraphQL 请求，都带 Bearer token、账号 id；日 / 月窗口变量对 */
  assert.equal(m.calls.length, 5);
  for (const c of m.calls) {
    assert.equal(c.method, 'POST');
    assert.equal(c.auth, 'Bearer ' + TOKEN);
    assert.equal(c.vars.accountTag, ACC);
  }
  const byQ = Object.fromEntries(m.calls.map((c) => [c.query, c.vars]));
  assert.equal(byQ[Q_Q_WORKERS].start, '2026-10-26T00:00:00Z');
  assert.equal(byQ[Q_Q_PAGES].day, '2026-10-26');
  assert.equal(byQ[Q_Q_KV].day, '2026-10-26');
  assert.equal(byQ[Q_Q_D1].day, '2026-10-26');
  assert.equal(byQ[Q_Q_R2].start, '2026-10-01T00:00:00Z');
  /* 查询用到的数据集 / 字段（和文档、旧 KV 预算闸一致） */
  assert.match(Q_Q_KV, /kvOperationsAdaptiveGroups[\s\S]*sum \{ requests \}[\s\S]*dimensions \{ actionType \}/);
  assert.match(Q_Q_D1, /d1AnalyticsAdaptiveGroups[\s\S]*rowsRead rowsWritten/);
  assert.match(Q_Q_R2, /r2OperationsAdaptiveGroups[\s\S]*actionType/);
  assert.match(Q_Q_PAGES, /pagesFunctionsInvocationsAdaptiveGroups/);
  assert.match(Q_Q_WORKERS, /workersInvocationsAdaptive/);
});

test('部分失败：Pages 挂了 → Workers 照给、pages = null；D1 GraphQL errors → d1 = null + 原因；其他照常', async () => {
  const m = cfMock({ pages: () => new Response('nope', { status: 500 }), d1: gqlErr });
  const r = await collectQuota(TOKEN, ACC, NOW, m.doFetch);
  assert.equal(r.ok, true);
  assert.deepEqual(r.snapshot.workers, { requests: 2000, workers: 2000, pages: null, limit: 100000 });
  assert.equal(r.snapshot.d1, null);
  assert.deepEqual(r.snapshot.errors, { pages: 'http-500', d1: 'graphql' });
  assert.equal(r.snapshot.kv.write, 850);
});

test('全部失败（token 没有 Analytics 权限 / 网络）→ api-error，不抛错', async () => {
  const r = await collectQuota(TOKEN, ACC, NOW, async () => new Response('', { status: 403 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'api-error');
  assert.equal(r.errors.workers, 'http-403');
  const r2 = await collectQuota(TOKEN, ACC, NOW, async () => { throw new TypeError('fetch failed'); });
  assert.equal(r2.ok, false);
  assert.equal(r2.errors.kv, 'network');
});

test('超时：某个数据集 6 秒没回 → 那一项 timeout，其余照给（/summary 不被拖住）', { timeout: 15000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = cfMock({ r2: () => new Promise(() => {}) });
  const p = collectQuota(TOKEN, ACC, NOW, m.doFetch);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(QUOTA_DEADLINE_MS + 1);
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.r2, null);
  assert.equal(r.snapshot.errors.r2, 'timeout');
  assert.equal(r.snapshot.workers.requests, 82000);
});

test('没配 token / 账号 → not-configured，不碰库也不碰网络；Secrets Store get() 抛错 → secret-missing', async () => {
  let touched = 0;
  const db = { prepare: () => { touched++; throw new Error('no'); } };
  const noFetch = async () => { touched++; throw new Error('no'); };
  assert.deepEqual(await readQuota(db, {}, NOW, noFetch), { quota: null, quota_reason: 'not-configured' });
  assert.deepEqual(await readQuota(db, { SGX_CF_USAGE_TOKEN: TOKEN }, NOW, noFetch), { quota: null, quota_reason: 'not-configured' });
  const env = { SGX_CF_USAGE_TOKEN: { get: async () => { throw new Error('missing'); } }, CF_ACCOUNT_ID: ACC };
  assert.deepEqual(await readQuota(db, env, NOW, noFetch), { quota: null, quota_reason: 'secret-missing' });
  assert.equal(touched, 0);
});

test('表不存在（迁移没跑）→ db，并且不去查 Cloudflare（没地方缓存就不查）', { skip: !sqlite }, async () => {
  const db = d1(schema(['0001_init.sql', '0002_usage.sql', '0003_cut_reads.sql']));
  const m = cfMock();
  assert.deepEqual(await readQuota(db, ENV, NOW, m.doFetch), { quota: null, quota_reason: 'db' });
  assert.equal(m.calls.length, 0);
});

test('缓存：5 分钟内只查一次；满 5 分钟再查；写进 quota 表', { skip: !sqlite }, async () => {
  const db = d1();
  const m = cfMock();
  const a = await readQuota(db, ENV, NOW, m.doFetch);
  assert.equal(a.quota_reason, null);
  assert.equal(a.quota.workers.requests, 82000);
  assert.equal(a.quota.fetched_at, NOW);
  assert.equal(m.calls.length, 5);
  const b = await readQuota(db, ENV, NOW + QUOTA_TTL_MS - 1, m.doFetch);
  assert.equal(m.calls.length, 5, '5 分钟内不再请求');
  assert.equal(b.quota.fetched_at, NOW);
  assert.equal(b.quota.stale, undefined);
  const row = db.raw.prepare('SELECT fetched_at, last_attempt_at, last_error FROM quota WHERE id = 1').get();
  assert.deepEqual({ ...row }, { fetched_at: NOW, last_attempt_at: NOW, last_error: null });
  await readQuota(db, ENV, NOW + QUOTA_TTL_MS, m.doFetch);
  assert.equal(m.calls.length, 10, '满 5 分钟重查');
});

test('失败退避：查失败 → 旧数据（同一 UTC 日）照给并标 stale；5 分钟内不重试；再成功清掉 stale', { skip: !sqlite }, async () => {
  const db = d1();
  await readQuota(db, ENV, NOW, cfMock().doFetch);
  let n = 0;
  const bad = async () => { n++; return new Response('', { status: 502 }); };
  const t1 = NOW + QUOTA_TTL_MS;
  const a = await readQuota(db, ENV, t1, bad);
  assert.equal(n, 5);
  assert.equal(a.quota.stale, true);
  assert.equal(a.quota.last_error, 'api-error');
  assert.equal(a.quota.fetched_at, NOW);
  const b = await readQuota(db, ENV, t1 + 60_000, bad);
  assert.equal(n, 5, '失败后 5 分钟内也不重试');
  assert.equal(b.quota.stale, true);
  const c = await readQuota(db, ENV, t1 + QUOTA_TTL_MS, cfMock().doFetch);
  assert.equal(c.quota.stale, undefined);
  assert.equal(c.quota.fetched_at, t1 + QUOTA_TTL_MS);
});

test('从没成功过 + 失败 → quota = null、api-error（页面显示「额度暂时拿不到」）', { skip: !sqlite }, async () => {
  const db = d1();
  const r = await readQuota(db, ENV, NOW, async () => new Response('', { status: 401 }));
  assert.deepEqual(r, { quota: null, quota_reason: 'api-error' });
  assert.deepEqual(await readQuota(db, ENV, NOW + 1000, async () => { throw new Error('should not fetch'); }), { quota: null, quota_reason: 'api-error' });
});

test('跨 UTC 零点（北京 08:00）：昨天的缓存不当今天显示——缓存没过期也立刻重查；重查失败 → null', { skip: !sqlite }, async () => {
  const db = d1();
  const before = Date.parse('2026-10-26T23:58:00Z');
  await readQuota(db, ENV, before, cfMock().doFetch);
  const after = Date.parse('2026-10-27T00:01:00Z');
  const m = cfMock();
  const r = await readQuota(db, ENV, after, m.doFetch);
  assert.equal(m.calls.length, 5);
  assert.equal(r.quota.day, '2026-10-27');
  /* 再来一遍：昨天有数据，今天第一次就失败 → 不给昨天的 */
  const db2 = d1();
  await readQuota(db2, ENV, before, cfMock().doFetch);
  const r2 = await readQuota(db2, ENV, after, async () => new Response('', { status: 500 }));
  assert.deepEqual(r2, { quota: null, quota_reason: 'api-error' });
});

test('GET /summary：带 quota + quota_reason；额度挂了（全失败 / 没表）站点数据照常 200', { skip: !sqlite }, async () => {
  const db = d1();
  const realFetch = globalThis.fetch;
  const m = cfMock();
  globalThis.fetch = m.doFetch;
  try {
    let res = await worker.fetch(new Request('https://styrigx-status/summary'), { D1_UPTIME_MONITOR: db, D1_CLOUDFLARE_USAGE: db, ...ENV });
    assert.equal(res.status, 200);
    let j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.sites.length, 5);
    assert.equal(j.quota_reason, null);
    assert.equal(j.quota.kv.write, 850);
    /* 没配 → quota null + not-configured，不请求 */
    const before = m.calls.length;
    res = await worker.fetch(new Request('https://styrigx-status/summary'), { D1_UPTIME_MONITOR: db, D1_CLOUDFLARE_USAGE: db });
    j = await res.json();
    assert.deepEqual([j.quota, j.quota_reason], [null, 'not-configured']);
    assert.equal(m.calls.length, before);
    /* Cloudflare 全挂、库里没数据 → 200，quota null + api-error */
    globalThis.fetch = async () => new Response('', { status: 503 });
    const fresh = d1();
    res = await worker.fetch(new Request('https://styrigx-status/summary'), { D1_UPTIME_MONITOR: fresh, D1_CLOUDFLARE_USAGE: fresh, ...ENV });
    assert.equal(res.status, 200);
    j = await res.json();
    assert.equal(j.sites.length, 5);
    assert.deepEqual([j.quota, j.quota_reason], [null, 'api-error']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
