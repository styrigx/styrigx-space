/**
 * v5 S3 网关分层（workers/space-core/src/gate.js 访问表 ROUTE_ACCESS）：整站页面公开，只有三处上锁。
 * - 快照：访问表整张写在这里，改表必须改这条测试（评审里一眼看得见谁被放开了）
 * - 规则：页面 / 静态文件一律 public；/api/* 和 /<站>/api/* 只有表里逐条的「方法 + 路径」public，其余 entry（fail closed）
 * - 精确匹配：多一段 /x、换方法、编码 / 大小写绕法都不算 public
 * - 访客：/wild/、/blog/、/curio/、/daymark/ 页面 200；/api/ai、/api/status、/api/space-audit、/api/account 401；屏幕时间合计公开
 * - 进站（password / passkey / link）放行；分享链接作废、回锁（lock-now 清 cookie）、纪元推进之后 /api/ai 401
 * 听歌三层（歌单公开 / 听要进站 / 管理要账号）在 curio-core 自己的访问表里，见 tests/workers/curio-core/movies-music.test.mjs。
 * 运行：node --test tests/workers/space-core/route-access.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testLockSession, TEST_LINK_ID } from './_tickets.mjs';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/space-core/src/app.js')).default;
const { ROUTE_ACCESS, ACCESS, accessOf, isApiPath } = await import(REPO + 'workers/space-core/src/gate.js');
const { API_ROUTES, FORWARDING } = await import(REPO + 'workers/space-core/src/router.js');
const { conclusionFor } = await import(REPO + 'workers/space-core/src/core/conclusion.js');
const { bumpLockEpoch } = await import(REPO + 'workers/space-core/src/core/lock-session.js');
const { PUBLIC_API: ACCOUNT_PUBLIC_API } = await import(REPO + 'workers/account/src/gate.js');

const { priv: PRIV, pub: PUB } = await genKeyPair();
const CTX = { waitUntil() {} };

function env(db = makeAuthD1()) {
  const seen = [];
  return {
    seen,
    db,
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_SPACE_PUBLIC: PUB,
    D1_SPACE: db,
    ANON_LIMITER: { async limit() { return { success: true }; } },
    ACCOUNT: { async fetch(req) { seen.push('ACCOUNT ' + new URL(req.url).pathname); return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'X-SGX-Runtime': 'account' } }); } },
    ASSETS: {
      async fetch(req) {
        const p = new URL(req.url).pathname;
        seen.push('ASSETS ' + p);
        return new Response('<!DOCTYPE html><html lang="zh"><body>page ' + p + '</body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    },
  };
}
const cookieOf = async (by) => 'sgx-space-session=' + (await testLockSession(PRIV, 0, by));
function get(e, p, { cookie = '', method = 'GET' } = {}) {
  const headers = { Origin: 'https://styrigx.com' };
  if (cookie) headers.Cookie = cookie;
  return worker.fetch(new Request('https://styrigx.com' + p, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : '{}' }), e, CTX);
}

test('访问表快照：改了这张表，这里必须跟着改', () => {
  assert.deepEqual(ROUTE_ACCESS.map((r) => r.method + ' ' + r.path + ' → ' + r.access), [
    'GET /api/lock-entry → public',
    'GET /api/lock-session-check → public',
    'POST /api/lock-password → public',
    'POST /api/lock-passkey → public',
    'GET /api/lock-credentials → public',
    'POST /api/lock-reset → public',
    'POST /api/space-auth → public',
    'GET /s/:code → public',
    'HEAD /s/:code → public',
    'GET /api/geo → public',
    'GET /api/wellbeing → public',
  ]);
  assert.ok(Object.isFrozen(ROUTE_ACCESS) && ROUTE_ACCESS.every((r) => Object.isFrozen(r)));
  for (const r of ROUTE_ACCESS) assert.ok(typeof r.why === 'string' && r.why.length > 0, r.path + ' 要写为什么公开');
  /* 表里只有 public：entry 是默认值，不用写；三处上锁的接口一条都不在表里 */
  assert.ok(ROUTE_ACCESS.every((r) => r.access === ACCESS.PUBLIC));
  for (const p of ['/api/ai', '/api/status', '/api/space-audit', '/api/account', '/api/prefs', '/api/avatar', '/api/profile', '/api/share', '/api/lock-now', '/api/lock-reauth', '/api/lock-all-devices']) {
    assert.ok(!ROUTE_ACCESS.some((r) => r.path === p), p + ' 不许出现在访问表里');
    for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal(accessOf(m, p), ACCESS.ENTRY, m + ' ' + p);
  }
  /* 表里的接口都真有处理的地方（网关路由表、账号转发表或分享链接） */
  for (const r of ROUTE_ACCESS) {
    const known = API_ROUTES.has(r.path) || FORWARDING.some((f) => f.path === r.path) || r.path === '/s/:code';
    assert.ok(known, r.path);
  }
});

test('精确匹配：多一段、换方法、编码 / 大小写都不是 public；只把结尾一个 / 当同一条', () => {
  assert.equal(accessOf('GET', '/api/geo'), 'public');
  assert.equal(accessOf('GET', '/api/geo/'), 'public');
  for (const [m, p] of [['GET', '/api/geo/x'], ['GET', '/api/geo//'], ['POST', '/api/geo'], ['GET', '/api/geox'], ['GET', '/API/geo'], ['GET', '/api/%67eo'],
    ['GET', '/api/wellbeing/x'], ['POST', '/api/wellbeing'], ['GET', '/api/lock-entry/x'], ['POST', '/api/lock-entry'], ['GET', '/api/lock-password'],
    ['GET', '/api/lock-session-check/../ai'], ['POST', '/s/abc'], ['GET', '/api/unknown'], ['GET', '/curio/api/music'], ['GET', '/daymark/api/today']]) {
    assert.equal(accessOf(m, p), 'entry', m + ' ' + p);
  }
  assert.equal(accessOf('GET', '/s/abc'), 'public');
  assert.equal(accessOf('HEAD', '/s/abc/'), 'public');
  /* 页面路径一律 public */
  for (const p of ['/', '/zh/', '/wild/', '/blog/post/x/', '/curio/music/', '/daymark/', '/files-index.json', '/index.xml', '/blog/rss.xml', '/avatar/96.webp']) {
    assert.equal(accessOf('GET', p), 'public', p);
    assert.equal(isApiPath(p), false, p);
  }
  for (const p of ['/api/x', '/blog/api/x', '/CURIO/api/x', '/%63urio/api/x', '//daymark//api']) assert.equal(isApiPath(p), true, p);
});

test('访客：/wild/、/blog/、/curio/、/daymark/ 页面 200 HTML（标 locked、no-store，不 302）', async () => {
  for (const p of ['/', '/zh/', '/wild/', '/zh/wild/', '/blog/', '/blog/post/hello/', '/curio/', '/curio/music/', '/curio/zh/music/', '/daymark/', '/daymark/zh/']) {
    const e = env();
    const r = await get(e, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('Location'), null, p);
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store', p);
    assert.match(await r.text(), /<html data-sgx-lock-session="locked" lang="zh"><body>page /, p);
  }
});

test('访客：三处上锁的数据接口 401（AI 窗口、旷野 status 卡、进站凭证记录）；账号接口 401；屏幕时间合计公开', async () => {
  for (const [p, m] of [['/api/ai', 'GET'], ['/api/ai', 'POST'], ['/api/status', 'GET'], ['/api/space-audit', 'GET'], ['/api/account', 'GET'], ['/api/account', 'POST'], ['/api/prefs', 'GET'], ['/api/profile', 'GET'], ['/api/lock-now', 'POST'], ['/api/geo/x', 'GET'], ['/api/wellbeing/x', 'GET']]) {
    const e = env();
    const r = await get(e, p, { method: m });
    assert.equal(r.status, 401, m + ' ' + p);
    assert.deepEqual(await r.json(), { ok: false }, m + ' ' + p);
    assert.match(r.headers.get('Cache-Control') || '', /no-store/);
    assert.deepEqual(e.seen, [], m + ' ' + p + ' 没转发、没回源');
  }
  const e = env();
  const wb = await get(e, '/api/wellbeing');
  assert.equal(wb.status, 200);
  assert.deepEqual(e.seen, ['ACCOUNT /api/wellbeing']);
});

test('账号 Worker 的纵深防御表和网关访问表一致：转给 ACCOUNT 的 public 条目 = account/src/gate.js PUBLIC_API', () => {
  const fwd = ROUTE_ACCESS.filter((r) => FORWARDING.some((f) => (f.path.endsWith('/') ? r.path.startsWith(f.path) : r.path === f.path || r.path.startsWith(f.path + '/'))));
  assert.deepEqual(fwd.map((r) => r.method + ' ' + r.path), [...ACCOUNT_PUBLIC_API]);
});

test('进站（password / passkey / link）：三处上锁的接口放行（不再 401）', async () => {
  for (const by of ['password', 'passkey', 'link']) {
    const c = await cookieOf(by);
    for (const p of ['/api/status', '/api/ai']) {
      const r = await get(env(), p, { cookie: c });
      assert.notEqual(r.status, 401, by + ' ' + p);
    }
  }
});

test('分享链接作废之后：同一张票下一个请求 /api/ai 就 401（服务绑定结论也 space.ok=false）；页面照常 200', async () => {
  const db = makeAuthD1();
  const c = await cookieOf('link');
  assert.notEqual((await get(env(db), '/api/ai', { cookie: c })).status, 401);
  assert.equal((await conclusionFor({ SGX_SPACE_PUBLIC: PUB, D1_SPACE: db }, c, {}, {})).space.ok, true);
  db.raw.prepare('UPDATE share_link SET revoked_at = ? WHERE id = ?').run(Date.now(), TEST_LINK_ID);
  assert.equal((await get(env(db), '/api/ai', { cookie: c })).status, 401);
  assert.equal((await get(env(db), '/api/status', { cookie: c })).status, 401);
  assert.equal((await conclusionFor({ SGX_SPACE_PUBLIC: PUB, D1_SPACE: db }, c, {}, {})).space.ok, false, '奇趣听歌问的结论同样没进门');
  const page = await get(env(db), '/wild/', { cookie: c });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-sgx-lock-session="locked"/);
});

test('回锁（POST /api/lock-now 清掉 cookie）之后 /api/ai 401', async () => {
  const c = await cookieOf('password');
  assert.notEqual((await get(env(), '/api/ai', { cookie: c })).status, 401);
  const lock = await get(env(), '/api/lock-now', { cookie: c, method: 'POST' });
  assert.equal(lock.status, 200);
  const cleared = lock.headers.getSetCookie().find((x) => x.startsWith('sgx-space-session='));
  assert.match(cleared, /^sgx-space-session=; .*Max-Age=0/);
  /* 浏览器按 Set-Cookie 删掉以后，请求里就没有进站会话了 */
  assert.equal((await get(env(), '/api/ai')).status, 401);
});

test('纪元推进（退出所有设备 / 改密码 / 删通行密钥）之后旧票 /api/ai 401', async () => {
  const db = makeAuthD1({ epochs: { 'lock-epoch': 0 } });
  const c = await cookieOf('password');
  assert.notEqual((await get(env(db), '/api/ai', { cookie: c })).status, 401);
  await bumpLockEpoch(env(db));
  assert.equal((await get(env(db), '/api/ai', { cookie: c })).status, 401);
});

test('源码里没有旧的门：没有 302 到锁屏、没有瘦身、没有路径白名单', () => {
  const src = readFileSync(REPO + 'workers/space-core/src/gate.js', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  for (const old of ['lockRedirect', 'SGX-DESKTOP', 'API_WHITELIST', 'isWhitelisted', 'GATED_DATA', 'RSS_FEED_RE', 'LOCK_RESET_PATHS', 'PUBLIC_PAGE_PATHS', 'X-Robots-Tag', "'lock-reset'", '?lock=1']) {
    assert.ok(!src.includes(old), old);
  }
});
