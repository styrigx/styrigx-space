/**
 * GET /api/session-epoch
 * 返回当前 session epoch，供 blog/book 的 middleware 缓存。
 * 公开接口，无需认证。Cache-Control: public, max-age=60。
 *
 * fail closed：KV 未绑定或读取出错时返回 503（绝不返回 {epoch:0}，
 * 否则 blog/book 会缓存 0 而放行旧 cookie）；
 * key 确实不存在时才返回 {epoch:0}（与主站 getSessionEpoch 一致）。
 *
 * 注意：「锁定所有设备」（session-epoch +1）走 /api/owner-password
 * 的 lockout action（已有实现），不在这里另起 endpoint。
 * blog/book 缓存 epoch 约 60 秒（Cache-Control: max-age=60），
 * 锁定后 blog/book 最多 60 秒内生效。
 *
 * @param {any} context
 */
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
    v = await kv.get('session-epoch');
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
