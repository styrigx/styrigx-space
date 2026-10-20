/**
 * GET /api/session-epoch
 * 返回当前 session epoch（{"epoch":N}），供子站 middleware 缓存。
 * 公开接口，无需认证。Cache-Control: public, max-age=60。
 * （应用凭证删除后不再返回 app 字段。）
 *
 * fail closed：KV 未绑定或读取出错时返回 503（绝不返回 {epoch:0}，
 * 否则 子站 会缓存 0 而放行旧 cookie）；
 * key 确实不存在时才返回 {epoch:0}（与主站 getSessionEpoch 一致）。
 *
 * 注意：「锁定所有设备」（session-epoch +1）走 /api/lock-all-devices；
 * 改密码/删密码/删锁屏密钥时也各自 +1（见 owner-password.js、owner-passkey.js）。
 * 子站 缓存 epoch 约 60 秒（Cache-Control: max-age=60），
 * 锁定后 子站 最多 60 秒内生效。
 *
 * @param {any} context
 */
import { SESSION_EPOCH_KEY } from '../_kernel/realms.js';

export async function onRequestGet(context) {
  const { env } = context;
  const kv = env && env.OWNER_KV;
  if (!kv) {
    return Response.json(
      { ok: false, error: 'epoch' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  let v;
  try {
    v = await kv.get(SESSION_EPOCH_KEY);
  } catch (e) {
    return Response.json(
      { ok: false, error: 'epoch' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const epoch = v === null || v === undefined ? 0 : parseInt(v, 10) || 0;
  return new Response(JSON.stringify({ epoch }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
