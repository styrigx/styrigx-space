/**
 * 分层接管（layer takeover）。
 *
 * 两层：account（AccountKey：账号密码 / 账号通行密钥）、lock（LockKey：锁屏密码 / 锁屏通行密钥）。
 * 钥匙命名见 key-names.js。
 *
 * 规则：
 * - 某层没有自己的凭证时，root 可代开该层。
 * - 该层一旦配置自己的凭证，root 对该层失效（403）。
 * - "是否已配置"从 KV 读；KV 读取失败按已配置处理（root 被拒，fail closed）。
 *
 * KV 键：'layer:' + 层的存储名（LAYER_ACCOUNT / LAYER_LOCK 的值）= "1"
 */

import { passkeyKey, PASSKEY_KEY_PREFIX, PASSKEY_INDEX_KEY, STORE_CLASS_ACCOUNTKEY, STORE_CLASS_LOCKKEY } from './key-names.js';
import { REALM_LOCK, REALM_ACCOUNT } from './realms.js';

/* 层标识（值是 KV 存储名：账号层沿用早期的 'owner'，键名改造时随 KV 一起改） */
export const LAYER_ACCOUNT = 'owner';
export const LAYER_LOCK = 'lock';


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
    const v = await kv.get('layer:' + layer);
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
  await kv.put('layer:' + layer, '1');
}

/**
 * 清除某层的已配置标记（root 删除该层全部凭证时调用）。
 * @param {any} kv
 * @param {string} layer
 */
export async function clearLayerConfigured(kv, layer) {
  if (!kv) throw new Error('kv-missing');
  await kv.delete('layer:' + layer);
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
 * 真实凭证盘点（单次遍历，供 isLockEffectivelyConfigured / isAccountEffectivelyConfigured 共用）。
 * 只读真实凭证（密码 hash、通行密钥 class），不读 layer:* 标记。
 * 任何一步读取失败 → failed=true（调用方按已配置处理，fail closed）。
 * @param {any} kv
 * @returns {Promise<{accountPw:boolean, lockPw:boolean, accountPk:boolean, lockPk:boolean, failed:boolean}>}
 */
async function realCredentialPresence(kv) {
  const out = { accountPw: false, lockPw: false, accountPk: false, lockPk: false, failed: false };
  try {
    const accountPw = await kv.get(REALM_ACCOUNT.kv.password, 'json');
    if (accountPw && accountPw.hash) out.accountPw = true;
  } catch (e) {
    out.failed = true;
    return out;
  }
  try {
    const lockPw = await kv.get(REALM_LOCK.kv.password, 'json');
    if (lockPw && lockPw.hash) out.lockPw = true;
  } catch (e) {
    out.failed = true;
    return out;
  }
  try {
    let idx = null;
    try {
      idx = await kv.get(PASSKEY_INDEX_KEY, 'json');
    } catch (e) {
      out.failed = true;
      return out;
    }
    if (Array.isArray(idx)) {
      for (const credId of idx) {
        let v = null;
        try {
          v = await kv.get(passkeyKey(credId), 'json');
        } catch (e) {
          out.failed = true;
          return out;
        }
        if (v && v.credId && (v.class || STORE_CLASS_LOCKKEY) === STORE_CLASS_ACCOUNTKEY) out.accountPk = true;
        if (v && v.credId && (v.class || STORE_CLASS_LOCKKEY) === STORE_CLASS_LOCKKEY) out.lockPk = true;
      }
    } else {
      /* 索引不存在：用 kv.list 补查 */
      let list = null;
      try {
        list = await kv.list({ prefix: PASSKEY_KEY_PREFIX });
      } catch (e) {
        out.failed = true;
        return out;
      }
      for (const k of (list && list.keys) || []) {
        let v = null;
        try {
          v = await kv.get(k.name, 'json');
        } catch (e) {
          out.failed = true;
          return out;
        }
        if (v && v.credId && (v.class || STORE_CLASS_LOCKKEY) === STORE_CLASS_ACCOUNTKEY) out.accountPk = true;
        if (v && v.credId && (v.class || STORE_CLASS_LOCKKEY) === STORE_CLASS_LOCKKEY) out.lockPk = true;
      }
    }
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
 * @param {any} kv
 * @returns {Promise<boolean>}
 */
export async function isLockEffectivelyConfigured(kv) {
  if (!kv) return true;
  try {
    /* 1. KV 标记 */
    try {
      const marker = await kv.get('layer:' + LAYER_LOCK);
      if (marker === '1') return true;
    } catch (e) {
      return true;
    }
    /* 2. 真实凭证（密码 / 通行密钥） */
    const real = await realCredentialPresence(kv);
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
 * @param {any} kv
 * @returns {Promise<boolean>}
 */
export async function isAccountEffectivelyConfigured(kv) {
  if (!kv) return true;
  try {
    try {
      const marker = await kv.get('layer:' + LAYER_ACCOUNT);
      if (marker === '1') return true;
    } catch (e) {
      return true;
    }
    const real = await realCredentialPresence(kv);
    if (real.failed) return true;
    if (real.accountPw || real.accountPk) return true;
    return false;
  } catch (e) {
    return true;
  }
}
