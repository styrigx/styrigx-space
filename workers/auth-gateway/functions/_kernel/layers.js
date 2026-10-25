/**
 * 分层接管（layer takeover）。
 *
 * 两层：account（AccountKey：账号密码 / 账号通行密钥）、lock（LockKey：锁屏密码 / 锁屏通行密钥）。
 * 钥匙命名、KV 键名见 realms.js。
 *
 * 规则：
 * - 某层没有自己的凭证时，root 可代开该层。
 * - 该层一旦配置自己的凭证，root 对该层失效（403）。
 * - "是否已配置"从 KV 读；KV 读取失败按已配置处理（root 被拒，fail closed）。
 *
 * KV 键：lock-configured / account-configured = "1"（REALM_*.kv.configured）
 */

import { REALM_LOCK, REALM_ACCOUNT } from './realms.js';

/* 层标识（= 凭证域 id） */
export const LAYER_ACCOUNT = REALM_ACCOUNT.id;
export const LAYER_LOCK = REALM_LOCK.id;

/** @param {string} layer @returns {string} 该层「已配置」标记的 KV 键 */
function configuredKey(layer) {
  if (layer === LAYER_LOCK) return REALM_LOCK.kv.configured;
  if (layer === LAYER_ACCOUNT) return REALM_ACCOUNT.kv.configured;
  throw new Error('layers: bad layer ' + JSON.stringify(layer));
}


/**
 * 某域是否至少有一把通行密钥：先按索引读，索引不存在再按前缀 kv.list 补查。任何读取失败抛错（调用方按已配置处理）。
 * @param {any} kv @param {{passkeyIndex:string, passkeyPrefix:string}} c 域的 kv 表
 * @returns {Promise<boolean>}
 */
export async function hasPasskey(kv, c) {
  const idx = await kv.get(c.passkeyIndex, 'json');
  if (Array.isArray(idx)) {
    for (const credId of idx) {
      const v = await kv.get(c.passkeyPrefix + String(credId).slice(0, 12), 'json');
      if (v && v.credId) return true;
    }
    return false;
  }
  const list = await kv.list({ prefix: c.passkeyPrefix });
  for (const k of (list && list.keys) || []) {
    const v = await kv.get(k.name, 'json');
    if (v && v.credId) return true;
  }
  return false;
}

/**
 * 检查某层是否已配置自己的凭证。
 * 2.11 定稿：KV 读取失败（或无 KV）按已配置处理（root 被拒，fail closed），不再抛错。
 * @param {any} kv
 * @param {string} layer LAYER_ACCOUNT | LAYER_LOCK
 * @returns {Promise<boolean>}
 */
export async function isLayerConfigured(kv, layer) {
  if (!kv) return true;
  try {
    const v = await kv.get(configuredKey(layer));
    return v === '1';
  } catch (e) {
    return true; /* 读失败按已配置处理 */
  }
}

/**
 * 标记某层已配置。
 * @param {any} kv
 * @param {string} layer
 */
export async function setLayerConfigured(kv, layer) {
  if (!kv) throw new Error('kv-missing');
  await kv.put(configuredKey(layer), '1');
}

/**
 * 清除某层的已配置标记（root 删除该层全部凭证时调用）。
 * @param {any} kv
 * @param {string} layer
 */
export async function clearLayerConfigured(kv, layer) {
  if (!kv) throw new Error('kv-missing');
  await kv.delete(configuredKey(layer));
}

/**
 * 检查 root 是否可以代开某层。
 * - 层未配置 → 允许（takeover）
 * - 层已配置（含 KV 读取失败按已配置处理）→ 拒绝（该层有自己的凭证，root 失效）
 * @param {any} kv
 * @param {string} layer
 * @returns {Promise<{allowed:boolean, reason:string}>}
 *   reason: 'takeover' | 'configured'
 */
export async function checkRootTakeover(kv, layer) {
  const configured = await isLayerConfigured(kv, layer);
  if (configured) {
    return { allowed: false, reason: 'configured' };
  }
  return { allowed: true, reason: 'takeover' };
}

/**
 * 真实凭证盘点（，供 isLockEffectivelyConfigured / isAccountEffectivelyConfigured 共用）。
 * 只读真实凭证（密码 hash、两域的通行密钥），不读 *-configured 标记。
 * 任何一步读取失败 → failed=true（调用方按已配置处理，fail closed）。
 * lock-* 键从 KV_LOCK_DOOR 读，account-* 键从 KV_ACCOUNT_LOGIN 读（同一个 namespace，读的顺序和以前一样）。
 * @param {any} lkv KV_LOCK_DOOR
 * @param {any} akv KV_ACCOUNT_LOGIN
 * @returns {Promise<{accountPw:boolean, lockPw:boolean, accountPk:boolean, lockPk:boolean, failed:boolean}>}
 */
async function realCredentialPresence(lkv, akv) {
  const out = { accountPw: false, lockPw: false, accountPk: false, lockPk: false, failed: false };
  try {
    const accountPw = await akv.get(REALM_ACCOUNT.kv.password, 'json');
    if (accountPw && accountPw.hash) out.accountPw = true;
  } catch (e) {
    out.failed = true;
    return out;
  }
  try {
    const lockPw = await lkv.get(REALM_LOCK.kv.password, 'json');
    if (lockPw && lockPw.hash) out.lockPw = true;
  } catch (e) {
    out.failed = true;
    return out;
  }
  try {
    out.lockPk = await hasPasskey(lkv, REALM_LOCK.kv);
    out.accountPk = await hasPasskey(akv, REALM_ACCOUNT.kv);
  } catch (e) {
    out.failed = true;
  }
  return out;
}

/**
 * 锁屏层是否"有效已配置"（root-auth / lock-entry 共用）。
 *
 * 口径统一：锁屏层已配置标记为 '1'，或真实锁屏凭证存在
 * （锁屏通行密钥，或锁屏密码有 hash），或任何读取失败，
 * 都算已配置。避免"有凭证无标记"时无会话根凭证仍能通过。
 *
 * @param {any} kv KV_LOCK_DOOR
 * @param {any} [akv] KV_ACCOUNT_LOGIN（盘点真实凭证时读 account-* 键；不给就用 kv，同一个 namespace）
 * @returns {Promise<boolean>}
 */
export async function isLockEffectivelyConfigured(kv, akv) {
  if (!kv) return true;
  try {
    /* 1. KV 标记 */
    try {
      const marker = await kv.get(REALM_LOCK.kv.configured);
      if (marker === '1') return true;
    } catch (e) {
      return true;
    }
    /* 2. 真实凭证（密码 / 通行密钥） */
    const real = await realCredentialPresence(kv, akv || kv);
    if (real.failed) return true;
    if (real.lockPw || real.lockPk) return true;
    return false;
  } catch (e) {
    return true;
  }
}

/**
 * 账号层是否"有效已配置"（与 isLockEffectivelyConfigured 镜像，A-2）。
 * 口径：账号层已配置标记为 '1'，或真实账号凭证存在
 * （账号通行密钥，或账号密码有 hash），或任何读取失败，都算已配置。
 * @param {any} akv KV_ACCOUNT_LOGIN
 * @param {any} [lkv] KV_LOCK_DOOR（盘点真实凭证时读 lock-* 键；不给就用 akv，同一个 namespace）
 * @returns {Promise<boolean>}
 */
export async function isAccountEffectivelyConfigured(akv, lkv) {
  if (!akv) return true;
  try {
    try {
      const marker = await akv.get(REALM_ACCOUNT.kv.configured);
      if (marker === '1') return true;
    } catch (e) {
      return true;
    }
    const real = await realCredentialPresence(lkv || akv, akv);
    if (real.failed) return true;
    if (real.accountPw || real.accountPk) return true;
    return false;
  } catch (e) {
    return true;
  }
}
