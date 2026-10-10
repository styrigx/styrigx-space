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

test('lock.js：initLock 读 data-sgx-session（L1 注入，不自己 fetch 做初始判断）', () => {
  assert.ok(lockJs.includes('dataset.sgxSession'), '应读 document.documentElement.dataset.sgxSession');
  /* initLock 不应 fetch session-check（unlock 后的防循环确认保留，那是另一处） */
  const initLockSrc = lockJs.slice(lockJs.indexOf('export function initLock()'), lockJs.indexOf('function showLockScreen()'));
  assert.ok(!initLockSrc.includes("fetch('/api/session-check'"), 'initLock 不应 fetch session-check');
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

test('lock.js：有 return 时直接 location.replace（不做前端白名单校验）', () => {
  /* 2.4.1：return 校验只归 L1，前端删掉重复的白名单校验 */
  assert.ok(lockJs.includes('location.replace('), '有 return 时应 location.replace');
  assert.ok(!lockJs.includes('retOk'), '不应再有前端 return 白名单校验（retOk）');
  assert.ok(!lockJs.includes("ret.charAt(0) === '/'"), '不应再有前端站内路径校验');
});

test('lock.js：锁屏显示期间监听 visibilitychange/focus/pageshow 重查会话', () => {
  assert.ok(lockJs.includes("addEventListener('visibilitychange'"), '应监听 visibilitychange');
  assert.ok(lockJs.includes("addEventListener('focus'"), '应监听 focus');
  assert.ok(lockJs.includes("addEventListener('pageshow'"), '应监听 pageshow');
  assert.ok(lockJs.includes('recheckSession'), '应有 recheckSession 函数');
  /* 节流至少 1 秒 */
  assert.ok(lockJs.includes('lastRecheck'), '应有节流时间戳');
});

test('lock.js：不用前端存储传递解锁状态', () => {
  /* 状态源只有服务端 sgx-verified */
  assert.ok(!lockJs.includes('BroadcastChannel'), '不应使用 BroadcastChannel');
  /* sessionStorage 只允许读偏好（sgx-weather-show 等），不允许存解锁状态 */
  assert.ok(!lockJs.includes('sgx-unlocked'), '不应有解锁状态标记');
  assert.ok(!lockJs.includes('sgx-session-ok'), '不应有解锁状态标记');
});
