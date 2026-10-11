/**
 * 2.11：层配置状态查询（供 UI 显示「由根密钥代管 / 已接管」）。
 *
 * GET /api/layer-status
 * - 需要 owner 会话（任何 by）
 * - 返回 { ok:true, layers: { owner: 'takeover'|'configured', lock: ..., app: { aud: ... } } }
 * - KV 读取失败 → 503（fail closed）
 */
import { verifySessionDetailed } from '../_middleware.js';
import { ROLE_OWNER } from '../_kernel/session.js';
import { isLayerConfigured, LAYER_OWNER, LAYER_LOCK, layerApp } from '../_kernel/layers.js';
import { getApp } from '../_kernel/app-registry.js';

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/** @param {any} context */
async function handleGet(context) {
  const { request, env } = context;
  const kv = env && env.OWNER_KV;
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok || sess.role !== ROLE_OWNER) {
    return Response.json({ ok: false, error: 'session' }, { status: 401 });
  }

  try {
    const ownerCfg = await isLayerConfigured(kv, LAYER_OWNER);
    const lockCfg = await isLayerConfigured(kv, LAYER_LOCK);
    const apps = {};
    try {
      const appList = getApp ? [] : [];
      // 从 KV 列出已配置的 app 层
      const list = await kv.list({ prefix: 'layer:app:' });
      for (const k of list.keys || []) {
        const aud = k.name.slice('layer:app:'.length);
        if (aud) apps[aud] = 'configured';
      }
    } catch (e) {}
    return Response.json({
      ok: true,
      layers: {
        owner: ownerCfg ? 'configured' : 'takeover',
        lock: lockCfg ? 'configured' : 'takeover',
        app: apps,
      },
    });
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }
}
