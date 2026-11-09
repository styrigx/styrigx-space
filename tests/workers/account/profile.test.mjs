/**
 * 个人资料接口（2026-11-07 Gray 定；workers/account/src/api/profile.js、src/lib/profile.js）
 * - 字段表：姓名 / 昵称 / 签名 / 邮箱四项（头像另走 /avatar/*），与前端 space/web/assets/js/lib/profile.js 同名同序、长度一致
 * - 校验 checkField：去首尾空白；长度上限（按字符）；单行（控制字符、换行不收）；姓名、昵称、邮箱不能为空串，签名可空；邮箱格式；null = 清掉
 * - GET /api/profile：有进站会话即可；KV 没存 / 没绑 / 坏 JSON / 存了不合法的字段 → 对应字段 null（前端回退默认值），照样 200；回头像版本号
 * - PUT /api/profile：不同源 403；没有进站会话 401 session；没账号会话 401 account；没 profile.write 403 scope；
 *   不是 JSON / 空对象 / 不认识的字段 / 不合法的值 → 400 params（带 field、reason），整个请求不写；> 4 KB → 413；
 *   合法 → 与已存的合并写回一个键 profile；null 清掉；全清掉删键
 *
 * 运行：node --test tests/workers/account/profile.test.mjs
 */
import { wrap, testAccountSessionCookie } from './_auth.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testLockSession } from '../space-core/_tickets.mjs';
import { genKeyPair, authD1For } from '../_harness.mjs';
import { makeAccountD1 } from './_d1.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const api = await import(REPO + '/workers/account/src/api/profile.js');
const lib = await import(REPO + '/workers/account/src/lib/profile.js');
const onGet = wrap(api.onRequestGet);
const onPut = wrap(api.onRequestPut);

const { priv: PRIV, pub: PUB } = await genKeyPair();
const ACC = await genKeyPair();

function makeKv(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async getWithMetadata(k) { return { value: m.get(k) ?? null, metadata: null }; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}
const lockKv = makeKv();
function env(kv) {
  return {
    SGX_SPACE_PUBLIC: PUB, SGX_ACCOUNT_PUBLIC: ACC.pub,
    KV_PROFILE: kv,
    D1_SPACE: authD1For(lockKv), D1_ACCOUNT: makeAccountD1(),
  };
}
/** @param {string|null} role @param {boolean} [acc] */
async function cookie(role, acc) {
  const c = [];
  if (role) c.push('sgx-space-session=' + (await testLockSession(PRIV, 0, role)));
  if (acc) c.push(await testAccountSessionCookie(ACC.priv, 'password', 0, Date.now()));
  return c.join('; ');
}
async function getReq(role = 'password', acc = false) {
  const ck = await cookie(role, acc);
  return new Request('https://styrigx.com/api/profile', { headers: ck ? { Cookie: ck } : {} });
}
/** @param {any} body @param {{role?: string|null, acc?: boolean, origin?: string, raw?: boolean}} [o] */
async function putReq(body, o = {}) {
  const role = o.role === undefined ? 'password' : o.role;
  const headers = { Origin: o.origin || 'https://styrigx.com', 'Content-Type': 'application/json' };
  const ck = await cookie(role, o.acc === undefined ? true : o.acc);
  if (ck) headers.Cookie = ck;
  return new Request('https://styrigx.com/api/profile', { method: 'PUT', headers, body: o.raw ? body : JSON.stringify(body) });
}
const stored = (kv) => (kv.m.has('profile') ? JSON.parse(kv.m.get('profile')) : null);

/* ---------------- 字段表 / 校验 ---------------- */

test('字段表：name / nickname / motto / email（长度 40 / 32 / 120 / 254；签名可空），冻结；前端 lib/profile.js 同名同序同长度', () => {
  assert.deepEqual(lib.PROFILE_FIELDS.map((f) => [f.id, f.max, f.required, f.kind]), [
    ['name', 40, true, 'text'],
    ['nickname', 32, true, 'text'],
    ['motto', 120, false, 'text'],
    ['email', 254, true, 'email'],
  ]);
  assert.ok(Object.isFrozen(lib.PROFILE_FIELDS));
  for (const f of lib.PROFILE_FIELDS) assert.ok(Object.isFrozen(f));
  /* 前端同一份定义（不能互相 import：Worker 只 import 自己目录） */
  const fe = readFileSync(REPO + '/space/web/assets/js/lib/profile.js', 'utf8');
  const m = /PROFILE_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(fe);
  assert.ok(m, '前端 lib/profile.js 有 PROFILE_FIELDS');
  const ids = [...m[1].matchAll(/id: '([a-z]+)', max: (\d+)/g)].map((x) => [x[1], Number(x[2])]);
  assert.deepEqual(ids, lib.PROFILE_FIELDS.map((f) => [f.id, f.max]));
});

test('checkField：去空白、上限按字符算（中文 / emoji 一个算一个）、单行、必填、邮箱格式、null 清掉、不认识的字段', () => {
  assert.deepEqual(lib.checkField('name', '  Sloan Gray  '), { ok: true, value: 'Sloan Gray' });
  assert.deepEqual(lib.checkField('name', '甲'.repeat(40)), { ok: true, value: '甲'.repeat(40) });
  assert.deepEqual(lib.checkField('name', '甲'.repeat(41)), { ok: false, error: 'too-long' });
  assert.deepEqual(lib.checkField('nickname', '😀'.repeat(32)), { ok: true, value: '😀'.repeat(32) });
  assert.deepEqual(lib.checkField('nickname', 'x'.repeat(33)), { ok: false, error: 'too-long' });
  assert.deepEqual(lib.checkField('motto', 'a'.repeat(121)), { ok: false, error: 'too-long' });
  assert.deepEqual(lib.checkField('motto', '   '), { ok: true, value: '' }, '签名可以清空成空串');
  for (const id of ['name', 'nickname', 'email']) assert.deepEqual(lib.checkField(id, ' '), { ok: false, error: 'empty' }, id);
  for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u2028b', 'a\u007fb']) assert.deepEqual(lib.checkField('name', bad), { ok: false, error: 'format' }, JSON.stringify(bad));
  for (const ok of ['styrigx@gmail.com', 'a.b+c@sub.example.co', 'x@例子.中国']) assert.equal(lib.checkField('email', ok).ok, true, ok);
  for (const bad of ['styrigx', 'a@b', '@b.com', 'a@.com', 'a b@c.com', 'a@b.c', '<a@b.com>', 'a@b.com,c@d.com', 'mailto:a@b.com']) {
    assert.deepEqual(lib.checkField('email', bad), { ok: false, error: 'format' }, bad);
  }
  assert.deepEqual(lib.checkField('email', 'a@' + 'b'.repeat(250) + '.com'), { ok: false, error: 'too-long' });
  assert.deepEqual(lib.checkField('name', null), { ok: true, value: null });
  assert.deepEqual(lib.checkField('name', 3), { ok: false, error: 'type' });
  assert.deepEqual(lib.checkField('avatar', 'x'), { ok: false, error: 'field' });
});

/* ---------------- GET ---------------- */

test('GET 回退：KV 没存 → 四项都是 null（前端用默认值），头像版本空；200 no-store', async () => {
  const res = await onGet({ request: await getReq(), env: env(makeKv()) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control') || '', /no-store/);
  assert.deepEqual(await res.json(), { ok: true, profile: { name: null, nickname: null, motto: null, email: null }, avatar: '', updatedAt: 0 });
});

test('GET 回退：KV 没绑 / 读出错 / 坏 JSON / 存了不合法的字段 → 对应字段 null，照样 200', async () => {
  for (const kv of [null, { get: async () => { throw new Error('down'); } }, makeKv({ profile: '{not json' }), makeKv({ profile: '[1,2]' })]) {
    const res = await onGet({ request: await getReq(), env: env(kv) });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).profile, { name: null, nickname: null, motto: null, email: null });
  }
  const kv = makeKv({ profile: JSON.stringify({ v: 1, name: 'Sloan Gray', nickname: 'x'.repeat(99), email: 'nope', motto: 'Hi', extra: 'zzz' }), 'avatar:ver': 'abc' });
  const j = await (await onGet({ request: await getReq(), env: env(kv) })).json();
  assert.deepEqual(j.profile, { name: 'Sloan Gray', nickname: null, motto: 'Hi', email: null });
  assert.equal(j.avatar, 'abc');
  assert.equal('extra' in j.profile, false, '只回字段表里的公开字段');
});

test('GET：有进站会话即可，不要账号会话（临时钥匙进站也行）；没有进站会话 401 session', async () => {
  const kv = makeKv({ profile: JSON.stringify({ v: 1, nickname: 'Styrigx', updatedAt: 5 }) });
  for (const role of ['password', 'passkey', 'tempkey']) {
    const res = await onGet({ request: await getReq(role, false), env: env(kv) });
    assert.equal(res.status, 200, role);
    const j = await res.json();
    assert.equal(j.profile.nickname, 'Styrigx');
    assert.equal(j.updatedAt, 5);
  }
  const res = await onGet({ request: await getReq(null, true), env: env(kv) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'session');
});

/* ---------------- PUT 权限 ---------------- */

test('PUT 不同源 → 403 origin；没有进站会话 401 session；有进站会话、没账号会话 401 account（临时钥匙进站同样）；都不写', async () => {
  const kv = makeKv();
  let res = await onPut({ request: await putReq({ name: 'A' }, { origin: 'https://evil.example' }), env: env(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin');
  for (const [role, acc, code] of [[null, true, 'session'], ['password', false, 'account'], ['tempkey', false, 'account']]) {
    res = await onPut({ request: await putReq({ name: 'A' }, { role, acc }), env: env(kv) });
    assert.equal(res.status, 401, String(role));
    assert.equal((await res.json()).error, code);
  }
  assert.equal(kv.m.size, 0);
});

test('PUT 账号会话但没有 profile.write → 403 scope（带 scope），不写；有 → 写', async () => {
  const kv = makeKv();
  const req = await putReq({ name: 'A' });
  const authWith = (scopes) => ({ gateway: async () => ({ ok: true }), authorize: async () => ({ ok: true, reason: 'ok', deviceId: 'd', scopes, reauth: false }) });
  let res = await api.onRequestPut({ request: req.clone(), env: env(kv), auth: authWith(['avatar.write', 'prefs.sync']) });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { ok: false, error: 'scope', scope: 'profile.write' });
  assert.equal(kv.m.size, 0);
  res = await api.onRequestPut({ request: req.clone(), env: env(kv), auth: authWith(['profile.write']) });
  assert.equal(res.status, 200);
  assert.equal(stored(kv).name, 'A');
});

/* ---------------- PUT 校验 ---------------- */

test('PUT 校验：不是 JSON / 不是对象 400 body；空对象、不认识的字段、不合法的值 400 params（field + reason）；整个请求不写', async () => {
  const kv = makeKv({ profile: JSON.stringify({ v: 1, name: 'Sloan Gray', updatedAt: 1 }) });
  const before = kv.m.get('profile');
  const cases = [
    ['{oops', true, 400, 'body', null],
    ['[1]', true, 400, 'body', null],
    ['"x"', true, 400, 'body', null],
    [{}, false, 400, 'params', { reason: 'empty' }],
    [{ avatar: 'x' }, false, 400, 'params', { field: 'avatar', reason: 'field' }],
    [{ name: 'OK', email: 'bad' }, false, 400, 'params', { field: 'email', reason: 'format' }],
    [{ name: '' }, false, 400, 'params', { field: 'name', reason: 'empty' }],
    [{ nickname: 'x'.repeat(33) }, false, 400, 'params', { field: 'nickname', reason: 'too-long' }],
    [{ motto: 'line1\nline2' }, false, 400, 'params', { field: 'motto', reason: 'format' }],
    [{ name: 42 }, false, 400, 'params', { field: 'name', reason: 'type' }],
  ];
  for (const [body, raw, status, code, extra] of cases) {
    const res = await onPut({ request: await putReq(body, { raw }), env: env(kv) });
    assert.equal(res.status, status, JSON.stringify(body));
    const j = await res.json();
    assert.equal(j.error, code, JSON.stringify(body));
    if (extra) for (const k of Object.keys(extra)) assert.equal(j[k], extra[k], JSON.stringify(body) + ' ' + k);
  }
  assert.equal(kv.m.get('profile'), before, '一个字段不合法整个请求不写');
});

test('PUT 请求体 > 4 KB → 413 too-large', async () => {
  const res = await onPut({ request: await putReq(JSON.stringify({ motto: 'x'.repeat(5000) }), { raw: true }), env: env(makeKv()) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'too-large');
});

test('PUT 合法 → 合并写回一个键 profile（只存改过的字段 + v + updatedAt），回同 GET 的形状；null 清掉回默认；全清掉删键', async () => {
  const kv = makeKv({ 'avatar:ver': 'v9' });
  let res = await onPut({ request: await putReq({ name: '  Sloan Gray ', email: 'Hi@Example.com' }), env: env(kv) });
  assert.equal(res.status, 200);
  let j = await res.json();
  assert.deepEqual(j.profile, { name: 'Sloan Gray', nickname: null, motto: null, email: 'Hi@Example.com' });
  assert.equal(j.avatar, 'v9');
  assert.ok(j.updatedAt > 0);
  let s = stored(kv);
  assert.deepEqual(Object.keys(s).sort(), ['email', 'name', 'updatedAt', 'v']);
  assert.equal(s.v, 1);
  /* 第二次只改昵称：姓名、邮箱保留 */
  res = await onPut({ request: await putReq({ nickname: 'Styrigx', motto: '' }), env: env(kv) });
  j = await res.json();
  assert.deepEqual(j.profile, { name: 'Sloan Gray', nickname: 'Styrigx', motto: '', email: 'Hi@Example.com' });
  /* GET 读到同样的值 */
  j = await (await onGet({ request: await getReq(), env: env(kv) })).json();
  assert.deepEqual(j.profile, { name: 'Sloan Gray', nickname: 'Styrigx', motto: '', email: 'Hi@Example.com' });
  /* null 清掉 */
  res = await onPut({ request: await putReq({ email: null, motto: null }), env: env(kv) });
  j = await res.json();
  assert.deepEqual(j.profile, { name: 'Sloan Gray', nickname: 'Styrigx', motto: null, email: null });
  s = stored(kv);
  assert.equal('email' in s, false);
  /* 全清掉 → 删键 */
  res = await onPut({ request: await putReq({ name: null, nickname: null }), env: env(kv) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).updatedAt, 0);
  assert.equal(kv.m.has('profile'), false);
});

test('PUT：KV 没绑 → 500 server；写 KV 出错 → 500 server', async () => {
  let res = await onPut({ request: await putReq({ name: 'A' }), env: env(null) });
  assert.equal(res.status, 500);
  const broken = makeKv();
  broken.put = async () => { throw new Error('kv down'); };
  res = await onPut({ request: await putReq({ name: 'A' }), env: env(broken) });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'server');
});
