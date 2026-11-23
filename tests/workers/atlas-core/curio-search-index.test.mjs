// 奇趣的全站搜索索引（workers/atlas-core/src/curio/search-index.js，2026-11-14 合并进 atlas-core，KV styrigx-space-core 的 site:curio）：
// - 条目映射：收藏 / 游戏各出 zh + en 两条；标题、副标题（页签 · 分类 / 平台 · 状态）、text、url 深链（设备、电影奇趣重组 PR 3 删了，不进索引）
// - 私密：分类或收藏任一私密 → private:true；私密游戏同样；公开的不带 private
// - 改内容的写接口（links / import / 游戏 /games/api/games）成功后 ctx.waitUntil 重建并 put；读接口、失败的写、封面接口不重建
// - Cron scheduled 重建；KV / D1 出错、绑定缺失都只打日志不抛，接口照常回答
// SQL 用 node:sqlite 真跑（CI 用 Node 22）。运行：node --test tests/workers/atlas-core/curio-search-index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoAuth } from '../_v6who.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const W = REPO + '/workers/atlas-core/src/curio';
const worker = (await import(W + '/app.js')).default;
const SI = await import(W + '/search-index.js');

/** node:sqlite 包成 D1 的样子（batch 是一个事务；SELECT 回 results） */
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
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      db.exec('BEGIN');
      try { const out = list.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
function makeKV({ fail = false } = {}) {
  const m = new Map();
  const meta = new Map();
  return {
    m, meta, puts: 0, reads: 0,
    async put(k, v, opt = {}) { this.puts++; if (fail) throw new Error('kv down'); m.set(k, v); meta.set(k, opt.metadata ?? null); },
    async get(k) { return m.get(k) ?? null; },
    async getWithMetadata(k) { this.reads++; return { value: m.get(k) ?? null, metadata: meta.get(k) ?? null }; },
  };
}
function makeR2() {
  const m = new Map();
  return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { body: m.get(k), httpMetadata: {} } : null; }, async delete(k) { m.delete(k); } };
}
/* 网关 v6 替身（../_v6who.mjs）：'owner' root、'lock' 有身份没组 */
const auth = (who) => whoAuth(who);
const ORIGIN = 'https://styrigx.com';
const SITE = ORIGIN + '/curio';

/** 发请求并等完 waitUntil 里的活 */
async function call(env, p, { who = 'owner', method = 'GET', body } = {}) {
  const pending = [];
  const headers = { Cookie: 'sgx-session=x', Origin: ORIGIN };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(
    new Request(ORIGIN + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    { SPACE: auth(who), ...env },
    { waitUntil: (x) => pending.push(x) },
  );
  await Promise.all(pending);
  return { res, pending: pending.length };
}
/** 静音 console.error，返回收集到的日志 */
async function quiet(fn) {
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try { return { out: await fn(), logs }; } finally { console.error = orig; }
}

async function seeded() {
  const d1 = makeD1();
  await SI.buildIndex(d1); // 建表
  d1.raw.exec(`
    INSERT INTO cats (id, name_zh, name_en, private, pos) VALUES (1, '工具', 'Tools', 0, 0), (2, '私藏', 'Secret', 1, 1);
    INSERT INTO links (id, cat_id, url, name_zh, name_en, desc_zh, desc_en, private, pos) VALUES
      (10, 1, 'https://a.example/', '好工具', '', '一个好用的工具', 'A handy tool', 0, 0),
      (11, 1, 'https://b.example/', '', 'Only English', '', 'desc en', 1, 1),
      (12, 2, 'https://c.example/', '藏起来', 'Hidden', '', '', 0, 0);
    INSERT INTO games (id, title, platform, edition, status, review, private, pos) VALUES
      (1, '塞尔达传说', 'Switch', '王国之泪', 'done', '自由', 0, 0),
      (2, '秘密游戏', '', '', 'want', '', 1, 1);
  `);
  return d1;
}
const byId = (ix) => new Map(ix.items.map((it) => [it.id, it]));

test('buildIndex：收藏 / 游戏各出 zh + en 两条，标题、副标题、text、深链；没有设备 / 电影（奇趣重组 PR 3）', async () => {
  const ix = await SI.buildIndex(await seeded(), Date.UTC(2026, 9, 22));
  assert.equal(ix.site, 'curio');
  assert.equal(ix.generated, '2026-10-22T00:00:00.000Z');
  assert.equal(ix.items.length, 10);
  const m = byId(ix);
  assert.equal(ix.items.some((it) => /^(device|movie):/.test(it.id)), false);
  assert.equal('deviceItems' in SI, false);
  assert.equal('movieItems' in SI, false);
  for (const it of ix.items) {
    assert.equal(it.type, 'item');
    assert.ok(it.url.startsWith(it.id.startsWith('game:') ? 'https://styrigx.com/games/' : SITE + '/'), it.id);
    assert.ok(!it.text || it.text.length <= 2000);
  }
  assert.deepEqual(m.get('link:10'), {
    id: 'link:10', type: 'item', lang: 'zh', title: '好工具', url: SITE + '/zh/#c/1',
    subtitle: '发现 · 工具', text: '一个好用的工具\nA handy tool\nhttps://a.example/',
  });
  // 英文名空着 → 用中文名；分类名、页签名用英文；链到 /（英文默认，P4-3 PR-4c）；奇趣重组 PR 2 起发现 = 奇趣首页（不再是 /curio/finds/）
  const en = m.get('link:10:en');
  assert.equal(en.lang, 'en');
  assert.equal(en.title, '好工具');
  assert.equal(en.subtitle, 'Finds · Tools');
  assert.equal(en.url, SITE + '/#c/1');
  assert.equal(m.get('link:11').title, 'Only English');

  assert.equal(m.get('game:1').title, '塞尔达传说');
  assert.equal(m.get('game:1').subtitle, '游戏 · Switch · 通关');
  assert.equal(m.get('game:1:en').subtitle, 'Games · Switch · Finished');
  assert.equal(m.get('game:1').text, 'Switch\n王国之泪\n自由');
  // 奇趣重组 PR 2：游戏是第五个子站，链到这一款 /games/?game=<id>（中文 /games/zh/?game=<id>）
  assert.equal(m.get('game:1').url, 'https://styrigx.com/games/zh/?game=1');
  assert.equal(m.get('game:1:en').url, 'https://styrigx.com/games/?game=1');
  assert.equal(SI.gameUrl('zh', 7), 'https://styrigx.com/games/zh/?game=7');
});

test('私密：分类或收藏任一私密 → private:true；私密游戏同样；公开的不带 private', async () => {
  const m = byId(await SI.buildIndex(await seeded()));
  for (const id of ['link:11', 'link:11:en', 'link:12', 'link:12:en', 'game:2', 'game:2:en']) {
    assert.equal(m.get(id).private, true, id);
  }
  for (const id of ['link:10', 'link:10:en', 'game:1', 'game:1:en']) assert.equal('private' in m.get(id), false, id);
  // 分类不在了（孤儿收藏）也当私密，链到奇趣首页（中文条目 → /curio/zh/；奇趣重组 PR 2 前是发现子页 /curio/zh/finds/）
  const orphan = SI.linkItems({ id: 9, cat_id: 99, url: 'https://x/', name_zh: '孤儿', name_en: '' }, undefined);
  assert.equal(orphan[0].private, true);
  assert.equal(orphan[0].url, SITE + '/zh/');
  assert.equal(orphan[0].subtitle, '发现');
});

test('截断：标题 ≤ 80 字、text ≤ 2000 字；没名字不出条目', () => {
  const [it] = SI.gameItems({ id: 3, title: '长'.repeat(200), status: 'nope', review: 'x'.repeat(5000) });
  assert.equal([...it.title].length, 80);
  assert.ok(it.title.endsWith('…'));
  assert.equal(it.text.length, 2000);
  assert.equal(it.subtitle, '游戏', '不认识的状态不进副标题');
  assert.deepEqual(SI.gameItems({ id: 4, title: '  ' }), []);
});

test('改收藏成功后 waitUntil 重建并 put site:curio；读接口、失败的写不重建', async () => {
  const env = { D1_FINDS: makeD1(), KV_SEARCH_INDEX: makeKV(), R2_PHOTOS: makeR2() };
  let r = await call(env, '/curio/api/links');
  assert.equal(r.res.status, 200);
  assert.equal(env.KV_SEARCH_INDEX.puts, 0);

  r = await call(env, '/curio/api/links', { method: 'POST', body: { op: 'cat.add', name: { zh: '新分类' } } });
  assert.equal(r.res.status, 200);
  assert.equal(env.KV_SEARCH_INDEX.puts, 1);
  r = await call(env, '/curio/api/links', { method: 'POST', body: { op: 'link.add', cat: 1, url: 'https://new.example/', name: { zh: '新收藏' } } });
  assert.equal(r.res.status, 200);
  assert.equal(env.KV_SEARCH_INDEX.puts, 2);
  const ix = JSON.parse(env.KV_SEARCH_INDEX.m.get('site:curio'));
  assert.equal(ix.site, 'curio');
  assert.deepEqual(ix.items.map((it) => it.title), ['新收藏', '新收藏']);

  r = await call(env, '/curio/api/links', { method: 'POST', body: { op: 'link.del', id: 999 } });
  assert.equal(r.res.status, 404);
  r = await call(env, '/curio/api/links', { who: 'lock', method: 'POST', body: { op: 'cat.add', name: { zh: 'x' } } });
  assert.equal(r.res.status, 403); /* 档不够：403 forbidden，不重建 */
  assert.equal(env.KV_SEARCH_INDEX.puts, 2);
});

test('改游戏（/games/api/games）成功后也重建；封面接口、删掉的旧接口不重建', async () => {
  const db = makeD1();
  const env = { D1_FINDS: db, D1_GAMES: db, KV_SEARCH_INDEX: makeKV(), R2_PHOTOS: makeR2() };
  assert.equal((await call(env, '/curio/api/items', { method: 'POST', body: { op: 'game.add', title: 'x' } })).res.status, 401, '旧接口删了');
  assert.equal(env.KV_SEARCH_INDEX.puts, 0);
  const r = await call(env, '/games/api/games', { method: 'POST', body: { op: 'game.add', title: '空洞骑士', platform: 'PC', status: 'playing' } });
  assert.equal(r.res.status, 200, await r.res.clone().text());
  assert.equal(env.KV_SEARCH_INDEX.puts, 1);
  const ix = JSON.parse(env.KV_SEARCH_INDEX.m.get('site:curio'));
  assert.equal(ix.items[0].subtitle, '游戏 · PC · 在玩');
  assert.equal(SI.isContentMutation('/api/cover', 'POST', 200), false);
  assert.equal(SI.isContentMutation('/api/cover', 'DELETE', 200), false);
  assert.equal(SI.isContentMutation('/api/import', 'POST', 200), true);
  assert.equal(SI.isContentMutation('/api/games', 'GET', 200), false);
  assert.equal(SI.isContentMutation('/api/games', 'POST', 409), false);
  for (const gone of ['/api/items', '/api/movies', '/api/photo']) assert.equal(SI.isContentMutation(gone, 'POST', 200), false, gone);
});

test('Cron scheduled：重建并 put', async () => {
  const env = { D1_FINDS: await seeded(), KV_SEARCH_INDEX: makeKV() };
  const pending = [];
  await worker.scheduled({ cron: '23 * * * *' }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(env.KV_SEARCH_INDEX.puts, 1);
  assert.equal(JSON.parse(env.KV_SEARCH_INDEX.m.get('site:curio')).items.length, 10);
});

test('出错不抛：KV 写失败、D1 出错、绑定缺失只打日志；写接口照常 200', async () => {
  let q = await quiet(() => SI.rebuildSearchIndex({ D1_FINDS: makeD1(), KV_SEARCH_INDEX: makeKV({ fail: true }) }));
  assert.deepEqual(q.out, { ok: false, error: 'rebuild-failed' });
  assert.ok(q.logs.some((l) => l.includes('[curio-search]')));
  const badDb = { prepare() { throw new Error('d1 down'); }, batch: async () => { throw new Error('d1 down'); } };
  q = await quiet(() => SI.rebuildSearchIndex({ D1_FINDS: badDb, KV_SEARCH_INDEX: makeKV() }));
  assert.equal(q.out.ok, false);
  q = await quiet(() => SI.rebuildSearchIndex({ D1_FINDS: makeD1() }));
  assert.deepEqual(q.out, { ok: false, error: 'kv-binding-missing' });
  q = await quiet(() => SI.rebuildSearchIndex({ KV_SEARCH_INDEX: makeKV() }));
  assert.deepEqual(q.out, { ok: false, error: 'db-binding-missing' });

  const env = { D1_FINDS: makeD1(), KV_SEARCH_INDEX: makeKV({ fail: true }), R2_PHOTOS: makeR2() };
  q = await quiet(() => call(env, '/curio/api/links', { method: 'POST', body: { op: 'cat.add', name: { zh: 'a' } } }));
  assert.equal(q.out.res.status, 200);
  assert.equal(q.out.pending, 1);
  q = await quiet(() => worker.scheduled({}, { D1_FINDS: makeD1(), KV_SEARCH_INDEX: makeKV({ fail: true }) }, { waitUntil() {} }));
  assert.equal(q.out, undefined);
});

test('Cron 兜底：内容和 KV 里那份一样就不写；内容变了、旧值没有 metadata、读出错都照常写', async () => {
  const db = makeD1();
  const env = { D1_FINDS: db, D1_GAMES: db, KV_SEARCH_INDEX: makeKV(), R2_PHOTOS: makeR2() };
  const cron = async () => {
    const pending = [];
    await worker.scheduled({ cron: '23 * * * *', scheduledTime: Date.UTC(2026, 9, 26, 1, 23) }, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  };
  /* 第一次：KV 里没有 → 写，metadata 带内容指纹 */
  await cron();
  assert.equal(env.KV_SEARCH_INDEX.puts, 1);
  const sha = env.KV_SEARCH_INDEX.meta.get('site:curio').sha;
  assert.match(sha, /^[0-9a-f]{64}$/);
  assert.equal(sha, await SI.contentSha(JSON.parse(env.KV_SEARCH_INDEX.m.get('site:curio'))));
  /* 内容没变：只读一次，不写（generated 时间不算内容） */
  await cron();
  await cron();
  assert.equal(env.KV_SEARCH_INDEX.puts, 1);
  assert.equal(env.KV_SEARCH_INDEX.reads, 3);
  /* 写接口改了内容：照常写（不先读） */
  const r = await call(env, '/games/api/games', { method: 'POST', body: { op: 'game.add', title: '空洞骑士', platform: 'PC', status: 'playing' } });
  assert.equal(r.res.status, 200);
  assert.equal(env.KV_SEARCH_INDEX.puts, 2);
  assert.equal(env.KV_SEARCH_INDEX.reads, 3);
  await cron();
  assert.equal(env.KV_SEARCH_INDEX.puts, 2);
  /* 有人直接改了 KV（没 metadata，比如旧版本写的）→ 写回 */
  env.KV_SEARCH_INDEX.meta.set('site:curio', null);
  await cron();
  assert.equal(env.KV_SEARCH_INDEX.puts, 3);
  /* 读出错 → 照常写 */
  env.KV_SEARCH_INDEX.getWithMetadata = async () => { throw new Error('kv read down'); };
  await cron();
  assert.equal(env.KV_SEARCH_INDEX.puts, 4);
  /* 不带 skipUnchanged（写接口那条路）：不读、照写 */
  const kv = makeKV();
  await SI.rebuildSearchIndex({ D1_FINDS: db, KV_SEARCH_INDEX: kv });
  await SI.rebuildSearchIndex({ D1_FINDS: db, KV_SEARCH_INDEX: kv });
  assert.equal(kv.puts, 2);
  assert.equal(kv.reads, 0);
});
