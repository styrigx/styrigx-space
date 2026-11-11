/**
 * 聊天 /chat/ 与服务状态 /status/（含 /zh/）和其他主站内页一样过网关 gate.js：
 *   v5 S3 整站放开：没会话 / 坏 cookie 也 200（页面标 locked，no-store，不 302）；v6 会话 200 标 valid（v6 P4 起旧进站会话不认）。
 *   监控数据 /api/status 仍要进站：没会话 401。
 *   /api/status 本身的会话校验见 tests/workers/space-core/search-api.test.mjs。
 * 运行：node --test tests/workers/space-core/status-page-gate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as mw } from '../../../workers/space-core/src/gate.js';
import '../account/_cf-workers.mjs';
import { withAuthD1 } from '../_harness.mjs';
import { admitFor } from '../_v6admit.mjs';

function kv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } };
}
const env = () => withAuthD1({ SGX_ENV: 'production', SGX_SITE: 'space', KV_LOCK_DOOR: kv(),
  ACCOUNT_VERIFIER: { async admit(c, m, p, o) { return admitFor(c, m, p, o); } } });

function ctx(url, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  return {
    request: new Request(url, { headers }),
    next: async () => new Response('<html lang="zh"><head></head><body>PAGE</body></html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    env: env(),
  };
}

/* 2026-11-12：状态单独成页 /status/；旷野 /wild/ 留着验证旧地址照样先过网关（之后由 Pages _redirects 301 到 /status/） */
const PAGES = ['/status/', '/zh/status/', '/wild/', '/zh/wild/', '/chat/', '/zh/chat/'];

test('没会话：/wild/、/status/、/chat/（中英）200 页面标 locked、no-store，不 302；/api/status 401', async () => {
  for (const p of PAGES) {
    for (const cookie of ['', 'sgx-session=garbage', 'sgx-space-session=password.0.9999999999999.']) {
      const r = await mw(ctx('https://styrigx.com' + p + '?x=1', cookie));
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('Location'), null, p);
      assert.match(await r.text(), /<html data-sgx-lock-session="locked" lang="zh">.*PAGE/, p);
      assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
    }
  }
  for (const cookie of ['', 'sgx-session=garbage', 'sgx-space-session=password.0.9999999999999.']) assert.equal((await mw(ctx('https://styrigx.com/api/status', cookie))).status, 401);
});

test('v6 会话（v6 P4 起只认它）：/status/、/chat/（中英）都放行 200、页面标 valid，页面上没有等级标记', async () => {
  for (const who of ['styrigx', 'root', 'alice']) {
    for (const p of PAGES) {
      const r = await mw(ctx('https://styrigx.com' + p, 'sgx-session=' + who));
      assert.equal(r.status, 200, who + ' 访问 ' + p + ' 应 200');
      const html = await r.text();
      assert.match(html, /data-sgx-lock-session="valid"[^>]*>.*PAGE/, who + ' ' + p);
      assert.doesNotMatch(html, /data-sgx-role|data-sgx-upgrade/, who + ' ' + p); // old-name guard
    }
  }
});

test('旷野删除（2026-11-12）：_redirects 把 /wild/（含 /zh/）301 到状态页 /status/；/status/ 不再是跳转来源；没有 /en/ 规则', async () => {
  const { readFileSync } = await import('node:fs');
  const red = readFileSync(new URL('../../../space/web/static/_redirects', import.meta.url), 'utf8');
  assert.match(red, /^\/wild\/\s+\/status\/\s+301$/m);
  assert.match(red, /^\/zh\/wild\/\s+\/zh\/status\/\s+301$/m);
  assert.doesNotMatch(red, /^\/en\/(status|wild)/m);
  assert.equal((red.match(/^\/(?:zh\/)?(?:status|wild)/gm) || []).length, 2, '只有这两条');
  assert.doesNotMatch(red, /#status/, '没有指向旧锚点的跳转');
});
