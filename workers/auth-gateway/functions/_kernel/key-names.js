/**
 * 钥匙命名规范（站长定，全仓统一）。
 *
 * 按「门外钥匙 / 门内存放」分层，每类钥匙不分密码、通行密钥或将来的新方式，
 * 都用同一个名字：
 * - RootKey：根凭证（只用来比对，验过后签重置 / 再验证票；不拥有会话）
 * - AccountKey：账号凭证（账号密码、账号通行密钥），只在「账号 → 账号安全」管理。
 *   账号通行密钥注册时 WebAuthn user.name = AccountKey，密码管理器里显示这个名字
 * - LockKey：「安全与隐私 → 锁屏凭证」里存放的钥匙（解锁密码、锁屏通行密钥）
 *
 * 存储层（KV 键名、class 字段值）暂时保留原名，只在本文件的常量里出现一次；
 * 键名改造（第 5 层）时本文件并入 realms.js 后删除。代码一律引用这里的常量，不手拼键名。
 */

/* 钥匙类型 */
export const KEY_ROOT = 'RootKey';
export const KEY_ACCOUNT = 'AccountKey';
export const KEY_LOCK = 'LockKey';

/* 存储层 class 字段值（通行密钥记录里区分域）。
   读：兼容无 class 的早期数据（按 LockKey 处理）；写：一律写这两个值。其他文件只引用，不自己定义。 */
export const STORE_CLASS_ACCOUNTKEY = 'owner'; // AccountKey
export const STORE_CLASS_LOCKKEY = 'lock'; // LockKey

/* 存储层 KV 键名：通行密钥记录 <前缀><credId 前 12 位>（锁屏、账号两域混存，靠 class 区分）。
   全仓所有读写通行密钥记录的地方都调 passkeyKey()，不手拼；列表扫描用 PASSKEY_KEY_PREFIX。 */
export const PASSKEY_KEY_PREFIX = 'owner-passkey:';
/** @param {string} credId 完整 credId @returns {string} PASSKEY_KEY_PREFIX + 前 12 位 */
export function passkeyKey(credId) {
  return PASSKEY_KEY_PREFIX + String(credId).slice(0, 12);
}
/* 通行密钥索引（credId 数组，两域混存） */
export const PASSKEY_INDEX_KEY = 'owner-passkey-index';
/* 更早的数组结构（读到就一次性迁移成每把一个键） */
export const LEGACY_PASSKEY_ARRAY_KEY = 'owner-passkeys';
/* WebAuthn user handle：锁屏、账号各一个 */
export const LOCK_USER_HANDLE_KEY = 'owner-user-id';
export const ACCOUNT_USER_HANDLE_KEY = 'owner-user-id:owner';
