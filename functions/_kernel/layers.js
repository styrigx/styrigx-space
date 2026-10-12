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

/* 层标识 */
export const LAYER_OWNER = 'owner';
export const LAYER_LOCK = 'lock';
/** @param {string} aud */
export function layerApp(aud) { return 'app:' + aud; }

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
 * 锁屏层是否"有效已配置"（三处共用：root-auth / root-session / lock-config）。
 *
 * 口径统一：KV 标记 layer:lock 为 '1'，或真实锁屏凭证存在
 * （class=lock 的通行密钥，或 lock-pw 有 hash），或任何读取失败，
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
    /* 2. 真实凭证：锁屏密码 */
    try {
      const pw = await kv.get('lock-pw', 'json');
      if (pw && pw.hash) return true;
    } catch (e) {
      return true;
    }
    /* 3. 真实凭证：class=lock 的通行密钥（无 class 的旧凭据视为 lock） */
    try {
      let idx = null;
      try {
        idx = await kv.get('owner-passkey-index', 'json');
      } catch (e) {
        return true;
      }
      if (Array.isArray(idx)) {
        for (const credId of idx) {
          let v = null;
          try {
            v = await kv.get('owner-passkey:' + credId, 'json');
          } catch (e) {
            return true;
          }
          if (v && v.credId && (v.class || 'lock') === 'lock') return true;
        }
      } else {
        /* 索引不存在：用 kv.list 补查 */
        let list = null;
        try {
          list = await kv.list({ prefix: 'owner-passkey:' });
        } catch (e) {
          return true;
        }
        for (const k of (list && list.keys) || []) {
          let v = null;
          try {
            v = await kv.get(k.name, 'json');
          } catch (e) {
            return true;
          }
          if (v && v.credId && (v.class || 'lock') === 'lock') return true;
        }
      }
    } catch (e) {
      return true;
    }
    return false;
  } catch (e) {
    return true;
  }
}
