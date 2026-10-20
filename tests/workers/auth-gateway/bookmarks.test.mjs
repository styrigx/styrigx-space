/**
 * 书签在线管理（D1）：/api/bookmarks、/api/bookmark-preview
 * - 种子和 links.yaml 一致；首次读导入一次，删光后不再导入
 * - 读：无会话 401；访客、主人都能读；没绑 D1 → {ok:false, cats:[]}
 * - 写：非同源 403；访客 403；参数校验；增删改排序；分类非空不能删
 * - 预览：访客 403；内网/本机/自家域名不抓；HTML 解析标题、简介、图标
 *
 * 读写的 SQL 用 node:sqlite 真跑（Node 22+）；CI 的 Node 20 没有 node:sqlite 时这几条跳过，其余照跑。
 * 运行：node --test tests/workers/auth-gateway/bookmarks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const api = await import(REPO + '/workers/auth-gateway/functions/api/bookmarks.js');
const preview = await import(REPO + '/workers/auth-gateway/functions/api/bookmark-preview.js');
const K = await import(REPO + '/workers/auth-gateway/functions/_kernel/bookmarks.js');
const LP = await import(REPO + '/workers/auth-gateway/functions/_kernel/link-preview.js');
const { BOOKMARKS_SEED } = await import(REPO + '/workers/auth-gateway/functions/_kernel/bookmarks-seed.js');
const { buildSeed } = await import(REPO + '/scripts/gen-bookmarks-seed.mjs');
const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
const { API_ROUTES } = await import(REPO + '/workers/auth-gateway/src/routes.js');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (e) {
  /* Node 20：没有 node:sqlite */
}
const SQL = { skip: DatabaseSync ? false : 'node:sqlite 不可用（Node < 22）' };

/** 用 node:sqlite 模拟 D1 的 prepare/bind/run/all/first/batch */
function makeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes) } };
    },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) || null,
    _exec: () => (/^\s*(SELECT)/i.test(sql) ? { results: db.prepare(sql).all(...args) } : { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => s._exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
const PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');

const env = (db) => ({ SGX_LOCK_PUBLIC: PUB, OWNER_KV: { get: async () => '0' }, SGX_D1: db });
async function cookie(role) {
  return role ? { Cookie: 'sgx-verified=' + (await signSessionCookie(PRIV, 0, role, 'owner')) } : {};
}
async function get(role, db) {
  const req = new Request('https://styrigx.com/api/bookmarks', { headers: await cookie(role) });
  return api.onRequestGet({ request: req, env: env(db) });
}
async function post(role, db, body, origin = 'https://styrigx.com') {
  const headers = { ...(await cookie(role)), 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  const req = new Request('https://styrigx.com/api/bookmarks', { method: 'POST', headers, body: JSON.stringify(body) });
  return api.onRequestPost({ request: req, env: env(db) });
}

/* ---- 种子 / 路由 ---- */

test('种子和 links.yaml、en/links.yaml 一致', () => {
  assert.deepEqual(BOOKMARKS_SEED, buildSeed());
  assert.ok(BOOKMARKS_SEED.length > 0);
  for (const c of BOOKMARKS_SEED) {
    assert.ok(c.name.zh && c.name.en);
    for (const l of c.links) assert.ok(K.cleanUrl(l.url), l.url);
  }
});

test('路由表登记了 /api/bookmarks 和 /api/bookmark-preview', () => {
  assert.ok(API_ROUTES.get('/api/bookmarks'));
  assert.ok(API_ROUTES.get('/api/bookmark-preview'));
});

/* ---- 校验（不碰库） ---- */

test('parseOp：网址只收 http/https，不收带账号密码的', () => {
  assert.equal(K.parseOp({ op: 'link.add', cat: 1, url: 'javascript:alert(1)', name: 'x' }).error, 'bad-url');
  assert.equal(K.parseOp({ op: 'link.add', cat: 1, url: 'https://a:b@x.com', name: 'x' }).error, 'bad-url');
  assert.equal(K.parseOp({ op: 'link.add', cat: 1, url: 'ftp://x.com', name: 'x' }).error, 'bad-url');
  const ok = K.parseOp({ op: 'link.add', cat: 1, url: ' https://x.com ', name: '名字' });
  assert.equal(ok.url, 'https://x.com/');
  assert.deepEqual(ok.name, { zh: '名字', en: '' });
});

test('parseOp：名字必填、截断、去控制字符；排序名单不许重复', () => {
  assert.equal(K.parseOp({ op: 'cat.add', name: { zh: ' ', en: '' } }).error, 'bad-name');
  assert.equal(K.parseOp({ op: 'cat.add', name: 'a\u0000b'.padEnd(100, 'c') }).name.zh.length, 40);
  assert.equal(K.parseOp({ op: 'cat.add', name: 'a\u0000b' }).name.zh, 'ab');
  assert.equal(K.parseOp({ op: 'cat.order', ids: [1, 1] }).error, 'bad-ids');
  assert.equal(K.parseOp({ op: 'link.edit', id: 3 }).error, 'nothing');
  assert.equal(K.parseOp({ op: 'drop.table' }).error, 'bad-op');
  assert.equal(K.cleanIcon('http://x.com/a.png'), '');
});

/* ---- 鉴权 ---- */

test('GET 无会话 → 401；没绑 D1 → {ok:false, cats:[]}', async () => {
  assert.equal((await get(null, null)).status, 401);
  const j = await (await get('visitor', null)).json();
  assert.deepEqual(j, { ok: false, cats: [] });
});

test('POST：非同源 403、没 Origin 403、访客 403、坏 JSON 400', async () => {
  const db = { prepare() { throw new Error('不该碰库'); } };
  assert.equal((await post('owner', db, { op: 'cat.add', name: 'x' }, 'https://evil.com')).status, 403);
  assert.equal((await post('owner', db, { op: 'cat.add', name: 'x' }, null)).status, 403);
  const v = await post('visitor', db, { op: 'cat.add', name: 'x' });
  assert.equal(v.status, 403);
  assert.equal((await v.json()).error, 'role');
  const req = new Request('https://styrigx.com/api/bookmarks', {
    method: 'POST',
    headers: { ...(await cookie('owner')), Origin: 'https://styrigx.com' },
    body: '{oops',
  });
  assert.equal((await api.onRequestPost({ request: req, env: env(db) })).status, 400);
});

/* ---- 读写（真跑 SQL） ---- */

test('首次读导入种子；访客也能读；删光后不再导入', SQL, async () => {
  const db = makeD1();
  const j = await (await get('visitor', db)).json();
  assert.equal(j.ok, true);
  assert.equal(j.cats.length, BOOKMARKS_SEED.length);
  assert.deepEqual(j.cats.map((c) => c.name), BOOKMARKS_SEED.map((c) => c.name));
  assert.deepEqual(j.cats[0].links.map((l) => l.url), BOOKMARKS_SEED[0].links.map((l) => l.url));
  /* 再读不重复导入 */
  const j2 = await (await get('owner', db)).json();
  assert.equal(j2.cats.reduce((n, c) => n + c.links.length, 0), BOOKMARKS_SEED.reduce((n, c) => n + c.links.length, 0));
  /* 删光 */
  for (const c of j2.cats) {
    for (const l of c.links) assert.equal((await post('owner', db, { op: 'link.del', id: l.id })).status, 200);
    assert.equal((await post('owner', db, { op: 'cat.del', id: c.id })).status, 200);
  }
  const j3 = await (await get('owner', db)).json();
  assert.deepEqual(j3.cats, []);
});

test('增、改、换分类、排序、删；分类非空不能删', SQL, async () => {
  const db = makeD1();
  await get('owner', db);
  let j = await (await post('owner', db, { op: 'cat.add', name: { zh: '新分类', en: 'New' } })).json();
  const cat = j.cats[j.cats.length - 1];
  assert.deepEqual(cat.name, { zh: '新分类', en: 'New' });

  j = await (await post('owner', db, { op: 'link.add', cat: cat.id, url: 'https://a.example', name: 'A', desc: { zh: '甲' } })).json();
  j = await (await post('owner', db, { op: 'link.add', cat: cat.id, url: 'https://b.example', name: 'B' })).json();
  let mine = j.cats.find((c) => c.id === cat.id);
  assert.deepEqual(mine.links.map((l) => l.name.zh), ['A', 'B']);
  assert.deepEqual(mine.links[0].desc, { zh: '甲', en: '' });

  const [a, b] = mine.links;
  j = await (await post('owner', db, { op: 'link.order', cat: cat.id, ids: [b.id, a.id] })).json();
  assert.deepEqual(j.cats.find((c) => c.id === cat.id).links.map((l) => l.id), [b.id, a.id]);
  assert.equal((await post('owner', db, { op: 'link.order', cat: cat.id, ids: [a.id] })).status, 409);

  j = await (await post('owner', db, { op: 'link.edit', id: a.id, name: { zh: 'A2', en: 'A2en' }, icon: 'https://a.example/i.png' })).json();
  const a2 = j.cats.find((c) => c.id === cat.id).links.find((l) => l.id === a.id);
  assert.deepEqual(a2.name, { zh: 'A2', en: 'A2en' });
  assert.equal(a2.icon, 'https://a.example/i.png');
  assert.equal(a2.url, 'https://a.example/');

  const r409 = await post('owner', db, { op: 'cat.del', id: cat.id });
  assert.equal(r409.status, 409);
  assert.equal((await r409.json()).error, 'not-empty');

  const first = j.cats[0].id;
  j = await (await post('owner', db, { op: 'link.edit', id: a.id, cat: first })).json();
  assert.equal(j.cats[0].links[j.cats[0].links.length - 1].id, a.id);

  const ids = j.cats.map((c) => c.id).reverse();
  j = await (await post('owner', db, { op: 'cat.order', ids })).json();
  assert.deepEqual(j.cats.map((c) => c.id), ids);
  assert.equal((await post('owner', db, { op: 'cat.order', ids: ids.slice(1) })).status, 409);

  assert.equal((await post('owner', db, { op: 'link.del', id: 99999 })).status, 404);
  assert.equal((await post('owner', db, { op: 'link.add', cat: 99999, url: 'https://x.com', name: 'x' })).status, 404);
});

test('两个请求同时首次读，种子只导入一次', SQL, async () => {
  const db = makeD1();
  await K.ensureSchema(db);
  const [x, y] = await Promise.all([K.seedIfNeeded(db), K.seedIfNeeded(db)]);
  assert.equal([x, y].filter(Boolean).length, 1);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM bm_cat').first();
  assert.equal(n.n, BOOKMARKS_SEED.length);
});

/* ---- 预览 ---- */

test('预览：访客 403、非同源 403、坏网址 400', async () => {
  const mk = async (role, url, origin = 'https://styrigx.com') =>
    preview.onRequestGet({
      request: new Request('https://styrigx.com/api/bookmark-preview?url=' + encodeURIComponent(url), {
        headers: { ...(await cookie(role)), ...(origin ? { Origin: origin } : {}) },
      }),
      env: env(null),
    });
  assert.equal((await mk('visitor', 'https://x.com')).status, 403);
  assert.equal((await mk('owner', 'https://x.com', 'https://evil.com')).status, 403);
  assert.equal((await mk('owner', 'javascript:1')).status, 400);
});

test('预览：内网、本机、自家域名、怪端口不抓', () => {
  for (const u of [
    'http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.20.0.1/',
    'http://169.254.169.254/', 'http://[::1]/', 'http://intranet/', 'https://styrigx.com/api/x',
    'https://daymark.styrigx.com/', 'https://x.local/', 'https://example.com:8080/',
  ]) assert.equal(LP.previewAllowed(u), false, u);
  for (const u of ['https://github.com/', 'http://8.8.8.8/', 'https://example.com:443/']) assert.equal(LP.previewAllowed(u), true, u);
});

test('预览：解析 og 标题、简介、图标（相对地址补全、实体解码）', () => {
  const html = `<html><head>
    <title>Fallback</title>
    <meta property="og:title" content="Tom &amp; Jerry">
    <meta name="description" content='一个 &quot;网站&quot;'>
    <link rel="shortcut icon" href="/f.ico">
    <link rel="apple-touch-icon" href="img/t.png">
  </head></html>`;
  const r = LP.parseHtmlMeta(html, 'https://ex.com/a/b');
  assert.deepEqual(r, { title: 'Tom & Jerry', desc: '一个 "网站"', icon: 'https://ex.com/a/img/t.png' });
  assert.deepEqual(LP.parseHtmlMeta('<title> Hi\n there </title>', 'http://ex.com/'), { title: 'Hi there', desc: '', icon: 'https://ex.com/favicon.ico' });
});

test('预览：跟随跳转并逐跳检查；跳去内网 → blocked', async () => {
  const pages = {
    'https://a.example/': new Response(null, { status: 301, headers: { Location: '/home' } }),
    'https://a.example/home': new Response('<title>Home</title>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    'https://evil.example/': new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/admin' } }),
  };
  const f = async (u) => pages[u] || new Response('', { status: 404 });
  assert.deepEqual(await LP.fetchPreview('https://a.example/', f), { ok: true, url: 'https://a.example/home', title: 'Home', desc: '', icon: 'https://a.example/favicon.ico' });
  assert.deepEqual(await LP.fetchPreview('https://evil.example/', f), { ok: false, error: 'blocked' });
  assert.deepEqual(await LP.fetchPreview('https://nope.example/', f), { ok: false, error: 'http-404' });
});
