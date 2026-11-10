/**
 * 会话自检接口：前端唯一的「现在是什么状态、接下来去哪」的来源。
 * GET /api/lock-session-check[?return=<url>]
 * - 有有效 sgx-space-session 会话（进门）→ 200 {ok:true, by, exp, next}
 *   - by：进门方式（password | passkey | link），只用于展示（例如「你是用分享链接进来的」），不分等级（方案 3.7）
 *   - exp：会话到期（毫秒）
 *   - 带 return：next = 服务端校验后的去处（与首页 302 同一个 resolveReturn：站内路径或 *.styrigx.com 白名单，不合法回首页）
 *   - 不带 return：next = null
 * - 否则 → 401 {ok:false}
 * 锁屏前端解锁成功后、页面状态与 cookie 可能不一致时（切回标签页、bfcache 恢复）都只问这里，
 * 拿到 next 直接跳过去；不再「重载同一地址等 L1 302」（那依赖锁屏页本身过网关，2026-10-21 线上不成立）。
 * 只接受 GET；验签用 core/lock-session.js 的 verifyLockSession，回跳用 core/return.js 的 resolveReturn（都与 middleware 同一份）。
 */
import { verifyLockSession } from '../core/lock-session.js';
import { resolveReturn } from '../core/return.js';
import { json } from '../lib/http.js';

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const sess = await verifyLockSession(request, env);
  if (!sess.ok) return json(401, { ok: false });
  let next = null;
  let ret = '';
  try {
    ret = new URL(request.url).searchParams.get('return') || '';
  } catch (e) {}
  if (ret) next = resolveReturn(ret);
  return json(200, { ok: true, by: sess.by, exp: sess.exp || 0, next });
}
