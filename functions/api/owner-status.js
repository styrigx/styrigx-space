/**
 * 2.4.0 安全与隐私：只读状态接口。
 * GET /api/owner-status → { ok:true, password:bool, passkey:bool }
 * 只返回「是否已设置」，不返回任何敏感数据；无需鉴权。
 * passkey 读 owner-passkey-index（不走 kv.list，避开最终一致延迟）。
 * 外层 try/catch：异常一律返回 { ok:false }，不暴露细节。
 */

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    const kv = context.env && context.env.OWNER_KV;
    let password = false;
    let passkey = false;
    if (kv) {
      try {
        const pw = await kv.get('owner-pw', 'json');
        password = !!(pw && pw.hash);
      } catch (e) {}
      try {
        const idx = await kv.get('owner-passkey-index', 'json');
        passkey = !!(Array.isArray(idx) && idx.length);
      } catch (e) {}
    }
    return Response.json({ ok: true, password: password, passkey: passkey });
  } catch (e) {
    return Response.json({ ok: false }, { status: 500 });
  }
}
