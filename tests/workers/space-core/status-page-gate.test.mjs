/**
 * 聊天 /chat/ 与服务状态 /status/（含 /zh/）和其他主站内页一样过网关 gate.js：
 *   v5 S3 整站放开：没会话 / 坏 cookie 也 200（页面标 locked，no-store，不 302）；进门会话（任何 by，含分享链接）200 标 valid。
 *   监控数据 /api/status 仍要进站：没会话 401。
 *   页面本身只认进站会话，不问账号会话（没有账号 cookie、没绑 ACCOUNT_VERIFIER 也 200）。
 *   /api/status 本身的会话校验见 tests/workers/space-core/search-api.test.mjs。
 * 运行：node --test tests/workers/space-core/status-page-gate.test.mjs
 * Ed25519 测试密钥在测试内临时生成，不用生产密钥。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as mw } from '../../../workers/space-core/src/gate.js';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, withAuthD1 } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();

function kv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } };
}
const env = () => withAuthD1({ SGX_ENV: 'production', SGX_SITE: 'space', SGX_SPACE_PUBLIC: PUB, KV_LOCK_DOOR: kv() });

function ctx(url, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = 'sgx-space-session=' + cookie;
  return {
    request: new Request(url, { headers }),
    next: async () => new Response('<html lang="zh"><head></head><body>PAGE</body></html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    env: env(),
  };
}

/* 对齐 PR-B：服务状态并进旷野 /wild/#status；/status/ 留着验证旧地址照样先过网关（之后由 Pages _redirects 301） */
const PAGES = ['/status/', '/zh/status/', '/wild/', '/zh/wild/', '/chat/', '/zh/chat/'];

test('没会话：/wild/、/status/、/chat/（中英）200 页面标 locked、no-store，不 302；/api/status 401', async () => {
  for (const p of PAGES) {
    for (const cookie of ['', 'garbage.1.2']) {
      const r = await mw(ctx('https://styrigx.com' + p + '?x=1', cookie));
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('Location'), null, p);
      assert.match(await r.text(), /<html data-sgx-lock-session="locked" lang="zh">.*PAGE/, p);
      assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
    }
  }
  for (const cookie of ['', 'garbage.1.2']) assert.equal((await mw(ctx('https://styrigx.com/api/status', cookie))).status, 401);
});

test('进门会话（没有账号会话；锁屏密码 / 锁屏通行密钥 / 分享链接进门都一样）：/status/、/chat/（中英）都放行 200，页面上没有等级标记', async () => {
  for (const by of ['password', 'passkey', 'link']) {
    const cookie = await testLockSession(PRIV, 0, by);
    for (const p of PAGES) {
      const r = await mw(ctx('https://styrigx.com' + p, cookie));
      assert.equal(r.status, 200, by + ' 访问 ' + p + ' 应 200');
      const html = await r.text();
      assert.match(html, /PAGE/);
      assert.doesNotMatch(html, /data-sgx-role|data-sgx-upgrade/, by + ' ' + p); // old-name guard
    }
  }
});

test('旧的「状态」页 /status/（含 /zh/）并进旷野：_redirects 301 到 /wild/#status（对齐 PR-B），没有 /en/ 规则', async () => {
  const { readFileSync } = await import('node:fs');
  const red = readFileSync(new URL('../../../space/web/static/_redirects', import.meta.url), 'utf8');
  assert.match(red, /^\/status\/\s+\/wild\/#status\s+301$/m);
  assert.match(red, /^\/zh\/status\/\s+\/zh\/wild\/#status\s+301$/m);
  assert.doesNotMatch(red, /^\/en\/status/m);
  assert.equal((red.match(/^\/(?:zh\/)?status/gm) || []).length, 2, '只有这两条');
});
