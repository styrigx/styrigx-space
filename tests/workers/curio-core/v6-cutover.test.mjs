/**
 * 割接（v6 cutover）：奇趣接口 Worker 认 v6 新会话（新旧并存，旧会话照旧）。
 * 判断经网关 SpaceVerifier.admit 问账号 Worker（这里的替身 ../_v6admit.mjs 用真的 ROUTE_ACCESS + permits）：
 * - 每条新接上的路由：v6 身份在对的档放行、访客 / 档不够被拒（401 / 403 forbidden）
 * - export / import / album.del = root（styrigx 也被拒，要 su root）；root 的这些操作经 auditRoot 留痕
 * - 公开读的私密行与 canWrite（action private = curio-write）
 * - 没带 sgx-session 不问 admit；网关出错 / 旧版本不认 action → 当没有 v6（fail closed）
 * 运行：node --test tests/workers/curio-core/v6-cutover.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { conclusionAuth } from '../_conclusion.mjs';
import { v6Space } from '../_v6admit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const W = REPO + '/workers/curio-core';
const worker = (await import(W + '/src/app.js')).default;
const A = await import(W + '/src/api/_auth.js');

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
  return { raw: db, prepare: (sql) => stmt(sql), batch: async (list) => { db.exec('BEGIN'); try { const out = list.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
function makeR2() {
  const m = new Map();
  return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { body: m.get(k), httpMetadata: {} } : null; }, async head() { return null; }, async delete(keys) { for (const k of [].concat(keys)) m.delete(k); }, async list() { return { objects: [], truncated: false }; } };
}
const ORIGIN = 'https://styrigx.com';
function bench() {
  const db = makeD1();
  const calls = []; const audits = [];
  return { db, calls, audits, r2: makeR2(), r2m: makeR2() };
}
/** @param {any} b @param {string} p @param {{v6?: string, old?: string|null, method?: string, body?: any, type?: string, throws?: boolean}} [o] */
function call(b, p, o = {}) {
  const h = { Origin: ORIGIN };
  const ck = [];
  if (o.old) ck.push('sgx-space-session=x');
  if (o.v6) ck.push('sgx-session=' + o.v6);
  if (ck.length) h.Cookie = ck.join('; ');
  if (o.body !== undefined) h['Content-Type'] = o.type || 'application/json';
  h['CF-Connecting-IP'] = '203.0.113.9';
  const body = o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
  const SPACE = v6Space(conclusionAuth(o.old || null), { calls: b.calls, audits: b.audits, throws: o.throws });
  const env = { SPACE, D1_FINDS: b.db, D1_DEVICES: b.db, D1_GAMES: b.db, D1_MOVIES: b.db, D1_MUSIC: b.db, R2_PHOTOS: b.r2, R2_MUSIC: b.r2m, KV_SEARCH_INDEX: { async put() {}, async get() { return null; } } };
  return worker.fetch(new Request(ORIGIN + p, { method: o.method || 'GET', headers: h, body }), env, { waitUntil() {} });
}
const j = async (r) => ({ status: r.status, json: await r.json().catch(() => null) });

test('写接口（curio-write 档）：styrigx 的 v6 会话放行；alice（只有 listen）/ 临时用户 403 forbidden；坏令牌 / 没 cookie 401 unauthorized', async () => {
  const b = bench();
  const add = (v6, name) => call(b, '/curio/api/links', { v6, method: 'POST', body: { op: 'cat.add', name } });
  assert.equal((await add('styrigx', '一')).status, 200);
  for (const who of ['alice', 'temp']) {
    const r = await j(await add(who, 'x'));
    assert.equal(r.status, 403, who);
    assert.equal(r.json.error, 'forbidden');
  }
  assert.equal((await add('expired', 'x')).status, 401, '坏 / 过期令牌 = 没有身份');
  assert.equal((await add(undefined, 'x')).status, 401);
  /* 其余 curio-write 路由走同一套守卫 */
  assert.equal((await call(b, '/curio/api/items', { v6: 'styrigx', method: 'POST', body: { op: 'game.add', title: 'G', platform: 'PC', status: 'playing' } })).status, 200);
  assert.equal((await call(b, '/curio/api/items', { v6: 'alice', method: 'POST', body: { op: 'game.add', title: 'G', platform: 'PC', status: 'playing' } })).status, 403);
  assert.equal((await call(b, '/curio/api/movies', { v6: 'styrigx', method: 'POST', body: { op: 'movie.add', title: 'M' } })).status, 200);
  assert.equal((await call(b, '/curio/api/movies', { v6: 'temp', method: 'POST', body: { op: 'movie.add', title: 'M' } })).status, 403);
  assert.notEqual((await call(b, '/curio/api/preview?url=javascript:1', { v6: 'styrigx' })).status, 401, 'preview 归 curio-write');
  assert.equal((await call(b, '/curio/api/preview?url=javascript:1', { v6: 'alice' })).status, 403);
});

test('root：curio-write 档也放（permits 第 2 步）；救援会话一律拒（不在白名单）', async () => {
  const b = bench();
  assert.equal((await call(b, '/curio/api/links', { v6: 'root', method: 'POST', body: { op: 'cat.add', name: 'R' } })).status, 200);
  assert.equal((await call(b, '/curio/api/links', { v6: 'rescue', method: 'POST', body: { op: 'cat.add', name: 'R' } })).status, 403);
  assert.equal((await call(b, '/curio/api/export', { v6: 'rescue', headers: {} })).status, 403);
});

test('导出 GET /curio/api/export = root：root 200 并留痕 export；styrigx（写组）也 403；访客 401', async () => {
  const b = bench();
  const r = await call(b, '/curio/api/export', { v6: 'root' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Disposition') || '', /attachment/);
  assert.deepEqual(b.audits.map((a) => [a.command, a.ok]), [['export curio bookmarks', true]]);
  assert.equal(b.audits[0].ip, '203.0.113.9');
  assert.equal((await call(b, '/curio/api/export', { v6: 'styrigx' })).status, 403);
  assert.equal((await call(b, '/curio/api/export', {})).status, 401);
  assert.equal(b.audits.length, 1, '没放行的不留痕');
  /* 旧会话照旧（账号会话即可，不留身份审计） */
  assert.equal((await call(b, '/curio/api/export', { old: 'owner' })).status, 200);
  assert.equal(b.audits.length, 1);
});

test('导入 POST /curio/api/import = root（v6 的「每次重验」= su root，不要旧 reauth 票）：root 过了守卫；styrigx 403；成功时留痕 import', async () => {
  const b = bench();
  const bad = await j(await call(b, '/curio/api/import', { v6: 'root', method: 'POST', body: 'x', type: 'text/html' }));
  assert.equal(bad.status, 400, '过了权限，内容不是书签');
  assert.equal(bad.json.error, 'not-bookmarks');
  assert.equal((await call(b, '/curio/api/import', { v6: 'styrigx', method: 'POST', body: 'x', type: 'text/html' })).status, 403);
  const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://a.example/">A</A></DL>';
  const ok = await j(await call(b, '/curio/api/import', { v6: 'root', method: 'POST', body: html, type: 'text/html' }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(b.audits.map((a) => a.command), ['import curio bookmarks']);
  /* 旧会话照旧要 reauth 票 */
  assert.equal((await call(b, '/curio/api/import', { old: 'noreauth', method: 'POST', body: html, type: 'text/html' })).status, 401);
});

test('音乐：album.del = root（结构删除，留痕 rm-bulk）；album.add / track.* = curio-write；听歌 = listen（alice 有、临时用户没有）', async () => {
  const b = bench();
  const add = await j(await call(b, '/curio/api/music', { v6: 'styrigx', method: 'POST', body: { op: 'album.add', title: 'A' } }));
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const id = add.json.id;
  const del = (v6) => call(b, '/curio/api/music', { v6, method: 'POST', body: { op: 'album.del', id } });
  const no = await j(await del('styrigx'));
  assert.equal(no.status, 403, 'styrigx 删整张专辑要 su root');
  assert.equal(no.json.error, 'forbidden');
  assert.equal((await call(b, '/curio/api/music', { v6: 'alice', method: 'POST', body: { op: 'album.add', title: 'B' } })).status, 403);
  assert.equal((await del('root')).status, 200);
  assert.deepEqual(b.audits.map((a) => a.command), ['rm-bulk curio album ' + id]);
  /* 旧会话（作用域 curio.write）照旧能删（旧规则，P4 删） */
  const a2 = await j(await call(b, '/curio/api/music', { old: 'owner', method: 'POST', body: { op: 'album.add', title: 'C' } }));
  assert.equal((await call(b, '/curio/api/music', { old: 'owner', method: 'POST', body: { op: 'album.del', id: a2.json.id } })).status, 200);
  assert.equal(b.audits.length, 1);
  /* 听歌：listen */
  assert.notEqual((await call(b, '/curio/api/music-play', { v6: 'alice', method: 'POST', body: { track: 1 } })).status, 401);
  assert.notEqual((await call(b, '/curio/api/music-play', { v6: 'alice', method: 'POST', body: { track: 1 } })).status, 403);
  assert.equal((await call(b, '/curio/api/music-play', { v6: 'temp', method: 'POST', body: { track: 1 } })).status, 403);
  assert.equal((await call(b, '/curio/api/music-upload', { v6: 'alice', method: 'POST', body: 'x' })).status, 403, '上传归 curio-write');
});

test('公开读：私密行与 canWrite 按 action private（= curio-write）——styrigx / root 看得到，alice / 访客只拿公开的', async () => {
  const b = bench();
  await call(b, '/curio/api/links', { v6: 'styrigx', method: 'POST', body: { op: 'cat.add', name: '私密', private: true } });
  await call(b, '/curio/api/links', { v6: 'styrigx', method: 'POST', body: { op: 'cat.add', name: '公开' } });
  const view = async (v6) => (await call(b, '/curio/api/links', { v6 })).json();
  for (const who of ['styrigx', 'root']) {
    const r = await view(who);
    assert.equal(r.canWrite, true, who);
    assert.equal(r.showPrivate, true, who);
    assert.ok(r.cats.some((c) => JSON.stringify(c.name).includes('私密')), who);
  }
  for (const who of ['alice', 'temp', 'expired', undefined]) {
    const r = await view(who);
    assert.equal(r.canWrite, false, String(who));
    assert.equal(r.showPrivate, false, String(who));
    assert.ok(!r.cats.some((c) => JSON.stringify(c.name).includes('私密')), String(who));
  }
  for (const p of ['/curio/api/items', '/curio/api/movies', '/curio/api/music']) {
    assert.equal((await (await call(b, p, { v6: 'styrigx' })).json()).canWrite, true, p);
    assert.equal((await (await call(b, p, { v6: 'alice' })).json()).canWrite, false, p);
  }
  /* 问的是 GET 路由的 action private */
  const asked = b.calls.filter((c) => c.path === '/curio/api/links' && c.method === 'GET');
  assert.ok(asked.length > 0 && asked.every((c) => c.opts && c.opts.action === 'private'));
});

test('没带 sgx-session 不问 admit；旧会话够用时也不问；网关出错 / 回答里 action 对不上 → 当没有 v6（不抛错、不 500）', async () => {
  const b = bench();
  await call(b, '/curio/api/links');
  await call(b, '/curio/api/links', { method: 'POST', body: { op: 'cat.add', name: 'x' } });
  await call(b, '/curio/api/links', { old: 'owner', v6: 'styrigx', method: 'POST', body: { op: 'cat.add', name: 'y' } });
  assert.equal(b.calls.length, 0);
  const down = await call(b, '/curio/api/links', { v6: 'styrigx', method: 'POST', body: { op: 'cat.add', name: 'z' }, throws: true });
  assert.equal(down.status, 401);
  /* 旧版本账号 Worker：不认 action，回路由档（没有 action 字段）→ 不当 action 的结论 */
  assert.equal(A.normalizeAdmit({ allowed: true, uid: 1000, root: false }, 'album.del').allowed, false);
  assert.equal(A.normalizeAdmit({ allowed: true, uid: 1000, root: false, action: 'album.del' }, 'album.del').allowed, true);
  assert.equal(A.normalizeAdmit({ allowed: true, uid: null }).allowed, false, '没有 uid（public 档的访客）不算 v6 放行');
  assert.equal(A.normalizeAdmit({ allowed: true, uid: 0, root: true, rescue: true }).root, false, '救援不算 root（审计）');
  assert.equal(A.normalizeAdmit('junk').allowed, false);
});
