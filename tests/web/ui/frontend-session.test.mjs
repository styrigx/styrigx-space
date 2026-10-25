/**
 * 2.4.1 前端会话修复测试（node --test）。
 *
 * 覆盖：
 * - lock.js 不再读写 sessionStorage 的 'sgx-lock-shown'（grep 断言）
 * - lock.js 页面加载先 fetch('/api/lock-session-check', { credentials: 'include' })
 * - page-security.js 的「立即锁定」调 POST /api/lock-now，不再清 sessionStorage
 * - sgx-account-card.html 不再读 sessionStorage，改听 sgx:session 事件
 * - /api/lock-now：POST 下发两条 Set-Cookie 清除头（带 Domain + 不带 Domain）
 *
 * 运行：node --test tests/ui/frontend-session.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { onRequestPost as lockPost, onRequestGet as lockGet } from '../../../workers/auth-gateway/functions/api/lock-now.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const lockJs = readFileSync(join(root, 'web/assets/js/shell/lock.js'), 'utf8');
const secJs = readFileSync(join(root, 'web/assets/js/apps/security.js'), 'utf8');
const cardHtml = readFileSync(join(root, 'web/layouts/partials/sgx-account-card.html'), 'utf8');

test('lock.js：不再读写 sgx-lock-shown', () => {
  assert.ok(!lockJs.includes('sgx-lock-shown'), 'lock.js 不应再出现 sgx-lock-shown');
  assert.ok(!lockJs.includes("sessionStorage.getItem('sgx-lock-shown')"), '不应再读 sessionStorage');
  assert.ok(!lockJs.includes("sessionStorage.setItem('sgx-lock-shown'"), '不应再写 sessionStorage');
});

test('lock.js：initLock 读 data-sgx-lock-session（L1 注入，不自己 fetch 做初始判断）', () => {
  assert.ok(lockJs.includes('dataset.sgxLockSession'), '应读 document.documentElement.dataset.sgxLockSession');
  /* initLock 不应 fetch session-check（unlock 后的防循环确认保留，那是另一处） */
  const initLockSrc = lockJs.slice(lockJs.indexOf('export function initLock()'), lockJs.indexOf('function showLockScreen()'));
  assert.ok(!initLockSrc.includes("fetch('/api/lock-session-check'"), 'initLock 不应 fetch session-check');
});

test('lock.js：会话有效时分发 sgx:session 事件', () => {
  assert.ok(lockJs.includes("CustomEvent('sgx:session'"), '应分发 sgx:session 事件');
});

test('page-security.js：立即锁定调 POST /api/lock-now（确认层与请求在 lib/lock-now.js，安全页和快捷面板共用）', () => {
  const lockNowJs = readFileSync(join(root, 'web/assets/js/lib/lock-now.js'), 'utf8');
  assert.ok(!secJs.includes('sgx-lock-shown'), '不应再出现 sgx-lock-shown');
  assert.ok(secJs.includes("from '../lib/lock-now.js'") && secJs.includes('confirmLockNow()'), '安全页应调用共用的 confirmLockNow');
  assert.ok(!lockNowJs.includes('sgx-lock-shown'), '不应再出现 sgx-lock-shown');
  assert.ok(lockNowJs.includes("fetch('/api/lock-now'"), '应 fetch /api/lock-now');
  assert.ok(lockNowJs.includes("method: 'POST'"), '应用 POST');
});

test('sgx-account-card.html：只保留名字和头像（解锁入口已移走）；只在账号页使用，设置页不再放', () => {
  assert.ok(!cardHtml.includes('sgx-lock-shown'), '不应再出现 sgx-lock-shown');
  assert.ok(!cardHtml.includes('sgx-unlock-link'), '孤立的解锁入口应已删掉');
  assert.ok(!cardHtml.includes('sgx:session'), '账户卡不再监听会话事件');
  assert.ok(cardHtml.includes('sgx-account-card'), '账户卡主体保留');
  const setHtml = readFileSync(join(root, 'web/layouts/_default/settings.html'), 'utf8');
  const acctHtml = readFileSync(join(root, 'web/layouts/_default/account.html'), 'utf8');
  assert.ok(!setHtml.includes('sgx-account-card'), '设置页不再放账号卡');
  assert.ok(acctHtml.includes('partial "sgx-account-card.html"'), '账号页总览放账号卡');
  const setEntry = readFileSync(join(root, 'web/assets/js/entries/entry-settings.js'), 'utf8');
  const acctEntry = readFileSync(join(root, 'web/assets/js/entries/entry-account.js'), 'utf8');
  assert.ok(!setEntry.includes('initAvatarEdit'), '设置页入口不再加载换头像');
  assert.ok(acctEntry.includes('initAvatarEdit()'), '账号页入口加载换头像');
});

test('security.html：安全分组两个入口（锁屏凭证/立即锁定）；没有管理凭证、应用凭证；账号在顶栏头像', () => {
  const secHtml = readFileSync('web/layouts/_default/security.html', 'utf8');
  assert.ok(!secHtml.includes('id="sec-owner-cred"'), '管理员凭证入口已移到顶栏头像（账号页）');
  assert.ok(!secHtml.includes('id="sec-mgmt-cred"'), '管理凭证已删除');
  assert.ok(!secHtml.includes('管理凭证'), '不应再出现「管理凭证」');
  assert.ok(secHtml.includes('id="sec-lock-cred"'), '应有锁屏凭证入口');
  assert.ok(secHtml.includes('锁屏凭证'), '中文标题');
  assert.ok(secHtml.includes('id="sec-locknow"'), '应有立即锁定入口');
  assert.ok(!secHtml.includes('id="sec-app-row"'), '不应有应用验证');
  const base = readFileSync('web/layouts/_default/baseof.html', 'utf8');
  assert.ok(base.includes('<a class="sgx-drawer-me" href="{{ $acctUrl }}"'), '抽屉头的头像链到账号页');
});

test('security.js：读锁屏凭证状态，不再走 stepup；无角色条件渲染', () => {
  const js = readFileSync('web/assets/js/apps/security.js', 'utf8');
  assert.ok(!/stepup/i.test(js), '不应再有 stepup');
  assert.ok(js.includes("'/api/lock-credentials'"), '状态卡片读 /api/lock-credentials');
  assert.ok(js.includes("getElementById('sec-locknow')"), '应操作立即锁定入口');
  assert.ok(!js.includes("role === 'visitor'"), '不应有访客角色条件分支');
});

test('/api/lock-now：POST 下发 Set-Cookie 清除头（锁屏会话 + LockReauthTicket）', async () => {
  const res = await lockPost({ request: new Request('https://styrigx.com/api/lock-now', { method: 'POST' }), env: {} });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')];
  assert.equal(cookies.length, 2, '应下发两条 Set-Cookie（锁屏会话 + LockReauthTicket）');
  const sess = cookies.filter((c) => c.startsWith('sgx-lock-session=;'));
  assert.equal(sess.length, 1, '应有一条 sgx-lock-session 清除');
  assert.ok(sess[0].includes('Domain=.styrigx.com') && sess[0].includes('Max-Age=0'), '锁屏会话清除带 Domain=.styrigx.com');
  assert.ok(cookies.some((c) => c.startsWith('sgx-lock-reauth=;') && c.includes('Max-Age=0')), '应清除 LockReauthTicket');
  assert.ok(!cookies.some((c) => c.startsWith('sgx-door=') || c.startsWith('sgx-tk=') || c.startsWith('sgx-verified=')), '不再有旧 cookie');
  assert.ok(!cookies.some((c) => c.startsWith('sgx-stepup=') || c.startsWith('sgx-app=')), '不再有 stepup / app cookie');
});

test('/api/lock-now：GET 返回 405', async () => {
  const res = await lockGet({ request: new Request('https://styrigx.com/api/lock-now'), env: {} });
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
  /* pageshow 只在 bfcache 恢复时重查，避免 reload 循环 */
  assert.ok(lockJs.includes('persisted'), 'pageshow 应检查 persisted');
});

test('lock.js：不用前端存储传递解锁状态', () => {
  /* 状态源只有服务端 sgx-verified */
  assert.ok(!lockJs.includes('BroadcastChannel'), '不应使用 BroadcastChannel');
  /* sessionStorage 只允许读偏好（sgx-weather-show 等），不允许存解锁状态 */
  assert.ok(!lockJs.includes('sgx-unlocked'), '不应有解锁状态标记');
  assert.ok(!lockJs.includes('sgx-session-ok'), '不应有解锁状态标记');
});
