/**
 * 鉴权 Worker（workers/space-core）：
 * - 路由表与 src/api/ 文件一一对应（新增接口忘了登记 → CI 红）
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
import { v6Space } from '../_v6admit.mjs';
import { authD1For } from '../_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const worker = (await import(REPO + '/workers/space-core/src/app.js')).default;
const { routeKey, pickHandler } = await import(REPO + '/workers/space-core/src/router.js');
const { API_ROUTES } = await import(REPO + '/workers/space-core/src/router.js');
const pagesMw = await import(REPO + '/workers/space-core/src/gate.js');
const htmlKernel = await import(REPO + '/workers/space-core/src/gate.js');

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
function baseEnv() {
  const kv = makeKv();
  return { SGX_ENV: 'production', SGX_SITE: 'space', D1_SPACE: authD1For(kv), ACCOUNT_VERIFIER: v6Space({}) };
}
const CTX = { waitUntil() {} };

test('路由表与 src/api/*.js 一一对应（v6 P4：/api/share 与进站 / 锁屏接口随分享短链、进站签发删除）', () => {
  const files = readdirSync(REPO + '/workers/space-core/src/api').filter(f => f.endsWith('.js')).map(f => '/api/' + f.slice(0, -3)).sort();
  assert.deepEqual([...API_ROUTES.keys()].sort(), files);
  for (const gone of ['/api/share', '/api/space-auth', '/api/lock-now', '/api/lock-session-check', '/api/lock-password', '/api/lock-passkey', '/api/lock-reset', '/api/lock-reauth', '/api/lock-entry', '/api/lock-credentials', '/api/lock-all-devices']) {
    assert.ok(!files.includes(gone), gone);
  }
});

test('wrangler.toml：不开 workers.dev、生产模式；v6 P4 起不绑任何 Secrets Store 值（SGX_SPACE_* 四个随进站签发删除）；账号钥匙不绑', () => {
  const toml = readFileSync(REPO + '/workers/space-core/wrangler.toml', 'utf8');
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^SGX_ENV = "production"$/m);
  const live = toml.replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(live, /secrets_store_secrets|SGX_SPACE_/);
  assert.equal(existsSync(REPO + '/workers/space-core/src/secrets.js'), false, '没有私密值要解析');
  assert.doesNotMatch(live, /SGX_LOCK_|SGX_PW_PEPPER|D1_LOCK_AUTH|SGX_SPACE_TEMPKEY_PEPPER/, '旧名不再绑定');
  /* 账号拆分 PR3：账号钥匙、账号根密钥只绑在账号 Worker；进站凭证后台改名为 SGX_SPACE_RECOVERY_KEY（旧名 SGX_ROOT_KEY 不再绑定） */
  const code = toml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /SGX_ACCOUNT_|SGX_ROOT_KEY|D1_ACCOUNT_AUTH|D1_ROOT_AUTH/);
  for (const ep of ['AccountService', 'AccountVerifier']) assert.match(code, new RegExp(`service = "styrigx-account"\\nentrypoint = "${ep}"`), ep);
  assert.doesNotMatch(code, /TURNSTILE_SECRET/, 'Turnstile 已删，不再绑定');
  /* 2026-10-21：整站通配（不带 * 的规则遇到查询串不命中，锁屏入口 /?lock=1 曾因此绕过网关）。
     只接 styrigx.com 一条通配，不许有精确规则；旧 blog / daymark / curio 子域名不再登记。子站在 styrigx.com/<站>/，由 styrigx.com/* 接住。
     旧图志域名的 301（合并 PR3 起）已于 P4-3 PR-1 删除，路由不再登记。
     完整核对见 space/scripts/check/check-worker-routes.mjs。 */
  const routes = [...toml.matchAll(/^pattern = "([^"]+)"$/gm)].map(m => m[1]);
  assert.deepEqual(routes, ['styrigx.com/*']);
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
const PAGE = '<!DOCTYPE html><html lang="zh"><body><div id="desk">desk</div>x</body></html>';

test('页面（v5 S3）：未登录访问内页 → 回源 200、标 locked，不 302', async () => {
  await withOrigin(PAGE, async (calls) => {
    const res = await worker.fetch(new Request('https://styrigx.com/display/'), baseEnv(), CTX);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Location'), null);
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
    assert.match(await res.text(), /<html data-sgx-lock-session="locked" lang="zh"><body><div id="desk">desk<\/div>/);
    assert.equal(calls.length, 1);
  });
});

test('页面：未登录首页 → 回源、锁屏态、内容原样（v5 S3 不再瘦身），会话标记只出现一次', async () => {
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
    assert.match(html, /desk/);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
  });
});

test('页面：有 v6 会话的人（root / 站长 / 普通用户都一样）访问页面 → 回源、valid，带 cookie 回源，页面上没有等级标记', async () => {
  for (const by of ['root', 'styrigx', 'alice']) {
    const cookie = 'sgx-session=' + by;
    await withOrigin(PAGE, async (calls) => {
      const res = await worker.fetch(new Request('https://styrigx.com/security/lock/', { headers: { Cookie: cookie } }), baseEnv(), CTX);
      assert.equal(res.status, 200, by);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].headers.get('Cookie'), cookie);
      const html = await res.text();
      assert.doesNotMatch(html, /data-sgx-role|data-sgx-upgrade/); // old-name guard
      assert.match(html, /data-sgx-lock-session="valid"/);
      assert.match(html, /desk/);
    });
  }
});

test('页面：Pages 的跳转（补尾斜杠）原样交回', async () => {
  const cookie = 'sgx-session=styrigx';
  await withOrigin('', async () => {
    const res = await worker.fetch(new Request('https://styrigx.com/display', { headers: { Cookie: cookie } }), baseEnv(), CTX);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('Location'), '/display/');
  }, { status: 308, headers: { Location: '/display/' } });
});

test('stripSessionAttrs：只清 <html> 上的会话标记（body 等别的标签不动）', () => {
  const html = '<html data-sgx-lock-session="valid" lang="en" data-sgx-role="admin"><body data-sgx-x="1"></body></html>'; // old-name guard（伪造的旧标记要被剥掉）
  assert.equal(htmlKernel.stripSessionAttrs(html), '<html lang="en"><body data-sgx-x="1"></body></html>');
});

test('stripSessionAttrs：只清网关会写的会话标记，保留构建标记 data-sgx-build（2026-10-21）', () => {
  const html = '<html data-sgx-build="abc1234" data-sgx-lock-session="valid" lang="zh" data-sgx-role="admin" data-sgx-account-session="in" data-sgx-upgrade="1" data-sgx-upgrade-return="/x/"><head></head></html>'; // old-name guard（伪造的旧标记要被剥掉）
  assert.equal(htmlKernel.stripSessionAttrs(html), '<html data-sgx-build="abc1234" lang="zh"><head></head></html>');
});

test('页面：锁屏首页保留 <head> 里的分享卡片 meta 和 <html> 上的构建标记', async () => {
  const head = '<head><meta property="og:image" content="https://styrigx.com/og.png"><meta name="twitter:card" content="summary_large_image"><link rel="icon" type="image/svg+xml" href="/favicon.svg"></head>';
  const page = '<!DOCTYPE html><html lang="zh" data-sgx-build="abc1234" data-sgx-lock-session="locked">' + head + '<body>desk x</body></html>';
  await withOrigin(page, async () => {
    const res = await worker.fetch(new Request('https://styrigx.com/'), baseEnv(), CTX);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<html data-sgx-lock-session="locked" lang="zh" data-sgx-build="abc1234">/);
    assert.equal((html.match(/data-sgx-lock-session=/g) || []).length, 1);
    assert.ok(html.includes(head), '<head> 原样保留');
    assert.match(html, /desk x/);
  });
});

test('锁着也公开：标签页图标 / 分享卡片图（Pages 中间件放行，不跳锁屏）', async () => {
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
  /* 对照：要进站的接口没会话 401 */
  const res = await pagesMw.onRequest({
    request: new Request('https://styrigx.com/api/status'), env: baseEnv(), params: {}, data: {}, waitUntil() {},
    next: async () => new Response('api'),
  });
  assert.equal(res.status, 401);
});

test('所有响应带 X-SGX-Runtime: worker，且不改动原有头和正文', async () => {
  const res = await worker.fetch(new Request('https://styrigx.com/api/status'), baseEnv(), CTX);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
  assert.deepEqual(await res.json(), { ok: false });
});

test('非 styrigx.com 的 /api 请求 → 403（与 Pages 生产规则一致）', async () => {
  const res = await worker.fetch(new Request('https://styrigx-space-core.example.workers.dev/api/status'), baseEnv(), CTX);
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
  const headers = {};
  if (role) headers.Cookie = 'sgx-session=' + role;
  const a = await worker.fetch(makeReq(headers), baseEnv(), CTX);
  const b = await viaPages(makeReq(headers), baseEnv());
  assert.equal(a.status, b.status);
  assert.equal(a.headers.get('Cache-Control'), b.headers.get('Cache-Control'));
  assert.equal(await a.text(), await b.text());
  return a;
}

test('一致性：GET /api/space-audit 无会话 401 / 档不够 403 / 站长与 root 两边一样', async () => {
  const mk = (h) => new Request('https://styrigx.com/api/space-audit', { headers: h });
  assert.equal((await same(mk)).status, 401);
  assert.equal((await same(mk, 'alice')).status, 403);
  await same(mk, 'styrigx');
  await same(mk, 'root');
});

test('一致性：无会话调非白名单接口', async () => {
  await same((h) => new Request('https://styrigx.com/api/lock-all-devices', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' }), 'alice');
  await same((h) => new Request('https://styrigx.com/api/geo-nope', { headers: h }));
});

test('账号路径（/api/account、头像、云同步）不在网关路由表（数字健康 v6 P4 删除）；有会话打过来但没绑 ACCOUNT → 503 upstream（不落回 404 / 回源）', async () => {
  for (const p of ['/api/account', '/api/avatar', '/api/prefs', '/api/wellbeing']) assert.equal(API_ROUTES.has(p), false, p);
  const env = baseEnv();
  const ck = 'sgx-session=root';
  await withOrigin('X', async (calls) => {
    for (const [m, p] of [['POST', '/api/account/devices'], ['PUT', '/api/avatar'], ['GET', '/api/prefs']]) {
      const res = await worker.fetch(new Request('https://styrigx.com' + p, { method: m, headers: { Cookie: ck } }), env, CTX);
      assert.equal(res.status, 503, p);
      assert.deepEqual(await res.json(), { ok: false, error: 'upstream' }, p);
    }
    assert.equal(calls.length, 0, '不回源');
  });
});

/* ---- Pages 只放静态文件：后端代码全在网关 ---- */

test('仓库：根目录没有 functions/、migrations/、wrangler.toml（Pages 部署不会再带后端代码）', () => {
  for (const p of ['functions', 'migrations', 'wrangler.toml']) {
    assert.equal(existsSync(REPO + '/' + p), false, p + ' 应该在 workers/space-core/ 或 space/web/ 下');
  }
  assert.ok(existsSync(REPO + '/workers/space-core/src/gate.js'));
  assert.ok(existsSync(REPO + '/workers/space-core/migrations'));
});

test('space/web/wrangler.toml：Pages 生产没有变量和绑定，预览不连正式库', () => {
  const toml = readFileSync(REPO + '/space/web/wrangler.toml', 'utf8');
  const top = toml.split(/^\[/m)[0];
  assert.match(top, /^pages_build_output_dir = "public"$/m);
  assert.doesNotMatch(toml, /^\[vars\]$/m);
  assert.doesNotMatch(toml, /^\[\[(kv_namespaces|d1_databases)\]\]$/m);
  assert.doesNotMatch(toml, /b796097c90104000992b7713f61e16ea|2804d280-1cab-422a-834d-3390cea38976|6931d1da-3502-480d-b0bd-de1bc4829d1d|569d8caf-e315-471b-a080-4b9f055de5fa/);
  assert.doesNotMatch(toml, /PRIVATE KEY/);
});

test('Pages 静态 _worker.js：pages.dev 地址 301 到 styrigx.com，styrigx.com 原样交给静态文件', async () => {
  const pagesWorker = (await import(REPO + '/space/web/static/_worker.js')).default;
  const seen = [];
  const env = { ASSETS: { fetch: async (req) => { seen.push(req.url); return new Response('static'); } } };
  for (const h of ['styrigx-space.pages.dev', 'abc123.styrigx-space.pages.dev', 'passkey-e2e.styrigx-space.pages.dev']) {
    const res = await pagesWorker.fetch(new Request('https://' + h + '/display/?a=1'), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/display/?a=1');
  }
  assert.equal(seen.length, 0);
  const ok = await pagesWorker.fetch(new Request('https://styrigx.com/css/main.css'), env);
  assert.equal(await ok.text(), 'static');
  assert.deepEqual(seen, ['https://styrigx.com/css/main.css']);
});

test('头像 /avatar/*：页面路径公开，转给账号 Worker（ACCOUNT，不带身份头；尺寸对不对由账号 Worker 判）', async () => {
  const seen = [];
  const env = Object.assign(baseEnv(), {
    ACCOUNT: { fetch: async (req) => { seen.push(req); return new Response('IMG', { headers: { 'Content-Type': 'image/webp', 'X-SGX-Runtime': 'account' } }); } },
  });
  await withOrigin('X', async (calls) => {
    const res = await worker.fetch(new Request('https://styrigx.com/avatar/96.webp?v=3'), env, CTX);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-SGX-Runtime'), 'account', '账号写的运行时标记保留');
    assert.equal(await res.text(), 'IMG');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://styrigx.com/avatar/96.webp?v=3');
    assert.equal(seen[0].headers.get('X-Styrigx-Space-Level'), null, '没有进站会话不写身份头');
    await worker.fetch(new Request('https://styrigx.com/avatar/100.webp'), env, CTX);
    assert.equal(seen.length, 2, '同样转给账号 Worker');
    assert.equal(calls.length, 0, '不回源');
  });
});

test('预览（作为 Pages 的 _worker.js 运行，有 env.ASSETS）：页面读 ASSETS 不发子请求；账号路径照样只转 ACCOUNT（组合预览入口 tests/space/e2e/helpers/preview-worker.js 接上）', async () => {
  const seen = [];
  const acct = [];
  const env = {
    SGX_ENV: 'preview', /* space/web/wrangler.toml [env.preview.vars] 与 deploy.yml 预览变量同值 */
    SGX_SITE: 'space',
    ASSETS: { fetch: async (req) => { seen.push(new URL(req.url || req).pathname); return new Response(PAGE, { headers: { 'Content-Type': 'text/html' } }); } },
    ACCOUNT: { fetch: async (req) => { acct.push(new URL(req.url).pathname); return new Response('IMG', { headers: { 'X-SGX-Runtime': 'account' } }); } },
  };
  await withOrigin('X', async (calls) => {
    const page = await worker.fetch(new Request('https://passkey-e2e.styrigx-space.pages.dev/display/'), env, CTX);
    assert.equal(page.status, 200);
    const av = await worker.fetch(new Request('https://passkey-e2e.styrigx-space.pages.dev/avatar/32.webp'), env, CTX);
    assert.equal(av.status, 200);
    assert.equal(av.headers.get('X-SGX-Runtime'), 'account');
    assert.deepEqual(seen, ['/display/']);
    assert.deepEqual(acct, ['/avatar/32.webp']);
    assert.equal(calls.length, 0);
  });
});

test('预览显式设 SGX_ENV=preview（网关缺 SGX_ENV 按生产处理，不设预览地址就只剩 301/403）', () => {
  const pagesToml = readFileSync(REPO + '/space/web/wrangler.toml', 'utf8');
  const vars = pagesToml.slice(pagesToml.indexOf('[env.preview.vars]'));
  assert.match(vars.slice(0, vars.indexOf('\n[', 1)), /^SGX_ENV = "preview"$/m);
  /* deploy.yml 写预览变量时 SGX_ENV 取自同一份 toml（不在工作流里另写一个值） */
  const wf = readFileSync(REPO + '/.github/workflows/deploy.yml', 'utf8');
  assert.match(wf, /"SGX_ENV": plain\(pv\["SGX_ENV"\]\)/);
  assert.match(wf, /pv = tomllib\.load\(open\("space\/web\/wrangler\.toml", "rb"\)\)\["env"\]\["preview"\]\["vars"\]/);
});

test('路由：旧账号地址（/account/、/account/security/ 与 /zh/）过网关（2026-11-08 起只剩 301 到首页 #acct=<层>，跳转也要先进门）', async () => {
  const { readRoutes, routeMatches } = await import(REPO + '/space/scripts/check/check-worker-routes.mjs');
  const routes = readRoutes(readFileSync(path.join(REPO, 'workers/space-core/wrangler.toml'), 'utf8'));
  for (const p of ['/account/', '/account/security/', '/zh/account/security/']) {
    assert.ok(routes.some((r) => routeMatches(r, 'styrigx.com', p)), p + ' 应被路由覆盖');
  }
  for (const f of ['space/web/content/account-security.md', 'space/web/content/zh/account-security.md']) {
    assert.ok(!existsSync(path.join(REPO, f)), f + ' 应已删除（账号整页 2026-11-08 删了）');
  }
  const red = readFileSync(path.join(REPO, 'space/web/static/_redirects'), 'utf8');
  assert.match(red, /^\/account\/security\/\s+\/#acct=security\s+301$/m);
  assert.match(red, /^\/zh\/account\/security\/\s+\/zh\/#acct=security\s+301$/m);
});
