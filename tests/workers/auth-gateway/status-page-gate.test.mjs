/**
 * 聊天 /chat/ 与服务状态 /settings/status/（含 /en/）和其他主站内页一样过网关 gate.js：
 *   没会话 / 坏 cookie → 302 到首页锁屏（?lock=1&return=<原路径>，no-store）；进门会话（任何 by，含临时钥匙）放行（200）。
 *   进门二值（P2-3）：页面只分「要进门 / 公开」，没有按角色的 302。
 *   页面本身只认锁屏进门会话，不问账号会话（没有账号 cookie、没绑 ACCOUNT_VERIFIER 也 200）。
 *   /api/status 本身的会话校验见 tests/workers/auth-gateway/search-api.test.mjs。
 * 运行：node --test tests/workers/auth-gateway/status-page-gate.test.mjs
 * Ed25519 测试密钥在测试内临时生成，不用生产密钥。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as mw } from '../../../workers/auth-gateway/src/gate.js';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, withAuthD1 } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();

function kv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } };
}
const env = () => withAuthD1({ SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB, KV_LOCK_DOOR: kv() });

function ctx(url, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = 'sgx-lock-session=' + cookie;
  return {
    request: new Request(url, { headers }),
    next: async () => new Response('<html lang="zh"><head></head><body>PAGE</body></html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    env: env(),
  };
}

const PAGES = ['/settings/status/', '/en/settings/status/', '/chat/', '/en/chat/'];

test('没会话：/settings/status/、/chat/（中英）302 到首页锁屏，return = 原路径，no-store', async () => {
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

test('进门会话（没有账号会话；锁屏密码 / 锁屏通行密钥 / 临时钥匙进门都一样）：/settings/status/、/chat/（中英）都放行 200，页面上没有 data-sgx-role', async () => {
  for (const by of ['password', 'passkey', 'tempkey']) {
    const cookie = await testLockSession(PRIV, 0, by);
    for (const p of PAGES) {
      const r = await mw(ctx('https://styrigx.com' + p, cookie));
      assert.equal(r.status, 200, by + ' 访问 ' + p + ' 应 200');
      const html = await r.text();
      assert.match(html, /PAGE/);
      assert.doesNotMatch(html, /data-sgx-role|data-sgx-upgrade/, by + ' ' + p);
    }
  }
});

test('旧的顶栏「状态」页 /status/ 已删除：网关不认这个路径，也没有跳转规则', async () => {
  const { readFileSync } = await import('node:fs');
  const red = readFileSync(new URL('../../../web/atlas/static/_redirects', import.meta.url), 'utf8');
  assert.doesNotMatch(red, /^\/(en\/)?status/m);
});
