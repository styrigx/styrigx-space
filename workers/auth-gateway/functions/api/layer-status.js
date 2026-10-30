/**
 * 2.11：层配置状态查询（供 UI 显示「由根凭证代管 / 已接管」）。
 *
 * GET /api/layer-status
 * - 需要admin 会话（任何 by）
 * - 返回 { ok:true, layers: { account: 'takeover'|'configured', lock: ... } }
 * - 「已配置」由 D1 里的真实凭证推出（_kernel/layers.js；读取失败按已配置）
 * - 补充二：会话有效时顺带触发重置开关计时（只计时，不签票不标记已用；
 *   失败不影响返回；访客无会话到不了这里，不读开关）
 */
import { verifyLockSession } from '../_kernel/lock-session.js';
import { ROLE_ADMIN } from '../_kernel/lock-session.js';
import { isLayerConfigured, LAYER_ACCOUNT, LAYER_LOCK } from '../_kernel/layers.js';
import { REALM_LOCK, REALM_ACCOUNT } from '../_kernel/realms.js';
import { touchLockResetSwitch } from '../_kernel/lock-reset-switch.js';
import { json, apiError } from '../_kernel/lib/http.js';

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
  const lockDb = env && env[REALM_LOCK.d1Binding]; /* D1_LOCK_AUTH：lock 的行 + 恢复开关 */
  if (!lockDb || !(env && env[REALM_ACCOUNT.d1Binding])) {
    return apiError(500, 'config');
  }

  const sess = await verifyLockSession(request, env);
  if (!sess.ok || sess.role !== ROLE_ADMIN) {
    return apiError(401, 'session');
  }

  /* 补充二：管理页加载时触发开关计时（只计时，不签票不标记已用；
     失败不影响页面加载；访客到不了这里） */
  try {
    await touchLockResetSwitch(lockDb);
  } catch (e) {}

  try {
    const accountCfg = await isLayerConfigured(env, LAYER_ACCOUNT);
    const lockCfg = await isLayerConfigured(env, LAYER_LOCK);
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
