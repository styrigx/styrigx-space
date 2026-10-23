/**
 * @fileoverview 钥匙命名规范（站长定，全仓统一）——前端镜像。
 * 与 functions/_kernel/key-names.js 同源；存储层（class 字段值）保留原名，
 * 概念名：RootKey / AccountKey / LockKey（应用凭证 <aud>key 已删除）。
 * Cookie 名、环境变量名、Cloudflare 绑定不改。
 */

/** @type {string} 根凭证（账号登录入口之一，也是恢复路径） */
export const KEY_ROOT = 'RootKey';
/** @type {string} 账号凭证（账号密码、账号通行密钥；原「站长凭证」，概念名原为 OwnerKey），只在「账号 → 安全与隐私」管理 */
export const KEY_ACCOUNT = 'AccountKey';
/** @type {string} 「安全与隐私 → 锁屏凭证」里存放的钥匙 */
export const KEY_LOCK = 'LockKey';
/* 存储层 class 字段值（KV 历史数据，保留不迁移） */
export const STORE_CLASS_ACCOUNTKEY = 'owner'; // AccountKey（存储层沿用 owner）
export const STORE_CLASS_LOCKKEY = 'lock';
