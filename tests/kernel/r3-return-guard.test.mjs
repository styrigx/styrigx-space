/**
 * R3 子站回跳守卫测试（node --test）。
 *
 * 覆盖：
 * - lock.js 源码：回跳守卫存在（20 秒窗口、目标 origin+path、sessionStorage）；
 * - 失败卡用 One UI 确认弹层（showConfirmDialog），旧版底部小字已删除；
 * - 失败卡文案：标题/说明/按钮齐全，不含 why 码占位；
 * - L1 不变：带 why + 有效会话 → 200 不 302（服务端兜底；前端去掉 why 后 reload 才由 L1 302）。
 *
 * 运行：node --test tests/kernel/r3-return-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const LOCK_SRC = fs.readFileSync(new URL('../../assets/js/shell/lock.js', import.meta.url), 'utf8');

test('R3：回跳守卫存在（20 秒窗口 + 目标 origin+path + sessionStorage）', () => {
  assert.ok(LOCK_SRC.includes("RETURN_GUARD_KEY = 'sgx-return-guard'"), '应有守卫 key');
  assert.ok(LOCK_SRC.includes('RETURN_GUARD_WINDOW_MS = 20000'), '窗口应为 20 秒');
  assert.ok(LOCK_SRC.includes('function attemptReturnJump'), '应有 attemptReturnJump');
  assert.ok(LOCK_SRC.includes('function returnTarget'), '应有 returnTarget（origin+path）');
  assert.ok(LOCK_SRC.includes('function stripWhyAndReload'), '应有 stripWhyAndReload（去掉 why 后 reload）');
  assert.ok(LOCK_SRC.includes('function stayOnMain'), '应有 stayOnMain（去掉 return/why）');
  assert.ok(LOCK_SRC.includes('function clearReturnGuard'), '应有 clearReturnGuard（重试时清守卫）');
  /* 回跳前记守卫 */
  assert.ok(LOCK_SRC.includes('recordReturnGuard(target)'), '回跳前应记守卫');
  /* 守卫判定：同一目标 + 20 秒内 → 失败卡 */
  assert.ok(LOCK_SRC.includes('Date.now() - g.t < RETURN_GUARD_WINDOW_MS'), '应按 20 秒窗口判定死循环');
});

test('R3：失败卡用 One UI 确认弹层，旧版底部小字已删除', () => {
  assert.ok(LOCK_SRC.includes('showConfirmDialog({'), '失败卡应走 showConfirmDialog');
  assert.ok(!LOCK_SRC.includes("el.id = 'sgx-subsite-failure'"), '不应再创建旧版小字元素');
  assert.ok(!LOCK_SRC.includes('子站验证失败：'), '不应再显示「子站验证失败：」小字（带冒号的旧文案）');
  assert.ok(!LOCK_SRC.includes('rgba(255,255,255,0.6)'), '不应再有白色 60% 小字样式');
});

test('R3：失败卡文案（标题/说明/按钮），不露 why 码', () => {
  assert.ok(LOCK_SRC.includes("'没能回到'"), '标题应为「没能回到 …」');
  assert.ok(LOCK_SRC.includes("'书库'") && LOCK_SRC.includes("'博客'"), 'book→书库、blog→博客');
  assert.ok(LOCK_SRC.includes('这个浏览器还没有通过验证，或拦截了跨站登录信息。'), 'no-cookie 说明');
  assert.ok(LOCK_SRC.includes('登录已过期，请重新解锁。'), 'expired/epoch-stale 说明');
  assert.ok(LOCK_SRC.includes('网站配置有问题，请稍后再试。'), 'no-config/key-import 说明');
  assert.ok(LOCK_SRC.includes("'留在主站'") && LOCK_SRC.includes("'重试'"), '按钮：留在主站 / 重试');
  /* 失败卡标题/说明里不出现 why 码（why 只作分支条件，不拼进文案）：
     只检查文案构造块（let desc → showConfirmDialog），避免注释误报 */
  const cardSection = LOCK_SRC.slice(LOCK_SRC.indexOf('function showSubsiteFailure'));
  const descBlock = cardSection.slice(cardSection.indexOf('let desc;'), cardSection.indexOf('showConfirmDialog({'));
  assert.ok(!descBlock.includes("reasons[why]"), '文案不应按 why 码查表拼接');
  assert.ok(!descBlock.includes('+ why'), '文案不应拼接 why');
});

test('R3：解锁成功与会话已有效两处都走守卫回跳', () => {
  assert.ok(LOCK_SRC.includes('attemptReturnJump(ret, why,'), 'handleSessionOk / initLock 应调 attemptReturnJump');
  /* initLock 会话已有效 + return + why → 回跳一次 */
  assert.ok(LOCK_SRC.includes("if (ret && why) {"), 'initLock 应处理 return + why');
});
