/**
 * GET /api/session-epoch
 * 返回当前 session epoch，供 blog/book 的 middleware 缓存。
 * 公开接口，无需认证。Cache-Control: public, max-age=60。
 *
 * @param {any} context
 */
export async function onRequestGet(context) {
  const { env } = context;
  let epoch = 0;
  try {
    if (env && env.OWNER_KV) {
      epoch = parseInt(await env.OWNER_KV.get('session-epoch') || '0', 10) || 0;
    }
  } catch (e) {}
  return new Response(JSON.stringify({ epoch }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
