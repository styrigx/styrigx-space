/**
 * 2026-10-21 三站锁屏 / 回跳 / 复验 / 账号首帧 根因回归（与 tests/space/e2e/edge/edge-flow.spec.js 对应）。
 *
 * 根因（每条都有一个测试，改前会红）：
 * A. 路由：Cloudflare 不带 * 的规则遇到查询串不命中 → styrigx.com/?lock=1&return=…（锁屏入口）、
 *    blog / daymark 首页带查询串都绕过网关直达 Pages。
 * B. /api/lock-session-check 以前只回 ok，前端解锁后只能「重载同一地址等首页 302」，锁屏入口不过网关时永远等不到。
 *    P2-3 起回 {ok, by, exp, next}（进门二值，没有 role / upgrade）。
 * C. （P2-3 改写）进门的人直接打开锁屏凭证页 → 200 回源（页面自己要锁侧复验），不再按角色 302。
 * D. 锁屏瘦身标记被 Go 模板删掉，锁屏态整份下发桌面。（v5 S3 起整站放开，瘦身整个删了：D 改成断言首页照样下发桌面。）
 * E. 账号页首帧提示（网关注入 data-sgx-account-session）：命名 v2 起删掉（旧整页已删，账号终端自己读 GET /api/account）。
 * F. 内容索引 /files-index.json 被后缀白名单放行。（v5 S3 起 RSS / files-index 公开，F 改成断言没会话也 200。）
 * G. 站内链接 prerender（Speculation Rules）启用的是旧会话状态的页面快照。
 *
 * 运行：node --test tests/workers/space-core/auth-flow-2026-10-21.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockSession, TEST_ACCOUNT_COOKIE } from './_tickets.mjs';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const worker = (await import(REPO + '/workers/space-core/src/app.js')).default;
const { readRoutes, pickRoute, routeMatches } = await import(REPO + '/space/scripts/lib/cf-routes.mjs');
const { signLockSessionTicket } = await import(REPO + '/workers/space-core/src/core/lock-session.js');

const { priv: PRIV, pub: PUB } = await genKeyPair();
const CTX = { waitUntil() {} };

const DESKTOP_HTML = '<!doctype html><html lang="zh"><body><!-- SGX-DESKTOP-START --><div id="desk">DESK</div><!-- SGX-DESKTOP-END --></body></html>';
const ACCOUNT_HTML = '<!doctype html><html lang="zh"><body>' +
  '<!-- SGX-ACCT-LOGIN-START -->\n  <div id="acct-login" class="acct-login" hidden><p>欢迎回来</p></div>\n<!-- SGX-ACCT-LOGIN-END -->' +
  '<div id="acct-main" hidden>MAIN</div></body></html>';

function env() {
  const seen = [];
  const d1 = makeAuthD1(); /* 纪元在 D1，空库 → 0 */
  return {
    D1_SPACE: d1,
    seen,
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_SPACE_PUBLIC: PUB,
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
const lockCookie = async (by) => 'sgx-space-session=' + (await testLockSession(PRIV, 0, by));
/** session-check 正文：exp 是会话到期（毫秒），先查它在将来，再比其余字段 */
function body(j) {
  assert.equal(typeof j.exp, 'number');
  assert.ok(j.exp > Date.now(), 'exp 在将来');
  const { exp, ...rest } = j;
  return rest;
}
const accountCookie = async () => TEST_ACCOUNT_COOKIE;
const get = (url, cookie) => worker.fetch(new Request(url, { headers: cookie ? { Cookie: cookie } : {} }), env(), CTX);

/* ---------------- A. 路由 ---------------- */
const ROUTES = readRoutes(fs.readFileSync(path.join(REPO, 'workers/space-core/wrangler.toml'), 'utf8'));
/* styrigx-daymark-core、styrigx-curio-core（workers/daymark-core、workers/curio-core）：合并 PR3 起主域名 + 过渡期的旧图志两条 */
const OTHER = ['daymark-core', 'curio-core'].flatMap((d) => readRoutes(fs.readFileSync(path.join(REPO, 'workers', d, 'wrangler.toml'), 'utf8')));

test('A 路由匹配规则照线上实测：不带 * 的规则遇到查询串不命中；* 规则连查询串前缀匹配', () => {
  assert.equal(routeMatches('styrigx.com/', 'styrigx.com', '/'), true);
  assert.equal(routeMatches('styrigx.com/', 'styrigx.com', '/?lock=1'), false);
  assert.equal(routeMatches('styrigx.com/zh/*', 'styrigx.com', '/zh/?lock=1'), true);
  assert.equal(routeMatches('blog.styrigx.com/about*', 'blog.styrigx.com', '/about?a'), true);
});

test('A 锁屏入口、带查询串的首页、所有页面都过网关（改前 styrigx.com/?lock=1 直达 Pages）', () => {
  const mustGateway = [
    ['styrigx.com', '/'], ['styrigx.com', '/?lock=1'],
    ['styrigx.com', '/?lock=1&why=no-cookie&return=https%3A%2F%2Fstyrigx.com%2Fblog%2F'],
    ['styrigx.com', '/?return=%2Fsecurity%2Flock%2F'], ['styrigx.com', '/zh/?lock=1'],
    ['styrigx.com', '/security/lock/'], ['styrigx.com', '/files-index.json'], ['styrigx.com', '/brand-new-page/'],
    ['styrigx.com', '/blog/'], ['styrigx.com', '/blog/?utm=1'], ['styrigx.com', '/blog/rss.xml?a'], ['styrigx.com', '/blog/post/x/?a'],
    ['styrigx.com', '/daymark/'], ['styrigx.com', '/daymark/?x=1'], ['styrigx.com', '/daymark/sitemap.xml?a'],
    ['styrigx.com', '/curio/'], ['styrigx.com', '/curio/?x=1'], ['styrigx.com', '/curio/zh/?a'],
  ];
  for (const [h, p] of mustGateway) {
    const mine = pickRoute(ROUTES, h, p);
    const other = pickRoute(OTHER, h, p);
    assert.ok(mine && !(other && other.length > mine.length), 'not via gateway: ' + h + p);
  }
  /* daymark 句子接口、curio 收藏接口归各自的接口 Worker（更具体的规则优先） */
  for (const p of ['/daymark/api/today', '/daymark/api/quotes', '/curio/api/links', '/curio/api/icon?id=1', '/curio/api/import', '/curio/api/export']) {
    assert.equal(pickRoute(OTHER, 'styrigx.com', p).length > pickRoute(ROUTES, 'styrigx.com', p).length, true, p);
  }
  /* 旧子域名不再登记：一条网关路由都不命中（不跳转） */
  for (const h of ['blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com']) assert.equal(pickRoute(ROUTES, h, '/'), null, h);
});

test('A 静态资源进 Worker 后原样回源：不验会话、不 302', async () => {
  const e = env();
  const res = await worker.fetch(new Request('https://styrigx.com/css/main.abc.css'), e, CTX);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'css');
  assert.deepEqual(e.seen, ['styrigx.com/css/main.abc.css']);
  assert.equal(res.headers.get('X-SGX-Runtime'), null, '静态资源原样回源，不打网关标记');
  const m = await worker.fetch(new Request('https://styrigx.com/blog/manifest.json'), env(), CTX);
  assert.equal(m.status, 200);
  const css = await worker.fetch(new Request('https://styrigx.com/blog/css/main.abc.css'), env(), CTX);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('X-SGX-Runtime'), null, '子站 CI 冒烟要求静态资源 runtime=none');
  /* 子站页面是网关回的（v5 S3：没会话也 200，标 locked） */
  const pg = await worker.fetch(new Request('https://styrigx.com/blog/?utm=1'), env(), CTX);
  assert.equal(pg.status, 200);
  assert.equal(pg.headers.get('X-SGX-Runtime'), 'worker');
});

test('A 无会话打开 /?lock=1：网关给锁屏态页面（no-store、带 data-sgx-lock-session），不是 Pages 原样', async () => {
  const res = await get('https://styrigx.com/?lock=1&why=no-cookie&return=https%3A%2F%2Fstyrigx.com%2Fblog%2F');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.match(await res.text(), /<html data-sgx-lock-session="locked"/);
});

/* ---------------- B. session-check 给去处 ---------------- */
async function check(qs, cookie) {
  const res = await get('https://styrigx.com/api/lock-session-check' + qs, cookie);
  return { status: res.status, cc: res.headers.get('Cache-Control'), j: await res.json() };
}

test('B session-check?return：服务端给校验过的 next（子站原地址，合并 PR3 起在主域名）', async () => {
  const r = await check('?return=' + encodeURIComponent('https://styrigx.com/blog/post/x/'), await lockCookie('password'));
  assert.equal(r.status, 200);
  assert.equal(r.cc, 'private, no-store');
  assert.deepEqual(body(r.j), { ok: true, by: 'password', next: 'https://styrigx.com/blog/post/x/' });
  const rel = await check('?return=' + encodeURIComponent('/curio/zh/?a=1'), await lockCookie('password'));
  assert.equal(rel.j.next, '/curio/zh/?a=1');
});

test('B session-check?return：不合法 return → 首页；退役子站 → 首页；无 return → next null', async () => {
  const c = await lockCookie('password');
  assert.equal((await check('?return=' + encodeURIComponent('https://evil.example/'), c)).j.next, '/');
  assert.equal((await check('?return=' + encodeURIComponent('//evil.example/'), c)).j.next, '/');
  for (const h of ['book.styrigx.com', 'blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com', 'atlas.styrigx.com']) {
    assert.equal((await check('?return=' + encodeURIComponent('https://' + h + '/'), c)).j.next, '/', h);
  }
  assert.equal((await check('', c)).j.next, null);
  /* 无 return：整份正文 {ok, by, exp, next}，没有 role / upgrade */
  const plain = await check('', c);
  assert.equal(plain.status, 200);
  assert.deepEqual(body(plain.j), { ok: true, by: 'password', next: null });
});

test('B session-check：进门二值——任何 by 带门内页 return 都回原页（不再有 upgrade / 安全总览改道）；by 原样回给前端只作展示', async () => {
  for (const by of ['password', 'passkey', 'link']) {
    const r = await check('?return=' + encodeURIComponent('/security/lock/'), await lockCookie(by));
    assert.equal(r.status, 200, by);
    assert.deepEqual(body(r.j), { ok: true, by, next: '/security/lock/' }, by);
  }
  const s = await check('?return=' + encodeURIComponent('https://proxy-rules.styrigx.com/security/lock/'), await lockCookie('link'));
  assert.equal(s.j.next, 'https://proxy-rules.styrigx.com/security/lock/');
  const vp = await check('', await lockCookie('link'));
  assert.equal(vp.status, 200);
  assert.deepEqual(body(vp.j), { ok: true, by: 'link', next: null });
  assert.ok(!('role' in vp.j) && !('upgrade' in vp.j));
});

test('B session-check：没有会话 / 坏会话 → 401 no-store', async () => {
  const r = await check('?return=%2F', '');
  assert.equal(r.status, 401);
  assert.equal(r.cc, 'private, no-store');
  /* 以下两条原在 session-security「无会话/坏会话 → 401」 */
  const none = await check('', '');
  assert.equal(none.status, 401);
  assert.deepEqual(none.j, { ok: false });
  /* 旧三段式（无 role）→ 无效 */
  assert.equal((await check('', 'sgx-space-session=0.9999999999999.badsig')).status, 401);
});

/* ---------------- C. 进门的人打开门内页 ---------------- */
test('C 分享链接进门的人直接打开锁屏凭证页（中英）→ 200 回源、valid，没有升级 / 等级标记（复验由页面自己要）', async () => {
  for (const p of ['/security/lock/', '/zh/security/lock/']) {
    const res = await get('https://styrigx.com' + p, await lockCookie('link'));
    assert.equal(res.status, 200, p);
    const html = await res.text();
    assert.match(html, /data-sgx-lock-session="valid"/);
    assert.doesNotMatch(html, /data-sgx-upgrade|data-sgx-role/); // old-name guard
  }
  /* 首页带 return：进门的人直接 302 回原页 */
  const home = await get('https://styrigx.com/?return=' + encodeURIComponent('/security/lock/'), await lockCookie('link'));
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('Location'), '/security/lock/');
});

/* ---------------- D. 锁屏瘦身 ---------------- */
test('D（v5 S3）首页模板不再有瘦身标记；没进站也照样下发桌面', async () => {
  const tpl = fs.readFileSync(path.join(REPO, 'space/web/layouts/index.html'), 'utf8');
  assert.doesNotMatch(tpl, /SGX-DESKTOP/);
  assert.match(await (await get('https://styrigx.com/?lock=1')).text(), /DESK/);
  assert.match(await (await get('https://styrigx.com/', await lockCookie('password'))).text(), /DESK/);
});

/* ---------------- E. 账号页首帧 ---------------- */
test('E 网关不再给账号首帧提示（命名 v2：旧账号整页 #327 删了，gate.js isAccountPage / askSessionFor 删掉）：有账号会话也不注入 data-sgx-account-session，不问 ACCOUNT_VERIFIER', async () => {
  let asked = 0;
  const e = env();
  e.ACCOUNT_VERIFIER = new Proxy({}, { get: () => { asked++; return async () => ({ ok: true }); } });
  for (const p of ['/', '/zh/', '/account/', '/zh/account/']) {
    const res = await worker.fetch(new Request('https://styrigx.com' + p, { headers: { Cookie: (await lockCookie('password')) + '; ' + (await accountCookie()) } }), e, CTX);
    const html = await res.text();
    assert.doesNotMatch(html, /data-sgx-account-session=/, p);
  }
  assert.equal(asked, 0, '网关页面路径不问账号 Worker');
  const src = fs.readFileSync(path.join(REPO, 'workers/space-core/src/gate.js'), 'utf8');
  assert.doesNotMatch(src, /isAccountPage|askSessionFor|SGX-ACCT-LOGIN|acct-main/);
});
test('E 账号页模板随 2026-11-08 账号 UI 改版删除（账号在顶栏账号终端里；/account/ 由 _redirects 301 到首页 #acct）', () => {
  assert.equal(fs.existsSync(path.join(REPO, 'space/web/layouts/_default/account.html')), false);
  assert.match(fs.readFileSync(path.join(REPO, 'space/web/static/_redirects'), 'utf8'), /^\/account\/\s+\/#acct\s+301$/m);
});

/* ---------------- F. 内容索引 ---------------- */
test('F（v5 S3）/files-index.json 公开（无会话、有会话都 200）', async () => {
  assert.equal((await get('https://styrigx.com/files-index.json')).status, 200);
  assert.equal((await get('https://styrigx.com/files-index.json', await lockCookie('link'))).status, 200);
});
test('F（v5 S3）RSS（Hugo 生成的 */index.xml）、sitemap.xml / opensearch.xml 都公开', async () => {
  for (const p of ['/index.xml', '/zh/index.xml', '/tags/index.xml', '/zh/categories/index.xml', '/INDEX.XML']) {
    assert.equal((await get('https://styrigx.com' + p)).status, 200, p + ' 无会话');
    assert.equal((await get('https://styrigx.com' + p, await lockCookie('link'))).status, 200, p + ' 有会话');
  }
  for (const p of ['/sitemap.xml', '/opensearch.xml', '/zh/sitemap.xml']) {
    assert.equal((await get('https://styrigx.com' + p)).status, 200, p + ' 公开');
  }
});

/* ---------------- G. 不预渲染 ---------------- */
test('G 页面不带 Speculation Rules（预渲染会启用旧会话状态的页面）', () => {
  const base = fs.readFileSync(path.join(REPO, 'space/web/layouts/_default/baseof.html'), 'utf8');
  assert.doesNotMatch(base, /speculationrules/);
});
