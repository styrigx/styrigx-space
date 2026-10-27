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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, authD1For } from '../_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const worker = (await import(REPO + '/workers/auth-gateway/src/index.js')).default;
const { routeKey, pickHandler } = await import(REPO + '/workers/auth-gateway/src/index.js');
const { API_ROUTES } = await import(REPO + '/workers/auth-gateway/src/routes.js');
const { resolveSecrets, SECRET_NAMES, _resetSecretCache } = await import(REPO + '/workers/auth-gateway/src/secrets.js');
const pagesMw = await import(REPO + '/workers/auth-gateway/functions/_middleware.js');
const htmlKernel = await import(REPO + '/workers/auth-gateway/functions/_kernel/html.js');
const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');

const { priv: PRIV, pub: PUB } = await genKeyPair();

function makeKv() {
  const m = new Map();
  return {
    m,
    async get(k) { const v = m.get(k); return v === undefined ? null : v; }, /* 纪元在 D1（authD1For），KV 里没有 lock-epoch → 0 */
    async getWithMetadata(k) { const v = m.get(k); return { value: v ?? null, metadata: null }; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
}
const store = (v) => ({ get: async () => v });
function baseEnv() {
  const kv = makeKv();
  return { SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB, KV_LOCK_DOOR: kv, D1_LOCK_AUTH: authD1For(kv), D1_ACCOUNT_AUTH: authD1For(kv), D1_ROOT_AUTH: authD1For(kv), KV_ACCOUNT_LOGIN: kv };
}
const CTX = { waitUntil() {} };

test('路由表与 functions/api/*.js 一一对应', () => {
  const files = readdirSync(REPO + '/workers/auth-gateway/functions/api').filter(f => f.endsWith('.js')).map(f => '/api/' + f.slice(0, -3)).sort();
  assert.deepEqual([...API_ROUTES.keys()].sort(), files);
});

test('wrangler.toml：不开 workers.dev、生产模式、6 个密钥全走 Secrets Store、填了真实 store_id', () => {
  const toml = readFileSync(REPO + '/workers/auth-gateway/wrangler.toml', 'utf8');
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^SGX_ENV = "production"$/m);
  for (const n of SECRET_NAMES) {
    assert.match(toml, new RegExp(`binding = "${n}"\\nstore_id = "[^"]+"\\nsecret_name = "${n}"`));
  }
  assert.equal(SECRET_NAMES.length, 6);
  assert.ok(!SECRET_NAMES.includes('TURNSTILE_SECRET'), 'Turnstile 已删，不再绑定');
  /* 2026-10-21：三站整站通配（不带 * 的规则遇到查询串不命中，锁屏入口 /?lock=1 曾因此绕过网关）。
     只接 styrigx.com 和登记过的子站；除 daymark、curio 的 session-check（要比各自 core 的 /api/* 更具体）外不许有精确规则。
     完整核对见 scripts/check-worker-routes.mjs。 */
  const routes = [...toml.matchAll(/^pattern = "([^"]+)"$/gm)].map(m => m[1]);
  for (const h of ['styrigx.com', 'blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com']) assert.ok(routes.includes(h + '/*'), h + '/*');
  for (const r of routes) assert.match(r, /^(styrigx|blog\.styrigx|daymark\.styrigx|curio\.styrigx)\.com\//);
  for (const r of routes) assert.ok(r.endsWith('*') || r === 'daymark.styrigx.com/api/lock-session-check' || r === 'curio.styrigx.com/api/lock-session-check', '精确规则遇到查询串不命中：' + r);
  assert.ok(!routes.some(r => r.startsWith('*')), '不能通配子域名');
  /* 书库已下线：不再路由 book / book-preview，也不再绑定 styrigx-books D1 */
  assert.ok(!routes.some(r => /^book(-preview)?\.styrigx\.com\//.test(r)), '书库已下线，不能再有 book 路由');
  assert.doesNotMatch(toml, /BOOKS_D1|styrigx-books/);
  assert.doesNotMatch(toml, /REPLACE_WITH_STORE_ID/);
  assert.match(toml, /^\[observability\]\nenabled = true$/m); // 日志写进配置，免得部署把后台开关改回去
  assert.doesNotMatch(toml, /^SGX_\w+_PUBLIC = /m);
  assert.doesNotMatch(toml, /PRIVATE KEY/);
});

test('routeKey / pickHandler 与 Pages 一致', () => {
  assert.equal(routeKey('/api/lock-now/'), '/api/lock-now');
  assert.equal(routeKey('/api/lock-now'), '/api/lock-now');
  const mod = { onRequestGet: () => 'g', onRequest: () => 'any' };
  assert.equal(pickHandler(mod, 'GET')(), 'g');
  assert.equal(pickHandler(mod, 'post')(), 'any');
  assert.equal(pickHandler({ onRequestPut: () => 1 }, 'GET'), null);
  assert.equal(pickHandler(mod, 'TRACE'), null);
});

test('resolveSecrets：绑定 → 字符串；字符串原样；其他绑定不动', async () => {
  _resetSecretCache();
  const kv = makeKv();
  const env = { SGX_LOCK_PRIVATE: store('L'), SGX_PW_PEPPER: 'P', KV_LOCK_DOOR: kv, D1_LOCK_AUTH: authD1For(kv), D1_ACCOUNT_AUTH: authD1For(kv), D1_ROOT_AUTH: authD1For(kv), KV_ACCOUNT_LOGIN: kv, SGX_SITE: 'space' };
  const out = await resolveSecrets(env, 1000);
  assert.equal(out.SGX_LOCK_PRIVATE, 'L');
  assert.equal(out.SGX_PW_PEPPER, 'P');
  assert.equal(out.KV_LOCK_DOOR, kv);
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
  const fromPages = PAGE.replace('<html lang="zh">', '<html data-sgx-lock-session="locked" lang="zh">');
  await withOrigin(fromPages, async (calls) => {
    const res = await worker.fetch(new Request('https://styrigx.com/'), baseEnv(), CTX);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, 'manual');
    const html = await res.text();
    assert.equal((html.match(/data-sgx-lock-session=/g) || []).length, 1);
    assert.match(html, /<html data-sgx-lock-session="locked" lang="zh">/);
    assert.doesNotMatch(html, /desk/);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
  });
});

test('页面：管理员访问门内页 → 回源、valid + admin，带 cookie 回源', async () => {
  _resetSecretCache();
  const cookie = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin', 'password'));
  await withOrigin(PAGE, async (calls) => {
    const res = await worker.fetch(new Request('https://styrigx.com/settings/security/lock/', { headers: { Cookie: cookie } }), baseEnv(), CTX);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.get('Cookie'), cookie);
    const html = await res.text();
    assert.match(html, /data-sgx-role="admin"/);
    assert.match(html, /data-sgx-lock-session="valid"/);
    assert.match(html, /desk/);
  });
});

test('页面：访客访问门内页 → 302 到锁屏，不回源', async () => {
  _resetSecretCache();
  const cookie = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'visitor'));
  await withOrigin(PAGE, async (calls) => {
    const res = await worker.fetch(new Request('https://styrigx.com/en/settings/security/lock/', { headers: { Cookie: cookie } }), baseEnv(), CTX);
    assert.equal(res.status, 302);
    assert.equal(calls.length, 0);
  });
});

test('页面：Pages 的跳转（补尾斜杠）原样交回', async () => {
  _resetSecretCache();
  const cookie = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin', 'password'));
  await withOrigin('', async () => {
    const res = await worker.fetch(new Request('https://styrigx.com/settings', { headers: { Cookie: cookie } }), baseEnv(), CTX);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('Location'), '/settings/');
  }, { status: 308, headers: { Location: '/settings/' } });
});

test('stripSessionAttrs：只清 <html> 上的会话标记（body 等别的标签不动）', () => {
  const html = '<html data-sgx-lock-session="valid" lang="en" data-sgx-role="admin"><body data-sgx-x="1"></body></html>';
  assert.equal(htmlKernel.stripSessionAttrs(html), '<html lang="en"><body data-sgx-x="1"></body></html>');
});

test('stripSessionAttrs：只清网关会写的会话标记，保留构建标记 data-sgx-build（2026-10-21）', () => {
  const html = '<html data-sgx-build="abc1234" data-sgx-lock-session="valid" lang="zh" data-sgx-role="admin" data-sgx-account-session="in" data-sgx-upgrade="1" data-sgx-upgrade-return="/x/"><head></head></html>';
  assert.equal(htmlKernel.stripSessionAttrs(html), '<html data-sgx-build="abc1234" lang="zh"><head></head></html>');
});

test('页面：锁屏首页保留 <head> 里的分享卡片 meta 和 <html> 上的构建标记', async () => {
  _resetSecretCache();
  const head = '<head><meta property="og:image" content="https://styrigx.com/og.png"><meta name="twitter:card" content="summary_large_image"><link rel="icon" type="image/svg+xml" href="/favicon.svg"></head>';
  const page = '<!DOCTYPE html><html lang="zh" data-sgx-build="abc1234" data-sgx-lock-session="locked">' + head + '<body><!-- SGX-DESKTOP-START -->desk<!-- SGX-DESKTOP-END -->x</body></html>';
  await withOrigin(page, async () => {
    const res = await worker.fetch(new Request('https://styrigx.com/'), baseEnv(), CTX);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<html data-sgx-lock-session="locked" lang="zh" data-sgx-build="abc1234">/);
    assert.equal((html.match(/data-sgx-lock-session=/g) || []).length, 1);
    assert.ok(html.includes(head), '<head> 原样保留');
    assert.doesNotMatch(html, /desk/);
  });
});

test('锁着也公开：标签页图标 / 分享卡片图（Pages 中间件放行，不跳锁屏）', async () => {
  _resetSecretCache();
  for (const p of ['/favicon.ico', '/favicon.svg', '/og.png']) {
    let called = 0;
    const res = await pagesMw.onRequest({
      request: new Request('https://styrigx.com' + p), env: baseEnv(), params: {}, data: {}, waitUntil() {},
      next: async () => { called++; return new Response('img', { status: 200, headers: { 'Content-Type': 'image/png' } }); },
    });
    assert.equal(res.status, 200, p);
    assert.equal(called, 1, p);
    assert.equal(await res.text(), 'img', p);
  }
  /* 对照：未登录的内页仍跳锁屏 */
  const res = await pagesMw.onRequest({
    request: new Request('https://styrigx.com/settings/'), env: baseEnv(), params: {}, data: {}, waitUntil() {},
    next: async () => new Response('page'),
  });
  assert.equal(res.status, 302);
});

test('所有响应带 X-SGX-Runtime: worker，且不改动原有头和正文', async () => {
  _resetSecretCache();
  const res = await worker.fetch(new Request('https://styrigx.com/api/lock-session-check'), baseEnv(), CTX);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
  assert.deepEqual(await res.json(), { ok: false });
});

test('非 styrigx.com 的 /api 请求 → 403（与 Pages 生产规则一致）', async () => {
  const res = await worker.fetch(new Request('https://styrigx-auth-gateway.example.workers.dev/api/lock-session-check'), baseEnv(), CTX);
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
  if (role) headers.Cookie = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, role));
  const a = await worker.fetch(makeReq(headers), baseEnv(), CTX);
  const b = await viaPages(makeReq(headers), baseEnv());
  assert.equal(a.status, b.status);
  assert.equal(a.headers.get('Cache-Control'), b.headers.get('Cache-Control'));
  assert.equal(await a.text(), await b.text());
  return a;
}

test('一致性：GET /api/lock-session-check 无会话 / 访客 / 管理员', async () => {
  const mk = (h) => new Request('https://styrigx.com/api/lock-session-check', { headers: h });
  assert.equal((await same(mk)).status, 401);
  assert.equal((await same(mk, 'visitor')).status, 200);
  assert.equal((await same(mk, 'admin')).status, 200);
});

test('一致性：访客调管理员接口 / 无会话调非白名单接口', async () => {
  await same((h) => new Request('https://styrigx.com/api/lock-all-devices', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' }), 'visitor');
  await same((h) => new Request('https://styrigx.com/api/geo-nope', { headers: h }));
});

test('头像 / 云同步 / 数字健康已搬到账号 Worker：网关路由表里没有，有会话打过来 → 404', async () => {
  for (const p of ['/api/avatar', '/api/prefs', '/api/wellbeing']) assert.equal(API_ROUTES.has(p), false, p);
  _resetSecretCache();
  const env = baseEnv();
  const ck = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin', 'password'));
  for (const p of ['/api/avatar', '/api/prefs', '/api/wellbeing']) {
    const res = await worker.fetch(new Request('https://styrigx.com' + p, { headers: { Cookie: ck } }), env, CTX);
    assert.equal(res.status, 404, p);
  }
});

/* ---- Pages 只放静态文件：后端代码全在网关 ---- */

test('仓库：根目录没有 functions/、migrations/、wrangler.toml（Pages 部署不会再带后端代码）', () => {
  for (const p of ['functions', 'migrations', 'wrangler.toml']) {
    assert.equal(existsSync(REPO + '/' + p), false, p + ' 应该在 workers/auth-gateway/ 或 web/ 下');
  }
  assert.ok(existsSync(REPO + '/workers/auth-gateway/functions/_middleware.js'));
  assert.ok(existsSync(REPO + '/workers/auth-gateway/migrations'));
});

test('web/wrangler.toml：Pages 生产没有变量和绑定，预览不连正式库', () => {
  const toml = readFileSync(REPO + '/web/wrangler.toml', 'utf8');
  const top = toml.split(/^\[/m)[0];
  assert.match(top, /^pages_build_output_dir = "public"$/m);
  assert.doesNotMatch(toml, /^\[vars\]$/m);
  assert.doesNotMatch(toml, /^\[\[(kv_namespaces|d1_databases)\]\]$/m);
  assert.doesNotMatch(toml, /b796097c90104000992b7713f61e16ea|2804d280-1cab-422a-834d-3390cea38976|6931d1da-3502-480d-b0bd-de1bc4829d1d|569d8caf-e315-471b-a080-4b9f055de5fa/);
  assert.doesNotMatch(toml, /PRIVATE KEY/);
});

test('Pages 静态 _worker.js：pages.dev 地址 301 到 styrigx.com，styrigx.com 原样交给静态文件', async () => {
  const pagesWorker = (await import(REPO + '/web/static/_worker.js')).default;
  const seen = [];
  const env = { ASSETS: { fetch: async (req) => { seen.push(req.url); return new Response('static'); } } };
  for (const h of ['styrigx-space.pages.dev', 'abc123.styrigx-space.pages.dev', 'passkey-e2e.styrigx-space.pages.dev']) {
    const res = await pagesWorker.fetch(new Request('https://' + h + '/settings/?a=1'), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/settings/?a=1');
  }
  assert.equal(seen.length, 0);
  const ok = await pagesWorker.fetch(new Request('https://styrigx.com/css/main.css'), env);
  assert.equal(await ok.text(), 'static');
  assert.deepEqual(seen, ['https://styrigx.com/css/main.css']);
});

test('头像 /avatar/<尺寸>.webp 进了网关（只有预览会这样，线上归账号 Worker）：未登录放行、原样回源静态默认图', async () => {
  _resetSecretCache();
  await withOrigin('IMG', async (calls) => {
    const res = await worker.fetch(new Request('https://styrigx.com/avatar/96.webp'), baseEnv(), CTX);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
    assert.equal(await res.text(), 'IMG');
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).pathname, '/avatar/96.webp');
    const bad = await worker.fetch(new Request('https://styrigx.com/avatar/100.webp'), baseEnv(), CTX);
    assert.equal(bad.status, 302);
  });
});

test('预览（作为 Pages 的 _worker.js 运行，有 env.ASSETS）：页面和默认头像都读 ASSETS，不发子请求', async () => {
  _resetSecretCache();
  const seen = [];
  const env = {
    SGX_ENV: 'preview', /* web/wrangler.toml [env.preview.vars] 与 deploy.yml 预览变量同值 */
    SGX_SITE: 'space',
    KV_LOCK_DOOR: makeKv(),
    ASSETS: { fetch: async (req) => { seen.push(new URL(req.url || req).pathname); return new Response(PAGE, { headers: { 'Content-Type': 'text/html' } }); } },
  };
  await withOrigin('X', async (calls) => {
    const page = await worker.fetch(new Request('https://passkey-e2e.styrigx-space.pages.dev/settings/'), env, CTX);
    assert.equal(page.status, 200);
    const av = await worker.fetch(new Request('https://passkey-e2e.styrigx-space.pages.dev/avatar/32.webp'), env, CTX);
    assert.equal(av.status, 200); /* 预览没有账号 Worker：头像就是静态默认图 */
    assert.deepEqual(seen, ['/settings/', '/avatar/32.webp']);
    assert.equal(calls.length, 0);
  });
});

test('预览显式设 SGX_ENV=preview（网关缺 SGX_ENV 按生产处理，不设预览地址就只剩 301/403）', () => {
  const pagesToml = readFileSync(REPO + '/web/wrangler.toml', 'utf8');
  const vars = pagesToml.slice(pagesToml.indexOf('[env.preview.vars]'));
  assert.match(vars.slice(0, vars.indexOf('\n[', 1)), /^SGX_ENV = "preview"$/m);
  /* deploy.yml 写预览变量时 SGX_ENV 取自同一份 toml（不在工作流里另写一个值） */
  const wf = readFileSync(REPO + '/.github/workflows/deploy.yml', 'utf8');
  assert.match(wf, /"SGX_ENV": plain\(pv\["SGX_ENV"\]\)/);
  assert.match(wf, /pv = tomllib\.load\(open\("web\/wrangler\.toml", "rb"\)\)\["env"\]\["preview"\]\["vars"\]/);
});

test('路由：账号 → 安全与隐私子页（/account/security/ 与 /en/）过网关', async () => {
  const { readRoutes, routeMatches } = await import(REPO + '/scripts/check-worker-routes.mjs');
  const routes = readRoutes(readFileSync(path.join(REPO, 'workers/auth-gateway/wrangler.toml'), 'utf8'));
  for (const p of ['/account/', '/account/security/', '/en/account/security/']) {
    assert.ok(routes.some((r) => routeMatches(r, 'styrigx.com', p)), p + ' 应被路由覆盖');
  }
  for (const f of ['web/content/account-security.md', 'web/content/en/account-security.md']) {
    assert.ok(existsSync(path.join(REPO, f)), f + ' 应存在');
  }
});
