/**
 * @fileoverview 钥匙命名规范（站长定，全仓统一）——前端镜像。
 * 由 scripts/gen-key-names.mjs 从 functions/_kernel/key-names.js 生成，请勿手改。
 * 概念名：rootkey / ownerkey / lockkey / <aud>key（如 bookkey）。
 * Cookie 名、环境变量名、Cloudflare 绑定不改。
 */
export const KEY_ROOT = 'rootkey';

export const KEY_OWNER = 'ownerkey';

export const KEY_LOCK = 'lockkey';

export function appKeyName(aud) {
  return String(aud || '').toLowerCase() + 'key';
}

export const STORE_CLASS_OWNERKEY = 'owner';

export const STORE_CLASS_LOCKKEY = 'lock';

export const STORE_CLASS_APPKEY = 'app';
