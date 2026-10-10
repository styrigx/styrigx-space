/**
 * 2.4.1 前端会话修复测试（node --test）。
 *
 * 覆盖：
 * - lock.js 不再读写 sessionStorage 的 'sgx-lock-shown'（grep 断言）
 * - lock.js 页面加载先 fetch('/api/session-check', { credentials: 'include' })
 * - page-security.js 的「立即锁定」调 POST /api/lock，不再清 sessionStorage
 * - sgx-account-card.html 不再读 sessionStorage，改听 sgx:session 事件
 * - /api/lock：POST 下发两条 Set-Cookie 清除头（带 Domain + 不带 Domain）
 *
 * 运行：node --test tests/unit/frontend-session.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { onRequestPost as lockPost, onRequestGet as lockGet } from '../../functions/api/lock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const lockJs = readFileSync(join(root, 'assets/js/sgx/lock.js'), 'utf8');
const secJs = readFileSync(join(root, 'assets/js/sgx/page-security.js'), 'utf8');
const cardHtml = readFileSync(join(root, 'layouts/partials/sgx-account-card.html'), 'utf8');

test('lock.js：不再读写 sgx-lock-shown', () => {
  assert.ok(!lockJs.includes('sgx-lock-shown'), 'lock.js 不应再出现 sgx-lock-shown');
  assert.ok(!lockJs.includes("sessionStorage.getItem('sgx-lock-shown')"), '不应再读 sessionStorage');
  assert.ok(!lockJs.includes("sessionStorage.setItem('sgx-lock-shown'"), '不应再写 sessionStorage');
});

test('lock.js：页面加载先 fetch session-check（credentials include）', () => {
  assert.ok(lockJs.includes("fetch('/api/session-check'"), '应 fetch /api/session-check');
  assert.ok(lockJs.includes("credentials: 'include'"), '应带 credentials: include');
});

test('lock.js：中性加载态（不闪桌面/锁屏）', () => {
  assert.ok(lockJs.includes('sgx-lock-loading'), '应有中性加载态元素');
  assert.ok(lockJs.includes('showNeutralLoading'), '应有 showNeutralLoading');
});

test('lock.js：会话有效时分发 sgx:session 事件', () => {
  assert.ok(lockJs.includes("CustomEvent('sgx:session'"), '应分发 sgx:session 事件');
});

test('page-security.js：立即锁定调 POST /api/lock', () => {
  assert.ok(!secJs.includes('sgx-lock-shown'), '不应再出现 sgx-lock-shown');
  assert.ok(secJs.includes("fetch('/api/lock'"), '应 fetch /api/lock');
  assert.ok(secJs.includes("method: 'POST'"), '应用 POST');
});

test('sgx-account-card.html：改听 sgx:session 事件', () => {
  assert.ok(!cardHtml.includes('sgx-lock-shown'), '不应再出现 sgx-lock-shown');
  assert.ok(cardHtml.includes('sgx:session'), '应监听 sgx:session 事件');
});

test('/api/lock：POST 下发两条 Set-Cookie 清除头', async () => {
  const res = await lockPost({ request: new Request('https://styrigx.com/api/lock', { method: 'POST' }), env: {} });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  // Headers.getSetCookie() 在 Node 18+ 可用
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')];
  assert.equal(cookies.length, 2, '应下发两条 Set-Cookie');
  const withDomain = cookies.find((c) => c.includes('Domain=.styrigx.com'));
  const hostOnly = cookies.find((c) => !c.includes('Domain='));
  assert.ok(withDomain, '应有一条带 Domain=.styrigx.com');
  assert.ok(hostOnly, '应有一条不带 Domain（清 host-only）');
  assert.ok(withDomain.includes('Max-Age=0'), '带 Domain 的应 Max-Age=0');
  assert.ok(hostOnly.includes('Max-Age=0'), '不带 Domain 的应 Max-Age=0');
  assert.ok(cookies.every((c) => c.startsWith('sgx-verified=;')), '都应是 sgx-verified 清除');
});

test('/api/lock：GET 返回 405', async () => {
  const res = await lockGet({ request: new Request('https://styrigx.com/api/lock'), env: {} });
  assert.equal(res.status, 405);
});
