/**
 * 锁屏层是否已配置（root-auth / lock-entry / lock-passkey 共用）。
 *
 * 「是否已配置」不单独存标记，直接由 D1 里锁屏自己的真实凭证推出（password / passkey 表 realm='lock'，强一致）：
 * 锁屏层已配置 ⇔ 有锁屏密码或锁屏通行密钥。任何读取失败按已配置处理（根密钥代开被拒，fail closed）。
 *
 * 账号拆分 PR3（方案第 2 节）：去掉账号那一半——网关读不到账号凭证，锁屏是否已配置只看锁屏自己的凭证；
 * 锁屏凭证任何时候都不许删到 0（403 last-key，方案第 15 节 U3），所以「锁屏凭证删光但账号已配置」这种状态不再出现。
 * 规则：锁屏层没有自己的凭证时，锁屏根密钥可代开（/api/root-auth purpose=lock-reset）；配置后根密钥只能走 /api/lock-reset。
 */

import { REALM_LOCK } from './realms.js';
import { hasPasskey, PASSKEY_LOCK } from './passkey-store.js';
import { hasPassword } from './lib/password.js';

/* 层标识（= 凭证域 id） */
export const LAYER_LOCK = REALM_LOCK.id;

/**
 * 锁屏真实凭证盘点（D1，强一致）。任何一步读取失败 → failed=true（调用方按已配置处理，fail closed）。
 * @param {any} env
 * @returns {Promise<{lockPw:boolean, lockPk:boolean, failed:boolean}>}
 */
export async function realCredentialPresence(env) {
  const out = { lockPw: false, lockPk: false, failed: false };
  try {
    out.lockPw = await hasPassword(env, REALM_LOCK);
    out.lockPk = await hasPasskey(env, PASSKEY_LOCK);
  } catch (e) {
    out.failed = true;
  }
  return out;
}

/**
 * 锁屏层是否已配置。读取失败按已配置。
 * @param {any} env
 * @returns {Promise<boolean>}
 */
export async function isLockEffectivelyConfigured(env) {
  const real = await realCredentialPresence(env);
  if (real.failed) return true;
  return real.lockPw || real.lockPk;
}
