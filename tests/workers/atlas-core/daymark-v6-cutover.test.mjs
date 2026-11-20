/**
 * 割接（v6 cutover）：日刻接口 Worker 认 v6 会话（旧进站 / 账号结论随应用授权删除，定稿 v5.3 §十二）。
 * - 写（daymark-manage）：styrigx 放行，alice / 临时用户 403 forbidden，访客 401
 * - DELETE /daymark/api/collections = root（结构删除）：styrigx 403，root 200 并经 auditRoot 留痕 rm-bulk
 * - 公开读的私密句子与 canManage：action private（= daymark-use）、manage（= daymark-manage）（组权限 v1.1 §八）
 * 替身 ../_v6admit.mjs 用真的 ROUTE_ACCESS + permits。
 * 运行：node --test tests/workers/atlas-core/daymark-v6-cutover.test.mjs
 */
import '../account/_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { v6Space } from '../_v6admit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const worker = (await import(REPO + '/workers/atlas-core/src/daymark/index.js')).default;

function makeD1(db = new DatabaseSync(':memory:')) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) || null,
    _exec: () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { raw: db, prepare: (sql) => stmt(sql), batch: async (list) => { db.exec('BEGIN'); try { const out = list.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
const ORIGIN = 'https://styrigx.com';
function bench() { return { db: makeD1(), calls: [], audits: [] }; }
function call(b, p, o = {}) {
  const h = { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.5' };
  const ck = [];
  if (o.v6) ck.push('sgx-session=' + o.v6);
  if (ck.length) h.Cookie = ck.join('; ');
  if (o.body !== undefined) h['Content-Type'] = 'application/json';
  const SPACE = v6Space({}, { calls: b.calls, audits: b.audits });
  return worker.fetch(new Request(ORIGIN + p, { method: o.method || 'GET', headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) }),
    { SPACE, D1_QUOTES: b.db, KV_SEARCH_INDEX: { async put() {} } }, { waitUntil() {} });
}

test('写（daymark-manage）：styrigx 的 v6 会话放行；alice / 临时用户 403 forbidden；访客 401', async () => {
  const b = bench();
  const add = (v6, text) => call(b, '/daymark/api/quotes', { v6, method: 'POST', body: { text } });
  assert.equal((await add('styrigx', '一句')).status, 201);
  for (const who of ['alice', 'temp']) {
    const r = await add(who, 'x');
    assert.equal(r.status, 403, who);
    assert.equal((await r.json()).error, 'forbidden');
  }
  assert.equal((await add(undefined, 'x')).status, 401);
  assert.equal((await add('expired', 'x')).status, 401);
  assert.equal((await call(b, '/daymark/api/collections', { v6: 'styrigx', method: 'POST', body: { name: '专题' } })).status, 201);
  assert.equal((await call(b, '/daymark/api/collections', { v6: 'alice', method: 'POST', body: { name: '专题' } })).status, 403);
});

test('DELETE /daymark/api/collections = root（结构删除）：styrigx 403；root 200 并留痕 rm-bulk', async () => {
  const b = bench();
  const c = await (await call(b, '/daymark/api/collections', { v6: 'styrigx', method: 'POST', body: { name: '专题' } })).json();
  const id = c.collection.id;
  const del = (o) => call(b, '/daymark/api/collections?id=' + id, Object.assign({ method: 'DELETE' }, o));
  const no = await del({ v6: 'styrigx' });
  assert.equal(no.status, 403);
  assert.equal((await no.json()).error, 'forbidden');
  assert.equal(b.audits.length, 0);
  assert.equal((await del({ v6: 'root' })).status, 200);
  assert.deepEqual(b.audits.map((a) => [a.command, a.ok, a.ip]), [['rm-bulk daymark collection ' + id, true, '203.0.113.5']]);
  /* 单条删除归 manage 组：styrigx 能删一句 */
  const q = await (await call(b, '/daymark/api/quotes', { v6: 'styrigx', method: 'POST', body: { text: '删我' } })).json();
  assert.equal((await call(b, '/daymark/api/quotes?id=' + q.quote.id, { v6: 'styrigx', method: 'DELETE' })).status, 200);
});

test('公开读：私密句子按 action private（= daymark-use）、canManage 按 action manage（= daymark-manage）', async () => {
  const b = bench();
  await call(b, '/daymark/api/quotes', { v6: 'styrigx', method: 'POST', body: { text: '私密', visibility: 'private' } });
  await call(b, '/daymark/api/quotes', { v6: 'styrigx', method: 'POST', body: { text: '公开' } });
  const view = async (v6) => (await call(b, '/daymark/api/quotes', { v6 })).json();
  for (const who of ['styrigx', 'root']) {
    const r = await view(who);
    assert.equal(r.canManage, true, who);
    assert.equal(r.quotes.length, 2, who);
  }
  for (const who of ['alice', 'temp', undefined]) {
    const r = await view(who);
    assert.equal(r.canManage, false, String(who));
    assert.deepEqual(r.quotes.map((x) => x.text), ['公开'], String(who));
  }
  assert.equal((await (await call(b, '/daymark/api/collections', { v6: 'styrigx' })).json()).showPrivate, true);
  assert.equal((await (await call(b, '/daymark/api/collections', { v6: 'alice' })).json()).showPrivate, false);
  /* 设为今日（daymark-manage） */
  assert.equal((await call(b, '/daymark/api/today', { v6: 'alice', method: 'PUT', body: { id: 'x' } })).status, 403);
  assert.notEqual((await call(b, '/daymark/api/today', { v6: 'styrigx', method: 'PUT', body: { id: 'x' } })).status, 403);
});

test('组权限 v1.1 模板 · 日刻：访客 / alice 看不到私密句子；viewer（只有 daymark-use）看得到、canManage false、写 403；keeper（只有 daymark-manage）、styrigx、root 都行', async () => {
  const b = bench();
  await call(b, '/daymark/api/quotes', { v6: 'styrigx', method: 'POST', body: { text: '私密一句', visibility: 'private' } });
  const pub = await (await call(b, '/daymark/api/quotes', { v6: 'styrigx', method: 'POST', body: { text: '公开一句' } })).json();
  const col = await (await call(b, '/daymark/api/collections', { v6: 'styrigx', method: 'POST', body: { name: '专题' } })).json();
  const all = (await (await call(b, '/daymark/api/quotes', { v6: 'styrigx' })).json()).quotes;
  const secId = all.find((q) => q.text === '私密一句').id;
  assert.equal((await call(b, '/daymark/api/collections?id=' + col.collection.id, { v6: 'styrigx', method: 'PUT', body: { quote_ids: [secId] } })).status, 200);
  const look = async (who) => {
    const q = await (await call(b, '/daymark/api/quotes', { v6: who })).json();
    const c = await (await call(b, '/daymark/api/collections', { v6: who })).json();
    return { q, c };
  };
  for (const who of [undefined, 'alice', 'temp']) {
    const { q, c } = await look(who);
    assert.deepEqual(q.quotes.map((x) => x.text), ['公开一句'], String(who) + ' 看不到私密句子');
    assert.deepEqual([q.showPrivate, q.canManage, c.showPrivate, c.canManage], [false, false, false, false], String(who));
    assert.equal(c.collections.length, 0, String(who) + ' 只含私密句子的专题不给');
  }
  const v = await look('viewer');
  assert.deepEqual(v.q.quotes.map((x) => x.text).sort(), ['私密一句', '公开一句'].sort(), 'viewer（daymark-use）看得到私密句子');
  assert.deepEqual([v.q.showPrivate, v.q.canManage, v.c.showPrivate, v.c.canManage], [true, false, true, false]);
  assert.equal(v.c.collections.length, 1);
  assert.equal(v.q.canWrite, undefined, '旧字段 canWrite 不留别名');
  for (const [p, method, body] of [['/daymark/api/quotes', 'POST', { text: 'v' }], ['/daymark/api/quotes?id=' + pub.quote.id, 'PUT', { trans: 'x' }], ['/daymark/api/quotes?id=' + pub.quote.id, 'DELETE'],
    ['/daymark/api/collections', 'POST', { name: 'v' }], ['/daymark/api/today', 'PUT', { id: pub.quote.id }]]) {
    const r = await call(b, p, { v6: 'viewer', method, body });
    assert.equal(r.status, 403, 'viewer ' + method + ' ' + p);
    assert.equal((await r.json()).error, 'forbidden');
  }
  for (const who of ['keeper', 'styrigx', 'root']) {
    const { q, c } = await look(who);
    assert.equal(q.quotes.length >= 2, true, who);
    assert.deepEqual([q.showPrivate, q.canManage, c.showPrivate, c.canManage], [true, true, true, true], who + '（manage 包含 use）');
    assert.equal((await call(b, '/daymark/api/quotes', { v6: who, method: 'POST', body: { text: 'w-' + who } })).status, 201, who + ' 写');
  }
});
