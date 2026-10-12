/**
 * 钥匙命名规范（站长定，全仓统一）。
 *
 * 按「门外钥匙 / 门内存放」分层，每类钥匙不分密码、通行密钥或将来的新方式，
 * 都用同一个名字：
 * - rootkey：「站长凭证」门外的钥匙（根凭证）
 * - ownerkey：「站长凭证」门内存放的钥匙（站长密码、站长通行密钥……），
 *   同时是「管理凭证」门外的钥匙
 * - lockkey：「管理凭证 → 锁屏」里存放的钥匙（解锁密码、锁屏通行密钥）
 * - <aud>key：「管理凭证 → 应用 → <应用>」里存放的钥匙，如 bookkey；
 *   应用名取 app-registry.js 的 aud
 *
 * 存储层（KV 键名、class 字段值）保留原名，仅在常量层映射，
 * 避免迁移风险。Cookie 名、环境变量名、Cloudflare 绑定不改。
 */

/* 门/钥匙类型 */
export const KEY_ROOT = 'rootkey';
export const KEY_OWNER = 'ownerkey';
export const KEY_LOCK = 'lockkey';
/** @param {string} aud 应用标识，如 'book' */
export function appKeyName(aud) {
  return String(aud || '').toLowerCase() + 'key';
}

/* 存储层 class 字段值（KV 历史数据，保留不迁移）。
   读：兼容无 class 的旧数据（按 lockkey 处理）；
   写：一律写这三个值。其他文件只引用，不自己定义。 */
export const STORE_CLASS_OWNERKEY = 'owner'; // ownerkey
export const STORE_CLASS_LOCKKEY = 'lock'; // lockkey
export const STORE_CLASS_APPKEY = 'app'; // <aud>key

/* 存储层映射（KV class 字段值 → 钥匙名） */
export const CLASS_TO_KEY = {
  owner: KEY_OWNER,
  lock: KEY_LOCK,
};
/** @param {string} pkClass 'owner'|'lock'|'app' @param {string} [aud] */
export function classToKeyName(pkClass, aud) {
  if (pkClass === 'app' && aud) return appKeyName(aud);
  return CLASS_TO_KEY[pkClass] || pkClass;
}

/* 旧名 → 新名对照（PR 说明用） */
export const KEY_NAME_MAPPING = {
  '根凭证 / root credential': KEY_ROOT,
  'owner passkey / 站长通行密钥': KEY_OWNER,
  'owner password / 站长密码': KEY_OWNER,
  'lock passkey / 锁屏通行密钥': KEY_LOCK,
  'lock password / 解锁密码': KEY_LOCK,
  'app passkey (book) / Book 通行密钥': 'bookkey',
};
