/**
 * 割接（v6 cutover）：奇趣接口 Worker 认 v6 会话（旧进站 / 账号结论随应用授权删除，定稿 v5.3 §十二）。
 * 判断经网关 SpaceVerifier.admit 问账号 Worker（这里的替身 ../_v6admit.mjs 用真的 ROUTE_ACCESS + permits）：
 * - 每条新接上的路由：v6 身份在对的档放行、访客 / 档不够被拒（401 / 403 forbidden）
 * - export / import / album.del = root（styrigx 也被拒，要 su root）；root 的这些操作经 auditRoot 留痕
 * - 公开读的私密行与 canManage（组权限 v1.1 §八：action private = curio-use、manage = curio-manage，两档分开问）
 * - 没带 sgx-session 不问 admit；网关出错 / 旧版本不认 action → 当没有 v6（fail closed）
 * 运行：node --test tests/workers/atlas-core/curio-v6-cutover.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { v6Space } from '../_v6admit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const W = REPO + '/workers/atlas-core/src/curio';
const worker = (await import(W + '/app.js')).default;
const A = await import(W + '/api/_auth.js');

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
/** @param {any} b @param {string} p @param {{v6?: string, method?: string, body?: any, type?: string, throws?: boolean}} [o] */
function call(b, p, o = {}) {
  const h = { Origin: ORIGIN };
  const ck = [];
  if (o.v6) ck.push('sgx-session=' + o.v6);
  if (ck.length) h.Cookie = ck.join('; ');
  if (o.body !== undefined) h['Content-Type'] = o.type || 'application/json';
  h['CF-Connecting-IP'] = '203.0.113.9';
  const body = o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
  const SPACE = v6Space({}, { calls: b.calls, audits: b.audits, throws: o.throws });
  const env = { SPACE, D1_FINDS: b.db, D1_GAMES: b.db, D1_MUSIC: b.db, R2_PHOTOS: b.r2, R2_MUSIC: b.r2m, KV_SEARCH_INDEX: { async put() {}, async get() { return null; } } };
  return worker.fetch(new Request(ORIGIN + p, { method: o.method || 'GET', headers: h, body }), env, { waitUntil() {} });
}
const j = async (r) => ({ status: r.status, json: await r.json().catch(() => null) });

test('写接口（curio-manage 档）：styrigx 的 v6 会话放行；alice（只有 music-use）/ 临时用户 403 forbidden；坏令牌 / 没 cookie 401 unauthorized', async () => {
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
  /* 其余 curio-manage 路由走同一套守卫 */
  /* 奇趣重组 PR 3：/curio/api/items、/curio/api/movies 删了——谁来都是表外路径 401（styrigx 也是） */
  for (const p of ['/curio/api/items', '/curio/api/movies']) assert.equal((await call(b, p, { v6: 'styrigx', method: 'POST', body: { op: 'game.add', title: 'G' } })).status, 401, p);
  assert.notEqual((await call(b, '/curio/api/preview?url=javascript:1', { v6: 'styrigx' })).status, 401, 'preview 归 curio-manage');
  assert.equal((await call(b, '/curio/api/preview?url=javascript:1', { v6: 'alice' })).status, 403);
});

test('root：curio-manage 档也放（permits 第 2 步）；救援会话一律拒（不在白名单）', async () => {
  const b = bench();
  assert.equal((await call(b, '/curio/api/links', { v6: 'root', method: 'POST', body: { op: 'cat.add', name: 'R' } })).status, 200);
  assert.equal((await call(b, '/curio/api/links', { v6: 'rescue', method: 'POST', body: { op: 'cat.add', name: 'R' } })).status, 403);
  assert.equal((await call(b, '/curio/api/export', { v6: 'rescue', headers: {} })).status, 403);
});

test('导出 GET /curio/api/export = root：root 200 并留痕 export；styrigx（manage 组）也 403；访客 401', async () => {
  const b = bench();
  const r = await call(b, '/curio/api/export', { v6: 'root' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Disposition') || '', /attachment/);
  assert.deepEqual(b.audits.map((a) => [a.command, a.ok]), [['export curio bookmarks', true]]);
  assert.equal(b.audits[0].ip, '203.0.113.9');
  assert.equal((await call(b, '/curio/api/export', { v6: 'styrigx' })).status, 403);
  assert.equal((await call(b, '/curio/api/export', {})).status, 401);
  assert.equal(b.audits.length, 1, '没放行的不留痕');
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
});

test('音乐：album.del = root（结构删除，留痕 rm-bulk）；album.add / track.* = music-manage；听歌 = music-use（alice 有、临时用户没有）', async () => {
  const b = bench();
  const add = await j(await call(b, '/music/api/music', { v6: 'styrigx', method: 'POST', body: { op: 'album.add', title: 'A' } }));
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const id = add.json.id;
  const del = (v6) => call(b, '/music/api/music', { v6, method: 'POST', body: { op: 'album.del', id } });
  const no = await j(await del('styrigx'));
  assert.equal(no.status, 403, 'styrigx 删整张专辑要 su root');
  assert.equal(no.json.error, 'forbidden');
  assert.equal((await call(b, '/music/api/music', { v6: 'alice', method: 'POST', body: { op: 'album.add', title: 'B' } })).status, 403);
  assert.equal((await del('root')).status, 200);
  assert.deepEqual(b.audits.map((a) => a.command), ['rm-bulk curio album ' + id]);
  /* 听歌：music-use */
  assert.notEqual((await call(b, '/music/api/music-play', { v6: 'alice', method: 'POST', body: { track: 1 } })).status, 401);
  assert.notEqual((await call(b, '/music/api/music-play', { v6: 'alice', method: 'POST', body: { track: 1 } })).status, 403);
  assert.equal((await call(b, '/music/api/music-play', { v6: 'temp', method: 'POST', body: { track: 1 } })).status, 403);
  assert.equal((await call(b, '/music/api/music-upload', { v6: 'alice', method: 'POST', body: 'x' })).status, 403, '上传归 music-manage');
});

test('公开读：私密行按 action private（= curio-use）、canManage 按 action manage（= curio-manage）——styrigx / root 看得到，alice / 访客只拿公开的', async () => {
  const b = bench();
  await call(b, '/curio/api/links', { v6: 'styrigx', method: 'POST', body: { op: 'cat.add', name: '私密', private: true } });
  await call(b, '/curio/api/links', { v6: 'styrigx', method: 'POST', body: { op: 'cat.add', name: '公开' } });
  const view = async (v6) => (await call(b, '/curio/api/links', { v6 })).json();
  for (const who of ['styrigx', 'root']) {
    const r = await view(who);
    assert.equal(r.canManage, true, who);
    assert.equal(r.showPrivate, true, who);
    assert.ok(r.cats.some((c) => JSON.stringify(c.name).includes('私密')), who);
  }
  for (const who of ['alice', 'temp', 'expired', undefined]) {
    const r = await view(who);
    assert.equal(r.canManage, false, String(who));
    assert.equal(r.showPrivate, false, String(who));
    assert.ok(!r.cats.some((c) => JSON.stringify(c.name).includes('私密')), String(who));
  }
  for (const p of ['/curio/api/links', '/music/api/music']) {
    assert.equal((await (await call(b, p, { v6: 'styrigx' })).json()).canManage, true, p);
    assert.equal((await (await call(b, p, { v6: 'alice' })).json()).canManage, false, p);
  }
  /* 问的是 GET 路由的 action private 与 manage（公用 visibility，两档分开问） */
  const asked = b.calls.filter((c) => c.path === '/curio/api/links' && c.method === 'GET');
  assert.ok(asked.length > 0 && asked.every((c) => c.opts && (c.opts.action === 'private' || c.opts.action === 'manage')));
  assert.ok(asked.some((c) => c.opts.action === 'private') && asked.some((c) => c.opts.action === 'manage'));
});

test('没带 sgx-session 不问 admit；网关出错 / 回答里 action 对不上 → 当没有 v6（不抛错、不 500）', async () => {
  const b = bench();
  await call(b, '/curio/api/links');
  await call(b, '/curio/api/links', { method: 'POST', body: { op: 'cat.add', name: 'x' } });
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

/* ---------- 组权限 v1.1 §八「以后加一样东西，固定四步」第 4 步的测试模板：访客看不到私密行；只有 use 的看得到私密行、canManage 为 false、写接口 403；有 manage 的都行 ---------- */

test('组权限 v1.1 模板 · 奇趣：访客 / alice 看不到私密行；viewer（只有 curio-use）看得到私密行、canManage false、写 403；keeper（只有 curio-manage）、styrigx、root 都行', async () => {
  const b = bench();
  await call(b, '/curio/api/links', { v6: 'styrigx', method: 'POST', body: { op: 'cat.add', name: '私密', private: true } });
  const lj = await j(await call(b, '/curio/api/links', { v6: 'styrigx', method: 'POST', body: { op: 'cat.add', name: '公开' } }));
  const pub = lj.json.cats.find((c) => JSON.stringify(c.name).includes('公开'));
  const sec = lj.json.cats.find((c) => JSON.stringify(c.name).includes('私密'));
  assert.equal((await call(b, '/curio/api/links', { v6: 'styrigx', method: 'POST', body: { op: 'link.add', cat: pub.id, url: 'https://pub.example/', name: '公开收藏' } })).status, 200);
  assert.equal((await call(b, '/curio/api/links', { v6: 'styrigx', method: 'POST', body: { op: 'link.add', cat: sec.id, url: 'https://sec.example/', name: '私密收藏' } })).status, 200);
  /* 奇趣重组 PR 3 删了设备 /curio/api/items 和照片 /curio/api/photo：奇趣的模板只剩收藏（私密封面的同类用例在 games.test.mjs，按 games-use 问） */
  const look = async (who) => {
    const links = (await j(await call(b, '/curio/api/links', { v6: who }))).json;
    return { links, seesPrivate: JSON.stringify(links.cats).includes('私密收藏') };
  };
  for (const who of [undefined, 'alice', 'temp']) {
    const v = await look(who);
    assert.equal(v.seesPrivate, false, String(who) + ' 看不到私密行');
    assert.ok(JSON.stringify(v.links.cats).includes('公开收藏'), String(who) + ' 公开的照常');
    assert.deepEqual([v.links.showPrivate, v.links.canManage], [false, false], String(who));
  }
  const viewer = await look('viewer');
  assert.equal(viewer.seesPrivate, true, 'viewer（curio-use）看得到私密行（v1.1 §七 A）');
  assert.deepEqual([viewer.links.showPrivate, viewer.links.canManage], [true, false], 'use 不给 canManage');
  for (const [p, body] of [['/curio/api/links', { op: 'cat.add', name: 'v' }]]) {
    const r = await j(await call(b, p, { v6: 'viewer', method: 'POST', body }));
    assert.equal(r.status, 403, 'viewer 写 ' + p);
    assert.equal(r.json.error, 'forbidden');
  }
  assert.equal((await call(b, '/curio/api/preview?url=javascript:1', { v6: 'viewer' })).status, 403, 'viewer 抓预览（管理）403');
  for (const who of ['keeper', 'styrigx', 'root']) {
    const v = await look(who);
    assert.equal(v.seesPrivate, true, who + ' 看得到私密行（manage 包含 use）');
    assert.deepEqual([v.links.showPrivate, v.links.canManage], [true, true], who);
    const w = await j(await call(b, '/curio/api/links', { v6: who, method: 'POST', body: { op: 'cat.add', name: 'w-' + who } }));
    assert.equal(w.status, 200, who + ' 写');
    assert.equal(w.json.canManage, true);
    assert.equal(w.json.canWrite, undefined, '旧字段 canWrite 不留别名');
  }
  const l = (await j(await call(b, '/curio/api/links', { v6: 'viewer' }))).json;
  assert.deepEqual([l.showPrivate, l.canManage, l.canWrite], [true, false, undefined]);
});

test('组权限 v1.1 模板 · 音乐（搬家第 1 步换档；第 4 步起只在 /music/api/*）：viewer（music-use）能听、canManage false、上传 / 管理 403；keeper（music-manage）能管；curio-manage 管不了音乐', async () => {
  const b = bench();
  const add = await j(await call(b, '/music/api/music', { v6: 'styrigx', method: 'POST', body: { op: 'album.add', title: 'A' } }));
  assert.equal(add.status, 200, JSON.stringify(add.json));
  for (const who of [undefined, 'alice', 'temp', 'viewer']) {
    const r = (await j(await call(b, '/music/api/music', { v6: who }))).json;
    assert.equal(r.canManage, false, String(who));
    assert.equal(r.canWrite, undefined, '旧字段 canWrite 不留别名');
  }
  assert.notEqual((await call(b, '/music/api/music-play', { v6: 'viewer', method: 'POST', body: { track: 1 } })).status, 403, 'viewer 能签播放令牌（music-use）');
  assert.equal((await call(b, '/music/api/music', { v6: 'viewer', method: 'POST', body: { op: 'album.add', title: 'B' } })).status, 403, 'viewer 管不了');
  assert.equal((await call(b, '/music/api/music-upload', { v6: 'viewer', method: 'POST', body: 'x' })).status, 403, 'viewer 传不了');
  const keeper = (await j(await call(b, '/music/api/music', { v6: 'keeper' }))).json;
  assert.equal(keeper.canManage, true, 'keeper（music-manage）');
  assert.notEqual((await call(b, '/music/api/music-play', { v6: 'keeper', method: 'POST', body: { track: 1 } })).status, 403, 'music-manage 包含 music-use');
  const k = await j(await call(b, '/music/api/music', { v6: 'keeper', method: 'POST', body: { op: 'album.add', title: 'K' } }));
  assert.equal(k.status, 200);
  assert.deepEqual([k.json.canManage, k.json.canWrite], [true, undefined]);
  assert.equal((await call(b, '/music/api/music', { v6: 'keeper', method: 'POST', body: { op: 'album.del', id: k.json.id } })).status, 403, 'album.del 仍只属 root');
  /* 只有 curio-manage 的身份：管得了奇趣、管不了音乐（音乐的写权限从 curio-write 拆出，v1.1 §三） */
  const only = { uid: 1000, name: 'styrigx', groups: ['curio-manage'], rescue: false };
  const AD = await import(REPO + '/workers/account/src/core/admit.js');
  const RA = await import(REPO + '/workers/account/src/core/route-access.js');
  assert.equal(AD.admitDecision(only, RA.levelOf('POST', '/curio/api/links'), {}), true);
  assert.equal(AD.admitDecision(only, RA.levelOf('POST', '/music/api/music'), {}), false);
  assert.equal(AD.admitDecision(only, RA.levelOf('POST', '/music/api/music-upload'), {}), false);
  assert.equal(AD.admitDecision(only, RA.levelOf('POST', '/music/api/music-play'), {}), false);
});
