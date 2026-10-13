/**
 * GENERATED FILE — DO NOT EDIT MANUALLY.
 * 由 scripts/gen-key-names.mjs 从 functions/_kernel/key-names.js 生成
 * （后端是唯一来源；前端禁止手抄类别字面量，统一 import 本文件）。
 */
export const KEY_ROOT = 'rootkey';
export const KEY_OWNER = 'ownerkey';
export const KEY_LOCK = 'lockkey';
export const STORE_CLASS_OWNERKEY = 'owner';
export const STORE_CLASS_LOCKKEY = 'lock';
export const STORE_CLASS_APPKEY = 'app';
export const CLASS_TO_KEY = {
  owner: KEY_OWNER,
  lock: KEY_LOCK,
};
export const KEY_NAME_MAPPING = {
  '根凭证 / root credential': KEY_ROOT,
  'owner passkey / 站长通行密钥': KEY_OWNER,
  'owner password / 站长密码': KEY_OWNER,
  'lock passkey / 锁屏通行密钥': KEY_LOCK,
  'lock password / 解锁密码': KEY_LOCK,
  'app passkey (book) / Book 通行密钥': 'bookkey',
};
export const OWNER_PASSKEY_PREFIX = 'owner-passkey:';

/* 以下函数与后端同表达式手写（生成器不复制函数体，见脚本注释） */
export function appKeyName(aud) {
  return String(aud || '').toLowerCase() + 'key';
}

export function classToKeyName(pkClass, aud) {
  if (pkClass === 'app' && aud) return appKeyName(aud);
  return CLASS_TO_KEY[pkClass] || pkClass;
}

export function ownerPasskeyKey(credId) {
  return OWNER_PASSKEY_PREFIX + String(credId).slice(0, 12);
}
