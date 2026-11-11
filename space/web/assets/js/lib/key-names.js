/**
 * @fileoverview 钥匙概念名（全仓统一）——前端镜像：KEY_SPACE_PASSWORD / KEY_SPACE_PASSKEY（进站侧，进站 v3 Q6）；
 * KEY_ACCOUNT_PASSWORD / KEY_ACCOUNT_PASSKEY 是账号侧（workers/account；KEY_ACCOUNT_PASSKEY 与 workers/account/src/core/config.js 同值）。
 * 概念名：SpacePassword（解锁密码）、SpacePasskey（进站通行密钥）、AccountPassword（账号密码）、AccountPasskey（账号通行密钥）。
 * 也是密码管理器里隐藏用户名的值。
 * v6 P4（定稿 v5.3 §十三）：两把旧恢复钥匙删除，它们的概念名 KEY_SPACE_RECOVERY_KEY / KEY_RECOVERY_KEY 一并删掉（没有引用方）。
 */

/** @type {string} 解锁密码（密码管理器里的隐藏用户名） */
export const KEY_SPACE_PASSWORD = 'SpacePassword';
/** @type {string} 进站通行密钥（WebAuthn user.name；已注册的旧通行密钥照旧显示注册时的名字） */
export const KEY_SPACE_PASSKEY = 'SpacePasskey';
/** @type {string} 账号密码（密码管理器里的隐藏用户名） */
export const KEY_ACCOUNT_PASSWORD = 'AccountPassword';
/** @type {string} 账号通行密钥（WebAuthn user.name / signalCurrentUserDetails 的 name） */
export const KEY_ACCOUNT_PASSKEY = 'AccountPasskey';
