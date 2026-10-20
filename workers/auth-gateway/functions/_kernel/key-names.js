/**
 * 钥匙命名规范（站长定，全仓统一）。
 *
 * 按「门外钥匙 / 门内存放」分层，每类钥匙不分密码、通行密钥或将来的新方式，
 * 都用同一个名字：
 * - rootkey：根凭证（账号登录的入口之一，也是恢复路径）
 * - accountkey：账号凭证（账号密码、账号通行密钥……；原「站长凭证」升级为账号，
 *   概念名原为 ownerkey，2026-10 改名 accountkey；存储不变——class 仍是 'owner'，
 *   KV 仍是 owner-pw / owner-passkey:*），只在「账号 → 安全与隐私」管理。
 *   账号通行密钥注册时 WebAuthn user.name = accountkey，密码管理器里显示这个名字
 * - lockkey：「安全与隐私 → 锁屏凭证」里存放的钥匙（解锁密码、锁屏通行密钥）
 * （应用凭证 <aud>key 已删除；旧 class=app 的记录留在 KV 里，任何接口都不再读取。）
 *
 * 存储层（KV 键名、class 字段值）保留原名，仅在常量层映射，
 * 避免迁移风险。Cookie 名、环境变量名、Cloudflare 绑定不改。
 */

/* 门/钥匙类型 */
export const KEY_ROOT = 'rootkey';
export const KEY_ACCOUNT = 'accountkey';
export const KEY_LOCK = 'lockkey';

/* 存储层 class 字段值（KV 历史数据，保留不迁移）。
   读：兼容无 class 的旧数据（按 lockkey 处理）；
   写：一律写这两个值。其他文件只引用，不自己定义。 */
export const STORE_CLASS_OWNERKEY = 'owner'; // accountkey（存储层沿用 owner）
export const STORE_CLASS_LOCKKEY = 'lock'; // lockkey

/* 存储层 KV 键名：owner-passkey:<credId 前 12 位>。
   全仓所有读写 owner-passkey:* 键的地方都调 ownerPasskeyKey()，不手拼；
   列表扫描用 OWNER_PASSKEY_PREFIX。 */
export const OWNER_PASSKEY_PREFIX = 'owner-passkey:';
/** @param {string} credId 完整 credId @returns {string} 'owner-passkey:<前12位>' */
export function ownerPasskeyKey(credId) {
  return OWNER_PASSKEY_PREFIX + String(credId).slice(0, 12);
}
