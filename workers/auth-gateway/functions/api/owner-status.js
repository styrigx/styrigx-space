/**
 * 2.4.0 安全与隐私：只读状态接口（2.11 修正版）。
 * GET /api/owner-status → { ok:true, password:bool, passkey:bool }
 * - 需要有效 owner 会话（访客/无会话 → 401，不再无鉴权）。
 * - 只看站长密码 + class=owner 的通行密钥（stepup 只认站长类；
 *   旧版"任何一类通行密钥都算有"会导致显示必然失败的通行密钥按钮、又藏掉根凭证）。
 * - 只返回「是否已设置」，不返回任何敏感数据。
 * 外层 try/catch：异常一律返回 { ok:false }，不暴露细节。
 */
import { verifySessionDetailed } from '../_middleware.js';
import { ROLE_OWNER } from '../_kernel/session.js';
import { getPasskeys, PK_CLASS_OWNER } from './owner-passkey.js';

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    const kv = context.env && context.env.OWNER_KV;
    /* 鉴权：需要有效 owner 会话 */
    const sess = await verifySessionDetailed(context.request, context.env);
    if (!sess.ok || sess.role !== ROLE_OWNER) {
      return Response.json({ ok: false, error: 'session' }, { status: 401 });
    }
    let password = false;
    let passkey = false;
    if (kv) {
      try {
        const pw = await kv.get('owner-pw', 'json');
        password = !!(pw && pw.hash);
      } catch (e) {}
      try {
        /* 只看 class=owner 的通行密钥 */
        const keys = await getPasskeys(kv);
        passkey = keys.some(function (k) { return (k.class || 'lock') === PK_CLASS_OWNER; });
      } catch (e) {}
    }
    return Response.json({ ok: true, password: password, passkey: passkey });
  } catch (e) {
    return Response.json({ ok: false }, { status: 500 });
  }
}
