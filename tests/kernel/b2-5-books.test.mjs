/**
 * B2-5：GET /api/books（我的文件 › 书籍）
 * - 无会话 → 401
 * - owner → 全部书（SQL 不带 visibility 过滤），私有书封面走书库 /api/private/cover
 * - visitor → 只查 visibility='public'
 * - 未绑定 BOOKS_D1 → 200 {ok:false, books:[]}
 * - 只读：只调用 prepare().all()，不出现 INSERT/UPDATE/DELETE
 *
 * 运行：node --test tests/kernel/b2-5-books.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const { onRequestGet, toBook } = await import(REPO + '/functions/api/books.js');
const { signSessionCookie } = await import(REPO + '/functions/_kernel/session.js');

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
const PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');

const ROWS = [
  { id: 'a1', title: '私有书', author: '甲', format: 'epub', cover_key: 'covers/0a-1b.webp', visibility: 'private', created_at: 2000 },
  { id: 'b2', title: 'Public', author: '', format: 'pdf', cover_key: null, visibility: 'public', created_at: 1000 },
];

function makeDb() {
  const sqls = [];
  return {
    sqls,
    prepare(sql) {
      sqls.push(sql);
      const rows = /visibility='public'/.test(sql) ? ROWS.filter((r) => r.visibility === 'public') : ROWS;
      return { all: async () => ({ results: rows }) };
    },
  };
}
function env(db) {
  return { SGX_LOCK_PUBLIC: PUB, OWNER_KV: { get: async () => '0' }, BOOKS_D1: db };
}
async function req(role) {
  const headers = {};
  if (role) headers.Cookie = 'sgx-verified=' + (await signSessionCookie(PRIV, 0, role, 'owner'));
  return new Request('https://styrigx.com/api/books', { headers });
}

test('no session → 401', async () => {
  const res = await onRequestGet({ request: await req(null), env: env(makeDb()) });
  assert.equal(res.status, 401);
});

test('owner → all books, private cover via book site private endpoint', async () => {
  const db = makeDb();
  const res = await onRequestGet({ request: await req('owner'), env: env(db) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.deepEqual(j.books.map((b) => b.id), ['a1', 'b2']);
  assert.equal(j.books[0].cover_url, 'https://book.styrigx.com/api/private/cover?key=covers%2F0a-1b.webp');
  assert.equal(j.books[0].read_url, 'https://book.styrigx.com/read/?id=a1');
  assert.equal(j.books[1].cover_url, '');
  assert.ok(!/visibility='public'/.test(db.sqls[0]));
  assert.ok(db.sqls.every((s) => /^SELECT /.test(s)));
  assert.ok(!('r2_key' in j.books[0]));
});

test('visitor → public books only', async () => {
  const db = makeDb();
  const j = await (await onRequestGet({ request: await req('visitor'), env: env(db) })).json();
  assert.deepEqual(j.books.map((b) => b.id), ['b2']);
  assert.ok(/visibility='public'/.test(db.sqls[0]));
});

test('BOOKS_D1 missing → empty list', async () => {
  const res = await onRequestGet({ request: await req('owner'), env: env(undefined) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: false, books: [] });
});

test('toBook rejects malformed cover keys', () => {
  assert.equal(toBook({ id: 'x', cover_key: '../secret', visibility: 'private' }, true).cover_url, '');
  assert.equal(toBook({ id: 'y', cover_key: 'covers/ab.webp', visibility: 'public' }, true).cover_url, 'https://book.styrigx.com/api/cover?key=covers%2Fab.webp');
});
