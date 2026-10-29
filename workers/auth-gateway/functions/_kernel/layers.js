/**
 * 分层接管（layer takeover）。
 *
 * 两层：account（AccountKey：账号密码 / 账号通行密钥）、lock（LockKey：锁屏密码 / 锁屏通行密钥）。
 * 钥匙命名见 realms.js。
 *
 * 规则：
 * - 某层没有自己的凭证时，root 可代开该层。
 * - 该层一旦配置自己的凭证，root 对该层失效（403）。
 *
 * 「是否已配置」不再单独存标记（2026-10-27 起不写 lock-configured / account-configured），
 * 直接由 D1 里的真实凭证推出（password / passkey 表，强一致；任何读取失败按已配置处理，root 被拒，fail closed）：
 * - account 层已配置 ⇔ 有账号密码或账号通行密钥
 * - lock 层已配置 ⇔ 有锁屏密码或锁屏通行密钥，或 account 层已配置
 *   （第二条替代以前「删光锁屏凭证但账号已配置时保留 lock-configured 标记」：那时锁屏只显示访客 + 重置锁屏，
 *    根凭证不能直接代开锁屏；锁屏凭证在账号未配置时删不到 0，见 last-key 规则）
 */

import { REALM_LOCK, REALM_ACCOUNT } from './realms.js';
import { hasPasskey, PASSKEY_LOCK, PASSKEY_ACCOUNT } from './passkey-store.js';
import { hasPassword } from './lib/password.js';

/* 层标识（= 凭证域 id） */
export const LAYER_ACCOUNT = REALM_ACCOUNT.id;
export const LAYER_LOCK = REALM_LOCK.id;

/**
 * 真实凭证盘点（D1，强一致）。任何一步读取失败 → failed=true（调用方按已配置处理，fail closed）。
 * @param {any} env
 * @returns {Promise<{accountPw:boolean, lockPw:boolean, accountPk:boolean, lockPk:boolean, failed:boolean}>}
 */
export async function realCredentialPresence(env) {
  const out = { accountPw: false, lockPw: false, accountPk: false, lockPk: false, failed: false };
  try {
    out.accountPw = await hasPassword(env, REALM_ACCOUNT);
    out.lockPw = await hasPassword(env, REALM_LOCK);
    out.lockPk = await hasPasskey(env, PASSKEY_LOCK);
    out.accountPk = await hasPasskey(env, PASSKEY_ACCOUNT);
  } catch (e) {
    out.failed = true;
  }
  return out;
}

/**
 * 锁屏层是否已配置（root-auth / lock-entry / layer-status 共用）。读取失败按已配置。
 * @param {any} env
 * @returns {Promise<boolean>}
 */
export async function isLockEffectivelyConfigured(env) {
  const real = await realCredentialPresence(env);
  if (real.failed) return true;
  return real.lockPw || real.lockPk || real.accountPw || real.accountPk;
}

/**
 * 账号层是否已配置（与 isLockEffectivelyConfigured 镜像）。读取失败按已配置。
 * @param {any} env
 * @returns {Promise<boolean>}
 */
export async function isAccountEffectivelyConfigured(env) {
  const real = await realCredentialPresence(env);
  if (real.failed) return true;
  return real.accountPw || real.accountPk;
}

/**
 * 某层是否已配置（按层分派；读取失败按已配置）。
 * @param {any} env
 * @param {string} layer LAYER_ACCOUNT | LAYER_LOCK
 * @returns {Promise<boolean>}
 */
export async function isLayerConfigured(env, layer) {
  if (layer === LAYER_LOCK) return isLockEffectivelyConfigured(env);
  if (layer === LAYER_ACCOUNT) return isAccountEffectivelyConfigured(env);
  throw new Error('layers: bad layer ' + JSON.stringify(layer));
}
