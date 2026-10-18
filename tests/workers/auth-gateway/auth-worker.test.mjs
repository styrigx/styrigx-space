/**
 * 鉴权 Worker（workers/auth-gateway）：
 * - 路由表与 functions/api/ 文件一一对应（新增接口忘了登记 → CI 红）
 * - 方法挑选、尾斜杠与 Pages 一致
 * - Secrets Store 绑定换成字符串；取值失败留空且不缓存
 * - 同一请求走 Worker 和走 Pages（middleware + 接口）结果一致
 * - 页面：网关验会话，放行后回源 Pages；跳转原样交回；会话标记不重复
 *
 * 运行：node --test tests/kernel/auth-worker.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const worker = (await import(REPO + '/workers/auth-gateway/src/index.js')).default;
const { routeKey, pickHandler } = await import(REPO + '/workers/auth-gateway/src/index.js');
const { API_ROUTES } = await import(REPO + '/workers/auth-gateway/src/routes.js');
const { resolveSecrets, SECRET_NAMES, _resetSecretCache } = await import(REPO + '/workers/auth-gateway/src/secrets.js');
const pagesMw = await import(REPO + '/functions/_middleware.js');
const { signSessionCookie } = await import(REPO + '/functions/_kernel/session.js');

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
const PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');

function makeKv() {
  const m = new Map();
  return {
    m,
    async get(k) { if (k === 'session-epoch') return '0'; const v = m.get(k); return v === undefined ? null : v; },
    async getWithMetadata(k) { const v = m.get(k); return { value: v ?? null, metadata: null }; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
}
const store = (v) => ({ get: async () => v });
function baseEnv() {
  return { SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB, OWNER_KV: makeKv() };
}
const CTX = { waitUntil() {} };

test('路由表与 functions/api/*.js 一一对应', () => {
  const files = readdirSync(REPO + '/functions/api').filter(f => f.endsWith('.js')).map(f => '/api/' + f.slice(0, -3)).sort();
  assert.deepEqual([...API_ROUTES.keys()].sort(), files);
});

test('wrangler.toml：不开 workers.dev、生产模式、9 个密钥全走 Secrets Store、填了真实 store_id', () => {
  const toml = readFileSync(REPO + '/workers/auth-gateway/wrangler.toml', 'utf8');
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^SGX_ENV = "production"$/m);
  for (const n of SECRET_NAMES) {
    assert.match(toml, new RegExp(`binding = "${n}"\\nstore_id = "[^"]+"\\nsecret_name = "${n}"`));
  }
  assert.equal(SECRET_NAMES.length, 9);
  /* 只接 styrigx.com 的 /api 和页面目录：不接别的子域，不接静态资源（完整核对见 scripts/check-worker-routes.mjs） */
  const routes = [...toml.matchAll(/^pattern = "([^"]+)"$/gm)].map(m => m[1]);
  assert.ok(routes.includes('styrigx.com/api/*'));
  assert.ok(routes.includes('styrigx.com/'));
  for (const r of routes) assert.match(r, /^styrigx\.com\//);
  assert.ok(!routes.includes('styrigx.com/*'), '不能整站通配：静态资源不过 Worker，也给以后别的 Worker 留路径');
  assert.doesNotMatch(toml, /REPLACE_WITH_STORE_ID/);
  assert.match(toml, /^\[observability\]\nenabled = true$/m); // 日志写进配置，免得部署把后台开关改回去
  assert.doesNotMatch(toml, /^SGX_\w+_PUBLIC = /m);
  assert.doesNotMatch(toml, /PRIVATE KEY/);
});

test('routeKey / pickHandler 与 Pages 一致', () => {
  assert.equal(routeKey('/api/lock/'), '/api/lock');
  assert.equal(routeKey('/api/lock'), '/api/lock');
  const mod = { onRequestGet: () => 'g', onRequest: () => 'any' };
  assert.equal(pickHandler(mod, 'GET')(), 'g');
  assert.equal(pickHandler(mod, 'post')(), 'any');
  assert.equal(pickHandler({ onRequestPut: () => 1 }, 'GET'), null);
  assert.equal(pickHandler(mod, 'TRACE'), null);
});

test('resolveSecrets：绑定 → 字符串；字符串原样；其他绑定不动', async () => {
  _resetSecretCache();
  const kv = makeKv();
  const env = { SGX_LOCK_PRIVATE: store('L'), SGX_PW_PEPPER: 'P', OWNER_KV: kv, SGX_SITE: 'space' };
  const out = await resolveSecrets(env, 1000);
  assert.equal(out.SGX_LOCK_PRIVATE, 'L');
  assert.equal(out.SGX_PW_PEPPER, 'P');
  assert.equal(out.OWNER_KV, kv);
  assert.equal(out.SGX_SITE, 'space');
  assert.equal('SGX_ROOT_KEY' in out, false);
  assert.equal(typeof env.SGX_LOCK_PRIVATE, 'object'); /* 不改原 env */
});

test('resolveSecrets：60 秒缓存；取值失败留空且不缓存', async () => {
  _resetSecretCache();
  let n = 0;
  const counting = { get: async () => { n++; return 'v' + n; } };
  assert.equal((await resolveSecrets({ SGX_ROOT_KEY: counting }, 0)).SGX_ROOT_KEY, 'v1');
  assert.equal((await resolveSecrets({ SGX_ROOT_KEY: counting }, 30_000)).SGX_ROOT_KEY, 'v1');
  assert.equal((await resolveSecrets({ SGX_ROOT_KEY: counting }, 61_000)).SGX_ROOT_KEY, 'v2');

  _resetSecretCache();
  let fail = true;
  const flaky = { get: async () => { if (fail) throw new Error('x'); return 'ok'; } };
  assert.equal((await resolveSecrets({ SGX_ROOT_KEY: flaky }, 0)).SGX_ROOT_KEY, '');
  fail = false;
  assert.equal((await resolveSecrets({ SGX_ROOT_KEY: flaky }, 1)).SGX_ROOT_KEY, 'ok');
});

/* 页面：网关验会话，放行后回源（这里把 fetch 换成假的 Pages） */
async function withOrigin(html, fn, init = {}) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (req) => {
    calls.push(req);
    return new Response(html, { status: init.status || 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...(init.headers || {}) } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = orig; }
}
const PAGE = '<!DOCTYPE html><html lang="zh"><body><!-- SGX-DESKTOP-START -->desk<!-- SGX-DESKTOP-END -->x</body></html>';

test('页面：未登录访问内页 → 302 到锁屏，不回源', async () => {
  _resetSecretCache();
  await withOrigin(PAGE, async (calls) => {
    const res = await worker.fetch(new Request('https://styrigx.com/settings/'), baseEnv(), CTX);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/?lock=1&return=%2Fsettings%2F');
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
    assert.equal(calls.length, 0);
  });
});

test('页面：未登录首页 → 回源、锁屏态、去掉桌面内容，会话标记只出现一次', async () => {
  _resetSecretCache();
  /* 回源拿到的页面 Pages 已注入过一次 */
  const fromPages = PAGE.replace('<html lang="zh">', '<html data-sgx-session="locked" lang="zh">');
  await withOrigin(fromPages, async (calls) => {
    const res = await worker.fetch(new Request('https://styrigx.com/'), baseEnv(), CTX);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, 'manual');
    const html = await res.text();
    assert.equal((html.match(/data-sgx-session=/g) || []).length, 1);
    assert.match(html, /<html data-sgx-session="locked" lang="zh">/);
    assert.doesNotMatch(html, /desk/);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
  });
});

test('页面：主人访问门内页 → 回源、valid + owner，带 cookie 回源', async () => {
  _resetSecretCache();
  const cookie = 'sgx-verified=' + (await signSessionCookie(PRIV, 0, 'owner', 'owner'));
  await withOrigin(PAGE, async (calls) => {
    const res = await worker.fetch(new Request('https://styrigx.com/settings/security/lock/', { headers: { Cookie: cookie } }), baseEnv(), CTX);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.get('Cookie'), cookie);
    const html = await res.text();
    assert.match(html, /data-sgx-role="owner"/);
    assert.match(html, /data-sgx-session="valid"/);
    assert.match(html, /desk/);
  });
});

test('页面：访客访问门内页 → 302 到锁屏，不回源', async () => {
  _resetSecretCache();
  const cookie = 'sgx-verified=' + (await signSessionCookie(PRIV, 0, 'visitor', 'owner'));
  await withOrigin(PAGE, async (calls) => {
    const res = await worker.fetch(new Request('https://styrigx.com/en/settings/security/owner/', { headers: { Cookie: cookie } }), baseEnv(), CTX);
    assert.equal(res.status, 302);
    assert.equal(calls.length, 0);
  });
});

test('页面：Pages 的跳转（补尾斜杠）原样交回', async () => {
  _resetSecretCache();
  const cookie = 'sgx-verified=' + (await signSessionCookie(PRIV, 0, 'owner', 'owner'));
  await withOrigin('', async () => {
    const res = await worker.fetch(new Request('https://styrigx.com/settings', { headers: { Cookie: cookie } }), baseEnv(), CTX);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('Location'), '/settings/');
  }, { status: 308, headers: { Location: '/settings/' } });
});

test('stripSessionAttrs：只清 <html> 上的 data-sgx-*', () => {
  const html = '<html data-sgx-session="valid" lang="en" data-sgx-role="owner"><body data-sgx-x="1"></body></html>';
  assert.equal(pagesMw.stripSessionAttrs(html), '<html lang="en"><body data-sgx-x="1"></body></html>');
});

test('所有响应带 X-SGX-Runtime: worker，且不改动原有头和正文', async () => {
  _resetSecretCache();
  const res = await worker.fetch(new Request('https://styrigx.com/api/session-check'), baseEnv(), CTX);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
  assert.deepEqual(await res.json(), { ok: false });
});

test('非 styrigx.com 的 /api 请求 → 403（与 Pages 生产规则一致）', async () => {
  const res = await worker.fetch(new Request('https://styrigx-auth-gateway.example.workers.dev/api/session-check'), baseEnv(), CTX);
  assert.equal(res.status, 403);
});

/* 同一请求：Worker vs Pages（middleware.onRequest + next=接口） */
async function viaPages(req, env) {
  const url = new URL(req.url);
  const mod = API_ROUTES.get(routeKey(url.pathname));
  const ctx = {
    request: req, env, params: {}, data: {}, waitUntil() {},
    next: async () => {
      const h = pickHandler(mod, req.method);
      return h ? h({ request: req, env, params: {}, data: {}, waitUntil() {}, next: async () => new Response(null, { status: 404 }) })
        : new Response(null, { status: 405 });
    },
  };
  return pagesMw.onRequest(ctx);
}
async function same(makeReq, role) {
  _resetSecretCache();
  const headers = {};
  if (role) headers.Cookie = 'sgx-verified=' + (await signSessionCookie(PRIV, 0, role, 'owner'));
  const a = await worker.fetch(makeReq(headers), baseEnv(), CTX);
  const b = await viaPages(makeReq(headers), baseEnv());
  assert.equal(a.status, b.status);
  assert.equal(a.headers.get('Cache-Control'), b.headers.get('Cache-Control'));
  assert.equal(await a.text(), await b.text());
  return a;
}

test('一致性：GET /api/session-check 无会话 / 访客 / 主人', async () => {
  const mk = (h) => new Request('https://styrigx.com/api/session-check', { headers: h });
  assert.equal((await same(mk)).status, 401);
  assert.equal((await same(mk, 'visitor')).status, 200);
  assert.equal((await same(mk, 'owner')).status, 200);
});

test('一致性：访客调主人接口 / 无会话调非白名单接口', async () => {
  await same((h) => new Request('https://styrigx.com/api/lock-all-devices', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' }), 'visitor');
  await same((h) => new Request('https://styrigx.com/api/wellbeing', { headers: h }));
});

test('一致性：PUT /api/avatar 访客 → 403', async () => {
  const res = await same((h) => new Request('https://styrigx.com/api/avatar', { method: 'PUT', headers: { ...h, Origin: 'https://styrigx.com' }, body: new FormData() }), 'visitor');
  assert.equal(res.status, 403);
});
