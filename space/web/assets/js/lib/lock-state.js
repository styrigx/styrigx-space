/**
 * @fileoverview 锁屏前端状态（方案 3.7，P2-3）：只缓存服务端的说法，从不据此放行（所有判断都在服务端）。
 * - lockBy：这次是怎么进门的（password | passkey | tempkey；来自 /api/lock-session-check 的 by）。只作展示，不分等级。
 * - lockReauth：锁侧复验票的状态 {valid, exp}（来自 /api/lock-reauth status；exp 是到期时刻，毫秒）。
 * 写的人：shell/lock-guard.js askServer()（lockBy）、auth/lock-reauth.js（lockReauth）。
 */

/** @type {{lockBy: string, lockReauth: {valid: boolean, exp: number}}} */
export const lockState = { lockBy: '', lockReauth: { valid: false, exp: 0 } };
