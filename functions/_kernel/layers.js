/**
 * 2.11：分层接管（layer takeover）。
 *
 * 三层：owner（ownerkey：站长密码/站长通行密钥）、lock（lockkey：解锁密码/
 * 锁屏通行密钥）、app:<aud>（<aud>key，如 bookkey）。钥匙命名见 key-names.js。
 *
 * 规则：
 * - 某层没有自己的凭证时，root 可代开该层。
 * - 该层一旦配置自己的凭证，root 对该层失效（403）。
 * - "是否已配置"从 KV 读；KV 读取失败按已配置处理（root 被拒，fail closed）。
 *
 * KV 键：
 * - layer:owner = "1"（已配置 owner 凭证）
 * - layer:lock = "1"（已配置 lock 凭证）
 * - layer:app:<aud> = "1"（已配置该 aud 的 app 凭证）
 */

import { ownerPasskeyKey, OWNER_PASSKEY_PREFIX, STORE_CLASS_OWNERKEY, STORE_CLASS_LOCKKEY } from './key-names.js';

/* 层标识 */
export const LAYER_OWNER = 'owner';
export const LAYER_LOCK = 'lock';
/** @param {string} aud */
export function layerApp(aud) { return 'app:' + aud; }
/* 锁屏凭证被清空、owner 接管中的标记（批次 B #10）。
   删光 lock 凭证且 owner 已配置时置 '1'（保留 layer:lock 不清），
   锁屏不再出现根凭证直接解锁入口，只显示访客 + 重置锁屏；
   经重置锁屏或门内管理页新增任一 lock 凭证时清除。 */
export const LOCK_EMPTIED_KEY = 'layer:lock-emptied';

/** @param {any} kv */
export async function setLockEmptied(kv) {
  if (!kv) throw new Error('kv-missing');
  await kv.put(LOCK_EMPTIED_KEY, '1');
}

/** @param {any} kv */
export async function clearLockEmptied(kv) {
  if (!kv) throw new Error('kv-missing');
  await kv.delete(LOCK_EMPTIED_KEY);
}

/** @param {any} kv @returns {Promise<boolean>} */
export async function isLockEmptied(kv) {
  if (!kv) return false;
  try {
    return (await kv.get(LOCK_EMPTIED_KEY)) === '1';
  } catch (e) {
    return false;
  }
}

/**
 * 检查某层是否已配置自己的凭证。
 * 2.11 定稿：KV 读取失败（或无 KV）按已配置处理（root 被拒，fail closed），不再抛错。
 * @param {any} kv
 * @param {string} layer 'owner' | 'lock' | 'app:<aud>'
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
 * 真实凭证盘点（单次遍历，供 isLock/isOwner/isBootstrap 共用）。
 * 只读真实凭证（密码 hash、通行密钥 class），不读 layer:* 标记。
 * 任何一步读取失败 → failed=true（调用方按已配置处理，fail closed）。
 * @param {any} kv
 * @returns {Promise<{ownerPw:boolean, lockPw:boolean, ownerPk:boolean, lockPk:boolean, failed:boolean}>}
 */
async function realCredentialPresence(kv) {
  const out = { ownerPw: false, lockPw: false, ownerPk: false, lockPk: false, failed: false };
  try {
    const ownerPw = await kv.get('owner-pw', 'json');
    if (ownerPw && ownerPw.hash) out.ownerPw = true;
  } catch (e) {
    out.failed = true;
    return out;
  }
  try {
    const lockPw = await kv.get('lock-pw', 'json');
    if (lockPw && lockPw.hash) out.lockPw = true;
  } catch (e) {
    out.failed = true;
    return out;
  }
  try {
    let idx = null;
    try {
      idx = await kv.get('owner-passkey-index', 'json');
    } catch (e) {
      out.failed = true;
      return out;
    }
    if (Array.isArray(idx)) {
      for (const credId of idx) {
        let v = null;
        try {
          v = await kv.get(ownerPasskeyKey(credId), 'json');
        } catch (e) {
          out.failed = true;
          return out;
        }
        if (v && v.credId && (v.class || STORE_CLASS_LOCKKEY) === STORE_CLASS_OWNERKEY) out.ownerPk = true;
        if (v && v.credId && (v.class || STORE_CLASS_LOCKKEY) === STORE_CLASS_LOCKKEY) out.lockPk = true;
      }
    } else {
      /* 索引不存在：用 kv.list 补查 */
      let list = null;
      try {
        list = await kv.list({ prefix: OWNER_PASSKEY_PREFIX });
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
        if (v && v.credId && (v.class || STORE_CLASS_LOCKKEY) === STORE_CLASS_OWNERKEY) out.ownerPk = true;
        if (v && v.credId && (v.class || STORE_CLASS_LOCKKEY) === STORE_CLASS_LOCKKEY) out.lockPk = true;
      }
    }
  } catch (e) {
    out.failed = true;
  }
  return out;
}

/**
 * 锁屏层是否"有效已配置"（三处共用：root-auth / root-session / lock-config）。
 *
 * 口径统一：KV 标记 layer:lock 为 '1'，或真实锁屏凭证存在
 * （class=lock 的通行密钥，或 lock-pw 有 hash），或 layer:lock-emptied 为 '1'
 * （锁屏凭证被清空、owner 接管中，根凭证代开继续被拒），或任何读取失败，
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
      const marker = await kv.get('layer:lock');
      if (marker === '1') return true;
    } catch (e) {
      return true;
    }
    /* 1b. 锁屏凭证被清空、owner 接管中：同样算已配置（根凭证代开被拒） */
    try {
      const emptied = await kv.get(LOCK_EMPTIED_KEY);
      if (emptied === '1') return true;
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
 * 站长层是否"有效已配置"（与 isLockEffectivelyConfigured 镜像，批次 B #10/#16）。
 * 口径：KV 标记 layer:owner 为 '1'，或真实站长凭证存在
 * （class=owner 的通行密钥，或 owner-pw 有 hash），或任何读取失败，都算已配置。
 * @param {any} kv
 * @returns {Promise<boolean>}
 */
export async function isOwnerEffectivelyConfigured(kv) {
  if (!kv) return true;
  try {
    try {
      const marker = await kv.get('layer:owner');
      if (marker === '1') return true;
    } catch (e) {
      return true;
    }
    const real = await realCredentialPresence(kv);
    if (real.failed) return true;
    if (real.ownerPw || real.ownerPk) return true;
    return false;
  } catch (e) {
    return true;
  }
}

/**
 * 是否新站启动模式（批次 B #16）：owner 与 lock 两层真实凭证都为 0。
 * 边界：layer:owner / layer:lock 标记独有、无真实凭证的残留状态，
 * 或 layer:lock-emptied 残留，或任何读取失败，一律按已配置处理
 * （不进启动模式），与 lock-config.js 的标记独有口径一致；
 * 该状态下用户需走重置锁屏恢复。
 * @param {any} kv
 * @returns {Promise<boolean>}
 */
export async function isBootstrapStation(kv) {
  if (!kv) return false;
  try {
    try {
      if ((await kv.get('layer:owner')) === '1') return false;
      if ((await kv.get('layer:lock')) === '1') return false;
      if ((await kv.get(LOCK_EMPTIED_KEY)) === '1') return false;
    } catch (e) {
      return false;
    }
    const real = await realCredentialPresence(kv);
    if (real.failed) return false;
    return !real.ownerPw && !real.ownerPk && !real.lockPw && !real.lockPk;
  } catch (e) {
    return false;
  }
}
