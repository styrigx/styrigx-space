/**
 * 安全响应头（PR D，workers #3 / #4 / web-templates P2 CSP）：
 * - security-headers.js：强制 CSP 里没有任何 script / style / default 指令；Report-Only 带上所有内联脚本哈希；HSTS 不带 includeSubDomains / preload
 * - 网关：锁屏首页、内页 302、www / 别的域名 301、pages.dev 301、管理员页、访客 302、?return= 302、升级态、/api/* 401 / 403、500 都带全套头
 *   子站经网关的响应只有 HSTS（不套主站 CSP）；原样回源的静态资源不改
 * - Pages：_worker.js 的 301 带和 security-headers.js 一致的头；_headers 解析后每个路径最多一条 Cache-Control、安全头恰好一份且和模块一致
 * - 模板：会执行的内联脚本只剩 baseof 的 5 段 + alias + search-redirect，且后两者正文是常量（每页一个哈希）；没有 on*="…" 属性
 *
 * 运行：node --test tests/workers/auth-gateway/security-headers.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const SH = await import(REPO + '/workers/auth-gateway/functions/_kernel/security-headers.js');
const { INLINE_SCRIPT_HASHES } = await import(REPO + '/workers/auth-gateway/functions/_kernel/csp-hashes.js');
const worker = (await import(REPO + '/workers/auth-gateway/src/index.js')).default;
const { _resetSecretCache } = await import(REPO + '/workers/auth-gateway/src/secrets.js');
const { parseHeaders, headersFor, matchPattern } = await import(REPO + '/scripts/lib/pages-headers.mjs');
const gen = await import(REPO + '/scripts/gen-csp.mjs');

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
    async get(k) { if (k === 'lock-epoch') return '0'; const v = m.get(k); return v === undefined ? null : v; },
    async getWithMetadata(k) { const v = m.get(k); return { value: v ?? null, metadata: null }; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
}
function baseEnv(over = {}) {
  const kv = makeKv();
  return { SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB, KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv, ...over };
}
const CTX = { waitUntil() {} };
const PAGE = '<!DOCTYPE html><html lang="zh"><head></head><body><!-- SGX-DESKTOP-START -->desk<!-- SGX-DESKTOP-END -->x</body></html>';

/** 生产路径：网关发子请求回源（fetch），这里替换掉 */
async function withOrigin(body, fn, init = { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (req) => { calls.push(req); return new Response(body, init); };
  try { return await fn(calls); } finally { globalThis.fetch = orig; }
}

const MAIN = SH.mainSiteHeaderList();
function assertMainHeaders(res, label) {
  for (const [k, v] of MAIN) assert.equal(res.headers.get(k), v, label + ' ' + k);
}
function assertNoMainOnlyHeaders(res, label) {
  for (const k of ['Content-Security-Policy', 'Content-Security-Policy-Report-Only', 'X-Frame-Options', 'Permissions-Policy']) {
    assert.equal(res.headers.get(k), null, label + ' 不该有 ' + k);
  }
}

/** 解析 CSP：指令名 → 值列表 */
function cspDirectives(csp) {
  const out = new Map();
  for (const part of csp.split(';')) {
    const t = part.trim();
    if (!t) continue;
    const [name, ...vals] = t.split(/\s+/);
    assert.equal(out.has(name.toLowerCase()), false, '重复指令 ' + name);
    out.set(name.toLowerCase(), vals);
  }
  return out;
}

/* ---------------- 模块本身 ---------------- */

test('强制 CSP 只含不会拦脚本的指令：没有 script-src / style-src / default-src 等，也没有 unsafe-*', () => {
  const d = cspDirectives(SH.CSP_ENFORCED);
  assert.deepEqual([...d.keys()].sort(), ['base-uri', 'form-action', 'frame-ancestors', 'object-src']);
  assert.deepEqual(d.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(d.get('object-src'), ["'none'"]);
  assert.deepEqual(d.get('base-uri'), ["'self'"]);
  assert.deepEqual(d.get('form-action'), ["'self'"]);
  for (const bad of ['script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'default-src', 'connect-src', 'img-src', 'require-trusted-types-for', 'trusted-types', 'sandbox']) {
    assert.equal(d.has(bad), false, bad);
  }
  assert.doesNotMatch(SH.CSP_ENFORCED, /script|unsafe|nonce|sha256/i);
  /* 强制的那一份所有出口都一样：_worker.js 的常量也要过同一条 */
  const pw = readFileSync(REPO + '/web/static/_worker.js', 'utf8');
  const m = pw.match(/'Content-Security-Policy': "([^"]+)"/);
  assert.ok(m, '_worker.js 里有强制 CSP');
  assert.equal(m[1], SH.CSP_ENFORCED);
});

test('Report-Only CSP：script-src 是 self + 每个内联脚本哈希，没有 unsafe-inline / unsafe-eval；外连只有天气和日刻', () => {
  assert.ok(INLINE_SCRIPT_HASHES.length >= 5, '至少有 baseof 的首屏脚本');
  for (const h of INLINE_SCRIPT_HASHES) assert.match(h, /^sha256-[A-Za-z0-9+/]{43}=$/);
  const d = cspDirectives(SH.CSP_REPORT_ONLY);
  const script = d.get('script-src');
  assert.equal(script[0], "'self'");
  assert.deepEqual(script.slice(1).sort(), INLINE_SCRIPT_HASHES.map((h) => "'" + h + "'").sort());
  assert.doesNotMatch(script.join(' '), /unsafe|\*|https?:/);
  assert.deepEqual(d.get('default-src'), ["'self'"]);
  assert.deepEqual(d.get('connect-src'), ["'self'", 'https://api.open-meteo.com', 'https://geocoding-api.open-meteo.com', 'https://daymark.styrigx.com']);
  assert.deepEqual(d.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(d.get('object-src'), ["'none'"]);
  /* 不报到任何地方：匿名流量不能触发写 KV（看违规用浏览器控制台） */
  assert.equal(d.has('report-uri'), false);
  assert.equal(d.has('report-to'), false);
});

test('HSTS 一年、不带 includeSubDomains / preload；Permissions-Policy 不碰通行密钥和定位', () => {
  assert.equal(SH.HSTS, 'max-age=31536000');
  assert.doesNotMatch(SH.HSTS, /includeSubDomains|preload/i);
  assert.doesNotMatch(SH.PERMISSIONS_POLICY, /publickey-credentials|geolocation|clipboard|web-share/);
  for (const f of SH.PERMISSIONS_POLICY.split(',')) assert.match(f.trim(), /^[a-z-]+=\(\)$/);
});

test('applyMainSiteHeaders：只读头的响应（Response.redirect）也能加；已有的 Referrer-Policy 不覆盖，其余覆盖', () => {
  const r = SH.applyMainSiteHeaders(Response.redirect('https://styrigx.com/', 301));
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), 'https://styrigx.com/');
  assertMainHeaders(r, 'redirect');
  const nr = SH.applyMainSiteHeaders(new Response(null, { status: 302, headers: { 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' } }));
  assert.equal(nr.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(nr.headers.get('X-Frame-Options'), 'DENY');
  const sub = SH.applySubsiteHeaders(new Response('x'));
  assert.equal(sub.headers.get('Strict-Transport-Security'), SH.HSTS);
  assertNoMainOnlyHeaders(sub, 'subsite');
});

/* ---------------- 网关：主站 ---------------- */

test('网关·锁屏首页（未登录 /、/en/）：200 锁屏态 + 全套安全头 + private, no-store', async () => {
  _resetSecretCache();
  await withOrigin(PAGE, async () => {
    for (const p of ['/', '/en/', '/?lock=1&return=%2Fsettings%2F']) {
      const res = await worker.fetch(new Request('https://styrigx.com' + p), baseEnv(), CTX);
      assert.equal(res.status, 200, p);
      assert.match(await res.text(), /data-sgx-lock-session="locked"/);
      assertMainHeaders(res, p);
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
      assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
    }
  });
});

test('网关·未登录内页 → 302 锁屏，带全套安全头', async () => {
  _resetSecretCache();
  await withOrigin(PAGE, async (calls) => {
    const res = await worker.fetch(new Request('https://styrigx.com/chat/'), baseEnv(), CTX);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/?lock=1&return=%2Fchat%2F');
    assertMainHeaders(res, '302 lock');
    assert.equal(calls.length, 0);
  });
});

test('网关·域名跳转：www 301、别的域名 301 / 403、styrigx-space.pages.dev 301，都带安全头', async () => {
  _resetSecretCache();
  const cases = [
    ['https://www.styrigx.com/settings/', 301],
    ['https://evil.example/settings/', 301],
    ['https://evil.example/api/lock-entry', 403],
    ['https://styrigx-space.pages.dev/settings/', 301],
  ];
  for (const [u, st] of cases) {
    const res = await worker.fetch(new Request(u), baseEnv(), CTX);
    assert.equal(res.status, st, u);
    assertMainHeaders(res, u);
  }
});

test('网关·管理员页、访客打开门内页 302、账号区 302、?return= 302、访客升级态 200，都带安全头', async () => {
  _resetSecretCache();
  const admin = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin', 'password'));
  const visitor = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'visitor'));
  await withOrigin(PAGE, async () => {
    const cases = [
      ['/settings/security/lock/', admin, 200],
      ['/chat/', admin, 200],
      ['/settings/security/lock/', visitor, 302],
      ['/account/', visitor, 302],
      ['/?return=%2Fchat%2F', admin, 302],
      ['/?return=%2Fsettings%2Fsecurity%2Flock%2F', visitor, 200],
    ];
    for (const [p, cookie, st] of cases) {
      const res = await worker.fetch(new Request('https://styrigx.com' + p, { headers: { Cookie: cookie } }), baseEnv(), CTX);
      assert.equal(res.status, st, p);
      assertMainHeaders(res, p);
    }
  });
});

test('网关·Pages 自己的跳转（补尾斜杠 308）经网关交回时也带安全头', async () => {
  _resetSecretCache();
  const admin = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin', 'password'));
  await withOrigin('', async () => {
    const res = await worker.fetch(new Request('https://styrigx.com/settings', { headers: { Cookie: admin } }), baseEnv(), CTX);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('Location'), '/settings/');
    assertMainHeaders(res, '308');
  }, { status: 308, headers: { Location: '/settings/' } });
});

test('网关·/api/*：401、404、访客调管理员接口 403 都带安全头，Cache-Control 不变', async () => {
  _resetSecretCache();
  const visitor = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'visitor'));
  const r1 = await worker.fetch(new Request('https://styrigx.com/api/lock-session-check'), baseEnv(), CTX);
  assert.equal(r1.status, 401);
  assertMainHeaders(r1, '401');
  const r2 = await worker.fetch(new Request('https://styrigx.com/api/account', { headers: { Cookie: visitor } }), baseEnv(), CTX);
  assert.equal(r2.status, 403);
  assert.equal(r2.headers.get('Cache-Control'), 'no-store');
  assertMainHeaders(r2, '403');
  const admin = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin', 'password'));
  const r3 = await worker.fetch(new Request('https://styrigx.com/api/nope', { headers: { Cookie: admin } }), baseEnv(), CTX);
  assert.equal(r3.status, 404);
  assertMainHeaders(r3, '404');
});

test('网关·SGX_SITE 配错（500）和未处理异常（500）也带安全头', async () => {
  _resetSecretCache();
  const r1 = await worker.fetch(new Request('https://styrigx.com/'), baseEnv({ SGX_SITE: 'blog' }), CTX);
  assert.equal(r1.status, 500);
  assertMainHeaders(r1, 'misconfig');
  _resetSecretCache();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('boom'); };
  try {
    const r2 = await worker.fetch(new Request('https://styrigx.com/'), baseEnv(), CTX);
    assert.equal(r2.status, 500);
    assertMainHeaders(r2, 'unhandled');
  } finally {
    globalThis.fetch = orig;
  }
});

test('网关·原样回源的静态资源（/css/、/robots.txt）不改头：由 Pages 的 _headers 负责', async () => {
  _resetSecretCache();
  await withOrigin('body{}', async () => {
    const res = await worker.fetch(new Request('https://styrigx.com/css/main.abc.css'), baseEnv(), CTX);
    assert.equal(res.headers.get('X-SGX-Runtime'), null);
    assert.equal(res.headers.get('Content-Security-Policy'), null);
  }, { status: 200, headers: { 'Content-Type': 'text/css' } });
});

test('网关·预览（Pages 的 _worker.js，env.ASSETS）：锁屏首页同样带安全头', async () => {
  _resetSecretCache();
  const env = baseEnv({
    SGX_ENV: 'preview',
    ASSETS: { fetch: async () => new Response(PAGE, { headers: { 'Content-Type': 'text/html' } }) },
  });
  const res = await worker.fetch(new Request('https://passkey-e2e.styrigx-space.pages.dev/'), env, CTX);
  assert.equal(res.status, 200);
  assertMainHeaders(res, 'preview');
});

/* ---------------- 网关：子站 ---------------- */

test('网关·子站：302 到锁屏、401、会话有效的页面都只加 HSTS，不套主站 CSP / X-Frame-Options', async () => {
  _resetSecretCache();
  const admin = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin', 'password'));
  await withOrigin('<html><head></head><body>blog</body></html>', async () => {
    for (const host of ['blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com']) {
      const lock = await worker.fetch(new Request('https://' + host + '/posts/x/'), baseEnv(), CTX);
      assert.equal(lock.status, 302, host);
      assert.equal(lock.headers.get('Strict-Transport-Security'), SH.HSTS);
      assertNoMainOnlyHeaders(lock, host + ' 302');
      const api = await worker.fetch(new Request('https://' + host + '/api/whatever'), baseEnv(), CTX);
      assert.equal(api.status, 401);
      assert.equal(api.headers.get('Strict-Transport-Security'), SH.HSTS);
      assertNoMainOnlyHeaders(api, host + ' 401');
      const page = await worker.fetch(new Request('https://' + host + '/posts/x/', { headers: { Cookie: admin } }), baseEnv(), CTX);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('Strict-Transport-Security'), SH.HSTS);
      assertNoMainOnlyHeaders(page, host + ' page');
      assert.equal(page.headers.get('Cache-Control'), 'private, no-store');
    }
  });
  /* 子站静态资源原样回源，不加任何头 */
  await withOrigin('x', async () => {
    const st = await worker.fetch(new Request('https://blog.styrigx.com/js/app.js'), baseEnv(), CTX);
    assert.equal(st.headers.get('Strict-Transport-Security'), null);
  }, { status: 200, headers: { 'Content-Type': 'text/javascript' } });
});

/* ---------------- Pages ---------------- */

test('Pages _worker.js：pages.dev 的 301 带安全头，值和 security-headers.js 一致', async () => {
  const pagesWorker = (await import(REPO + '/web/static/_worker.js')).default;
  const res = await pagesWorker.fetch(new Request('https://abc.styrigx-space.pages.dev/chat/'), { ASSETS: { fetch: async () => new Response('x') } });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://styrigx.com/chat/');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const want = Object.fromEntries(MAIN);
  for (const k of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Content-Security-Policy']) {
    assert.equal(res.headers.get(k), want[k], k);
  }
});

const HEADERS_TEXT = readFileSync(REPO + '/web/static/_headers', 'utf8');
const RULES = parseHeaders(HEADERS_TEXT);

test('_headers 匹配器：splat / 精确 / 占位符', () => {
  assert.equal(matchPattern('/*', '/'), true);
  assert.equal(matchPattern('/css/*', '/css/main.x.css'), true);
  assert.equal(matchPattern('/css/*', '/cssx'), false);
  assert.equal(matchPattern('/fav/*', '/favicon.ico'), false);
  assert.equal(matchPattern('/og.png', '/og.png'), true);
  assert.equal(matchPattern('/og.png', '/ogXpng'), false);
  assert.equal(matchPattern('/a/:x/b', '/a/1/b'), true);
  assert.equal(matchPattern('/a/:x/b', '/a/1/2/b'), false);
  /* 合并语义：同名头两条规则都命中 → 逗号拼接（这就是 workers #4 的 bug 形状） */
  const dup = headersFor(parseHeaders('/*\n  Cache-Control: a\n/x/*\n  Cache-Control: b\n'), '/x/1');
  assert.equal(dup.headers.get('cache-control'), 'a, b');
  assert.equal(dup.counts.get('cache-control'), 2);
});

test('_headers：每个路径最多一条 Cache-Control（不再逗号拼接）、安全头恰好一份且等于 security-headers.js', () => {
  const expectCC = {
    '/css/main.4699.css': 'public, max-age=31536000, immutable',
    '/js/sgx/chunk-X.js': 'public, max-age=31536000, immutable',
    '/fav/x.png': 'public, max-age=31536000, immutable',
    '/images/a.webp': 'public, max-age=86400',
    '/fonts/inter-latin.woff2': 'public, max-age=300',
    '/avatar/96.webp': 'public, max-age=300',
    '/favicon.ico': 'public, max-age=300',
    '/favicon.svg': 'public, max-age=300',
    '/og.png': 'public, max-age=300',
    '/robots.txt': 'public, max-age=300',
    '/opensearch.xml': 'public, max-age=300',
    '/sitemap.xml': 'public, max-age=300',
    /* 页面和要先解锁的数据：不写 Cache-Control（Pages 默认 max-age=0, must-revalidate；页面网关再改成 private, no-store） */
    '/': undefined,
    '/settings/': undefined,
    '/files-index.json': undefined,
    '/index.xml': undefined,
    '/en/index.xml': undefined,
  };
  for (const [p, cc] of Object.entries(expectCC)) {
    const { headers, counts } = headersFor(RULES, p);
    assert.equal(headers.get('cache-control'), cc, p);
    assert.ok((counts.get('cache-control') || 0) <= 1, p + ' Cache-Control 只能一条');
    for (const [k, v] of MAIN) {
      assert.equal(counts.get(k.toLowerCase()), 1, p + ' ' + k + ' 恰好一份');
      assert.equal(headers.get(k.toLowerCase()), v, p + ' ' + k);
    }
  }
  /* 每一个头在所有路径上都不会被拼接 */
  for (const p of Object.keys(expectCC)) {
    for (const [k, n] of headersFor(RULES, p).counts) assert.equal(n, 1, p + ' ' + k);
  }
  assert.doesNotMatch(HEADERS_TEXT, /^ {2}! /m, '不靠 detach');
  for (const l of HEADERS_TEXT.split('\n')) assert.ok(l.length <= 2000);
});

test('_headers 生成段和 gen-csp.mjs 的渲染一致（不需要构建就能核对的那一半）', () => {
  const want = gen.spliceBlock(HEADERS_TEXT, gen.renderHeadersBlock(MAIN));
  assert.equal(want, HEADERS_TEXT);
});

/* ---------------- gen-csp.mjs 的解析 ---------------- */

test('gen-csp：只算会执行的内联脚本（JSON / 有 src 的不算）；哈希按原始字节', () => {
  const html = '<script>a()</script><script type="module">b()</script><script type="application/json">{"x":1}</script>' +
    '<script src="/x.js"></script><script nomodule>c()</script><script type="text/javascript">d()</script>' +
    '<script id="i" type="application/ld+json">{}</script>';
  assert.deepEqual(gen.inlineScripts(html), ['a()', 'b()', 'c()', 'd()']);
  /* 浏览器对 <script>alert(1)</script> 算的就是这个值（CSP 规范示例的同一算法） */
  assert.equal(gen.sha256('alert(1)'), 'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI=');
  assert.deepEqual(gen.unhashable('<a href="javascript:void 0">x</a><button onclick="x()">y</button><script>var s="<b onclick=1>"</script>'), ['onclick=', 'href="javascript:']);
  assert.deepEqual(gen.unhashable('<div data-on="1" aria-label="turn on">x</div>'), []);
});

/* ---------------- 模板 ---------------- */

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.html')) out.push(p);
  }
  return out;
}

test('模板：会执行的内联脚本只在 baseof（5 段）、alias、search-redirect；settings / setcat-advanced 已搬进模块；没有 on*= 属性', () => {
  const where = {};
  for (const f of walk(REPO + '/web/layouts')) {
    const src = readFileSync(f, 'utf8').replace(/\{\{\/\*[\s\S]*?\*\/\}\}/g, '');
    const n = gen.inlineScripts(src).length;
    if (n) where[path.relative(REPO + '/web/layouts', f)] = n;
    assert.deepEqual(gen.unhashable(src.replace(/\{\{[\s\S]*?\}\}/g, '')), [], f);
  }
  assert.deepEqual(where, { '_default/baseof.html': 5, '_default/search-redirect.html': 1, 'alias.html': 1 });
  /* alias / search-redirect：脚本正文里不插模板值（每页一字不差 → 一个哈希），目标地址在 <html data-sgx-*> */
  for (const f of ['alias.html', '_default/search-redirect.html']) {
    const [body] = gen.inlineScripts(readFileSync(REPO + '/web/layouts/' + f, 'utf8'));
    assert.doesNotMatch(body, /\{\{/, f);
  }
  const settingsJs = readFileSync(REPO + '/web/assets/js/apps/settings.js', 'utf8');
  assert.match(settingsJs, /export function legacyHashRedirect\(\)/);
  assert.match(settingsJs, /'sg-goodlock': 'advanced'/);
  assert.match(settingsJs, /querySelectorAll\('\.gl-row'\)/);
});
