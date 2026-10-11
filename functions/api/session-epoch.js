/**
 * GET /api/session-epoch
 * 返回当前 session epoch 与各应用纪元，供 blog/book 的 middleware 缓存。
 * 公开接口，无需认证。Cache-Control: public, max-age=60。
 *
 * 2.10.0：响应新增 app 字段，如 {"epoch":N,"app":{"book":M}}。
 * 字段只增不改，旧客户端不受影响。
 *
 * fail closed：KV 未绑定或读取出错时返回 503（绝不返回 {epoch:0}，
 * 否则 blog/book 会缓存 0 而放行旧 cookie）；
 * key 确实不存在时才返回 {epoch:0}（与主站 getSessionEpoch 一致）。
 * app-epoch:<aud> 缺失视为 0；读取出错 → 503。
 *
 * 注意：「锁定所有设备」（session-epoch +1）走 /api/owner-password
 * 的 lockout action（已有实现），不在这里另起 endpoint。
 * blog/book 缓存 epoch 约 60 秒（Cache-Control: max-age=60），
 * 锁定后 blog/book 最多 60 秒内生效。
 *
 * @param {any} context
 */
import { APP_WHITELIST } from '../_kernel/app-registry.js';

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
  /* 2.10.0：各应用纪元 */
  const app = {};
  try {
    for (const a of APP_WHITELIST) {
      const av = await kv.get('app-epoch:' + a.aud);
      app[a.aud] = av === null || av === undefined ? 0 : parseInt(av, 10) || 0;
    }
  } catch (e) {
    return Response.json(
      { ok: false, error: 'epoch' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  return new Response(JSON.stringify({ epoch, app }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
