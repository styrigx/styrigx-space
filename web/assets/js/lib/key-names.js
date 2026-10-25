/**
 * @fileoverview 钥匙概念名（全仓统一）——前端镜像，与 workers/auth-gateway/functions/_kernel/realms.js 的 KEY_* 同值。
 * 概念名：RootKey / AccountKey / LockKey。
 */

/** @type {string} 根凭证（账号登录入口之一，也是恢复路径） */
export const KEY_ROOT = 'RootKey';
/** @type {string} 账号凭证（账号密码、账号通行密钥），只在「账号 → 账号安全」管理 */
export const KEY_ACCOUNT = 'AccountKey';
/** @type {string} 「安全与隐私 → 锁屏凭证」里存放的钥匙 */
export const KEY_LOCK = 'LockKey';
