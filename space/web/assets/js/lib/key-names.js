/**
 * @fileoverview 钥匙概念名（全仓统一）——前端镜像：KEY_SPACE / KEY_LOCK 与 workers/auth-gateway/src/core/realms.js 同值，
 * KEY_ACCOUNT_PASSWORD / KEY_ACCOUNT_PASSKEY / KEY_RECOVERY 是账号侧（workers/account；KEY_ACCOUNT_PASSKEY 与 workers/account/src/core/realm.js 同值）。
 * 概念名：SpaceKey / LockKey（锁屏侧）；账号三把钥匙（2026-11-08）：AccountPassword（account password）、AccountPasskey（account passkey）、
 * RecoveryKey（恢复密钥，原 RootKey，只给 sudo root reset 用）。不再有 AccountKey 统称。也是密码管理器里隐藏用户名的值。
 */

/** @type {string} 进站凭证（锁屏侧兜底：锁屏凭证页复验、重置锁屏） */
export const KEY_SPACE = 'SpaceKey';
/** @type {string} 恢复密钥（账号侧恢复路径 sudo root reset；Secrets 名仍是 SGX_ACCOUNT_ROOT_KEY） */
export const KEY_RECOVERY = 'RecoveryKey';
/** @type {string} 账号密码（密码管理器里的隐藏用户名） */
export const KEY_ACCOUNT_PASSWORD = 'AccountPassword';
/** @type {string} 账号通行密钥（WebAuthn user.name / signalCurrentUserDetails 的 name） */
export const KEY_ACCOUNT_PASSKEY = 'AccountPasskey';
/** @type {string} 「安全与隐私 → 锁屏凭证」里存放的钥匙 */
export const KEY_LOCK = 'LockKey';
