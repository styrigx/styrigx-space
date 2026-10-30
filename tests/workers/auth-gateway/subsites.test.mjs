/**
 * 网关子站门禁（workers/auth-gateway/src/subsites.js）：
 * - blog/book 页面：会话有效回源（HTML 加 no-store），无效 302 主站锁屏（带 why 和 return）
 * - /api/lock-session-check：blog 认 204、book 认 200 {ok:true}，无效 401
 * - 静态资源后缀不验会话
 * - 子站 /api/*（未登录）回 401 JSON，不 302
 * - 主站请求不受影响；未登记的域名照旧 301 回主站
 *
 * 运行：node --test tests/workers/auth-gateway/subsites.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const worker = (await import(REPO + '/workers/auth-gateway/src/index.js')).default;
const { isStaticAsset, subsiteFor, markSubsiteRole } = await import(REPO + '/workers/auth-gateway/src/subsites.js');
const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');

const { priv: PRIV, pub: PUB } = await genKeyPair();

const CTX = { waitUntil() {} };
function env(epoch = '0') {
  const seen = [];
  const d1 = makeAuthD1({ epochs: { 'lock-epoch': Number(epoch) } }); /* 纪元在 D1 */
  return {
    seen,
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB,
    KV_LOCK_DOOR: { async get() { return null; } },
    D1_LOCK_AUTH: d1,
    ASSETS: {
      async fetch(req) {
        seen.push(new URL(req.url).hostname + new URL(req.url).pathname);
        const p = new URL(req.url).pathname;
        if (p.endsWith('.js')) return new Response('js', { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=60' } });
        return new Response('<html><body>page</body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    },
  };
}

async function cookie(role = 'visitor', epoch = 0) {
  const v = await testLockSession(PRIV, epoch, role);
  return 'sgx-lock-session=' + v;
}

function req(url, cookieHeader) {
  return new Request(url, { headers: cookieHeader ? { Cookie: cookieHeader } : {} });
}

test('登记表：只认 blog、daymark、curio（书库已下线）', () => {
  assert.ok(subsiteFor('blog.styrigx.com'));
  assert.equal(subsiteFor('book.styrigx.com'), null);
  assert.equal(subsiteFor('book-preview.styrigx.com'), null);
  assert.ok(subsiteFor('daymark.styrigx.com'));
  assert.ok(subsiteFor('curio.styrigx.com'));
  assert.equal(subsiteFor('evil.styrigx.com'), null);
  assert.equal(subsiteFor('styrigx.com'), null);
  assert.equal(subsiteFor('__proto__'), null);
});

test('静态资源后缀判断', () => {
  assert.equal(isStaticAsset('/pagefind/pagefind.js'), true);
  assert.equal(isStaticAsset('/fonts/a.woff2'), true);
  assert.equal(isStaticAsset('/pagefind/fragment/zh_1.pf_fragment'), false);
  assert.equal(isStaticAsset('/rss.xml'), false);
  assert.equal(isStaticAsset('/post/a.b/'), false);
  assert.equal(isStaticAsset('/'), false);
});

for (const host of ['blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com']) {
  test(host + '：未登录页面 302 到主站锁屏，带 why=no-cookie 和 return，不回源', async () => {
    const e = env();
    const res = await worker.fetch(req('https://' + host + '/post/hello/?a=1'), e, CTX);
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('Location'));
    assert.equal(loc.origin, 'https://styrigx.com');
    assert.equal(loc.searchParams.get('lock'), '1');
    assert.equal(loc.searchParams.get('why'), 'no-cookie');
    assert.equal(loc.searchParams.get('return'), 'https://' + host + '/post/hello/?a=1');
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
    assert.match(res.headers.get('Cache-Control'), /no-store/);
    assert.deepEqual(e.seen, []);
  });

  test(host + '：访客、管理员会话都回源，HTML 加 private, no-store，<html> 标上角色', async () => {
    for (const role of ['visitor', 'admin']) {
      const e = env();
      const res = await worker.fetch(req('https://' + host + '/', await cookie(role)), e, CTX);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '<html data-sgx-role="' + role + '"><body>page</body></html>');
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
      assert.deepEqual(e.seen, [host + '/']);
    }
  });

  test(host + '：伪造签名、epoch 过低都算无效（why=invalid-session）', async () => {
    const good = await cookie('admin');
    const i = good.length - 10; /* 改签名中间一位（最后一位可能只是补位） */
    const bad = good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
    let res = await worker.fetch(req('https://' + host + '/', bad), env(), CTX);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('Location')).searchParams.get('why'), 'invalid-session');
    res = await worker.fetch(req('https://' + host + '/', await cookie('admin', 1)), env('2'), CTX);
    assert.equal(res.status, 302);
  });

  test(host + '：静态资源后缀不验会话，原样回源', async () => {
    const e = env();
    const res = await worker.fetch(req('https://' + host + '/pagefind/pagefind.js'), e, CTX);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  });

  test(host + '：未登录 /api/* 回 401 JSON，不 302', async () => {
    const res = await worker.fetch(req('https://' + host + '/api/private/me'), env(), CTX);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('Content-Type'), /json/);
  });
}

test('session-check：blog 有效 204、daymark / curio 有效 200 {ok:true}、无效 401', async () => {
  const c = await cookie('visitor');
  let res = await worker.fetch(req('https://blog.styrigx.com/api/lock-session-check', c), env(), CTX);
  assert.equal(res.status, 204);
  for (const host of ['daymark.styrigx.com', 'curio.styrigx.com']) {
    res = await worker.fetch(req('https://' + host + '/api/lock-session-check', c), env(), CTX);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }
  for (const host of ['blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com']) {
    res = await worker.fetch(req('https://' + host + '/api/lock-session-check'), env(), CTX);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).why, 'no-cookie');
    assert.match(res.headers.get('Cache-Control'), /no-store/);
  }
});

test('主站照旧；未登记的子域名照旧 301 回主站', async () => {
  let res = await worker.fetch(req('https://styrigx.com/settings/'), env(), CTX);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('Location'), /^https:\/\/styrigx\.com\/\?lock=1&return=%2Fsettings%2F/);
  res = await worker.fetch(req('https://evil.styrigx.com/'), env(), CTX);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://styrigx.com/');
  /* 书库已下线：book 当未登记子域名处理 */
  res = await worker.fetch(req('https://book.styrigx.com/'), env(), CTX);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://styrigx.com/');
});

/* 用户 2026-10-24：三个子站访客模式点边栏头像还能跳主站账号页，主站访客点不了。网关在子站 HTML 里替访客去掉这个链接。 */
const DRAWER = '<html lang="zh-CN" data-sgx-role="admin"><body><div class="sgx-drawer-head"><span class="sgx-drawer-brand">S</span>'
  + '<a class="sgx-drawer-me" href="https://styrigx.com/account/" aria-label="账号">'
  + '<img src="https://styrigx.com/avatar/192.webp" alt="" width="52" height="52" class="sgx-tb-avatar"></a></div>'
  + '<a class="sgx-drawer-item" href="https://styrigx.com/">主站</a></body></html>';

test('子站访客：抽屉头像换成不可点的 span（不带 href / aria-label，读屏跳过），其他链接不动', () => {
  const out = markSubsiteRole(DRAWER, 'visitor');
  assert.doesNotMatch(out, /<a class="sgx-drawer-me"/);
  assert.doesNotMatch(out, /account\//);
  assert.match(out, /<span class="sgx-drawer-me" aria-hidden="true" style="pointer-events:none;cursor:default"><img src="https:\/\/styrigx.com\/avatar\/192.webp"[^>]*><\/span>/);
  assert.match(out, /<a class="sgx-drawer-item" href="https:\/\/styrigx.com\/">主站<\/a>/);
  assert.match(out, /^<html data-sgx-role="visitor" lang="zh-CN">/, '页面里伪造的角色标记先去掉，再按会话标');
});

test('子站管理员：抽屉头像照旧链到主站账号页', () => {
  const out = markSubsiteRole(DRAWER, 'admin');
  assert.match(out, /<a class="sgx-drawer-me" href="https:\/\/styrigx.com\/account\/" aria-label="账号">/);
  assert.match(out, /^<html data-sgx-role="admin" lang="zh-CN">/);
});

for (const host of ['blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com']) {
  test(host + '：访客经网关拿到的页面里头像不可点，管理员可点', async () => {
    const page = (e) => { e.ASSETS.fetch = async () => new Response(DRAWER, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); return e; };
    let res = await worker.fetch(req('https://' + host + '/', await cookie('visitor')), page(env()), CTX);
    let html = await res.text();
    assert.match(html, /<span class="sgx-drawer-me"/);
    assert.doesNotMatch(html, /href="https:\/\/styrigx.com\/account\/"/);
    res = await worker.fetch(req('https://' + host + '/', await cookie('admin')), page(env()), CTX);
    html = await res.text();
    assert.match(html, /<a class="sgx-drawer-me" href="https:\/\/styrigx.com\/account\/"/);
  });
}
