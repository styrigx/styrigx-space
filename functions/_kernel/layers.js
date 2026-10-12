/**
 * 2.11：分层接管（layer takeover）。
 *
 * 三层：owner（owner passkey/密码）、lock（锁屏 passkey/密码）、app:<aud>（应用类 passkey）。
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
