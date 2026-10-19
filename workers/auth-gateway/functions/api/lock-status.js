/**
 * 锁屏凭证状态只读接口（2.11）。
 *
 * GET /api/lock-status → { ok:true, password:bool, passkey:bool }
 * - 只读：返回锁屏密码是否有 hash、是否有 class=lock 的通行密钥。
 * - 鉴权：有效 owner 会话（任何 by），或有效的 stepup 票据（scope=keys / lockreset）。
 *   修复 security-lock.js refreshStatus 读 /api/owner-status 的显示错误：
 *   owner-status 读的是 owner-pw + class=owner 通行密钥（且要求 owner 会话），
 *   只设了站长密码时锁屏页误显示「已设置」，只设了锁屏密码时误显示「未设置」
 *   且没有删除按钮，lockreset 页（无会话）直接 401。
 * - 只返回「是否已设置」，不返回任何敏感数据。
 * - KV 读取失败 → 503（fail closed），不按未设置退回。
 * 外层 try/catch：异常一律返回 { ok:false }，不暴露细节。
 */
import { verifySessionDetailed } from '../_middleware.js';
import { ROLE_OWNER } from '../_kernel/session.js';
import {
  verifyStepupCookie,
  STEPUP_SCOPE_KEYS,
  STEPUP_SCOPE_LOCKRESET,
} from './stepup.js';
import { getPasskeys, PK_CLASS_LOCK } from './owner-passkey.js';
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
  const kv = env && env.OWNER_KV;
  if (!kv) {
    /* 未绑 KV：会话/票据校验本身也读 KV，直接按配置错误处理（fail closed）。
       注意：实际请求中 verifySessionDetailed/verifyStepupCookie 无 KV 时均返回
       无效，正常走 401；此处为纵深防御。 */
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* 鉴权：有效 owner 会话，或 keys/lockreset 票据 */
  let authed = false;
  try {
    const sess = await verifySessionDetailed(request, env);
    if (sess.ok && sess.role === ROLE_OWNER) authed = true;
  } catch (e) {}
  if (!authed) {
    try {
      const st = await verifyStepupCookie(request, env);
      if (st.ok && (st.scope === STEPUP_SCOPE_KEYS || st.scope === STEPUP_SCOPE_LOCKRESET)) {
        authed = true;
      }
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
      return (k.class || 'lock') === PK_CLASS_LOCK;
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
