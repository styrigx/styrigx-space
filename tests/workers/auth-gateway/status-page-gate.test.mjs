/**
 * 聊天 /chat/ 与服务状态 /account/status/（含 /en/）和其他主站内页一样过网关 _middleware：
 *   没会话 / 坏 cookie → 302 到首页锁屏（?lock=1&return=<原路径>，no-store）；admin 会话放行（200）；
 *   visitor：聊天放行，服务状态 2026-10-24 PR4 起在账号区里（原顶栏「状态」页 /status/ 删除）→ 和其他账号子页一样 302 回首页。
 *   /api/status 本身的会话校验见 tests/workers/auth-gateway/search-api.test.mjs。
 * 运行：node --test tests/workers/auth-gateway/status-page-gate.test.mjs
 * Ed25519 测试密钥在测试内临时生成，不用生产密钥。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signLockSessionTicket } from '../../../workers/auth-gateway/functions/_kernel/lock-session.js';
import { onRequest as mw } from '../../../workers/auth-gateway/functions/_middleware.js';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();

function kv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } };
}
const env = () => ({ SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB, KV_LOCK_DOOR: kv() });

function ctx(url, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = 'sgx-lock-session=' + cookie;
  return {
    request: new Request(url, { headers }),
    next: async () => new Response('<html lang="zh"><head></head><body>PAGE</body></html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    env: env(),
  };
}

const PAGES = ['/account/status/', '/en/account/status/', '/chat/', '/en/chat/'];
const ACCOUNT = (p) => p.includes('/account/');

test('没会话：/account/status/、/chat/（中英）302 到首页锁屏，return = 原路径，no-store', async () => {
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

test('admin 会话：/account/status/、/chat/（中英）都放行 200；visitor：聊天 200，服务状态（账号区）302 回首页', async () => {
  for (const role of ['admin', 'visitor']) {
    const cookie = role === 'admin' ? await testLockSession(PRIV, 0, 'admin') : await testLockSession(PRIV, 0, 'visitor');
    for (const p of PAGES) {
      const r = await mw(ctx('https://styrigx.com' + p, cookie));
      if (role === 'visitor' && ACCOUNT(p)) {
        assert.equal(r.status, 302, 'visitor 访问 ' + p + ' 应 302');
        assert.equal(r.headers.get('Location'), 'https://styrigx.com' + (p.startsWith('/en/') ? '/en/' : '/'));
        continue;
      }
      assert.equal(r.status, 200, role + ' 访问 ' + p + ' 应 200');
      assert.match(await r.text(), /PAGE/);
    }
  }
});

test('旧的顶栏「状态」页 /status/ 已删除：网关不认这个路径，也没有跳转规则', async () => {
  const { readFileSync } = await import('node:fs');
  const red = readFileSync(new URL('../../../web/static/_redirects', import.meta.url), 'utf8');
  assert.doesNotMatch(red, /^\/(en\/)?status/m);
});
