/**
 * 网关子站门禁（workers/auth-gateway/src/gate.js，合并 PR3）：主域名 styrigx.com 的 /blog/、/curio/、/daymark/ 前缀
 * - 页面：会话有效回源（HTML 加 no-store），无效 302 主站锁屏（带 why 和完整的 return）
 * - 编码 / 大小写 / 多斜杠 / .. 绕法都按子站处理：博客全文 RSS、站点地图没有会话拿不到
 * - 静态资源后缀不验会话（xml / json 不算）
 * - /<站>/api/*（未登录、漏到网关）回 401 JSON，不 302
 * - 根上的 /api/lock-session-check 由主站路由回答（有效 200 {ok:true}、无效 401 {ok:false}），子站前端的判断都对得上
 * - 旧图志 atlas.styrigx.com：任意路径 301 到主域名同路径 + 查询串，不验会话、不回源
 * - 主站请求不受影响；未登记的域名照旧 301 回主站
 *
 * 运行：node --test tests/workers/auth-gateway/subsites.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const worker = (await import(REPO + '/workers/auth-gateway/src/app.js')).default;
const { isStaticAsset, subsiteOf, siteOf, normPath, markSubsiteRole } = await import(REPO + '/workers/auth-gateway/src/gate.js');
const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/src/core/lock-session.js');

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

test('子站判断：只认主域名 styrigx.com + 第一段 blog / curio / daymark；旧图志、旧子域名、书库都不算子站', () => {
  for (const u of ['https://styrigx.com/blog/', 'https://styrigx.com/curio/x', 'https://styrigx.com/daymark', 'https://styrigx.com/%62log/rss.xml', 'https://styrigx.com//blog/rss.xml', 'https://styrigx.com/BLOG/']) {
    assert.ok(subsiteOf(new URL(u)), u);
  }
  for (const u of ['https://atlas.styrigx.com/blog/', 'https://blog.styrigx.com/', 'https://curio.styrigx.com/curio/', 'https://book.styrigx.com/blog/',
    'https://evil.styrigx.com/blog/', 'https://styrigx.com/', 'https://styrigx.com/blogx/', 'https://styrigx.com/__proto__/', 'https://styrigx.com/en/blog/']) {
    assert.equal(subsiteOf(new URL(u)), null, u);
  }
});

test('路径归一：解码一次、反斜杠、小写、多斜杠、. / .. 段', () => {
  assert.equal(normPath('/%62log/rss.xml'), '/blog/rss.xml');
  assert.equal(normPath('/blog%2Frss.xml'), '/blog/rss.xml');
  assert.equal(normPath('//blog///rss.xml'), '/blog/rss.xml');
  assert.equal(normPath('/BLOG/RSS.XML'), '/blog/rss.xml');
  assert.equal(normPath('/css/..%2Fblog/rss.xml'), '/blog/rss.xml');
  assert.equal(normPath('/blog\\rss.xml'), '/blog/rss.xml');
  assert.equal(normPath('/blog/.'), '/blog/');
  assert.equal(normPath('/a/../..'), '/');
  assert.equal(normPath('/%zz/x'), '/%zz/x', '解不开就按原样');
});

test('路径归哪个站：第一段是 blog / curio / daymark 才算', () => {
  assert.equal(siteOf('/blog/post/x/'), 'blog');
  assert.equal(siteOf('/curio/'), 'curio');
  assert.equal(siteOf('/daymark/en/'), 'daymark');
  assert.equal(siteOf('/'), null);
  assert.equal(siteOf('/robots.txt'), null);
  assert.equal(siteOf('/__proto__/'), null);
  assert.equal(siteOf('/blogx/'), null);
  assert.equal(siteOf('/%63urio/'), 'curio');
});

test('静态资源后缀判断（xml / json / txt 都不算，只有博客 manifest 例外）', () => {
  assert.equal(isStaticAsset('/blog/pagefind/pagefind.js'), true);
  assert.equal(isStaticAsset('/blog/fonts/a.woff2'), true);
  assert.equal(isStaticAsset('/blog/CSS/A.CSS'), true);
  assert.equal(isStaticAsset('/blog/pagefind/fragment/zh_1.pf_fragment'), false);
  assert.equal(isStaticAsset('/blog/rss.xml'), false);
  assert.equal(isStaticAsset('/blog/en/rss.xml'), false);
  assert.equal(isStaticAsset('/curio/sitemap.xml'), false);
  /* 带编码 / 多斜杠 / .. 的一律不当静态文件（回源时 Pages 自己解码，指向哪个文件说不准），交给会话检查 */
  for (const p of ['/blog/rss.xml%3F.css', '/blog/rss.xml%23.css', '/blog/%2e%2e/blog/a.css', '//blog/a.css', '/blog/x/../a.css', '/blog\\a.css', '/blog/./a.css']) {
    assert.equal(isStaticAsset(p), false, p);
  }
  assert.equal(isStaticAsset('/blog/robots.txt'), false, 'robots.txt 只在主域名根上（归主站）');
  assert.equal(isStaticAsset('/blog/manifest.json'), true);
  assert.equal(isStaticAsset('/blog/%6Danifest.json'), false);
  assert.equal(isStaticAsset('/curio/manifest.json'), false);
  assert.equal(isStaticAsset('/blog/index.json'), false);
  assert.equal(isStaticAsset('/blog/post/a.b/'), false);
  assert.equal(isStaticAsset('/blog/'), false);
});

for (const site of ['blog', 'daymark', 'curio']) {
  const host = 'styrigx.com';
  const base = 'https://' + host + '/' + site;
  test(site + '：未登录页面 302 到主站锁屏，带 why=no-cookie 和 return，不回源', async () => {
    const e = env();
    const res = await worker.fetch(req(base + '/post/hello/?a=1'), e, CTX);
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('Location'));
    assert.equal(loc.origin, 'https://styrigx.com');
    assert.equal(loc.searchParams.get('lock'), '1');
    assert.equal(loc.searchParams.get('why'), 'no-cookie');
    assert.equal(loc.searchParams.get('return'), base + '/post/hello/?a=1');
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
    assert.match(res.headers.get('Cache-Control'), /no-store/);
    assert.deepEqual(e.seen, []);
  });

  test(site + '：访客、管理员会话都回源，HTML 加 private, no-store，<html> 标上角色', async () => {
    for (const role of ['visitor', 'admin']) {
      const e = env();
      const res = await worker.fetch(req(base + '/', await cookie(role)), e, CTX);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '<html data-sgx-role="' + role + '"><body>page</body></html>');
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
      assert.deepEqual(e.seen, [host + '/' + site + '/']);
    }
  });

  test(site + '：伪造签名、epoch 过低都算无效（why=invalid-session）', async () => {
    const good = await cookie('admin');
    const i = good.length - 10; /* 改签名中间一位（最后一位可能只是补位） */
    const bad = good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
    let res = await worker.fetch(req(base + '/', bad), env(), CTX);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('Location')).searchParams.get('why'), 'invalid-session');
    res = await worker.fetch(req(base + '/', await cookie('admin', 1)), env('2'), CTX);
    assert.equal(res.status, 302);
  });

  test(site + '：静态资源后缀不验会话，原样回源（不打 X-SGX-Runtime，只补 HSTS / nosniff）', async () => {
    const e = env();
    const res = await worker.fetch(req(base + '/pagefind/pagefind.js'), e, CTX);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
    assert.equal(res.headers.get('X-SGX-Runtime'), null);
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(e.seen, [host + '/' + site + '/pagefind/pagefind.js']);
  });

  test(site + '：未登录漏到网关的 /<站>/api/* 回 401 JSON，不 302、不回源', async () => {
    for (const u of [base + '/api/x', base + '/api/links?x=1', base + '/api']) {
      const e = env();
      const res = await worker.fetch(req(u), e, CTX);
      assert.equal(res.status, 401, u);
      assert.match(res.headers.get('Content-Type'), /json/);
      assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
      assert.deepEqual(e.seen, [], u);
    }
  });

  test(site + '：xml / json（全文 RSS、站点地图、索引）没有会话 302 锁屏、不回源；有会话照常回源', async () => {
    for (const p of ['/rss.xml', '/en/rss.xml', '/sitemap.xml', '/sitemap-index.xml', '/index.xml', '/index.json']) {
      const e = env();
      const res = await worker.fetch(req(base + p), e, CTX);
      assert.equal(res.status, 302, p);
      assert.deepEqual(e.seen, [], p);
      const ok = env();
      const r2 = await worker.fetch(req(base + p, await cookie('visitor')), ok, CTX);
      assert.equal(r2.status, 200, p);
      assert.deepEqual(ok.seen, [host + '/' + site + p]);
    }
  });
}

test('绕法：编码 / 大小写 / 多斜杠 / .. / 反斜杠拼出来的子站路径，没有会话一律不回源（不会落到主站的公开后缀白名单）', async () => {
  for (const p of ['/%62log/rss.xml', '/blog%2Frss.xml', '//blog/rss.xml', '/BLOG/rss.xml', '/Blog/Rss.xml', '/css/..%2Fblog/rss.xml',
    '/js/%2e%2e/blog/rss.xml', '/blog%5Crss.xml', '/%63urio/sitemap.xml', '//daymark//sitemap.xml', '/fonts/..%2F..%2Fblog/en/rss.xml',
    '/blog/rss.xml%3F.css', '/blog/rss.xml%23.js', '/css/..%2Fblog/rss.xml%3F.css']) {
    const e = env();
    const res = await worker.fetch(req('https://styrigx.com' + p), e, CTX);
    assert.equal(res.status, 302, p);
    assert.equal(new URL(res.headers.get('Location')).searchParams.get('why'), 'no-cookie', p);
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker', p);
    assert.deepEqual(e.seen, [], p);
  }
});

test('主域名根上的 /api/lock-session-check（子站前端问的）：有效 200 {ok:true}、无效 401 {ok:false}——blog 只对 401 跳锁屏，curio / daymark 只认 401', async () => {
  const c = await cookie('visitor');
  let res = await worker.fetch(req('https://styrigx.com/api/lock-session-check', c), env(), CTX);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  res = await worker.fetch(req('https://styrigx.com/api/lock-session-check'), env(), CTX);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false });
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  /* 前端判断：blog sgx-lock-check.js 只在 204 时「什么都不做」、401 时跳锁屏、其他状态不动；curio / daymark sgx-lock-sync.js 只认 401 */
  const blog = readFileSync(REPO + '/web/blog/assets/js/blog/sgx-lock-check.js', 'utf8');
  assert.match(blog, /if \(r\.status === 401\)/);
  assert.match(blog, /其他状态码：不跳转/);
  for (const s of ['curio', 'daymark']) {
    assert.match(readFileSync(REPO + '/web/' + s + '/assets/js/sgx-lock-sync.js', 'utf8'), /res\.status === 401/);
  }
});

test('旧图志 atlas.styrigx.com：任意路径 301 到 https://styrigx.com 同路径 + 查询串；不验会话、不回源、不解密钥', async () => {
  const cases = [
    ['/blog/', 'https://styrigx.com/blog/'],
    ['/curio/?a=1', 'https://styrigx.com/curio/?a=1'],
    ['/daymark/en/', 'https://styrigx.com/daymark/en/'],
    ['/blog/post/hello/?utm=x&b=2', 'https://styrigx.com/blog/post/hello/?utm=x&b=2'],
    ['/api/lock-session-check', 'https://styrigx.com/api/lock-session-check'],
    ['/api/search?q=a', 'https://styrigx.com/api/search?q=a'],
    ['/blog/rss.xml', 'https://styrigx.com/blog/rss.xml'],
    ['/blog/css/a.css', 'https://styrigx.com/blog/css/a.css'],
    ['/robots.txt', 'https://styrigx.com/robots.txt'],
    ['/', 'https://styrigx.com/'],
    ['/?lock=1', 'https://styrigx.com/?lock=1'],
  ];
  for (const [p, loc] of cases) {
    for (const ck of [null, await cookie('admin')]) {
      const e = env();
      /* 不解密钥：Secrets Store 绑定被读就抛错 */
      e.SGX_LOCK_PUBLIC = { get() { throw new Error('secret read'); } };
      const res = await worker.fetch(req('https://atlas.styrigx.com' + p, ck), e, CTX);
      assert.equal(res.status, 301, p);
      assert.equal(res.headers.get('Location'), loc, p);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
      assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
      assert.equal(res.headers.get('Strict-Transport-Security'), 'max-age=31536000');
      assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
      assert.deepEqual(e.seen, [], p);
    }
  }
  /* POST 也 301（不回源、不进接口） */
  const e = env();
  const res = await worker.fetch(new Request('https://atlas.styrigx.com/api/lock-password', { method: 'POST', body: '{}' }), e, CTX);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://styrigx.com/api/lock-password');
  assert.deepEqual(e.seen, []);
});

test('主站照旧；未登记的子域名照旧 301 回主站', async () => {
  let res = await worker.fetch(req('https://styrigx.com/settings/'), env(), CTX);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('Location'), /^https:\/\/styrigx\.com\/\?lock=1&return=%2Fsettings%2F/);
  res = await worker.fetch(req('https://evil.styrigx.com/'), env(), CTX);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://styrigx.com/');
  /* 书库、旧的 blog / daymark / curio 子域名已下线：当未登记子域名处理（主站关口 301 回首页，不保留路径） */
  for (const h of ['book.styrigx.com', 'blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com']) {
    res = await worker.fetch(req('https://' + h + '/'), env(), CTX);
    assert.equal(res.status, 301, h);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com/');
  }
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

for (const site of ['blog', 'daymark', 'curio']) {
  const host = 'styrigx.com/' + site;
  test(site + '：访客经网关拿到的页面里头像不可点，管理员可点', async () => {
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
