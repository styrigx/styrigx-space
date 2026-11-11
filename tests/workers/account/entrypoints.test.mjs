/**
 * 账号 Worker 命名入口（workers/account/src/rpc/account-service.js、rpc/account-verifier.js、gate.js；部署入口 index.js）。
 * v6 P4（定稿 v5.2 §十三）起只认 v6 会话（sgx-session）：旧进站身份头（X-Styrigx-Space-*）、旧账号会话（sgx-account-session）、
 * AccountVerifier.authorize（作用域结论）与 /api/account 状态、session / reauth / reset / keys 四个入口全部删除，对应用例一并删除。
 * - index.js：默认导出 = app.js 的 default（一律 404），另导出 AccountService / AccountVerifier / AccountJanitor
 * - AccountService：路由表；没有 v6 身份 → /api/* 401 {ok:false}（PUBLIC_API 除外）；旧身份头 / 旧账号 cookie 一律不算；v6 会话照常
 * - 默认 fetch 一律 404、不读 env；账号 Worker 没有回调网关的代码
 * 运行：node --test tests/workers/account/entrypoints.test.mjs
 */
import './_cf-workers.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeAccountD1 } from './_d1.mjs';

const SRC = '../../../workers/account/src/';
const { WorkerEntrypoint } = await import('cloudflare:workers');
const app = await import(SRC + 'app.js');
const router = await import(SRC + 'router.js');
const index = { default: app.default, API_ROUTES: router.API_ROUTES };
const ep = { ...(await import(SRC + 'rpc/account-service.js')), ...(await import(SRC + 'rpc/account-verifier.js')), ...(await import(SRC + 'gate.js')) };
const stack = await import(SRC + 'core/identity-stack.js');
const { readFileSync } = await import('node:fs');
const { _resetSecretCache } = await import(SRC + 'secrets.js');

const CTX = { waitUntil() {} };
const ORIGIN = 'https://styrigx.com';
const OLD_HEADERS = { 'X-Styrigx-Space-Session': '1', 'X-Styrigx-Space-By': 'password', 'X-Styrigx-Space-Level': 'password', 'X-Styrigx-Client-Address': '10.9.9.9' };

beforeEach(() => _resetSecretCache());

/** 账号 Worker env：账号库 + 账号 pepper；styrigx（uid 1000）一个用户 */
function makeEnv(over = {}) {
  const db = makeAccountD1();
  db.raw.prepare("INSERT INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (1000, 'styrigx', '', 0, 0, 0, 1)").run();
  for (const g of ['wheel', 'sudoers', 'listen', 'ai', 'status', 'curio-write', 'daymark-write']) db.raw.prepare('INSERT INTO account_user_groups (uid, grp, added_at) VALUES (1000, ?, 1)').run(g);
  return {
    SGX_ENV: 'production',
    D1_ACCOUNT: db,
    KV_PROFILE: { get: async () => null, getWithMetadata: async () => ({ value: null, metadata: null }), put: async () => {}, delete: async () => {} },
    ASSETS: { fetch: async () => new Response('DEFAULT', { status: 200 }) },
    SGX_ACCOUNT_PASSWORD_PEPPER: 'pep',
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: ORIGIN,
    ...over,
  };
}
async function v6Cookie(env) {
  const s = await stack.issueSession(env, { uid: 1000, epoch: 0 });
  return 'sgx-session=' + s.token;
}

const service = (env) => new ep.AccountService(CTX, env);
const req = (path, o = {}) => new Request(ORIGIN + path, { method: o.method || 'GET', headers: { Origin: ORIGIN, ...(o.headers || {}) }, body: o.body });

/* ---------------- 导出 ---------------- */

test('index.js：默认导出就是 app.js 的 default；AccountService / AccountVerifier / AccountJanitor 是 WorkerEntrypoint 子类；AccountVerifier 没有 authorize（v6 P4）', () => {
  const entry = readFileSync(new URL(SRC + 'index.js', import.meta.url), 'utf8');
  assert.match(entry, /export \{ default \} from '\.\/app\.js'/);
  assert.match(entry, /export \{ AccountService \} from '\.\/rpc\/account-service\.js'/);
  assert.match(entry, /export \{ AccountVerifier \} from '\.\/rpc\/account-verifier\.js'/);
  assert.match(entry, /export \{ AccountJanitor \} from '\.\/rpc\/account-janitor\.js'/);
  assert.equal((entry.match(/^export /gm) || []).length, 4, '只接线：四条再导出');
  assert.ok(new ep.AccountService(CTX, {}) instanceof WorkerEntrypoint);
  assert.ok(new ep.AccountVerifier(CTX, {}) instanceof WorkerEntrypoint);
  assert.equal(typeof ep.AccountService.prototype.fetch, 'function');
  assert.equal(typeof ep.AccountVerifier.prototype.admit, 'function');
  assert.equal(typeof ep.AccountVerifier.prototype.auditRoot, 'function');
  assert.equal(ep.AccountVerifier.prototype.authorize, undefined, 'v6 P4：旧账号会话的作用域结论删除');
  assert.equal(ep.AccountVerifier.prototype.fetch, undefined);
  assert.equal(ep.checkAuthorize, undefined);
});

test('路由表（v6 P4）：/api/account/devices、grants、proxy + 四个账号数据接口 + /api/identity；/api/account 状态与 session / reauth / reset / keys 删除', () => {
  assert.deepEqual([...index.API_ROUTES.keys()].sort(), ['/api/account/devices', '/api/account/grants', '/api/account/proxy',
    '/api/avatar', '/api/identity', '/api/prefs', '/api/profile', '/api/wellbeing']);
  assert.equal(ep.SERVICE_API_ROUTES, index.API_ROUTES);
});

/* ---------------- AccountService ---------------- */

test('AccountService：没有 v6 身份 → /api/* 401 {ok:false}（最小门，PUBLIC_API 除外）；头像文件照旧公开', async () => {
  const env = makeEnv();
  for (const [m, p] of [['GET', '/api/account'], ['POST', '/api/account/devices'], ['GET', '/api/prefs'], ['POST', '/api/wellbeing'], ['GET', '/api/wellbeing/x'], ['PUT', '/api/avatar']]) {
    const r = await service(env).fetch(req(p, { method: m, body: m === 'GET' ? undefined : '{}' }));
    assert.equal(r.status, 401, m + ' ' + p);
    assert.deepEqual(await r.json(), { ok: false });
  }
  const av = await service(env).fetch(req('/avatar/96.webp'));
  assert.equal(av.status, 200);
  assert.equal(await av.text(), 'DEFAULT');
});

test('AccountService（v6 P4）：旧进站身份头、旧账号会话 cookie 一律不算 → 401', async () => {
  const env = makeEnv();
  for (const headers of [OLD_HEADERS, { ...OLD_HEADERS, Cookie: 'sgx-account-session=password.0.1.2.dev.sig' }, { Cookie: 'sgx-space-session=password.0.9999999999999.sig' }]) {
    for (const [m, p] of [['GET', '/api/prefs'], ['POST', '/api/account/devices'], ['POST', '/api/account/grants']]) {
      const r = await service(env).fetch(req(p, { method: m, headers, body: m === 'GET' ? undefined : '{"action":"list"}' }));
      assert.equal(r.status, 401, m + ' ' + p + ' ' + JSON.stringify(headers));
    }
  }
});

test('AccountService：v6 会话 → GET /api/prefs 200（X-SGX-Runtime: account、no-store），POST /api/account/devices list 200', async () => {
  const env = makeEnv();
  const ck = await v6Cookie(env);
  let r = await service(env).fetch(req('/api/prefs', { headers: { Cookie: ck } }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
  assert.match(r.headers.get('Cache-Control'), /no-store/);
  r = await service(env).fetch(req('/api/account/devices', { method: 'POST', headers: { Cookie: ck, 'Content-Type': 'application/json' }, body: '{"action":"list"}' }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).devices.length, 1);
});

test('AccountService：处理中抛错 → 500 internal（仍打 X-SGX-Runtime）', async () => {
  const env = makeEnv({ D1_ACCOUNT: { prepare() { throw new Error('boom'); } } });
  const bad = new Request(ORIGIN + '/api/prefs');
  Object.defineProperty(bad, 'url', { get() { throw new TypeError('x'); } });
  const r = await service(env).fetch(bad);
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'internal');
  assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
});

/* ---------------- 默认 fetch：一律 404（第二道保险） ---------------- */

test('默认 fetch：任何路径一律 404，伪造的 x-styrigx-* 头 + cookie 也碰不到接口', async () => {
  const env = makeEnv();
  const ck = await v6Cookie(env);
  for (const [m, p] of [['GET', '/api/account'], ['POST', '/api/identity'], ['GET', '/api/wellbeing'], ['GET', '/api/prefs'], ['GET', '/avatar/32.webp']]) {
    const r = await index.default.fetch(req(p, { method: m, headers: { ...OLD_HEADERS, Cookie: ck }, body: m === 'POST' ? '{"action":"whoami"}' : undefined }), env, CTX);
    assert.equal(r.status, 404, m + ' ' + p);
    assert.equal((await r.json()).error, 'not-found');
    assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
  }
});

test('默认 fetch：不读 env（不碰账号库 / 钥匙）', async () => {
  let touched = 0;
  const env = new Proxy({}, { get() { touched++; return undefined; } });
  const r = await index.default.fetch(req('/api/prefs', { headers: OLD_HEADERS }), env, CTX);
  assert.equal(r.status, 404);
  assert.equal(touched, 0);
});

test('源码：账号 Worker 没有任何回调网关的代码（不读 env.AUTH、不 import 网关目录、没有 auth.js）；v6 P4 起不读旧进站身份头', async () => {
  const { readdirSync, readFileSync: rf, existsSync } = await import('node:fs');
  const root = new URL(SRC, import.meta.url).pathname;
  assert.equal(existsSync(root + 'auth.js'), false);
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + e.name + '/') : [d + e.name]));
  for (const f of walk(root).filter((x) => x.endsWith('.js'))) {
    const code = rf(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /env\.AUTH\b|env\[['"]AUTH['"]\]|SpaceVerifier|auth-gateway|D1_SPACE|SGX_LOCK_|SGX_SPACE_RECOVERY_KEY|SGX_SPACE_PASSWORD_PEPPER|SGX_ACCOUNT_RECOVERY_KEY|lock_reset_switch|X-Styrigx-Space-Session|sgx-account-session/i, f);
  }
});

test('verifierRequest：只带 Cookie / User-Agent / 地点头，不带锁屏身份头；超长 cookie 截断', () => {
  const r = ep.verifierRequest('a=' + 'x'.repeat(10000), { ua: 'U'.repeat(600), country: 'CN', city: 'Shanghai', role: 'password' });
  assert.equal(r.headers.get('Cookie').length, 8192);
  assert.equal(r.headers.get('User-Agent').length, 512);
  assert.equal(r.headers.get('X-Styrigx-Client-Country'), 'CN');
  assert.equal(r.headers.get('X-Styrigx-Client-City'), 'Shanghai');
  assert.equal(r.headers.get('X-Styrigx-Space-Level'), null);
  assert.deepEqual([...r.headers.keys()].sort(), ['cookie', 'user-agent', 'x-styrigx-client-city', 'x-styrigx-client-country']);
});

test('个人资料（经 AccountService）：GET /api/profile 公开；PUT 要 v6 会话（没有 → 401），有 → 200', async () => {
  const kvm = new Map();
  const kv = { get: async (k) => (kvm.has(k) ? kvm.get(k) : null), getWithMetadata: async () => ({ value: null, metadata: null }), put: async (k, v) => { kvm.set(k, v); }, delete: async (k) => { kvm.delete(k); } };
  const env = makeEnv({ KV_PROFILE: kv });
  let r = await service(env).fetch(req('/api/profile'));
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(await r.json()).sort(), ['avatar', 'ok', 'profile', 'updatedAt'], '只回公开字段');
  r = await service(env).fetch(req('/api/profile', { method: 'PUT', headers: { ...OLD_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'X' }) }));
  assert.equal(r.status, 401, '旧身份头不算');
  const ck = await v6Cookie(env);
  r = await service(env).fetch(req('/api/profile', { method: 'PUT', headers: { Cookie: ck, 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'Gray' }) }));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal((await r.json()).profile.nickname, 'Gray');
});
