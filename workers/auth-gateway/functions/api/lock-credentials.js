/**
 * 锁屏凭证状态只读接口。
 *
 * GET /api/lock-credentials → { ok:true, password:bool, passkey:bool }
 * - 只读：锁屏密码是否有 hash、是否有锁屏通行密钥。
 * - 鉴权：有效站长会话（任何 by），或有效的重置锁屏门票（door=lockreset）——重置锁屏页没有会话也要能显示。
 * - 只返回「是否已设置」，不返回任何敏感数据。
 * - KV 读取失败 → 503（fail closed），不按未设置退回。
 * 外层 try/catch：异常一律返回 { ok:false }，不暴露细节。
 */
import { verifySessionDetailed } from '../_middleware.js';
import { ROLE_OWNER } from '../_kernel/lock-session.js';
import { verifyDoorCookie, DOOR_LOCKRESET } from '../_kernel/tickets.js';
import { getPasskeys, PK_CLASS_LOCK } from '../_kernel/passkey-store.js';
import { REALM_LOCK } from '../_kernel/realms.js';

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return Response.json({ ok: false }, { status: 500 });
  }
}

/** @param {any} context */
async function handleGet(context) {
  const { request, env } = context;
  const kv = env && env.KV_LOCK_DOOR;
  if (!kv) {
    /* 未绑 KV：会话/票据校验本身也读 KV，直接按配置错误处理（fail closed）。
       注意：实际请求中 verifySessionDetailed/verifyDoorCookie 无 KV 时均返回
       无效，正常走 401；此处为纵深防御。 */
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* 鉴权：有效站长会话，或重置锁屏门票 */
  let authed = false;
  try {
    const sess = await verifySessionDetailed(request, env);
    if (sess.ok && sess.role === ROLE_OWNER) authed = true;
  } catch (e) {}
  if (!authed) {
    try {
      const st = await verifyDoorCookie(request, env, DOOR_LOCKRESET);
      if (st.ok) authed = true;
    } catch (e) {}
  }
  if (!authed) {
    return Response.json({ ok: false, error: 'session' }, { status: 401 });
  }

  /* 只读锁屏凭证状态 */
  try {
    const pw = await kv.get(REALM_LOCK.kv.password, 'json');
    const password = !!(pw && pw.hash);
    const keys = await getPasskeys(kv);
    const passkey = keys.some(function (k) {
      return (k.class || PK_CLASS_LOCK) === PK_CLASS_LOCK;
    });
    return Response.json(
      { ok: true, password: password, passkey: passkey },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    /* KV 读取失败 → 503 fail closed */
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }
}
