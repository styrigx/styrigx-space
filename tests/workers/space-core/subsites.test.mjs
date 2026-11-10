/**
 * 网关子站门禁（workers/space-core/src/gate.js，合并 PR3）：主域名 styrigx.com 的 /blog/、/curio/、/daymark/ 前缀
 * - v5 S3 整站放开：页面、RSS、站点地图、index.json 谁都能看；HTML 注入会话状态（valid / locked）+ no-store；不再 302 到锁屏
 * - 编码 / 大小写 / 多斜杠 / .. 绕法都按子站处理（同一套放行，绕不出别的结果）
 * - 静态资源后缀直接回源
 * - /<站>/api/*（漏到网关）访问表默认 entry：没进站 401 JSON，不 302
 * - 根上的 /api/lock-session-check 由主站路由回答（有效 200 {ok:true, by}、无效 401 {ok:false}）
 * - 主站请求不受影响；未登记的域名照旧 301 回主站
 *
 * 运行：node --test tests/workers/space-core/subsites.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const worker = (await import(REPO + '/workers/space-core/src/app.js')).default;
const { isStaticAsset, subsiteOf, siteOf, normPath, stripSessionAttrs } = await import(REPO + '/workers/space-core/src/gate.js');
const { signLockSessionTicket } = await import(REPO + '/workers/space-core/src/core/lock-session.js');

const { priv: PRIV, pub: PUB } = await genKeyPair();

const CTX = { waitUntil() {} };
function env(epoch = '0') {
  const seen = [];
  const d1 = makeAuthD1({ epochs: { 'lock-epoch': Number(epoch) } }); /* 纪元在 D1 */
  return {
    seen,
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_SPACE_PUBLIC: PUB,
    KV_LOCK_DOOR: { async get() { return null; } },
    D1_SPACE: d1,
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

async function cookie(role = 'link', epoch = 0) {
  const v = await testLockSession(PRIV, epoch, role);
  return 'sgx-space-session=' + v;
}

function req(url, cookieHeader) {
  return new Request(url, { headers: cookieHeader ? { Cookie: cookieHeader } : {} });
}

test('子站判断：只认主域名 styrigx.com + 第一段 blog / curio / daymark；旧子域名、书库、别的主机都不算子站', () => {
  for (const u of ['https://styrigx.com/blog/', 'https://styrigx.com/curio/x', 'https://styrigx.com/daymark', 'https://styrigx.com/%62log/rss.xml', 'https://styrigx.com//blog/rss.xml', 'https://styrigx.com/BLOG/']) {
    assert.ok(subsiteOf(new URL(u)), u);
  }
  for (const u of ['https://blog.styrigx.com/', 'https://curio.styrigx.com/curio/', 'https://book.styrigx.com/blog/',
    'https://evil.styrigx.com/blog/', 'https://styrigx.com/', 'https://styrigx.com/blogx/', 'https://styrigx.com/__proto__/', 'https://styrigx.com/zh/blog/']) {
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
  assert.equal(siteOf('/daymark/zh/'), 'daymark');
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
  assert.equal(isStaticAsset('/blog/zh/rss.xml'), false);
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
  test(site + '：访客（没会话）页面 200 回源，<html> 标 locked，private, no-store，不 302', async () => {
    const e = env();
    const res = await worker.fetch(req(base + '/post/hello/?a=1'), e, CTX);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Location'), null);
    assert.equal(await res.text(), '<html data-sgx-lock-session="locked"><body>page</body></html>');
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('X-Robots-Tag'), null);
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker');
    assert.deepEqual(e.seen, [host + '/' + site + '/post/hello/']);
  });

  test(site + '：任何进门方式都回源，<html> 标 valid（进门二值，不标等级），private, no-store', async () => {
    for (const by of ['link', 'password', 'passkey']) {
      const e = env();
      const res = await worker.fetch(req(base + '/', await cookie(by)), e, CTX);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '<html data-sgx-lock-session="valid"><body>page</body></html>');
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
      assert.deepEqual(e.seen, [host + '/' + site + '/']);
    }
  });

  test(site + '：伪造签名、epoch 过低都算没进站（页面照给、标 locked）', async () => {
    const good = await cookie('password');
    const i = good.length - 10; /* 改签名中间一位（最后一位可能只是补位） */
    const bad = good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
    let res = await worker.fetch(req(base + '/', bad), env(), CTX);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /data-sgx-lock-session="locked"/);
    res = await worker.fetch(req(base + '/', await cookie('password', 1)), env('2'), CTX);
    assert.match(await res.text(), /data-sgx-lock-session="locked"/);
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

  test(site + '：xml / json（全文 RSS、站点地图、索引）公开：没会话也回源', async () => {
    for (const p of ['/rss.xml', '/zh/rss.xml', '/sitemap.xml', '/sitemap-index.xml', '/index.xml', '/index.json']) {
      const e = env();
      const res = await worker.fetch(req(base + p), e, CTX);
      assert.equal(res.status, 200, p);
      assert.deepEqual(e.seen, [host + '/' + site + p], p);
    }
  });
}

test('绕法：编码 / 大小写 / 多斜杠 / .. 拼出来的子站接口路径，没有会话一律 401（不回源）；页面路径照常公开', async () => {
  for (const p of ['/%62log/api/x', '/BLOG/api/x', '//curio//api/links', '/css/..%2Fcurio/api/music-stream?t=x', '/%63urio/API/music', '/daymark%2Fapi/quotes']) {
    const e = env();
    const res = await worker.fetch(req('https://styrigx.com' + p), e, CTX);
    assert.equal(res.status, 401, p);
    assert.equal(res.headers.get('X-SGX-Runtime'), 'worker', p);
    assert.deepEqual(e.seen, [], p);
  }
  for (const p of ['/%62log/rss.xml', '//blog/rss.xml', '/BLOG/rss.xml', '/%63urio/sitemap.xml']) {
    const res = await worker.fetch(req('https://styrigx.com' + p), env(), CTX);
    assert.equal(res.status, 200, p);
  }
});

test('主域名根上的 /api/lock-session-check（子站前端问的）：有效 200 {ok:true, by}、无效 401 {ok:false}', async () => {
  const c = await cookie('link');
  let res = await worker.fetch(req('https://styrigx.com/api/lock-session-check', c), env(), CTX);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.by, 'link');
  res = await worker.fetch(req('https://styrigx.com/api/lock-session-check'), env(), CTX);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false });
  assert.match(res.headers.get('Cache-Control'), /no-store/);
});

test('主站照旧；未登记的子域名照旧 301 回主站', async () => {
  let res = await worker.fetch(req('https://styrigx.com/display/'), env(), CTX);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Location'), null);
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

/* 子站页面源码里混进旧会话标记（等级 / 升级验证）时，网关先清掉；P2-3 起不分进门方式，抽屉头像都能点进账号页。 */
const DRAWER = '<html lang="zh-CN" data-sgx-' + 'role="x" data-sgx-upgrade="1"><body>' // old-name guard（伪造的旧标记要被剥掉）
  + '<div class="sgx-drawer-head"><span class="sgx-drawer-brand">S</span>'
  + '<a class="sgx-drawer-me" href="https://styrigx.com/account/" aria-label="账号">'
  + '<img src="https://styrigx.com/avatar/192.webp" alt="" width="52" height="52" class="sgx-tb-avatar"></a></div>'
  + '<a class="sgx-drawer-item" href="https://styrigx.com/">主站</a></body></html>';

test('子站页面：页面源码里混进的旧会话标记（等级 / 升级验证）先清掉；抽屉头像原样（进门的人都能点进账号页）', () => {
  const out = stripSessionAttrs(DRAWER);
  assert.match(out, /^<html lang="zh-CN"><body>/);
  assert.match(out, /<a class="sgx-drawer-me" href="https:\/\/styrigx.com\/account\/" aria-label="账号">/);
});

for (const site of ['blog', 'daymark', 'curio']) {
  const host = 'styrigx.com/' + site;
  test(site + '：分享链接进门、锁屏密码进门拿到的页面一样，头像都可点、没有旧会话标记', async () => {
    const page = (e) => { e.ASSETS.fetch = async () => new Response(DRAWER, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); return e; };
    const a = await (await worker.fetch(req('https://' + host + '/', await cookie('link')), page(env()), CTX)).text();
    const b = await (await worker.fetch(req('https://' + host + '/', await cookie('password')), page(env()), CTX)).text();
    assert.equal(a, b);
    assert.match(a, /<a class="sgx-drawer-me" href="https:\/\/styrigx.com\/account\/"/);
    assert.doesNotMatch(a, /data-sgx-(?:role|upgrade)/);
  });
}
