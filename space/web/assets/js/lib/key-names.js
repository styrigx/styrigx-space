/**
 * @fileoverview 钥匙概念名（全仓统一）——前端镜像：KEY_SPACE_PASSWORD / KEY_SPACE_PASSKEY / KEY_SPACE_RECOVERY_KEY 与 workers/space-core/src/core/realms.js 同值；
 * KEY_ACCOUNT_PASSWORD / KEY_ACCOUNT_PASSKEY / KEY_RECOVERY_KEY 是账号侧（workers/account；KEY_ACCOUNT_PASSKEY 与 workers/account/src/core/config.js 同值）。
 * 概念名（进站侧，进站 v3 Q6，L2 起）：SpacePassword（解锁密码）、SpacePasskey（进站通行密钥）、SpaceRecoveryKey（恢复钥匙）；账号三把钥匙（K2，2026-11-08）：AccountPassword（账号密码）、AccountPasskey（账号通行密钥）、
 * RecoveryKey（恢复密钥，只给 sudo root reset 用）。也是密码管理器里隐藏用户名的值。
 */

/** @type {string} 解锁密码（密码管理器里的隐藏用户名） */
export const KEY_SPACE_PASSWORD = 'SpacePassword';
/** @type {string} 进站通行密钥（WebAuthn user.name；已注册的旧通行密钥照旧显示注册时的名字） */
export const KEY_SPACE_PASSKEY = 'SpacePasskey';
/** @type {string} 恢复钥匙（sudo styrigx reset；Secrets 名 SGX_SPACE_RECOVERY_KEY） */
export const KEY_SPACE_RECOVERY_KEY = 'SpaceRecoveryKey';
/** @type {string} 恢复密钥（账号侧恢复路径 sudo root reset；Secrets 名 SGX_ACCOUNT_RECOVERY_KEY） */
export const KEY_RECOVERY_KEY = 'RecoveryKey';
/** @type {string} 账号密码（密码管理器里的隐藏用户名） */
export const KEY_ACCOUNT_PASSWORD = 'AccountPassword';
/** @type {string} 账号通行密钥（WebAuthn user.name / signalCurrentUserDetails 的 name） */
export const KEY_ACCOUNT_PASSKEY = 'AccountPasskey';
