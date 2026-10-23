/**
 * 网关子站门禁（workers/auth-gateway/src/subsites.js）：
 * - blog/book 页面：会话有效回源（HTML 加 no-store），无效 302 主站锁屏（带 why 和 return）
 * - /api/session-check：blog 认 204、book 认 200 {ok:true}，无效 401
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const worker = (await import(REPO + '/workers/auth-gateway/src/index.js')).default;
const { isStaticAsset, subsiteFor } = await import(REPO + '/workers/auth-gateway/src/subsites.js');
const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
const PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');

const CTX = { waitUntil() {} };
function env(epoch = '0') {
  const seen = [];
  return {
    seen,
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB,
    KV_LOCK_DOOR: { async get(k) { return k === 'session-epoch' ? epoch : null; } },
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
  const v = await signSessionCookie(PRIV, epoch, role, 'owner');
  return 'sgx-verified=' + v;
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

  test(host + '：访客、主人会话都回源，HTML 加 private, no-store', async () => {
    for (const role of ['visitor', 'owner']) {
      const e = env();
      const res = await worker.fetch(req('https://' + host + '/', await cookie(role)), e, CTX);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '<html><body>page</body></html>');
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
      assert.deepEqual(e.seen, [host + '/']);
    }
  });

  test(host + '：伪造签名、epoch 过低都算无效（why=invalid-session）', async () => {
    const good = await cookie('owner');
    const i = good.length - 10; /* 改签名中间一位（最后一位可能只是补位） */
    const bad = good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
    let res = await worker.fetch(req('https://' + host + '/', bad), env(), CTX);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('Location')).searchParams.get('why'), 'invalid-session');
    res = await worker.fetch(req('https://' + host + '/', await cookie('owner', 1)), env('2'), CTX);
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
  let res = await worker.fetch(req('https://blog.styrigx.com/api/session-check', c), env(), CTX);
  assert.equal(res.status, 204);
  for (const host of ['daymark.styrigx.com', 'curio.styrigx.com']) {
    res = await worker.fetch(req('https://' + host + '/api/session-check', c), env(), CTX);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }
  for (const host of ['blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com']) {
    res = await worker.fetch(req('https://' + host + '/api/session-check'), env(), CTX);
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
