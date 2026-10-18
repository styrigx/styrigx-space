/**
 * @fileoverview 钥匙命名规范（站长定，全仓统一）——前端镜像。
 * 与 functions/_kernel/key-names.js 同源；存储层（class 字段值）保留原名，
 * 概念名：rootkey / ownerkey / lockkey / <aud>key（如 bookkey）。
 * Cookie 名、环境变量名、Cloudflare 绑定不改。
 */

/** @type {string} 「站长凭证」门外的钥匙（根凭证） */
export const KEY_ROOT = 'rootkey';
/** @type {string} 「站长凭证」门内存放的钥匙，同时是「管理凭证」门外的钥匙 */
export const KEY_OWNER = 'ownerkey';
/** @type {string} 「管理凭证 → 锁屏」里存放的钥匙 */
export const KEY_LOCK = 'lockkey';
/**
 * @param {string} aud 应用标识（app-registry.js 的 aud），如 'book'
 * @returns {string} 如 'bookkey'
 */
export function appKeyName(aud) {
  return String(aud || '').toLowerCase() + 'key';
}

/* 存储层 class 字段值（KV 历史数据，保留不迁移） */
export const STORE_CLASS_OWNERKEY = 'owner';
export const STORE_CLASS_LOCKKEY = 'lock';
export const STORE_CLASS_APPKEY = 'app';
