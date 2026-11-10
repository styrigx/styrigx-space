/**
 * 2.4.1 前端会话修复测试（node --test）。
 *
 * 覆盖：
 * - 锁屏（进站 v3 L1：守卫 shell/space/guard.js + 界面 shell/space/entry.js）不再读写 sessionStorage 的 'sgx-lock-shown'（grep 断言）
 * - 守卫读网关注入的 data-sgx-lock-session，不自己 fetch 做初始判断
 * - 立即锁屏（shell/space/lock-now.js，盾牌 / lock 命令共用）调 POST /api/lock-now，不确认、不清 sessionStorage
 * - sgx-account-card.html 随账号页删除（2026-11-08）
 * - /api/lock-now：POST 下发两条 Set-Cookie 清除头（带 Domain + 不带 Domain）
 *
 * 运行：node --test tests/ui/frontend-session.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { onRequestPost as lockPost, onRequestGet as lockGet } from '../../../../workers/space-core/src/api/lock-now.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
/* 2026-10-26（frontend-js #6）：锁屏拆成守卫（core 里）+ 界面（按需加载）；v5 S5 起是守卫 shell/space/guard.js + 终端里的钥匙层 shell/space/layer.js / unlock.js，合起来查 */
const SP = join(root, 'space/web/assets/js/shell/space');
const lockJs = readFileSync(join(SP, 'guard.js'), 'utf8') + '\n' + readFileSync(join(SP, 'layer.js'), 'utf8') + '\n' + readFileSync(join(SP, 'unlock.js'), 'utf8');

test('lock.js：不再读写 sgx-lock-shown', () => {
  assert.ok(!lockJs.includes('sgx-lock-shown'), 'lock.js 不应再出现 sgx-lock-shown');
  assert.ok(!lockJs.includes("sessionStorage.getItem('sgx-lock-shown')"), '不应再读 sessionStorage');
  assert.ok(!lockJs.includes("sessionStorage.setItem('sgx-lock-shown'"), '不应再写 sessionStorage');
});

test('lock.js：initLock 读 data-sgx-lock-session（L1 注入，不自己 fetch 做初始判断）', () => {
  assert.ok(lockJs.includes('dataset.sgxLockSession'), '应读 document.documentElement.dataset.sgxLockSession');
  /* initLock 不应 fetch session-check（unlock 后的防循环确认保留，那是另一处） */
  const initLockSrc = lockJs.slice(lockJs.indexOf('export function initLock()'), lockJs.indexOf('function showEntryCover()'));
  assert.ok(initLockSrc.length > 100, '找到 initLock');
  assert.ok(!initLockSrc.includes("fetch('/api/lock-session-check'"), 'initLock 不应 fetch session-check');
});

test('lock.js：会话有效时分发 sgx:session 事件', () => {
  assert.ok(lockJs.includes("CustomEvent('sgx:session'"), '应分发 sgx:session 事件');
});

test('立即锁屏（shell/space/lock-now.js）：只锁本机、不验证、没有确认层；调 api.session.end → POST /api/lock-now；锁所有设备是 /api/lock-all-devices', () => {
  const lockNowJs = readFileSync(join(SP, 'lock-now.js'), 'utf8');
  const api = readFileSync(join(SP, 'api.js'), 'utf8');
  const paths = readFileSync(join(SP, 'paths.js'), 'utf8');
  assert.ok(!lockNowJs.includes('sgx-lock-shown'), '不应再出现 sgx-lock-shown');
  assert.ok(lockNowJs.includes('api.session.end()'), '走 api.session.end');
  assert.ok(!/confirm|dialog/i.test(lockNowJs.replace(/\/\*[\s\S]*?\*\//g, '')), '没有确认层');
  assert.ok(/end: function \(\) \{ return postJSON\(API\.lockNow, \{\}\); \}/.test(api), 'session.end = POST lockNow');
  assert.ok(paths.includes("lockNow: '/api/lock-now'") && paths.includes("lockAll: '/api/lock-all-devices'"));
  for (const f of ['auth/lock-now.js', 'apps/security.js']) {
    let gone = false;
    try { readFileSync(join(root, 'space/web/assets/js', f), 'utf8'); } catch (e) { gone = true; }
    assert.ok(gone, f + ' 已删');
  }
});

test('2026-11-08 账号 UI 改版：账号卡 sgx-account-card.html 和账号页一起删了；旷野页 / 子页也不放账号卡', () => {
  let gone = false;
  try { readFileSync(join(root, 'space/web/layouts/partials/sgx-account-card.html'), 'utf8'); } catch (e) { gone = true; }
  assert.ok(gone, 'sgx-account-card.html 应已删除');
  const setHtml = readFileSync(join(root, 'space/web/layouts/index.html'), 'utf8') + readFileSync(join(root, 'space/web/layouts/_default/wild.html'), 'utf8');
  assert.ok(!setHtml.includes('sgx-account-card'), '旷野页 / 子页不放账号卡');
  const setEntry = readFileSync(join(root, 'space/web/assets/js/entries/entry-space.js'), 'utf8') + readFileSync(join(root, 'space/web/assets/js/entries/entry-space-wild.js'), 'utf8');
  assert.ok(!setEntry.includes('initAvatarEdit'), '旷野页入口不加载换头像');
});

test('进站 v3 L1：安全页（security.html / security.js）删了，旧地址 301 到盾牌 /#sec；顶栏账号下拉是骨架', () => {
  let gone = false;
  try { readFileSync('space/web/layouts/_default/security.html', 'utf8'); } catch (e) { gone = true; }
  assert.ok(gone, 'security.html 已删');
  const red = readFileSync('space/web/static/_redirects', 'utf8');
  assert.match(red, /^\/security\/\s+\/#sec\s+301/m, '/security/ → /#sec 301');
  const base = readFileSync('space/web/layouts/_default/baseof.html', 'utf8');
  assert.ok(base.includes('"acct" $acctUrl'), '顶栏头像 / 账号下拉链到账号页');
  const tb = readFileSync('space/web/layouts/partials/shell-topbar.html', 'utf8');
  assert.ok(tb.includes('<a class="sgx-tb-av" href="{{ .acct }}"'), '顶栏头像用 acct 参数');
  assert.ok(tb.includes('<dialog id="sgx-acct"'), '账号下拉骨架');
  assert.ok(!tb.includes('sgx-pop-me-a'), '账号下拉模板里不再有去账号页的链接');
  assert.ok(!tb.includes('sgx-tb-me'), '顶栏没有头像');
});

test('/api/lock-now：POST 下发 Set-Cookie 清除头（锁屏会话 + LockReauthTicket + LockResetTicket）', async () => {
  const res = await lockPost({ request: new Request('https://styrigx.com/api/lock-now', { method: 'POST' }), env: {} });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')];
  assert.equal(cookies.length, 3, '应下发三条 Set-Cookie（锁屏会话 + LockReauthTicket + LockResetTicket）');
  const sess = cookies.filter((c) => c.startsWith('sgx-space-session=;'));
  assert.equal(sess.length, 1, '应有一条 sgx-space-session 清除');
  assert.ok(sess[0].includes('Domain=.styrigx.com') && sess[0].includes('Max-Age=0'), '锁屏会话清除带 Domain=.styrigx.com');
  assert.ok(cookies.some((c) => c.startsWith('sgx-space-reauth=;') && c.includes('Max-Age=0')), '应清除 LockReauthTicket');
  assert.ok(cookies.some((c) => c.startsWith('sgx-space-reset=;') && c.includes('Max-Age=0')), '应清除 LockResetTicket');
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

test('lock.js：v5 S5 起没有锁屏界面；已解锁页面在 visibilitychange/focus/pageshow 时重查会话（自动回锁，节流）', () => {
  assert.ok(lockJs.includes("addEventListener('visibilitychange'"), '应监听 visibilitychange');
  assert.ok(lockJs.includes("addEventListener('focus'"), '应监听 focus');
  assert.ok(lockJs.includes("addEventListener('pageshow'"), '应监听 pageshow');
  assert.ok(lockJs.includes('checkSessionForAutoLock'), '应有 checkSessionForAutoLock');
  assert.ok(!lockJs.includes('recheckSession'), '锁屏期间的 recheckSession 随锁屏删了');
  assert.ok(lockJs.includes('lastLockCheck'), '应有节流时间戳');
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
