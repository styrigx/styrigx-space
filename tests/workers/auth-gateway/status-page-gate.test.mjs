/**
 * 主站顶栏三栏的两页（2026-10-22 PR2）：状态 /status/、聊天 /chat/（含 /en/）和其他主站内页一样过网关 _middleware：
 *   没会话 / 坏 cookie → 302 到首页锁屏（?lock=1&return=<原路径>，no-store）；owner、visitor 会话都放行（200）。
 *   /api/status 本身的会话校验见 tests/workers/auth-gateway/search-api.test.mjs。
 * 运行：node --test tests/workers/auth-gateway/status-page-gate.test.mjs
 * Ed25519 测试密钥在测试内临时生成，不用生产密钥。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSessionCookie } from '../../../workers/auth-gateway/functions/_kernel/session.js';
import { onRequest as mw } from '../../../workers/auth-gateway/functions/_middleware.js';

function derToPem(der, label) {
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
const PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');

function kv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } };
}
const env = () => ({ SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB, KV_LOCK_DOOR: kv() });

function ctx(url, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = 'sgx-verified=' + cookie;
  return {
    request: new Request(url, { headers }),
    next: async () => new Response('<html lang="zh"><head></head><body>PAGE</body></html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    env: env(),
  };
}

const PAGES = ['/status/', '/en/status/', '/chat/', '/en/chat/'];

test('没会话：/status/、/chat/（中英）302 到首页锁屏，return = 原路径，no-store', async () => {
  for (const p of PAGES) {
    for (const cookie of ['', 'garbage.1.2']) {
      const r = await mw(ctx('https://styrigx.com' + p + '?x=1', cookie));
      assert.equal(r.status, 302, p + ' 应 302');
      const loc = r.headers.get('Location') || '';
      assert.ok(loc.startsWith('https://styrigx.com/?lock=1&return='), loc);
      assert.equal(decodeURIComponent(loc.slice(loc.indexOf('return=') + 7)), p + '?x=1');
      assert.equal(r.headers.get('Cache-Control'), 'no-store');
    }
  }
});

test('owner / visitor 会话：/status/、/chat/（中英）都放行 200', async () => {
  for (const role of ['owner', 'visitor']) {
    const cookie = role === 'owner' ? await signSessionCookie(PRIV, 0, 'owner') : await signSessionCookie(PRIV, 0, 'visitor', 'owner');
    for (const p of PAGES) {
      const r = await mw(ctx('https://styrigx.com' + p, cookie));
      assert.equal(r.status, 200, role + ' 访问 ' + p + ' 应 200');
      assert.match(await r.text(), /PAGE/);
    }
  }
});
