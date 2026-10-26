/**
 * 2.11：层配置状态查询（供 UI 显示「由根凭证代管 / 已接管」）。
 *
 * GET /api/layer-status
 * - 需要admin 会话（任何 by）
 * - 返回 { ok:true, layers: { account: 'takeover'|'configured', lock: ... } }
 * - KV 读取失败 → 503（fail closed）
 * - 补充二：会话有效时顺带触发重置开关计时（只计时，不签票不标记已用；
 *   失败不影响返回；访客无会话到不了这里，不读开关）
 */
import { verifyLockSession } from '../_kernel/lock-session.js';
import { ROLE_ADMIN } from '../_kernel/lock-session.js';
import { isLayerConfigured, LAYER_ACCOUNT, LAYER_LOCK } from '../_kernel/layers.js';
import { touchLockResetSwitch } from '../_kernel/lock-reset-switch.js';
import { json, apiError } from '../_kernel/http.js';

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return apiError(500, 'server');
  }
}

/** @param {any} context */
async function handleGet(context) {
  const { request, env } = context;
  const kv = env && env.KV_LOCK_DOOR;
  const akv = env && env.KV_ACCOUNT_LOGIN; /* account-* 键 */
  if (!kv || !akv) {
    return apiError(500, 'config');
  }

  const sess = await verifyLockSession(request, env);
  if (!sess.ok || sess.role !== ROLE_ADMIN) {
    return apiError(401, 'session');
  }

  /* 补充二：管理页加载时触发开关计时（只计时，不签票不标记已用；
     失败不影响页面加载；访客到不了这里） */
  try {
    await touchLockResetSwitch(kv, env && env.D1_LOCK_RESET);
  } catch (e) {}

  try {
    const accountCfg = await isLayerConfigured(akv, LAYER_ACCOUNT);
    const lockCfg = await isLayerConfigured(kv, LAYER_LOCK);
    return json(200, {
      ok: true,
      layers: {
        account: accountCfg ? 'configured' : 'takeover',
        lock: lockCfg ? 'configured' : 'takeover',
      },
    });
  } catch (e) {
    return apiError(503, 'server');
  }
}
