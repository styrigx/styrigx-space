/**
 * @fileoverview 进站前端状态（原 lib/lock-state.js；进站 v3 SPACE-V3 §1.3「前端文件」）：只缓存服务端的说法，从不据此放行（所有判断都在服务端）。
 * - by：这次是怎么进站的（password | passkey | tempkey；来自会话检查的 by）。只作展示，不分等级。
 * 写的人：shell/space/guard.js askServer()。
 */

/** @type {{by: string}} */
export const spaceState = { by: '' };
