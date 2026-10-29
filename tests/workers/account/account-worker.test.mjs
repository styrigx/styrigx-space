/**
 * 账号 Worker styrigx-account（workers/account，2026-10-24 从网关拆出来）：
 * - wrangler.toml：名字、不开 workers.dev / 预览地址、四条路由、服务绑定 AUTH → AuthVerifier、正式 / 预览库 id、
 *   D1_ACCOUNT_AUTH 指向账号库（PR2）、不绑网关认证库（Secrets Store 绑定见 account-auth-scaffold.test.mjs）
 * - 门（gate.js）：和网关 middleware 对这几条路径的结论一致（没会话 401 / 302、访客调 /api/prefs 403、头像文件公开、别的域名 403）
 * - 会话问网关（真实 verifier.js）；网关不可达 / 没绑 → 当作无会话
 * - 头像：默认图回源、KV 里的图、只读 KV_PROFILE；X-SGX-Runtime: account；/api/* no-store
 * - 网关 AuthVerifier.accountSession()：和 verifyAccountSession 同结论，设备记录带上 User-Agent
 *
 * 运行：node --test tests/workers/account/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gatewayVerifier } from './_auth.mjs';
import { testLockSession, testAccountSession } from '../auth-gateway/_tickets.mjs';
import { genKeyPair, withAuthD1 } from '../_harness.mjs';
import { makeAccountD1 } from './_d1.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/account/src/index.js')).default;
const { API_ROUTES } = await import(REPO + 'workers/account/src/index.js');
const { signLockSessionTicket } = await import(REPO + 'workers/auth-gateway/functions/_kernel/lock-session.js');
const { signAccountSessionTicket } = await import(REPO + 'workers/auth-gateway/functions/_kernel/account-session.js');
const { checkAccountSession } = await import(REPO + 'workers/auth-gateway/src/verifier.js');
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

/** 网关那边的 env（钥匙 + 认证库）和账号 Worker 的 env（账号库 + AUTH 绑定）分开放，和线上一样 */
function setup(over = {}) {
  const authKv = makeKv();
  const gwEnv = withAuthD1({ SGX_LOCK_PUBLIC: PUB, SGX_ACCOUNT_PUBLIC: PUB, KV_LOCK_DOOR: authKv, KV_ACCOUNT_LOGIN: authKv });
  const profile = makeKv();
  const origin = [];
  const env = {
    SGX_ENV: 'production',
    AUTH: gatewayVerifier(gwEnv),
    KV_PROFILE: profile,
    D1_SETTINGS_SYNC: makeAccountD1(),
    ASSETS: { fetch: async (req) => { origin.push(new URL(req.url || req).pathname); return new Response('DEFAULT', { status: 200 }); } },
    ...over,
  };
  return { env, gwEnv, authKv, profile, origin };
}
const CTX = { waitUntil() {} };
const call = (req, env) => worker.fetch(req, env, CTX);
async function sess(role) { return 'sgx-lock-session=' + (await testLockSession(PRIV, 0, role)); }

test('wrangler.toml：styrigx-account、不开公开地址、四条路由、AUTH → AuthVerifier、D1_ACCOUNT_AUTH → 账号库、不绑网关认证库', () => {
  const toml = readFileSync(REPO + 'workers/account/wrangler.toml', 'utf8');
  const [prod, preview] = toml.split(/^\[env\.preview\]$/m);
  assert.match(prod, /^name = "styrigx-account"$/m);
  assert.match(prod, /^main = "src\/worker\.js"$/m);
  assert.match(prod, /^workers_dev = false$/m);
  assert.match(prod, /^preview_urls = false$/m);
  assert.match(prod, /^SGX_ENV = "production"$/m);
  const routes = [...prod.matchAll(/^pattern = "([^"]+)"\nzone_name = "styrigx\.com"$/gm)].map((m) => m[1]);
  assert.deepEqual(routes, ['styrigx.com/api/avatar*', 'styrigx.com/api/prefs*', 'styrigx.com/api/wellbeing*', 'styrigx.com/avatar/*']);
  assert.match(prod, /\[\[services\]\]\nbinding = "AUTH"\nservice = "styrigx-auth-gateway"\nentrypoint = "AuthVerifier"/);
  assert.match(prod, /binding = "D1_WELLBEING"\ndatabase_name = "styrigx-account"\ndatabase_id = "03f60d23-9c2f-4f3d-a692-764ccaac6f5d"\nmigrations_dir = "migrations"/);
  /* 2026-10-28 云同步搬到 D1：D1_SETTINGS_SYNC 和 D1_WELLBEING 同一个库；KV 只剩 KV_PROFILE（公开头像），正式 / 预览都没有 KV_SETTINGS_SYNC */
  assert.match(prod, /\[\[d1_databases\]\]\nbinding = "D1_SETTINGS_SYNC"\ndatabase_name = "styrigx-account"\ndatabase_id = "03f60d23-9c2f-4f3d-a692-764ccaac6f5d"\nmigrations_dir = "migrations"/);
  const code = toml.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  assert.doesNotMatch(code, /KV_SETTINGS_SYNC/);
  assert.deepEqual([...code.matchAll(/^binding = "(KV_[A-Z0-9_]+)"/gm)].map((m) => m[1]), ['KV_PROFILE', 'KV_PROFILE']);
  assert.match(prod, /KV_PROFILE 只放公开的头像 avatar:\*/);
  /* 2026-10-29 PR2：账号鉴权脚手架。D1_ACCOUNT_AUTH 指向账号库（不是网关认证库 6931d1da…），钥匙只经 Secrets Store 绑定，不写进 toml */
  assert.doesNotMatch(toml, /PRIVATE KEY|b796097c90104000992b7713f61e16ea|6931d1da-3502-480d-b0bd-de1bc4829d1d|5084ea8ef2444156ba48203220b93df6|d417e421-75bb-4425-bdc8-54856b88578f/);
  assert.match(prod, /\[\[d1_databases\]\]\nbinding = "D1_ACCOUNT_AUTH"\ndatabase_name = "styrigx-account"\ndatabase_id = "03f60d23-9c2f-4f3d-a692-764ccaac6f5d"\nmigrations_dir = "migrations"\n/);
  assert.match(prod, /^SGX_RP_ID = "styrigx\.com"$/m);
  assert.match(prod, /^SGX_ORIGIN = "https:\/\/styrigx\.com"$/m);
  assert.doesNotMatch(prod, /^SGX_\w+_(PUBLIC|PRIVATE) = /m);
  /* 预览：不抢正式路由、不连正式库；KV / D1 都是所有 Worker 预览共用的测试资源（2026-10-29，D1 styrigx-test-preview） */
  assert.match(preview, /^routes = \[\]$/m);
  assert.match(preview, /^name = "styrigx-account-preview"$/m);
  assert.doesNotMatch(preview, /b20701f5f48e498e897bc6f0bd81643f|03f60d23-9c2f-4f3d-a692-764ccaac6f5d/);
  assert.doesNotMatch(preview, /PLACEHOLDER/);
  assert.match(preview, /\[\[env\.preview\.kv_namespaces\]\]\nbinding = "KV_PROFILE"\nid = "193b4d68b8ac4c6f8c0ba16b5ea78b14"/);
  /* 共库：迁移记录表单独用 d1_migrations_account，不和网关 / 短链的迁移记录混在一起 */
  for (const b of ['D1_WELLBEING', 'D1_SETTINGS_SYNC', 'D1_ACCOUNT_AUTH']) {
    assert.match(preview, new RegExp('\\[\\[env\\.preview\\.d1_databases\\]\\]\\nbinding = "' + b + '"\\ndatabase_name = "styrigx-test-preview"\\ndatabase_id = "1339bb0b-f9f8-4e3d-b413-ff07ca28ce69"\\nmigrations_dir = "migrations"\\nmigrations_table = "d1_migrations_account"'), b);
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

test('路由表：只有这三个接口', () => {
  assert.deepEqual([...API_ROUTES.keys()].sort(), ['/api/avatar', '/api/prefs', '/api/wellbeing']);
});

test('门：没会话 → /api/* 401 {ok:false} private, no-store（workers/account/src/lib/http.js json()）；头像文件公开；不认识的头像路径 → 302 锁屏', async () => {
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
  assert.equal(bad.status, 302);
  assert.equal(bad.headers.get('Location'), 'https://styrigx.com/?lock=1&return=' + encodeURIComponent('/avatar/100.webp?x=1'));
  assert.equal(bad.headers.get('X-Robots-Tag'), 'noindex');
});

test('门：访客调 /api/prefs → 403 role；认证类 action 照网关放过去，接口再按会话拒（401 session）', async () => {
  const { env } = setup();
  const ck = await sess('visitor');
  let r = await call(new Request('https://styrigx.com/api/prefs', { headers: { Cookie: ck } }), env);
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: 'role' });
  r = await call(new Request('https://styrigx.com/api/prefs', { method: 'POST', headers: { Cookie: ck, Origin: 'https://styrigx.com', 'Content-Type': 'application/json' }, body: '{"changes":{}}' }), env);
  assert.equal(r.status, 403);
  r = await call(new Request('https://styrigx.com/api/prefs', { method: 'POST', headers: { Cookie: ck, Origin: 'https://styrigx.com', 'Content-Type': 'application/json' }, body: '{"action":"verify"}' }), env);
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

test('会话问网关：网关报错 / 没绑 AUTH / 回了看不懂的东西 → 当作无会话（fail closed）', async () => {
  const ck = await sess('admin');
  const boom = { lockSession: async () => { throw new Error('down'); }, accountSession: async () => { throw new Error('down'); } };
  for (const AUTH of [boom, undefined, { lockSession: async () => ({ ok: true, role: 'root' }), accountSession: async () => ({ ok: 1 }) }]) {
    const { env } = setup({ AUTH });
    const r = await call(new Request('https://styrigx.com/api/wellbeing', { headers: { Cookie: ck } }), env);
    assert.equal(r.status, 401);
    const put = await call(new Request('https://styrigx.com/api/avatar', { method: 'DELETE', headers: { Cookie: ck, Origin: 'https://styrigx.com' } }), env);
    assert.equal(put.status, 401);
  }
});

test('伪造 / 过期的 cookie：网关验签不过 → 401', async () => {
  const { env } = setup();
  const { priv: otherPriv } = await genKeyPair();
  const forged = 'sgx-lock-session=' + (await testLockSession(otherPriv, 0, 'admin', 'password'));
  const r = await call(new Request('https://styrigx.com/api/wellbeing', { headers: { Cookie: forged } }), env);
  assert.equal(r.status, 401);
});

test('别的域名：/api/* 403，头像 301 到 styrigx.com（路由只登记 styrigx.com，正常进不来）', async () => {
  const { env } = setup();
  const r = await call(new Request('https://evil.example/api/prefs'), env);
  assert.equal(r.status, 403);
  const a = await call(new Request('http://www.styrigx.com/avatar/96.webp'), env);
  assert.equal(a.status, 301);
  assert.equal(a.headers.get('Location'), 'https://styrigx.com/avatar/96.webp');
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

test('网关 AuthVerifier.accountSession()：同 verifyAccountSession；吊销 → revoked；设备记录带浏览器 User-Agent', async () => {
  const kv = makeKv();
  const gwEnv = withAuthD1({ SGX_ACCOUNT_PUBLIC: PUB, KV_ACCOUNT_LOGIN: kv }); /* account-epoch 在 D1 */
  const sid = 'BBBBBBBBBBBBBBBB';
  const t = await testAccountSession(PRIV, 'passkey', 0, Date.now(), undefined, sid);
  const ua = 'Mozilla/5.0 (Linux; Android 16; SM-S9380) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36';
  assert.deepEqual(await checkAccountSession('sgx-account-session=' + t, gwEnv, { ua, country: 'CN' }), { ok: true });
  const rec = gwEnv.D1_ACCOUNT_AUTH.rows('device').find((r) => r.device_id === sid && r.realm === 'account');
  assert.ok(rec, '设备记录补写了（D1 device 表）');
  const dev = JSON.parse(rec.record);
  assert.equal(dev.country, 'CN');
  assert.ok(dev.browser || dev.platform, '从 User-Agent 解析出了浏览器 / 系统');
  /* 单独退出：D1 device.revoked_at（强一致，下一个请求就拒） */
  gwEnv.D1_ACCOUNT_AUTH.raw.prepare("UPDATE device SET revoked_at = ? WHERE realm = 'account' AND device_id = ?").run(Date.now(), sid);
  assert.deepEqual(await checkAccountSession('sgx-account-session=' + t, gwEnv, {}), { ok: false, reason: 'revoked' });
  assert.deepEqual(await checkAccountSession('', gwEnv), { ok: false, reason: 'no-cookie' });
});

test('check-worker-routes：现在的两份路由通过；账号 Worker 规则写宽了（抢网关接口 / 页面）就报错', async () => {
  const { readRoutes, readApiRoutes, checkAccount } = await import(REPO + 'scripts/check-worker-routes.mjs');
  const gw = readRoutes(readFileSync(REPO + 'workers/auth-gateway/wrangler.toml', 'utf8'));
  const acct = readRoutes(readFileSync(REPO + 'workers/account/wrangler.toml', 'utf8'));
  const apis = readApiRoutes(readFileSync(REPO + 'workers/auth-gateway/src/routes.js', 'utf8'));
  assert.ok(apis.includes('/api/account') && apis.includes('/api/geo') && !apis.includes('/api/prefs'));
  const pages = ['/', '/account/', '/settings/wellbeing/', '/en/settings/'];
  assert.deepEqual(checkAccount(gw, acct, apis, pages), []);
  assert.ok(checkAccount(gw, acct.concat('styrigx.com/api/a*'), apis, pages).some((e) => e.includes('/api/account')));
  assert.ok(checkAccount(gw, acct.concat('styrigx.com/settings/*'), apis, pages).some((e) => e.includes('/settings/wellbeing/')));
  assert.ok(checkAccount(gw, acct.filter((r) => !r.includes('wellbeing')), apis, pages).some((e) => e.includes('/api/wellbeing')));
  assert.ok(checkAccount(gw, acct.concat('blog.styrigx.com/avatar/*'), apis, pages).some((e) => e.includes('不在 styrigx.com')));
});

/* ---------------- 安全响应头（PR D，workers #3）：和网关主站同一套 ---------------- */
const SECH = await import(REPO + 'workers/account/src/lib/security-headers.js');

test('安全头：头像文件、/api/* 401、www 301、不认识的头像路径 302 都带全套安全头（和网关同一份）', async () => {
  const { env } = setup();
  const reqs = [
    [new Request('https://styrigx.com/avatar/96.webp'), 200],
    [new Request('https://styrigx.com/api/prefs'), 401],
    [new Request('http://www.styrigx.com/avatar/96.webp'), 301],
    [new Request('https://styrigx.com/avatar/100.webp'), 302],
  ];
  for (const [req, st] of reqs) {
    const r = await call(req, env);
    assert.equal(r.status, st, req.url);
    for (const [k, v] of SECH.mainSiteHeaderList()) assert.equal(r.headers.get(k), v, req.url + ' ' + k);
    assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
  }
  assert.doesNotMatch(SECH.CSP_ENFORCED, /script-src|style-src|default-src/);
});
