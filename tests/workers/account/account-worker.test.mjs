/**
 * 账号 Worker styrigx-account（workers/account，2026-10-24 从网关拆出来）：
 * - wrangler.toml：名字、不开 workers.dev / 预览地址、四条路由、服务绑定 AUTH → SessionVerifier、正式 / 预览库 id、不绑认证库和钥匙
 * - 门（gate.js）：和网关 middleware 对这几条路径的结论一致（没会话 401 / 302、访客调 /api/prefs 403、头像文件公开、别的域名 403）
 * - 会话问网关（真实 verifier.js）；网关不可达 / 没绑 → 当作无会话
 * - 头像：默认图回源、KV 里的图、只读 KV_PROFILE；X-SGX-Runtime: account；/api/* no-store
 * - 网关 SessionVerifier.account()：和 verifyAccountCookie 同结论，设备记录带上 User-Agent
 *
 * 运行：node --test tests/workers/account/*.test.mjs
 */
import { signRole } from '../auth-gateway/_tk.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gatewayVerifier } from './_auth.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/account/src/index.js')).default;
const { API_ROUTES } = await import(REPO + 'workers/account/src/index.js');
const { signSessionCookie } = await import(REPO + 'workers/auth-gateway/functions/_kernel/session.js');
const { signAccountTicket } = await import(REPO + 'workers/auth-gateway/functions/_kernel/account-session.js');
const { checkAccount } = await import(REPO + 'workers/auth-gateway/src/verifier.js');
const { KEY_VER, keyOf, avatarKv } = await import(REPO + 'workers/account/src/lib/avatar.js');

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
const PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');

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
  const gwEnv = { SGX_LOCK_PUBLIC: PUB, SGX_ACCOUNT_PUBLIC: PUB, KV_LOCK_DOOR: authKv, KV_ACCOUNT_LOGIN: authKv };
  const profile = makeKv();
  const origin = [];
  const env = {
    SGX_ENV: 'production',
    AUTH: gatewayVerifier(gwEnv),
    KV_PROFILE: profile,
    KV_SETTINGS_SYNC: profile,
    ASSETS: { fetch: async (req) => { origin.push(new URL(req.url || req).pathname); return new Response('DEFAULT', { status: 200 }); } },
    ...over,
  };
  return { env, gwEnv, authKv, profile, origin };
}
const CTX = { waitUntil() {} };
const call = (req, env) => worker.fetch(req, env, CTX);
async function sess(role) { return 'sgx-verified=' + (await signRole(signSessionCookie, PRIV, 0, role, 'owner')); }

test('wrangler.toml：styrigx-account、不开公开地址、四条路由、AUTH → SessionVerifier、不绑钥匙和认证库', () => {
  const toml = readFileSync(REPO + 'workers/account/wrangler.toml', 'utf8');
  const [prod, preview] = toml.split(/^\[env\.preview\]$/m);
  assert.match(prod, /^name = "styrigx-account"$/m);
  assert.match(prod, /^main = "src\/index\.js"$/m);
  assert.match(prod, /^workers_dev = false$/m);
  assert.match(prod, /^preview_urls = false$/m);
  assert.match(prod, /^SGX_ENV = "production"$/m);
  const routes = [...prod.matchAll(/^pattern = "([^"]+)"\nzone_name = "styrigx\.com"$/gm)].map((m) => m[1]);
  assert.deepEqual(routes, ['styrigx.com/api/avatar*', 'styrigx.com/api/prefs*', 'styrigx.com/api/wellbeing*', 'styrigx.com/avatar/*']);
  assert.match(prod, /\[\[services\]\]\nbinding = "AUTH"\nservice = "styrigx-auth-gateway"\nentrypoint = "SessionVerifier"/);
  assert.match(prod, /binding = "D1_WELLBEING"\ndatabase_name = "styrigx-account"\ndatabase_id = "03f60d23-9c2f-4f3d-a692-764ccaac6f5d"\nmigrations_dir = "migrations"/);
  assert.doesNotMatch(toml, /secrets_store_secrets|PRIVATE KEY|b796097c90104000992b7713f61e16ea|6931d1da-3502-480d-b0bd-de1bc4829d1d|5084ea8ef2444156ba48203220b93df6|d417e421-75bb-4425-bdc8-54856b88578f/);
  /* 预览：不抢正式路由、不连正式库；预览 D1 还没建 → 只有注释掉的占位，不编 id */
  assert.match(preview, /^routes = \[\]$/m);
  assert.match(preview, /^name = "styrigx-account-preview"$/m);
  assert.doesNotMatch(preview, /b20701f5f48e498e897bc6f0bd81643f|03f60d23-9c2f-4f3d-a692-764ccaac6f5d/);
  assert.doesNotMatch(preview, /^\[\[env\.preview\.d1_databases\]\]$/m);
  assert.match(preview, /^# database_id = "<PLACEHOLDER: styrigx-account-preview 的 database_id>"$/m);
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

test('门：没会话 → /api/* 401 {ok:false} no-store；头像文件公开；不认识的头像路径 → 302 锁屏', async () => {
  const { env } = setup();
  for (const [m, p] of [['GET', '/api/wellbeing'], ['POST', '/api/wellbeing'], ['GET', '/api/prefs'], ['PUT', '/api/avatar'], ['DELETE', '/api/avatar'], ['GET', '/api/prefs/x']]) {
    const r = await call(new Request('https://styrigx.com' + p, { method: m, headers: { Origin: 'https://styrigx.com' }, body: m === 'GET' ? undefined : '{}' }), env);
    assert.equal(r.status, 401, m + ' ' + p);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
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

test('主人：未知子路径 404、不支持的方法 405；/api/prefs/ 尾斜杠同 /api/prefs', async () => {
  const { env, authKv } = setup();
  const ck = await sess('owner');
  assert.equal((await call(new Request('https://styrigx.com/api/avatarx', { headers: { Cookie: ck } }), env)).status, 404);
  assert.equal((await call(new Request('https://styrigx.com/api/avatar', { headers: { Cookie: ck } }), env)).status, 405);
  /* 没登账号 → 401 account（尾斜杠也进 prefs） */
  const r = await call(new Request('https://styrigx.com/api/prefs/', { headers: { Cookie: ck } }), env);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'account');
  /* 登了账号 → 200 */
  const acc = await signAccountTicket(PRIV, 'passkey', 0, Date.now());
  const ok = await call(new Request('https://styrigx.com/api/prefs', { headers: { Cookie: ck + '; sgx-account=' + acc } }), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  assert.ok(authKv);
});

test('会话问网关：网关报错 / 没绑 AUTH / 回了看不懂的东西 → 当作无会话（fail closed）', async () => {
  const ck = await sess('owner');
  const boom = { session: async () => { throw new Error('down'); }, account: async () => { throw new Error('down'); } };
  for (const AUTH of [boom, undefined, { session: async () => ({ ok: true, role: 'root' }), account: async () => ({ ok: 1 }) }]) {
    const { env } = setup({ AUTH });
    const r = await call(new Request('https://styrigx.com/api/wellbeing', { headers: { Cookie: ck } }), env);
    assert.equal(r.status, 401);
    const put = await call(new Request('https://styrigx.com/api/avatar', { method: 'DELETE', headers: { Cookie: ck, Origin: 'https://styrigx.com' } }), env);
    assert.equal(put.status, 401);
  }
});

test('伪造 / 过期的 cookie：网关验签不过 → 401', async () => {
  const { env } = setup();
  const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const otherPriv = derToPem(await crypto.subtle.exportKey('pkcs8', other.privateKey), 'PRIVATE KEY');
  const forged = 'sgx-verified=' + (await signSessionCookie(otherPriv, 0, 'owner', 'owner'));
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

test('网关 SessionVerifier.account()：同 verifyAccountCookie；吊销 → revoked；设备记录带浏览器 User-Agent', async () => {
  const kv = makeKv();
  const gwEnv = { SGX_ACCOUNT_PUBLIC: PUB, KV_ACCOUNT_LOGIN: kv };
  const sid = 'BBBBBBBBBBBBBBBB';
  const t = await signAccountTicket(PRIV, 'passkey', 0, Date.now(), undefined, sid);
  const ua = 'Mozilla/5.0 (Linux; Android 16; SM-S9380) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36';
  assert.deepEqual(await checkAccount('sgx-account=' + t, gwEnv, { ua, country: 'CN' }), { ok: true });
  const rec = [...kv.m.entries()].find(([k]) => k.includes(sid));
  assert.ok(rec, '设备记录补写了');
  const dev = JSON.parse(rec[1].value ?? rec[1]);
  assert.equal(dev.country, 'CN');
  assert.ok(dev.browser || dev.platform, '从 User-Agent 解析出了浏览器 / 系统');
  await kv.put('account-revoked:' + sid, '1');
  assert.deepEqual(await checkAccount('sgx-account=' + t, gwEnv, {}), { ok: false, reason: 'revoked' });
  assert.deepEqual(await checkAccount('', gwEnv), { ok: false, reason: 'no-cookie' });
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
