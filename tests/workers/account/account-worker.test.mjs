/**
 * 账号 Worker styrigx-account（workers/account；账号拆分 PR3：完整的账号系统，没有公开路由）：
 * - wrangler.toml：名字、不开 workers.dev / 预览地址、没有 [[routes]]、没有 [[services]]（不回调网关）、正式 / 预览库 id、
 *   D1_ACCOUNT_AUTH 指向账号库、不绑网关认证库（Secrets Store 绑定见 account-auth-scaffold.test.mjs）
 * - 默认 fetch：一律 404（第二道保险：残留公开路由也碰不到接口），伪造的 x-styrigx-* 头不起作用
 * - AccountService（serviceFetch）：只认网关写的身份头；没有身份头 → /api/* 401；访客调 /api/prefs 403；头像文件公开
 * - 头像：默认图回源、KV 里的图、只读 KV_PROFILE；X-SGX-Runtime: account；/api/* no-store
 * - AccountVerifier（checkAccountSession）：账号会话本 Worker 自己验；吊销 → revoked；设备记录带上 User-Agent
 *
 * 请求经 _auth.mjs 的 gatewayHop 模拟网关：真实 verifyLockSession + writeLockIdentity 把锁屏 cookie 换成身份头。
 * 运行：node --test tests/workers/account/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serviceCall, gatewayHop, testAccountSession } from './_auth.mjs';
import { testLockSession } from '../auth-gateway/_tickets.mjs';
import { genKeyPair, withAuthD1 } from '../_harness.mjs';
import { makeAccountD1 } from './_d1.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/account/src/index.js')).default;
const { API_ROUTES } = await import(REPO + 'workers/account/src/index.js');
const { checkAccountSession, serviceFetch } = await import(REPO + 'workers/account/src/entrypoints.js');
const { KEY_VER, keyOf, avatarKv } = await import(REPO + 'workers/account/src/lib/avatar.js');

const { priv: PRIV, pub: PUB } = await genKeyPair();

function makeKv(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    async get(k, type) {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async getWithMetadata(k) { const v = m.get(k); return v ? { value: v.value ?? v, metadata: v.metadata ?? null } : { value: null, metadata: null }; },
    async put(k, v, opts) { m.set(k, opts && opts.metadata ? { value: v, metadata: opts.metadata } : v); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
}

/** 一个 env 同时给网关这一跳（SGX_LOCK_PUBLIC + D1_LOCK_AUTH）和账号 Worker（账号库 + SGX_ACCOUNT_PUBLIC）用；账号代码只读自己的名字 */
function setup(over = {}) {
  const authKv = makeKv();
  const gwEnv = withAuthD1({ SGX_LOCK_PUBLIC: PUB, SGX_ACCOUNT_PUBLIC: PUB, KV_LOCK_DOOR: authKv, KV_ACCOUNT_LOGIN: authKv });
  const profile = makeKv();
  const origin = [];
  const env = {
    ...gwEnv,
    SGX_ENV: 'production',
    KV_PROFILE: profile,
    D1_SETTINGS_SYNC: makeAccountD1(),
    ASSETS: { fetch: async (req) => { origin.push(new URL(req.url || req).pathname); return new Response('DEFAULT', { status: 200 }); } },
    ...over,
  };
  return { env, gwEnv, authKv, profile, origin };
}
const CTX = { waitUntil() {} };
const call = (req, env) => serviceCall(req, env, CTX);
async function sess(role) { return 'sgx-lock-session=' + (await testLockSession(PRIV, 0, role)); }

test('wrangler.toml：styrigx-account、不开公开地址、没有路由、没有服务绑定（不回调网关）、D1_ACCOUNT_AUTH → 账号库、不绑网关认证库', () => {
  const toml = readFileSync(REPO + 'workers/account/wrangler.toml', 'utf8');
  const code = toml.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  const [prod, preview] = code.split(/^\[env\.preview\]$/m);
  assert.match(prod, /^name = "styrigx-account"$/m);
  assert.match(prod, /^main = "src\/worker\.js"$/m);
  assert.match(prod, /^workers_dev = false$/m);
  assert.match(prod, /^preview_urls = false$/m);
  assert.match(prod, /^SGX_ENV = "production"$/m);
  assert.doesNotMatch(code, /\[\[routes\]\]|^pattern = /m, '账号 Worker 一条路由都没有（方案第 4 节）');
  assert.doesNotMatch(code, /\[\[(env\.preview\.)?services\]\]|styrigx-auth-gateway|AuthVerifier/, '不绑网关、不回调网关');
  assert.match(prod, /binding = "D1_WELLBEING"\ndatabase_name = "styrigx-account"\ndatabase_id = "03f60d23-9c2f-4f3d-a692-764ccaac6f5d"\nmigrations_dir = "migrations"/);
  assert.match(prod, /\[\[d1_databases\]\]\nbinding = "D1_SETTINGS_SYNC"\ndatabase_name = "styrigx-account"\ndatabase_id = "03f60d23-9c2f-4f3d-a692-764ccaac6f5d"\nmigrations_dir = "migrations"/);
  assert.doesNotMatch(code, /KV_SETTINGS_SYNC/);
  assert.deepEqual([...code.matchAll(/^binding = "(KV_[A-Z0-9_]+)"/gm)].map((m) => m[1]), ['KV_PROFILE', 'KV_PROFILE']);
  assert.match(toml, /KV_PROFILE 只放公开的头像 avatar:\*/);
  assert.doesNotMatch(toml, /PRIVATE KEY|b796097c90104000992b7713f61e16ea|6931d1da-3502-480d-b0bd-de1bc4829d1d|5084ea8ef2444156ba48203220b93df6|a5ee2a75f00d4308959b2bea55247ff6|d417e421-75bb-4425-bdc8-54856b88578f/);
  assert.match(prod, /\[\[d1_databases\]\]\nbinding = "D1_ACCOUNT_AUTH"\ndatabase_name = "styrigx-account"\ndatabase_id = "03f60d23-9c2f-4f3d-a692-764ccaac6f5d"\nmigrations_dir = "migrations"\n/);
  assert.match(prod, /^SGX_RP_ID = "styrigx\.com"$/m);
  assert.match(prod, /^SGX_ORIGIN = "https:\/\/styrigx\.com"$/m);
  assert.doesNotMatch(prod, /^SGX_\w+_(PUBLIC|PRIVATE) = /m);
  /* 预览：不单独部署（没有预览 name）、不抢正式路由、不连正式库；KV / D1 都是同一个测试资源 styrigx-test-preview */
  assert.match(preview, /^routes = \[\]$/m);
  assert.doesNotMatch(preview, /^name = /m);
  assert.doesNotMatch(toml, /styrigx-account-preview/);
  assert.doesNotMatch(preview, /b20701f5f48e498e897bc6f0bd81643f|03f60d23-9c2f-4f3d-a692-764ccaac6f5d/);
  assert.doesNotMatch(preview, /PLACEHOLDER/);
  assert.match(preview, /\[\[env\.preview\.kv_namespaces\]\]\nbinding = "KV_PROFILE"\nid = "193b4d68b8ac4c6f8c0ba16b5ea78b14"/);
  for (const b of ['D1_WELLBEING', 'D1_SETTINGS_SYNC', 'D1_ACCOUNT_AUTH']) {
    assert.match(preview, new RegExp('\\[\\[env\\.preview\\.d1_databases\\]\\]\\nbinding = "' + b + '"\\ndatabase_name = "styrigx-test-preview"\\ndatabase_id = "1339bb0b-f9f8-4e3d-b413-ff07ca28ce69"\\nmigrations_dir = "migrations"\\nmigrations_table = "d1_migrations_account"'), b);
  }
});

test('默认 fetch：一律 404（任何路径、任何方法；伪造的 X-Styrigx-Lock-Role: admin 也不起作用），带 X-SGX-Runtime: account 和安全头', async () => {
  for (const [m, p] of [['GET', '/api/account'], ['POST', '/api/account'], ['GET', '/api/prefs'], ['PUT', '/api/avatar'], ['GET', '/avatar/96.webp'], ['GET', '/'], ['POST', '/api/wellbeing']]) {
    const r = await worker.fetch(new Request('https://styrigx.com' + p, { method: m, headers: { 'X-Styrigx-Lock-Role': 'admin', 'X-Styrigx-Lock-By': 'password', Origin: 'https://styrigx.com' }, body: m === 'GET' ? undefined : '{"action":"login-challenge"}' }), {}, CTX);
    assert.equal(r.status, 404, m + ' ' + p);
    assert.deepEqual(await r.json(), { ok: false, error: 'not-found' });
    assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
    assert.ok(r.headers.get('Strict-Transport-Security'));
  }
});

test('迁移：wb_daily 在账号库；网关的迁移目录不再建它', async () => {
  const sql = readFileSync(REPO + 'workers/account/migrations/0001_wellbeing.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS wb_daily/);
  const gw = readFileSync(REPO + 'workers/auth-gateway/wrangler.toml', 'utf8');
  assert.doesNotMatch(gw, /^binding = "(D1_WELLBEING|KV_PROFILE|KV_SETTINGS_SYNC)"$/m);
  const { readdirSync } = await import('node:fs');
  assert.equal(readdirSync(REPO + 'workers/auth-gateway/migrations').some((f) => /wellbeing/.test(f)), false);
});

test('路由表：/api/account + 三个账号数据接口（与网关转发表 /api/* 条目一一对应）', async () => {
  assert.deepEqual([...API_ROUTES.keys()].sort(), ['/api/account', '/api/avatar', '/api/prefs', '/api/wellbeing']);
  const { FORWARDING } = await import(REPO + 'workers/auth-gateway/src/forwarding.js');
  assert.deepEqual(FORWARDING.filter((r) => r.path.startsWith('/api/')).map((r) => r.path).sort(), [...API_ROUTES.keys()].sort());
});

test('AccountService：没有身份头 → /api/* 401 {ok:false} private, no-store；头像文件公开；不认识的头像尺寸 → 404', async () => {
  const { env } = setup();
  for (const [m, p] of [['GET', '/api/wellbeing'], ['POST', '/api/wellbeing'], ['GET', '/api/prefs'], ['PUT', '/api/avatar'], ['DELETE', '/api/avatar'], ['GET', '/api/prefs/x']]) {
    const r = await call(new Request('https://styrigx.com' + p, { method: m, headers: { Origin: 'https://styrigx.com' }, body: m === 'GET' ? undefined : '{}' }), env);
    assert.equal(r.status, 401, m + ' ' + p);
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
    assert.deepEqual(await r.json(), { ok: false });
  }
  const av = await call(new Request('https://styrigx.com/avatar/32.webp'), env);
  assert.equal(av.status, 200);
  const bad = await call(new Request('https://styrigx.com/avatar/100.webp?x=1'), env);
  assert.equal(bad.status, 404, '不认识的尺寸由头像处理函数回 404（302 锁屏是网关的门，见 forwarding.test）');
  const page = await call(new Request('https://styrigx.com/settings/'), env);
  assert.equal(page.status, 404, '网关只转发表里的路径；别的路径不在这里出页面');
});

test('AccountService：访客身份调 /api/prefs → 403 role（纵深防御，门在网关）；/api/account 由 account.js 自己按身份拒（401 session）', async () => {
  const { env } = setup();
  const ck = await sess('visitor');
  let r = await call(new Request('https://styrigx.com/api/prefs', { headers: { Cookie: ck } }), env);
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: 'role' });
  r = await call(new Request('https://styrigx.com/api/prefs', { method: 'POST', headers: { Cookie: ck, Origin: 'https://styrigx.com', 'Content-Type': 'application/json' }, body: '{"changes":{}}' }), env);
  assert.equal(r.status, 403);
  r = await call(new Request('https://styrigx.com/api/account', { method: 'POST', headers: { Cookie: ck, Origin: 'https://styrigx.com', 'Content-Type': 'application/json' }, body: '{"action":"device-list"}' }), env);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'session');
});

test('访客：PUT /api/avatar 403、数字健康上报 204 丢弃（不写库）、读取 200', async () => {
  let touched = 0;
  const db = {
    prepare() { touched++; return { run: async () => ({}), bind() { return this; }, all: async () => ({ results: [] }) }; },
    batch: async () => { touched += 100; },
  };
  const { env } = setup({ D1_WELLBEING: db });
  const ck = await sess('visitor');
  const put = await call(new Request('https://styrigx.com/api/avatar', { method: 'PUT', headers: { Cookie: ck, Origin: 'https://styrigx.com' }, body: new FormData() }), env);
  assert.equal(put.status, 403);
  assert.deepEqual(await put.json(), { ok: false, error: 'role' });
  const post = await call(new Request('https://styrigx.com/api/wellbeing', { method: 'POST', headers: { Cookie: ck }, body: '{"d":"2026-10-24","s":[{"k":"home","sec":5}]}' }), env);
  assert.equal(post.status, 204);
  assert.equal(touched, 0);
  const get = await call(new Request('https://styrigx.com/api/wellbeing?d=2000-01-01', { headers: { Cookie: ck } }), env);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).ok, true);
});

test('管理员：未知子路径 404、不支持的方法 405；/api/prefs/ 尾斜杠同 /api/prefs', async () => {
  const { env, authKv } = setup();
  const ck = await sess('admin');
  assert.equal((await call(new Request('https://styrigx.com/api/avatarx', { headers: { Cookie: ck } }), env)).status, 404);
  assert.equal((await call(new Request('https://styrigx.com/api/avatar', { headers: { Cookie: ck } }), env)).status, 405);
  /* 没登账号 → 401 account（尾斜杠也进 prefs） */
  const r = await call(new Request('https://styrigx.com/api/prefs/', { headers: { Cookie: ck } }), env);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'account');
  /* 登了账号 → 200 */
  const acc = await testAccountSession(PRIV, 'passkey', 0, Date.now());
  const ok = await call(new Request('https://styrigx.com/api/prefs', { headers: { Cookie: ck + '; sgx-account-session=' + acc } }), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Cache-Control'), 'private, no-store');
  assert.ok(authKv);
});

test('身份头白名单：不认识的 role / 只有 by 没有 role / 旧头名 X-Sgx-Role → 当作无会话（401）', async () => {
  const { env } = setup();
  for (const h of [{ 'X-Styrigx-Lock-Role': 'root' }, { 'X-Styrigx-Lock-Role': 'Admin' }, { 'X-Styrigx-Lock-By': 'password' }, { 'X-Sgx-Role': 'admin' }]) {
    const r = await serviceFetch(new Request('https://styrigx.com/api/wellbeing', { headers: h }), env, CTX);
    assert.equal(r.status, 401, JSON.stringify(h));
    const del = await serviceFetch(new Request('https://styrigx.com/api/avatar', { method: 'DELETE', headers: { ...h, Origin: 'https://styrigx.com' } }), env, CTX);
    assert.equal(del.status, 401, JSON.stringify(h));
  }
  const ok = await serviceFetch(new Request('https://styrigx.com/api/wellbeing?d=2000-01-01', { headers: { 'X-Styrigx-Lock-Role': 'admin', 'X-Styrigx-Lock-By': 'passkey' } }), { ...env, D1_WELLBEING: makeAccountD1() }, CTX);
  assert.equal(ok.status, 200, '合规的身份头 → 放行');
});

test('伪造 / 过期的锁屏 cookie：网关这一跳验签不过 → 不写身份头 → 401', async () => {
  const { env } = setup();
  const { priv: otherPriv } = await genKeyPair();
  const forged = 'sgx-lock-session=' + (await testLockSession(otherPriv, 0, 'admin', 'password'));
  const r = await call(new Request('https://styrigx.com/api/wellbeing', { headers: { Cookie: forged } }), env);
  assert.equal(r.status, 401);
});

test('网关这一跳：验过的锁屏会话写成身份头，外来伪造的 x-styrigx-* 头先被剥掉', async () => {
  const { env } = setup();
  const ck = await sess('admin');
  const fake = { 'X-Styrigx-Lock-Role': 'admin', 'X-Styrigx-Client-Address': '6.6.6.6' };
  const none = await gatewayHop(new Request('https://styrigx.com/api/prefs', { headers: fake }), env);
  assert.equal(none.headers.get('X-Styrigx-Lock-Role'), null, '没有锁屏会话：伪造的身份头被剥掉');
  assert.equal(none.headers.get('X-Styrigx-Client-Address'), null);
  const real = await gatewayHop(new Request('https://styrigx.com/api/prefs', { headers: { ...fake, Cookie: ck, 'CF-Connecting-IP': '203.0.113.5' } }), env);
  assert.equal(real.headers.get('X-Styrigx-Lock-Role'), 'admin');
  assert.equal(real.headers.get('X-Styrigx-Lock-By'), 'password');
  assert.equal(real.headers.get('X-Styrigx-Client-Address'), '203.0.113.5');
});

test('头像：没上传过 → 回源默认图（ETag d-<尺寸>、公开缓存、runtime account）；上传过 → 读 KV 不回源；HEAD 照网关落到静态文件', async () => {
  const { env, profile, origin } = setup();
  let r = await call(new Request('https://styrigx.com/avatar/96.webp'), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('ETag'), '"d-96"');
  assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
  assert.match(r.headers.get('Cache-Control'), /^public, max-age=300/);
  assert.equal(await r.text(), 'DEFAULT');
  assert.deepEqual(origin, ['/avatar/96.webp']);
  profile.m.set(KEY_VER, 'v7');
  profile.m.set(keyOf(192), { value: new Uint8Array([1, 2, 3]).buffer, metadata: { type: 'image/png' } });
  r = await call(new Request('https://styrigx.com/avatar/192.webp?v=v7'), env);
  assert.equal(r.headers.get('ETag'), '"v7-192"');
  assert.equal(r.headers.get('Content-Type'), 'image/png');
  assert.equal((await r.arrayBuffer()).byteLength, 3);
  assert.deepEqual(origin, ['/avatar/96.webp']);
  r = await call(new Request('https://styrigx.com/avatar/192.webp', { method: 'HEAD' }), env);
  assert.deepEqual(origin, ['/avatar/96.webp', '/avatar/192.webp']);
});

test('头像：生产没有 env.ASSETS → 默认图发子请求到同一地址（redirect: manual）', async () => {
  const { env } = setup();
  delete env.ASSETS;
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (req) => { seen.push([req.url, req.redirect]); return new Response('PAGES', { status: 200 }); };
  try {
    const r = await call(new Request('https://styrigx.com/avatar/512.webp'), env);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'PAGES');
  } finally { globalThis.fetch = orig; }
  assert.deepEqual(seen, [['https://styrigx.com/avatar/512.webp', 'manual']]);
});

test('头像只读 KV_PROFILE：认证库里有 avatar:* 也不读', () => {
  const lockKv = makeKv({ [KEY_VER]: 'v0' });
  const profileKv = makeKv({ [KEY_VER]: 'v1' });
  assert.equal(avatarKv({ KV_LOCK_DOOR: lockKv, KV_PROFILE: profileKv }), profileKv);
  assert.equal(avatarKv({ KV_LOCK_DOOR: lockKv, KV_ACCOUNT_LOGIN: lockKv }), null);
});

test('AccountVerifier.accountSession()（checkAccountSession）：账号 Worker 自己验；吊销 → revoked；设备记录带浏览器 User-Agent', async () => {
  const kv = makeKv();
  const env = withAuthD1({ SGX_ACCOUNT_PUBLIC: PUB, KV_ACCOUNT_LOGIN: kv }); /* account-epoch、device 在 D1_ACCOUNT_AUTH */
  const sid = 'BBBBBBBBBBBBBBBB';
  const t = await testAccountSession(PRIV, 'passkey', 0, Date.now(), undefined, sid);
  const ua = 'Mozilla/5.0 (Linux; Android 16; SM-S9380) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36';
  assert.deepEqual(await checkAccountSession(env, 'sgx-account-session=' + t, { ua, country: 'CN' }), { ok: true });
  const rec = env.D1_ACCOUNT_AUTH.rows('device').find((r) => r.device_id === sid && r.realm === 'account');
  assert.ok(rec, '设备记录补写了（D1 device 表）');
  const dev = JSON.parse(rec.record);
  assert.equal(dev.country, 'CN');
  assert.ok(dev.browser || dev.platform, '从 User-Agent 解析出了浏览器 / 系统');
  env.D1_ACCOUNT_AUTH.raw.prepare("UPDATE device SET revoked_at = ? WHERE realm = 'account' AND device_id = ?").run(Date.now(), sid);
  assert.deepEqual(await checkAccountSession(env, 'sgx-account-session=' + t, {}), { ok: false, reason: 'revoked' });
  assert.equal((await checkAccountSession(env, '')).ok, false);
});

test('check-worker-routes：现在通过；账号 Worker 只要登记任何一条路由就报错', async () => {
  const { readRoutes, readApiRoutes, checkAccount } = await import(REPO + 'scripts/check-worker-routes.mjs');
  const gw = readRoutes(readFileSync(REPO + 'workers/auth-gateway/wrangler.toml', 'utf8'));
  const acct = readRoutes(readFileSync(REPO + 'workers/account/wrangler.toml', 'utf8'));
  const apis = readApiRoutes(readFileSync(REPO + 'workers/auth-gateway/src/routes.js', 'utf8'));
  assert.deepEqual(acct, []);
  assert.ok(!apis.includes('/api/account') && apis.includes('/api/geo') && !apis.includes('/api/prefs'));
  const pages = ['/', '/account/', '/settings/wellbeing/', '/en/settings/'];
  assert.deepEqual(checkAccount(gw, acct, apis, pages), []);
  for (const extra of ['styrigx.com/api/avatar*', 'styrigx.com/avatar/*', 'styrigx.com/settings/*']) {
    assert.ok(checkAccount(gw, [extra], apis, pages).some((e) => e.includes(extra)), extra);
  }
});

/* ---------------- 安全响应头（PR D，workers #3）：和网关主站同一套 ---------------- */
const SECH = await import(REPO + 'workers/account/src/lib/security-headers.js');

test('安全头：头像文件、/api/* 401、访客 /api/prefs 403、不认识的头像尺寸 404 都带全套安全头（和网关同值）', async () => {
  const { env } = setup();
  const reqs = [
    [new Request('https://styrigx.com/avatar/96.webp'), 200],
    [new Request('https://styrigx.com/api/prefs'), 401],
    [new Request('https://styrigx.com/avatar/100.webp'), 404],
  ];
  for (const [req, st] of reqs) {
    const r = await call(req, env);
    assert.equal(r.status, st, req.url);
    for (const [k, v] of SECH.mainSiteHeaderList()) assert.equal(r.headers.get(k), v, req.url + ' ' + k);
    assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
  }
  assert.doesNotMatch(SECH.CSP_ENFORCED, /script-src|style-src|default-src/);
});
