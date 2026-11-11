/**
 * 主站头像接口
 * - GET /avatar/<尺寸>.webp：没上传过 → 默认图（ETag "d-<尺寸>"）；上传过 → KV 里的图（ETag "<版本>-<尺寸>"）；
 *   If-None-Match 命中 → 304；不认识的尺寸 → 404；公开缓存头。
 * - PUT /api/avatar（v6 P4 起只认 v6 会话 + 路由档）：不同源 403；没有 v6 会话 401 session（旧进站会话 / 旧账号会话都不算）；
 *   缺尺寸 400；不是 WebP/PNG 415；太大 413；v6 会话 + 四张合法图 → 写四张 + 版本号。
 * - DELETE /api/avatar：同一道门；没 v6 会话 401 session；有 → 删版本号和四张。
 *
 * 账号 Worker styrigx-account（workers/account，2026-10-24 从网关搬来）；v6 会话测试台见 _auth.mjs。
 *
 * 运行：node --test tests/workers/account/avatar.test.mjs
 */
import { wrap, seedV6, V6_COOKIE } from './_auth.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authD1For } from '../_harness.mjs';
import { makeAccountD1 } from './_d1.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const { onRequestGet } = await import(REPO + '/workers/account/src/api/avatar-file.js');
const avatarApi = await import(REPO + '/workers/account/src/api/avatar.js');
const onRequestPut = wrap(avatarApi.onRequestPut);
const onRequestDelete = wrap(avatarApi.onRequestDelete);
const { sniffImage, sizeOfFile } = await import(REPO + '/workers/account/src/lib/avatar.js');

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);

function makeKv(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    async get(k) {
      const v = m.get(k); /* 纪元在 D1（authD1For），KV 里没有 lock-epoch → 0 */
      return v === undefined ? null : v.value ?? v;
    },
    async getWithMetadata(k) {
      const v = m.get(k);
      return v ? { value: v.value, metadata: v.metadata } : { value: null, metadata: null };
    },
    async put(k, value, opts) {
      m.set(k, opts && opts.metadata ? { value, metadata: opts.metadata } : value);
    },
    async delete(k) {
      m.delete(k);
    },
  };
}
function env(kv) {
  return {
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv, KV_PROFILE: kv,
    D1_SPACE: authD1For(kv), D1_ACCOUNT: seedV6(makeAccountD1()),
    ASSETS: { fetch: async (u) => new Response('DEFAULT:' + new URL(u).pathname, { status: 200 }) },
  };
}
/**
 * v6 P4：role && acc（原「进站 + 账号会话」）→ v6 会话 cookie；其余只带旧 cookie 的样子（服务端不再认）。
 * @param {string|null} role @param {boolean} [acc]
 */
async function cookie(role, acc) {
  if (role && acc) return V6_COOKIE;
  const c = [];
  if (role) c.push('sgx-space-session=' + role + '.0.9999999999999.sig');
  if (acc) c.push('sgx-account-session=password.0.1.2.dev.sig');
  return c.join('; ');
}
function form(parts) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(parts)) fd.append(k, new Blob([v]), k + '.webp');
  return fd;
}
async function putReq({ role, acc = true, origin = 'https://styrigx.com', parts }) {
  const headers = { Origin: origin };
  const ck = await cookie(role, acc);
  if (ck) headers.Cookie = ck;
  return new Request('https://styrigx.com/api/avatar', { method: 'PUT', headers, body: form(parts) });
}
const ALL = { 32: WEBP, 96: WEBP, 192: PNG, 512: WEBP };

test('sniffImage / sizeOfFile', () => {
  assert.equal(sniffImage(WEBP), 'image/webp');
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), '');
  assert.equal(sizeOfFile('96.webp'), 96);
  assert.equal(sizeOfFile('64.webp'), 0);
  assert.equal(sizeOfFile('96.png'), 0);
});

test('GET 默认图：ETag d-<尺寸>，公开缓存头；If-None-Match → 304', async () => {
  const e = env(makeKv());
  const res = await onRequestGet({ request: new Request('https://styrigx.com/avatar/96.webp'), env: e, params: { file: '96.webp' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ETag'), '"d-96"');
  assert.match(res.headers.get('Cache-Control'), /^public, max-age=300, stale-while-revalidate=/);
  assert.equal(await res.text(), 'DEFAULT:/avatar/96.webp');
  const res2 = await onRequestGet({
    request: new Request('https://styrigx.com/avatar/96.webp', { headers: { 'If-None-Match': '"d-96"' } }),
    env: e,
    params: { file: '96.webp' },
  });
  assert.equal(res2.status, 304);
});

test('GET 不认识的尺寸 → 404', async () => {
  const res = await onRequestGet({ request: new Request('https://styrigx.com/avatar/64.webp'), env: env(makeKv()), params: { file: '64.webp' } });
  assert.equal(res.status, 404);
});

test('PUT 不同源 → 403', async () => {
  const res = await onRequestPut({ request: await putReq({ role: 'password', origin: 'https://evil.example', parts: ALL }), env: env(makeKv()) });
  assert.equal(res.status, 403);
});

test('PUT 没有 v6 会话 401 session（只有旧进站会话 / 旧账号会话都一样），不写 KV', async () => {
  for (const [role, acc, code] of [[null, false, 'session'], [null, true, 'session'], ['password', false, 'session'], ['link', false, 'session']]) {
    const kv = makeKv();
    const res = await onRequestPut({ request: await putReq({ role, acc, parts: ALL }), env: env(kv) });
    assert.equal(res.status, 401, String(role) + '/' + acc);
    assert.equal((await res.json()).error, code);
    assert.match(res.headers.get('Cache-Control') || '', /no-store/);
    assert.equal(kv.m.size, 0);
  }
});

test('PUT 缺尺寸 400 / 格式不对 415 / 太大 413', async () => {
  const kv = makeKv();
  let res = await onRequestPut({ request: await putReq({ role: 'password', parts: { 32: WEBP, 96: WEBP, 192: WEBP } }), env: env(kv) });
  assert.equal(res.status, 400);
  res = await onRequestPut({ request: await putReq({ role: 'password', parts: { ...ALL, 96: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) } }), env: env(kv) });
  assert.equal(res.status, 415);
  const big = new Uint8Array(70 * 1024);
  big.set(WEBP);
  res = await onRequestPut({ request: await putReq({ role: 'password', parts: { ...ALL, 32: big } }), env: env(kv) });
  assert.equal(res.status, 413);
  assert.equal(kv.m.size, 0);
});

test('PUT v6 会话 → 写四张 + 版本号；GET 读到新图和新 ETag；DELETE 回到默认', async () => {
  const kv = makeKv();
  const e = env(kv);
  const res = await onRequestPut({ request: await putReq({ role: 'password', parts: ALL }), env: e });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.ok(j.ver);
  assert.equal(kv.m.get('avatar:ver'), j.ver);
  assert.equal(kv.m.get('avatar:192').metadata.type, 'image/png');

  const g = await onRequestGet({ request: new Request('https://styrigx.com/avatar/192.webp'), env: e, params: { file: '192.webp' } });
  assert.equal(g.headers.get('ETag'), '"' + j.ver + '-192"');
  assert.equal(g.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await g.arrayBuffer()), PNG);

  const noAccDel = await onRequestDelete({
    request: new Request('https://styrigx.com/api/avatar', { method: 'DELETE', headers: { Origin: 'https://styrigx.com', Cookie: await cookie('password', false) } }),
    env: e,
  });
  assert.equal(noAccDel.status, 401);
  assert.equal((await noAccDel.json()).error, 'session');
  assert.ok(kv.m.has('avatar:ver'));

  const del = await onRequestDelete({
    request: new Request('https://styrigx.com/api/avatar', { method: 'DELETE', headers: { Origin: 'https://styrigx.com', Cookie: await cookie('password', true) } }),
    env: e,
  });
  assert.equal(del.status, 200);
  assert.equal(kv.m.size, 0);
  const g2 = await onRequestGet({ request: new Request('https://styrigx.com/avatar/192.webp'), env: e, params: { file: '192.webp' } });
  assert.equal(g2.headers.get('ETag'), '"d-192"');
});
