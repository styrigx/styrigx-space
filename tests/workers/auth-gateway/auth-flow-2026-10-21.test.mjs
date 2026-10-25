/**
 * 2026-10-21 三站锁屏 / 回跳 / 管理员验证 / 账号首帧 根因回归（与 tests/web/e2e/edge-flow.spec.js 对应）。
 *
 * 根因（每条都有一个测试，改前会红）：
 * A. 路由：Cloudflare 不带 * 的规则遇到查询串不命中 → styrigx.com/?lock=1&return=…（锁屏入口）、
 *    blog / daymark 首页带查询串都绕过网关直达 Pages。
 * B. /api/lock-session-check 只回 ok/role，前端解锁后只能「重载同一地址等首页 302」，锁屏入口不过网关时永远等不到。
 * C. 访客打开锁屏凭证页 → 302 到 /?lock=1（锁屏），应是管理员验证（不带 lock=1）。
 * D. 锁屏瘦身标记被 Go 模板删掉，锁屏态整份下发桌面。
 * E. 账号页没有服务端账号状态，首帧总是先画「欢迎回来」登录区。
 * F. 内容索引 /files-index.json 被后缀白名单放行。
 * G. 站内链接 prerender（Speculation Rules）启用的是旧会话状态的页面快照。
 *
 * 运行：node --test tests/workers/auth-gateway/auth-flow-2026-10-21.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockSession, testAccountSession } from './_tickets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const worker = (await import(REPO + '/workers/auth-gateway/src/index.js')).default;
const { readRoutes, pickRoute, routeMatches } = await import(REPO + '/scripts/lib/cf-routes.mjs');
const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
const { signAccountSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/account-session.js');

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
const PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');
const CTX = { waitUntil() {} };

const DESKTOP_HTML = '<!doctype html><html lang="zh"><body><!-- SGX-DESKTOP-START --><div id="desk">DESK</div><!-- SGX-DESKTOP-END --></body></html>';
const ACCOUNT_HTML = '<!doctype html><html lang="zh"><body>' +
  '<!-- SGX-ACCT-LOGIN-START -->\n  <div id="acct-login" class="acct-login" hidden><p>欢迎回来</p></div>\n<!-- SGX-ACCT-LOGIN-END -->' +
  '<div id="acct-main" hidden>MAIN</div></body></html>';

function env() {
  const seen = [];
  return {
    seen,
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB, SGX_ACCOUNT_PUBLIC: PUB,
    KV_LOCK_DOOR: { async get() { return null; }, async put() {} },
    KV_ACCOUNT_LOGIN: { async get() { return null; }, async put() {} },
    ASSETS: {
      async fetch(req) {
        const u = new URL(req.url);
        seen.push(u.hostname + u.pathname);
        if (u.pathname.endsWith('.css')) return new Response('css', { headers: { 'Content-Type': 'text/css' } });
        if (u.pathname.endsWith('.json')) return new Response('{"items":[]}', { headers: { 'Content-Type': 'application/json' } });
        const html = u.pathname.includes('/account/') ? ACCOUNT_HTML : DESKTOP_HTML;
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
      },
    },
  };
}
const lockCookie = async (role) => 'sgx-lock-session=' + (await testLockSession(PRIV, 0, role));
const accountCookie = async () => 'sgx-account-session=' + (await testAccountSession(PRIV, 'passkey', 0, Date.now()));
const get = (url, cookie) => worker.fetch(new Request(url, { headers: cookie ? { Cookie: cookie } : {} }), env(), CTX);

/* ---------------- A. 路由 ---------------- */
const ROUTES = readRoutes(fs.readFileSync(path.join(REPO, 'workers/auth-gateway/wrangler.toml'), 'utf8'));
const OTHER = ['daymark.styrigx.com/api/*', 'curio.styrigx.com/api/*']; /* styrigx-daymark-core、styrigx-curio-core（各自的仓库） */

test('A 路由匹配规则照线上实测：不带 * 的规则遇到查询串不命中；* 规则连查询串前缀匹配', () => {
  assert.equal(routeMatches('styrigx.com/', 'styrigx.com', '/'), true);
  assert.equal(routeMatches('styrigx.com/', 'styrigx.com', '/?lock=1'), false);
  assert.equal(routeMatches('styrigx.com/en/*', 'styrigx.com', '/en/?lock=1'), true);
  assert.equal(routeMatches('blog.styrigx.com/about*', 'blog.styrigx.com', '/about?a'), true);
});

test('A 锁屏入口、带查询串的首页、所有页面都过网关（改前 styrigx.com/?lock=1 直达 Pages）', () => {
  const mustGateway = [
    ['styrigx.com', '/'], ['styrigx.com', '/?lock=1'],
    ['styrigx.com', '/?lock=1&why=no-cookie&return=https%3A%2F%2Fblog.styrigx.com%2F'],
    ['styrigx.com', '/?return=%2Fsettings%2Fsecurity%2Flock%2F'], ['styrigx.com', '/en/?lock=1'],
    ['styrigx.com', '/settings/security/lock/'], ['styrigx.com', '/files-index.json'], ['styrigx.com', '/brand-new-page/'],
    ['blog.styrigx.com', '/'], ['blog.styrigx.com', '/?utm=1'], ['blog.styrigx.com', '/rss.xml?a'], ['blog.styrigx.com', '/post/x/?a'],
    ['daymark.styrigx.com', '/'], ['daymark.styrigx.com', '/?x=1'], ['daymark.styrigx.com', '/sitemap.xml?a'],
    ['daymark.styrigx.com', '/api/lock-session-check'],
    ['curio.styrigx.com', '/'], ['curio.styrigx.com', '/?x=1'], ['curio.styrigx.com', '/en/?a'], ['curio.styrigx.com', '/api/lock-session-check'],
  ];
  for (const [h, p] of mustGateway) {
    const mine = pickRoute(ROUTES, h, p);
    const other = pickRoute(OTHER, h, p);
    assert.ok(mine && !(other && other.length > mine.length), 'not via gateway: ' + h + p);
  }
  /* daymark 句子接口仍归 daymark-core（更具体的规则优先） */
  assert.equal(pickRoute(OTHER, 'daymark.styrigx.com', '/api/today').length > pickRoute(ROUTES, 'daymark.styrigx.com', '/api/today').length, true);
  /* curio 收藏接口归 curio-core */
  for (const p of ['/api/links', '/api/icon?id=1', '/api/import', '/api/export']) {
    assert.equal(pickRoute(OTHER, 'curio.styrigx.com', p).length > pickRoute(ROUTES, 'curio.styrigx.com', p).length, true, p);
  }
});

test('A 静态资源进 Worker 后原样回源：不验会话、不 302', async () => {
  const e = env();
  const res = await worker.fetch(new Request('https://styrigx.com/css/main.abc.css'), e, CTX);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'css');
  assert.deepEqual(e.seen, ['styrigx.com/css/main.abc.css']);
  assert.equal(res.headers.get('X-SGX-Runtime'), null, '静态资源原样回源，不打网关标记');
  const m = await worker.fetch(new Request('https://blog.styrigx.com/manifest.json'), env(), CTX);
  assert.equal(m.status, 200);
  const css = await worker.fetch(new Request('https://blog.styrigx.com/css/main.abc.css'), env(), CTX);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('X-SGX-Runtime'), null, '子站 CI 冒烟要求静态资源 runtime=none');
  /* 子站页面仍是网关回的 302 */
  const pg = await worker.fetch(new Request('https://blog.styrigx.com/?utm=1'), env(), CTX);
  assert.equal(pg.status, 302);
  assert.equal(pg.headers.get('X-SGX-Runtime'), 'worker');
});

test('A 无会话打开 /?lock=1：网关给锁屏态页面（no-store、带 data-sgx-lock-session），不是 Pages 原样', async () => {
  const res = await get('https://styrigx.com/?lock=1&why=no-cookie&return=https%3A%2F%2Fblog.styrigx.com%2F');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.match(await res.text(), /<html data-sgx-lock-session="locked"/);
});

/* ---------------- B. session-check 给去处 ---------------- */
async function check(qs, cookie) {
  const res = await get('https://styrigx.com/api/lock-session-check' + qs, cookie);
  return { status: res.status, cc: res.headers.get('Cache-Control'), j: await res.json() };
}

test('B session-check?return：服务端给校验过的 next（子站原地址）', async () => {
  const r = await check('?return=' + encodeURIComponent('https://blog.styrigx.com/post/x/'), await lockCookie('admin'));
  assert.equal(r.status, 200);
  assert.equal(r.cc, 'private, no-store');
  assert.deepEqual(r.j, { ok: true, role: 'admin', next: 'https://blog.styrigx.com/post/x/', upgrade: false });
});

test('B session-check?return：不合法 return → 首页；退役子站 → 首页；无 return → next null', async () => {
  const c = await lockCookie('admin');
  assert.equal((await check('?return=' + encodeURIComponent('https://evil.example/'), c)).j.next, '/');
  assert.equal((await check('?return=' + encodeURIComponent('//evil.example/'), c)).j.next, '/');
  assert.equal((await check('?return=' + encodeURIComponent('https://book.styrigx.com/'), c)).j.next, '/');
  assert.equal((await check('', c)).j.next, null);
});

test('B session-check：访客 + 管理员专属 return → upgrade（就地管理员验证）；管理员 + 门内页 → 安全总览', async () => {
  const v = await check('?return=' + encodeURIComponent('/settings/security/lock/'), await lockCookie('visitor'));
  assert.equal(v.j.upgrade, true);
  assert.equal(v.j.next, '/settings/security/lock/');
  const o = await check('?return=' + encodeURIComponent('/settings/security/lock/'), await lockCookie('admin'));
  assert.equal(o.j.upgrade, false);
  assert.equal(o.j.next, '/settings/security/');
  /* 子站同名路径不是管理员专属页 */
  const s = await check('?return=' + encodeURIComponent('https://blog.styrigx.com/settings/security/lock/'), await lockCookie('visitor'));
  assert.equal(s.j.upgrade, false);
});

test('B session-check：没有会话 → 401 no-store', async () => {
  const r = await check('?return=%2F', '');
  assert.equal(r.status, 401);
  assert.equal(r.cc, 'private, no-store');
});

/* ---------------- C. 访客打开管理员专属页 ---------------- */
test('C 访客直接打开锁屏凭证页 → 302 到首页管理员验证（?return=，不带 lock=1）', async () => {
  const res = await get('https://styrigx.com/settings/security/lock/', await lockCookie('visitor'));
  assert.equal(res.status, 302);
  const loc = res.headers.get('Location');
  assert.equal(loc, 'https://styrigx.com/?return=' + encodeURIComponent('/settings/security/lock/'));
  const en = await get('https://styrigx.com/en/settings/security/lock/', await lockCookie('visitor'));
  assert.equal(en.headers.get('Location'), 'https://styrigx.com/en/?return=' + encodeURIComponent('/en/settings/security/lock/'));
  /* 跟过去：首页是 valid + upgrade，不是锁屏 */
  const home = await get('https://styrigx.com' + new URL(loc).pathname + new URL(loc).search, await lockCookie('visitor'));
  const html = await home.text();
  assert.match(html, /data-sgx-upgrade="1"/);
  assert.match(html, /data-sgx-lock-session="valid"/);
});

/* ---------------- D. 锁屏瘦身 ---------------- */
test('D 首页模板用 safeHTML 输出瘦身标记（Go 模板会删 HTML 注释）；锁屏态剥掉桌面、valid 保留', async () => {
  const tpl = fs.readFileSync(path.join(REPO, 'web/layouts/index.html'), 'utf8');
  assert.match(tpl, /\{\{ "<!-- SGX-DESKTOP-START -->" \| safeHTML \}\}/);
  assert.match(tpl, /\{\{ "<!-- SGX-DESKTOP-END -->" \| safeHTML \}\}/);
  assert.doesNotMatch(await (await get('https://styrigx.com/?lock=1')).text(), /DESK/);
  assert.match(await (await get('https://styrigx.com/', await lockCookie('admin'))).text(), /DESK/);
});

/* ---------------- E. 账号页首帧 ---------------- */
test('E 账号页（访客）：访客眼里没有账号——/account/ 及子页（中英）一律 302 回首页，不出页面', async () => {
  for (const p of ['/account/', '/account/devices/', '/account/tempkeys/', '/account/security/', '/en/account/', '/en/account/profile/']) {
    const res = await get('https://styrigx.com' + p, (await lockCookie('visitor')) + '; ' + (await accountCookie()));
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com' + (p.startsWith('/en/') ? '/en/' : '/'), p);
  }
});
for (const role of ['admin']) {
  test(`E 账号页（锁屏 ${role} + 账号会话）：data-sgx-account-session=in，登录区不下发，总览不 hidden`, async () => {
    const html = await (await get('https://styrigx.com/account/', (await lockCookie(role)) + '; ' + (await accountCookie()))).text();
    assert.match(html, /data-sgx-account-session="in"/);
    assert.doesNotMatch(html, /acct-login|欢迎回来/);
    assert.match(html, /<div id="acct-main">/);
  });
}
test('E 账号页（管理员，无账号会话）：data-sgx-account-session=out，登录区去掉 hidden', async () => {
  const html = await (await get('https://styrigx.com/account/', await lockCookie('admin'))).text();
  assert.match(html, /data-sgx-account-session="out"/);
  assert.match(html, /<div id="acct-login" class="acct-login">/);
  assert.match(html, /<div id="acct-main" hidden>/);
});
test('E 账号页模板：登录区默认 hidden，并被 SGX-ACCT-LOGIN 标记包住（safeHTML）', () => {
  const tpl = fs.readFileSync(path.join(REPO, 'web/layouts/_default/account.html'), 'utf8');
  assert.match(tpl, /\{\{ "<!-- SGX-ACCT-LOGIN-START -->" \| safeHTML \}\}\n\s*<div id="acct-login" class="acct-login" hidden>/);
  assert.match(tpl, /\{\{ "<!-- SGX-ACCT-LOGIN-END -->" \| safeHTML \}\}/);
  assert.match(tpl, /<div id="acct-main" hidden>/);
});

/* ---------------- F. 内容索引 ---------------- */
test('F /files-index.json 要先解锁（无会话 302，有会话 200）', async () => {
  assert.equal((await get('https://styrigx.com/files-index.json')).status, 302);
  assert.equal((await get('https://styrigx.com/files-index.json', await lockCookie('visitor'))).status, 200);
});

/* ---------------- G. 不预渲染 ---------------- */
test('G 页面不带 Speculation Rules（预渲染会启用旧会话状态的页面）', () => {
  const base = fs.readFileSync(path.join(REPO, 'web/layouts/_default/baseof.html'), 'utf8');
  assert.doesNotMatch(base, /speculationrules/);
});
