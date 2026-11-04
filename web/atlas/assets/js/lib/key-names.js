/**
 * @fileoverview 钥匙概念名（全仓统一）——前端镜像：KEY_SPACE / KEY_LOCK 与 workers/auth-gateway/src/core/realms.js 同值，
 * KEY_ROOT 是账号侧（账号根凭证，workers/account）。
 * 概念名：SpaceKey / LockKey（锁屏侧）、RootKey / AccountKey（账号侧）。也是密码管理器里隐藏用户名的值。
 */

/** @type {string} 进站凭证（锁屏侧兜底：锁屏凭证页复验、重置锁屏） */
export const KEY_SPACE = 'SpaceKey';
/** @type {string} 账号根凭证（账号侧恢复路径：/account/reset/） */
export const KEY_ROOT = 'RootKey';
/** @type {string} 账号凭证（账号密码、账号通行密钥），只在「账号 → 账号安全」管理 */
export const KEY_ACCOUNT = 'AccountKey';
/** @type {string} 「安全与隐私 → 锁屏凭证」里存放的钥匙 */
export const KEY_LOCK = 'LockKey';
