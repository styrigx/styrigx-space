/**
 * styrigx-status 用量收集（workers/status/src/usage.js，2026-10-22 PR3）：mock Cloudflare API。
 *   成功（四项都有）· 没配 token · API 出错（全部失败 / 部分失败）· 写库 / 读库 · /summary 带 usage · Cron 分流。
 * 运行：node --test tests/workers/status/usage.test.mjs
 * 真 SQL 用 node:sqlite（Node 22+；没有就跳过写库那几条）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectUsage, persistUsage, readUsage, runUsage, FREE_LIMITS, USAGE_CRON, CF_API, Q_WORKERS, Q_R2, Q_KV,
} from '../../../workers/status/src/usage.js';
import { summary } from '../../../workers/status/src/monitor.js';
import worker from '../../../workers/status/src/index.js';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch {}
const SCHEMA = ['0001_init.sql', '0002_usage.sql']
  .map((f) => readFileSync(new URL('../../../workers/status/migrations/' + f, import.meta.url), 'utf8')).join('\n');

/** node:sqlite 模拟 D1（prepare / bind / first / run / batch） */
function d1(schema = SCHEMA) {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(schema);
  const mk = (sql, args = []) => ({
    sql, args,
    bind: (...a) => mk(sql, a),
    _exec() {
      const s = db.prepare(sql);
      if (/^\s*select/i.test(sql)) return { results: s.all(...args) };
      s.run(...args);
      return { results: [] };
    },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async run() { db.prepare(sql).run(...args); return { success: true }; },
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

const ACC = 'acc123';
const TOKEN = 'test-token-not-real';
const ENV = { CF_USAGE_TOKEN: TOKEN, CF_ACCOUNT_ID: ACC };
const NOW = Date.parse('2026-10-22T10:41:00Z');

const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });
const gqlOk = (acc) => new Response(JSON.stringify({ data: { viewer: { accounts: [acc] } }, errors: null }), { status: 200 });

/**
 * 假 Cloudflare API。over：按名字覆盖某个端点（返回 Response 或抛错的函数）。
 * 记下每次调用（url、方法、Authorization、GraphQL 变量）。
 */
function cfMock(over = {}) {
  const calls = [];
  const handlers = {
    d1List: () => ok([{ uuid: 'u-auth', name: 'styrigx-auth' }, { uuid: 'u-status', name: 'styrigx-status' }]),
    d1Get: (uuid) => ok({ uuid, name: uuid === 'u-auth' ? 'styrigx-auth' : 'styrigx-status', file_size: uuid === 'u-auth' ? 12_000_000 : 380_000_000 }),
    r2Buckets: () => ok({ buckets: [{ name: 'files' }, { name: 'avatars' }] }),
    kvList: () => ok([{ id: 'ns1', title: 'SEARCH_KV' }, { id: 'ns2', title: 'SESSIONS' }, { id: 'ns3', title: 'EMPTY' }]),
    workers: () => gqlOk({ workersInvocationsAdaptive: [{ sum: { requests: 73_456 } }] }),
    r2: () => gqlOk({ r2StorageAdaptiveGroups: [
      /* 新 → 旧：files 取最新一行（不是最大值） */
      { max: { objectCount: 1200, payloadSize: 2_000_000_000, metadataSize: 1_000_000 }, dimensions: { bucketName: 'files', datetime: '2026-10-22T10:00:00Z' } },
      { max: { objectCount: 1300, payloadSize: 2_500_000_000, metadataSize: 1_000_000 }, dimensions: { bucketName: 'files', datetime: '2026-10-22T09:00:00Z' } },
      { max: { objectCount: 34, payloadSize: 9_000_000, metadataSize: 0 }, dimensions: { bucketName: 'avatars', datetime: '2026-10-22T10:00:00Z' } },
    ] }),
    kv: () => gqlOk({ kvStorageAdaptiveGroups: [
      { max: { keyCount: 400, byteCount: 5_000_000 }, dimensions: { namespaceId: 'ns1', date: '2026-10-22' } },
      { max: { keyCount: 390, byteCount: 4_000_000 }, dimensions: { namespaceId: 'ns1', date: '2026-10-21' } },
      { max: { keyCount: 20, byteCount: 300_000 }, dimensions: { namespaceId: 'ns2', date: '2026-10-21' } },
    ] }),
    ...over,
  };
  const doFetch = async (url, init = {}) => {
    const u = String(url);
    const auth = init.headers && init.headers.Authorization;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, method: init.method || 'GET', auth, vars: body && body.variables, query: body && body.query });
    if (u === CF_API + '/graphql') {
      if (body.query === Q_WORKERS) return handlers.workers(body.variables);
      if (body.query === Q_R2) return handlers.r2(body.variables);
      if (body.query === Q_KV) return handlers.kv(body.variables);
      return new Response('{}', { status: 400 });
    }
    const base = CF_API + '/accounts/' + ACC;
    if (u === base + '/d1/database') return handlers.d1List();
    if (u.startsWith(base + '/d1/database/')) return handlers.d1Get(u.slice((base + '/d1/database/').length));
    if (u.startsWith(base + '/r2/buckets')) return handlers.r2Buckets();
    if (u.startsWith(base + '/storage/kv/namespaces')) return handlers.kvList();
    return new Response('not found', { status: 404 });
  };
  return { doFetch, calls };
}

test('免费额度常量（2026-10-22 对过文档）：Workers 10 万次/天、D1 合计 5 GB / 单库 500 MB、R2 10 GB、KV 1 GB', () => {
  assert.equal(FREE_LIMITS.workersRequestsPerDay, 100000);
  assert.equal(FREE_LIMITS.d1TotalBytes, 5e9);
  assert.equal(FREE_LIMITS.d1PerDbBytes, 5e8);
  assert.equal(FREE_LIMITS.r2Bytes, 1e10);
  assert.equal(FREE_LIMITS.kvBytes, 1e9);
  assert.equal(USAGE_CRON, '41 * * * *');
  const toml = readFileSync(new URL('../../../workers/status/wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /crons = \["\* \* \* \* \*", "41 \* \* \* \*"\]/);
  /* 仓库里不写 token / 账号 id 的值（只能是 secret） */
  assert.doesNotMatch(toml, /CF_USAGE_TOKEN\s*=/);
  assert.doesNotMatch(toml, /CF_ACCOUNT_ID\s*=/);
  /* token 走 Secrets Store：同鉴权网关的 store，secret_name 固定 */
  const gw = readFileSync(new URL('../../../workers/auth-gateway/wrangler.toml', import.meta.url), 'utf8');
  const storeId = gw.match(/store_id = "([0-9a-f]+)"/)[1];
  assert.match(toml, new RegExp('\\[\\[secrets_store_secrets\\]\\]\\s*binding = "CF_USAGE_TOKEN"\\s*store_id = "' + storeId + '"\\s*secret_name = "SGX_CF_USAGE_TOKEN"'));
});

test('Secrets Store 绑定：await get() 取 token；get() 抛错 → secret-missing；取到空 → not-configured；都不碰网络、/summary 不坏', async () => {
  const { doFetch, calls } = cfMock();
  const bound = { CF_USAGE_TOKEN: { get: async () => TOKEN }, CF_ACCOUNT_ID: ACC };
  const r = await collectUsage(bound, NOW, doFetch);
  assert.equal(r.ok, true);
  assert.ok(calls.every((c) => c.auth === 'Bearer ' + TOKEN));
  const missing = { CF_USAGE_TOKEN: { get: async () => { throw new Error('secret not found'); } }, CF_ACCOUNT_ID: ACC };
  const m2 = cfMock();
  assert.deepEqual(await collectUsage(missing, NOW, m2.doFetch), { ok: false, reason: 'secret-missing' });
  assert.deepEqual(await collectUsage({ CF_USAGE_TOKEN: { get: async () => null }, CF_ACCOUNT_ID: ACC }, NOW, m2.doFetch), { ok: false, reason: 'not-configured' });
  assert.deepEqual(await collectUsage({ CF_USAGE_TOKEN: {}, CF_ACCOUNT_ID: ACC }, NOW, m2.doFetch), { ok: false, reason: 'not-configured' });
  assert.equal(m2.calls.length, 0);
  const boom = { prepare() { throw new Error('should not touch db'); } };
  assert.deepEqual(await readUsage(boom, missing), { usage: null, usage_reason: 'secret-missing' });
  if (sqlite) {
    const s = await summary(d1(), NOW, missing);
    assert.equal(s.ok, true);
    assert.equal(s.sites.length, 5);
    assert.deepEqual([s.usage, s.usage_reason], [null, 'secret-missing']);
    let wrote = 0;
    await persistUsage({ prepare: () => { wrote++; return { bind: () => ({ run: async () => {} }) }; } }, { ok: false, reason: 'secret-missing' }, NOW);
    assert.equal(wrote, 0);
  }
});

test('成功：四项都有；D1 每库大小 + 合计；R2 取每桶最新一行；KV 合计 + 命名空间数；Workers 今天 UTC 起', async () => {
  const { doFetch, calls } = cfMock();
  const r = await collectUsage(ENV, NOW, doFetch);
  assert.equal(r.ok, true);
  const s = r.snapshot;
  assert.equal(s.fetched_at, NOW);
  assert.deepEqual(s.errors, {});
  assert.deepEqual(s.workers, { requests: 73456, limit: 100000, day: '2026-10-22' });
  assert.deepEqual(s.d1, {
    total_bytes: 392_000_000, limit_bytes: 5e9, per_db_limit_bytes: 5e8,
    databases: [{ name: 'styrigx-status', bytes: 380_000_000 }, { name: 'styrigx-auth', bytes: 12_000_000 }],
  });
  assert.deepEqual(s.r2, { bytes: 2_010_000_000, objects: 1234, buckets: 2, limit_bytes: 1e10 });
  assert.deepEqual(s.kv, { bytes: 5_300_000, keys: 420, namespaces: 3, limit_bytes: 1e9 });
  /* 每个请求都带 Bearer token；只读（GET + GraphQL POST），没有别的方法 */
  assert.ok(calls.length >= 8 && calls.length <= 20, 'calls ' + calls.length);
  assert.ok(calls.every((c) => c.auth === 'Bearer ' + TOKEN));
  assert.ok(calls.every((c) => c.method === 'GET' || (c.method === 'POST' && c.url.endsWith('/graphql'))));
  const w = calls.find((c) => c.query === Q_WORKERS);
  assert.equal(w.vars.accountTag, ACC);
  assert.equal(w.vars.start, '2026-10-22T00:00:00Z');
  assert.equal(calls.find((c) => c.query === Q_KV).vars.start, '2026-10-21');
  /* 页面上不出现 D1 的 uuid */
  assert.doesNotMatch(JSON.stringify(s), /u-auth|u-status/);
});

test('没配 token（或没配账号 id）→ not-configured，一个请求都不发', async () => {
  for (const env of [{}, { CF_ACCOUNT_ID: ACC }, { CF_USAGE_TOKEN: TOKEN }, { CF_USAGE_TOKEN: '  ', CF_ACCOUNT_ID: ACC }]) {
    const { doFetch, calls } = cfMock();
    assert.deepEqual(await collectUsage(env, NOW, doFetch), { ok: false, reason: 'not-configured' });
    assert.equal(calls.length, 0);
  }
});

test('API 全部出错（401 / 网络）→ api-error，各项原因短码', async () => {
  const deny = () => new Response('{"success":false}', { status: 401 });
  const { doFetch } = cfMock({ d1List: deny, r2Buckets: deny, kvList: deny, workers: deny, r2: deny, kv: () => { throw new TypeError('fetch failed'); } });
  const r = await collectUsage(ENV, NOW, doFetch);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'api-error');
  assert.deepEqual(r.errors, { workers: 'http-401', d1: 'http-401', r2: 'http-401', kv: 'network' });
});

test('部分出错：GraphQL errors / 某个 D1 库 500 → 那一项 null + 原因，其他照常；KV GraphQL 挂了仍给命名空间数', async () => {
  const gqlErr = () => new Response(JSON.stringify({ data: null, errors: [{ message: 'not authorized for r2StorageAdaptiveGroups' }] }), { status: 200 });
  const { doFetch } = cfMock({
    r2: gqlErr,
    kv: gqlErr,
    d1Get: (uuid) => (uuid === 'u-auth' ? new Response('x', { status: 500 }) : ok({ file_size: 1 })),
  });
  const r = await collectUsage(ENV, NOW, doFetch);
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.r2, null);
  assert.equal(r.snapshot.d1, null);
  assert.deepEqual(r.snapshot.errors, { d1: 'http-500', r2: 'graphql' });
  assert.equal(r.snapshot.workers.requests, 73456);
  assert.deepEqual(r.snapshot.kv, { bytes: null, keys: null, namespaces: 3, limit_bytes: 1e9, error: 'graphql' });
  /* 错误文本（可能含内部信息）不进快照 */
  assert.doesNotMatch(JSON.stringify(r.snapshot), /not authorized/);
});

test('超时：15 秒没回应 → timeout', { timeout: 20000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const p = collectUsage(ENV, NOW, hang);
  /* 读钥匙是异步的：等请求都发出去（setImmediate 没被 mock）再拨钟 */
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(15001);
  const r = await p;
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, { workers: 'timeout', d1: 'timeout', r2: 'timeout', kv: 'timeout' });
});

test('读库：没配 → not-configured（不碰库）；表不存在 → db；从没成功 → not-collected / last_error', { skip: !sqlite }, async () => {
  const boom = { prepare() { throw new Error('should not touch db'); } };
  assert.deepEqual(await readUsage(boom, {}), { usage: null, usage_reason: 'not-configured' });
  assert.deepEqual(await readUsage(boom, undefined), { usage: null, usage_reason: 'not-configured' });
  /* 迁移没跑：表不存在 */
  const old = d1(readFileSync(new URL('../../../workers/status/migrations/0001_init.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await readUsage(old, ENV), { usage: null, usage_reason: 'db' });
  const db = d1();
  assert.deepEqual(await readUsage(db, ENV), { usage: null, usage_reason: 'not-collected' });
  await persistUsage(db, { ok: false, reason: 'api-error' }, NOW);
  assert.deepEqual(await readUsage(db, ENV), { usage: null, usage_reason: 'api-error' });
});

test('写库：成功覆盖快照；之后失败 → 旧快照留着、stale + last_error；再成功清掉；not-configured 不写', { skip: !sqlite }, async () => {
  const db = d1();
  await persistUsage(db, { ok: false, reason: 'not-configured' }, NOW);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM usage').get().n, 0);
  const { doFetch } = cfMock();
  const r1 = await runUsage({ ...ENV, STATUS_DB: db }, NOW, doFetch);
  assert.equal(r1.ok, true);
  let u = await readUsage(db, ENV);
  assert.equal(u.usage_reason, null);
  assert.equal(u.usage.fetched_at, NOW);
  assert.equal(u.usage.workers.requests, 73456);
  assert.equal(u.usage.stale, undefined);
  await runUsage({ ...ENV, STATUS_DB: db }, NOW + 3600e3, cfMock({ d1List: () => new Response('', { status: 403 }), workers: () => new Response('', { status: 403 }), r2: () => new Response('', { status: 403 }), kv: () => new Response('', { status: 403 }), kvList: () => new Response('', { status: 403 }) }).doFetch);
  u = await readUsage(db, ENV);
  assert.equal(u.usage.fetched_at, NOW);
  assert.equal(u.usage.stale, true);
  assert.equal(u.usage.last_error, 'api-error');
  await runUsage({ ...ENV, STATUS_DB: db }, NOW + 7200e3, doFetch);
  u = await readUsage(db, ENV);
  assert.equal(u.usage.fetched_at, NOW + 7200e3);
  assert.equal(u.usage.stale, undefined);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM usage').get().n, 1);
  /* token 撤了：就算库里有快照也不给 */
  assert.deepEqual(await readUsage(db, {}), { usage: null, usage_reason: 'not-configured' });
});

test('/summary：带 usage + usage_reason；用量读挂了不影响站点数据', { skip: !sqlite }, async () => {
  const db = d1();
  let s = await summary(db, NOW, {});
  assert.equal(s.ok, true);
  assert.equal(s.usage, null);
  assert.equal(s.usage_reason, 'not-configured');
  assert.equal(s.sites.length, 5);
  await runUsage({ ...ENV, STATUS_DB: db }, NOW, cfMock().doFetch);
  s = await summary(db, NOW + 60e3, ENV);
  assert.equal(s.usage.fetched_at, NOW);
  assert.equal(s.usage.d1.databases.length, 2);
  /* 迁移没跑：站点照常，usage = null / db */
  const old = d1(readFileSync(new URL('../../../workers/status/migrations/0001_init.sql', import.meta.url), 'utf8'));
  s = await summary(old, NOW, ENV);
  assert.equal(s.ok, true);
  assert.equal(s.sites.length, 5);
  assert.deepEqual([s.usage, s.usage_reason], [null, 'db']);
  /* 入口：GET /summary 200 带 usage */
  const res = await worker.fetch(new Request('https://styrigx-status/summary'), { STATUS_DB: db, ...ENV });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.usage.workers.requests, 73456);
});

test('Cron 分流：41 * * * * 只收用量（没配 → 不碰网络、不写库）', async () => {
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return new Response('', { status: 200 }); };
  try {
    let wrote = 0;
    const db = { prepare: () => ({ bind: () => ({ run: async () => { wrote++; } }) }) };
    await worker.scheduled({ cron: USAGE_CRON, scheduledTime: NOW }, { STATUS_DB: db }, ctx);
    await Promise.all(waits);
    assert.equal(waits.length, 1);
    assert.equal(fetched, 0);
    assert.equal(wrote, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
