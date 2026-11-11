/**
 * 割接（v6 cutover）：日刻接口 Worker 认 v6 新会话（新旧并存，旧会话照旧）。
 * - 写（daymark-write）：styrigx 放行，alice / 临时用户 403 forbidden，访客 401
 * - DELETE /daymark/api/collections = root（结构删除）：styrigx 403，root 200 并经 auditRoot 留痕 rm-bulk
 * - 公开读的私密句子与 canWrite：action private（= daymark-write）
 * 替身 ../_v6admit.mjs 用真的 ROUTE_ACCESS + permits。
 * 运行：node --test tests/workers/daymark-core/v6-cutover.test.mjs
 */
import '../account/_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { conclusionAuth } from '../_conclusion.mjs';
import { v6Space } from '../_v6admit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const worker = (await import(REPO + '/workers/daymark-core/src/index.js')).default;

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
  if (o.old) ck.push('sgx-space-session=x');
  if (o.v6) ck.push('sgx-session=' + o.v6);
  if (ck.length) h.Cookie = ck.join('; ');
  if (o.body !== undefined) h['Content-Type'] = 'application/json';
  const SPACE = v6Space(conclusionAuth(o.old || null), { calls: b.calls, audits: b.audits });
  return worker.fetch(new Request(ORIGIN + p, { method: o.method || 'GET', headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) }),
    { SPACE, D1_QUOTES: b.db, KV_SEARCH_INDEX: { async put() {} } }, { waitUntil() {} });
}

test('写（daymark-write）：styrigx 的 v6 会话放行；alice / 临时用户 403 forbidden；访客 401', async () => {
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

test('DELETE /daymark/api/collections = root（结构删除）：styrigx 403；root 200 并留痕 rm-bulk；旧会话照旧（daymark.write）', async () => {
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
  /* 单条删除归写组：styrigx 能删一句 */
  const q = await (await call(b, '/daymark/api/quotes', { v6: 'styrigx', method: 'POST', body: { text: '删我' } })).json();
  assert.equal((await call(b, '/daymark/api/quotes?id=' + q.quote.id, { v6: 'styrigx', method: 'DELETE' })).status, 200);
  /* 旧会话：daymark.write 照旧能删专题（旧规则，P4 删），不进身份审计 */
  const c2 = await (await call(b, '/daymark/api/collections', { old: 'owner', method: 'POST', body: { name: '旧' } })).json();
  assert.equal((await call(b, '/daymark/api/collections?id=' + c2.collection.id, { old: 'owner', method: 'DELETE' })).status, 200);
  assert.equal(b.audits.length, 1);
});

test('公开读：私密句子与 canWrite 按 action private（= daymark-write）', async () => {
  const b = bench();
  await call(b, '/daymark/api/quotes', { v6: 'styrigx', method: 'POST', body: { text: '私密', visibility: 'private' } });
  await call(b, '/daymark/api/quotes', { v6: 'styrigx', method: 'POST', body: { text: '公开' } });
  const view = async (v6) => (await call(b, '/daymark/api/quotes', { v6 })).json();
  for (const who of ['styrigx', 'root']) {
    const r = await view(who);
    assert.equal(r.canWrite, true, who);
    assert.equal(r.quotes.length, 2, who);
  }
  for (const who of ['alice', 'temp', undefined]) {
    const r = await view(who);
    assert.equal(r.canWrite, false, String(who));
    assert.deepEqual(r.quotes.map((x) => x.text), ['公开'], String(who));
  }
  assert.equal((await (await call(b, '/daymark/api/collections', { v6: 'styrigx' })).json()).showPrivate, true);
  assert.equal((await (await call(b, '/daymark/api/collections', { v6: 'alice' })).json()).showPrivate, false);
  /* 设为今日（daymark-write） */
  assert.equal((await call(b, '/daymark/api/today', { v6: 'alice', method: 'PUT', body: { id: 'x' } })).status, 403);
  assert.notEqual((await call(b, '/daymark/api/today', { v6: 'styrigx', method: 'PUT', body: { id: 'x' } })).status, 403);
});
