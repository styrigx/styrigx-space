/**
 * 2.4.1 前端会话修复测试（node --test）。
 *
 * 覆盖：
 * - 锁屏（进站 v3 L1：守卫 shell/space/guard.js + 界面 shell/space/entry.js）不再读写 sessionStorage 的 'sgx-lock-shown'（grep 断言）
 * - 守卫读网关注入的 data-sgx-lock-session，不自己 fetch 做初始判断
 * - 旧的立即锁屏（shell/space/lock-now.js → POST /api/lock-now）v6 P4 删了，lock 走 v6 身份层
 * - sgx-account-card.html 随账号页删除（2026-11-08）
 * - /api/lock-now 接口 v6 P4 随进站会话删除（网关源码里没有这个文件）
 *
 * 运行：node --test tests/ui/frontend-session.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
/* 2026-10-26（frontend-js #6）：锁屏拆成守卫（core 里）+ 界面（按需加载）；v5 S5 起是守卫 shell/space/guard.js + 终端里的钥匙层 shell/space/layer.js / unlock.js，合起来查 */
const SP = join(root, 'space/web/assets/shell/js/shell/space');
/* v6 P4：钥匙层（layer.js / unlock.js / lock-now.js …）随旧进站会话删了，只剩守卫 */
const lockJs = readFileSync(join(SP, 'guard.js'), 'utf8');

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

test('v6 P4：旧的立即锁屏（shell/space/lock-now.js → POST /api/lock-now）删了；lock = v6 身份层清栈（POST /api/identity lock）', () => {
  for (const f of ['shell/space/lock-now.js', 'shell/space/api.js', 'shell/space/paths.js', 'auth/lock-now.js', 'apps/security.js']) {
    let gone = false;
    try { readFileSync(join(root, 'space/web/assets/shell/js', f), 'utf8'); } catch (e) { gone = true; }
    assert.ok(gone, f + ' 已删');
  }
  const code = lockJs.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!code.includes('/api/lock-session-check') && !code.includes('/api/lock-now'), '守卫不再问旧接口');
  const lockCmd = readFileSync(join(root, 'space/web/assets/shell/js/shell/term/cmds/keys/lock.js'), 'utf8');
  assert.ok(lockCmd.includes('I.cmdLock()'), 'lock 走身份层');
});

test('2026-11-08 账号 UI 改版：账号卡 sgx-account-card.html 和账号页一起删了；主页 / 状态页也不放账号卡', () => {
  let gone = false;
  try { readFileSync(join(root, 'space/web/layouts/partials/sgx-account-card.html'), 'utf8'); } catch (e) { gone = true; }
  assert.ok(gone, 'sgx-account-card.html 应已删除');
  const setHtml = readFileSync(join(root, 'space/web/layouts/index.html'), 'utf8') + readFileSync(join(root, 'space/web/layouts/_default/status.html'), 'utf8');
  assert.ok(!setHtml.includes('sgx-account-card'), '主页 / 状态页不放账号卡');
  const setEntry = readFileSync(join(root, 'space/web/assets/shell/js/entries/entry-space.js'), 'utf8') + readFileSync(join(root, 'space/web/assets/shell/js/entries/entry-space-status.js'), 'utf8');
  assert.ok(!setEntry.includes('initAvatarEdit'), '主站页面入口不加载换头像');
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

test('v6 P4：网关的 /api/lock-now 接口随进站会话删除', () => {
  let gone = false;
  try { readFileSync(join(root, 'workers/space-core/src/api/lock-now.js'), 'utf8'); } catch (e) { gone = true; }
  assert.ok(gone, 'workers/space-core/src/api/lock-now.js 已删');
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
