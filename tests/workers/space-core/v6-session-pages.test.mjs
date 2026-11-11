/**
 * 2b（v6 割接后续）：纯 v6 登录的页面视为已登录——网关这一侧。
 * - 页面状态（data-sgx-lock-session，gate.js pageStateOf）：只有 v6 / 只有旧 / 都有 / 都没有 / v6 过期 / 救援 / RPC 出错；主站、子站、旧 /en/ 404 页同一套
 * - PAGE_PROBE 在账号路由表里是 user 档、不是救援可用（判断只在 ROUTE_ACCESS + permits）
 * - 云同步 GET /api/prefs：纯 v6 过网关门、转给账号 Worker（数据归谁由账号 Worker dataUid 按 v6 uid 定）
 * - 网关自己的接口：/api/status（status 组）、/api/ai（ai 组）认 v6；有 v6 身份但档不够 403 forbidden；访客 401
 * 放行判断用 ../_v6admit.mjs（真的 ROUTE_ACCESS + permits）。
 * 运行：node --test tests/workers/space-core/v6-session-pages.test.mjs
 */
import '../account/_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAuthD1, genKeyPair } from '../_harness.mjs';
import { testLockSession } from './_tickets.mjs';
import { admitFor } from '../_v6admit.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/space-core/src/app.js')).default;
const IA = await import(REPO + 'workers/space-core/src/core/identity-admit.js');
const RA = await import(REPO + 'workers/account/src/core/route-access.js');

const LOCK = await genKeyPair();
const ctx = { waitUntil() {} };
const HTML = '<!DOCTYPE html><html lang="en"><body>x</body></html>';

function setup(o = {}) {
  const rec = { calls: [], forwarded: [] };
  const env = {
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_SPACE_PUBLIC: LOCK.pub, SGX_SPACE_PRIVATE: LOCK.priv,
    D1_SPACE: makeAuthD1(),
    ANON_LIMITER: { async limit() { return { success: true }; } },
    ACCOUNT_VERIFIER: {
      async authorize() { return { ok: false, reason: 'no-cookie', deviceId: '', scopes: [], reauth: false }; },
      async admit(c, m, p, opts) { rec.calls.push([c, m, p]); if (o.throws) throw new Error('down'); return admitFor(c, m, p, opts); },
    },
    ACCOUNT: { async fetch(req) { rec.forwarded.push(new URL(req.url).pathname); return new Response('{"ok":true,"items":{},"updatedAt":0}', { headers: { 'Content-Type': 'application/json' } }); } },
    STATUS: { async fetch() { return new Response('{"ok":true,"sites":[]}', { status: 200 }); } },
    AI_SERVICE: { async fetch() { return new Response('{"ok":true,"models":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }); } },
    ASSETS: { async fetch() { return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); } },
  };
  return { env, rec };
}
async function page(env, path, cookie) {
  const res = await worker.fetch(new Request('https://styrigx.com' + path, { headers: cookie ? { Cookie: cookie } : {} }), env, ctx);
  const html = await res.text();
  const m = /<html[^>]*data-sgx-lock-session="([a-z]+)"/.exec(html);
  return { status: res.status, state: m ? m[1] : null, cc: res.headers.get('Cache-Control') };
}
const oldCookie = async () => 'sgx-space-session=' + (await testLockSession(LOCK.priv, 0, 'password'));

test('PAGE_PROBE：账号路由表里是 user 档（任一已登录身份），不是救援可用', () => {
  assert.equal(RA.levelOf(IA.PAGE_PROBE.method, IA.PAGE_PROBE.path), 'user');
  assert.equal(RA.rescueOf(IA.PAGE_PROBE.method, IA.PAGE_PROBE.path), false);
});

test('页面状态：只有 v6（styrigx / root / alice / 无组临时用户）→ valid；按 PAGE_PROBE 问一次', async () => {
  for (const who of ['styrigx', 'root', 'alice', 'temp']) {
    const { env, rec } = setup();
    const r = await page(env, '/', 'sgx-session=' + who);
    assert.equal(r.state, 'valid', who);
    assert.equal(r.cc, 'private, no-store');
    assert.deepEqual(rec.calls, [['sgx-session=' + who, 'GET', '/api/prefs']], who);
  }
});

test('页面状态：只有旧会话 → valid，不问 v6；两样都有 → valid，不问 v6（旧会话先判）', async () => {
  const { env, rec } = setup();
  const old = await oldCookie();
  assert.equal((await page(env, '/', old)).state, 'valid');
  assert.equal((await page(env, '/zh/', old + '; sgx-session=styrigx; sgx-id=1')).state, 'valid');
  assert.equal(rec.calls.length, 0);
});

test('页面状态：都没有 → locked、不问；v6 过期 / 坏令牌 → locked；救援会话 → locked；RPC 出错 → locked（fail closed）', async () => {
  const { env, rec } = setup();
  assert.equal((await page(env, '/')).state, 'locked');
  assert.equal((await page(env, '/', 'sgx-id=1')).state, 'locked', '只有登录标记、没有会话 cookie');
  assert.equal(rec.calls.length, 0, '没 sgx-session 不问');
  assert.equal((await page(env, '/', 'sgx-session=expired')).state, 'locked');
  assert.equal((await page(env, '/', 'sgx-session=rescue')).state, 'locked', '救援会话只做白名单命令，页面不算登录');
  const t = setup({ throws: true });
  assert.equal((await page(t.env, '/', 'sgx-session=styrigx')).state, 'locked');
});

test('子站页面和旧 /en/ 404 页同一套（handleSubsite / retiredEnNotFound）', async () => {
  const { env } = setup();
  for (const p of ['/curio/', '/daymark/', '/blog/']) {
    assert.equal((await page(env, p, 'sgx-session=styrigx')).state, 'valid', p);
    assert.equal((await page(env, p)).state, 'locked', p);
  }
  const en = await page(env, '/en/', 'sgx-session=styrigx');
  assert.equal(en.status, 404);
  assert.equal(en.state, 'valid');
  const sen = await page(env, '/curio/en/', 'sgx-session=expired');
  assert.equal(sen.status, 404);
  assert.equal(sen.state, 'locked');
});

test('云同步 GET /api/prefs：纯 v6 过网关门、转给账号 Worker；访客 401 不转', async () => {
  const { env, rec } = setup();
  const r = await worker.fetch(new Request('https://styrigx.com/api/prefs', { headers: { Cookie: 'sgx-session=styrigx' } }), env, ctx);
  assert.equal(r.status, 200);
  assert.deepEqual(rec.forwarded, ['/api/prefs']);
  const g = await worker.fetch(new Request('https://styrigx.com/api/prefs'), env, ctx);
  assert.equal(g.status, 401);
  assert.deepEqual(rec.forwarded, ['/api/prefs']);
});

test('/api/status（status 组）：纯 v6 styrigx 200，不在 status 组 403 forbidden，访客 401；关口问过的结论接口复用（只问一次）', async () => {
  const { env, rec } = setup();
  const get = (ck) => worker.fetch(new Request('https://styrigx.com/api/status', { headers: ck ? { Cookie: ck } : {} }), env, ctx);
  const ok = await get('sgx-session=styrigx');
  assert.equal(ok.status, 200);
  assert.equal(rec.calls.length, 1, '接口用关口的 v6 结论');
  const f = await get('sgx-session=temp');
  assert.equal(f.status, 403);
  assert.equal((await f.json()).error, 'forbidden');
  assert.equal((await get('')).status, 401);
  assert.equal((await get('sgx-session=expired')).status, 401);
  /* 接口直接调（没有关口结论）：自己问 */
  const S = await import(REPO + 'workers/space-core/src/api/status.js');
  const d = await S.onRequestGet({ request: new Request('https://styrigx.com/api/status', { headers: { Cookie: 'sgx-session=temp' } }), env, data: {} });
  assert.equal(d.status, 403);
});

test('/api/ai（ai 组）：纯 v6 styrigx 能取模型列表；不在 ai 组（alice 只有 listen）403 forbidden；访客 401', async () => {
  const { env } = setup();
  const get = (ck) => worker.fetch(new Request('https://styrigx.com/api/ai', { headers: ck ? { Cookie: ck } : {} }), env, ctx);
  assert.equal((await get('sgx-session=styrigx')).status, 200);
  const f = await get('sgx-session=alice');
  assert.equal(f.status, 403);
  assert.equal((await f.json()).error, 'forbidden');
  assert.equal((await get('')).status, 401);
});

test('entryOrV6 / newSessionSignedIn：旧会话有效直接 ok 不问；没 cookie 不问', async () => {
  const { env, rec } = setup();
  assert.equal(await IA.entryOrV6({ request: new Request('https://styrigx.com/api/status'), env, data: {} }, { ok: true }), 'ok');
  assert.equal(await IA.newSessionSignedIn(env, new Request('https://styrigx.com/')), false);
  assert.equal(rec.calls.length, 0);
  assert.equal(await IA.newSessionSignedIn(env, new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-session=root' } })), true);
  assert.equal(await IA.newSessionSignedIn({}, new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-session=root' } })), false, '没绑定 → false');
});
