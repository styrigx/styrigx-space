/**
 * POST /api/account/devices：设备会话。v6 P4（定稿 v5.2 §十三）起只认 v6 会话（没有 → 401 session）。
 *
 * v6 P4-3（定稿 v5.5 §五「设备会话的列表与踢出属后台控制，root 档（站长 sudo），列表为全站视图、列出全站会话」；
 * §七「站长打开账号页时设备卡列表直接可读，只有改动才预填 sudo」；§十一 2g「设备列表按 sgx-device 合并同一台设备的会话」）：
 * - list → { ok, devices:[{ n, path, since, expiresAt, current }] }：全站会话按设备标记归并（core/user-admin.js deviceList）；
 *   档 webmaster（站长直读，root 放行）。
 * - revoke { n } → 踢出第 n 台设备（它的全部会话；含本会话 → 400 current）；档 root（站长 sudo device rm <n>）。
 * - revoke-all → 踢出自己（本会话栈底用户）的其他全部会话，范围同 main（Gray 11-11 22:35）；档 root（站长 sudo device rm --all）。
 * 档在路由表（core/route-access.js /api/account/devices 的 actions），判断只经 context.auth.v6(action)（同 permits）；
 * sudo 借来的 root（api/sudo-route.js）同样经 context.auth.v6()，本会话 = 执行 sudo 的那个会话。
 */
import { json, apiError } from '../../lib/http.js';
import { readPost, clientAddress, guarded, v6Admitted, auditActor } from './_request.js';
import { deviceList } from '../../core/user-admin.js';
import { onDb } from '../../lib/db.js';
import { writeUserAudit } from '../../core/user-audit.js';

/**
 * @param {any} context @param {any} body @param {string} action @param {any} v 这条 action 的 v6 结论（已放行）
 */
async function v6Devices(context, body, action, v) {
  const { env, request } = context;
  const ip = clientAddress(request);
  const current = typeof v.sessionId === 'string' ? v.sessionId : '';
  const { devices, ids } = await deviceList(env, { current });
  if (action === 'list') return json(200, { ok: true, devices });
  const who = auditActor(v);
  if (action === 'revoke') {
    const n = Number(body.n);
    const list = Number.isInteger(n) && n >= 1 ? ids[n - 1] : undefined;
    if (!list || !list.length) return apiError(404, 'not-found');
    if (current && list.indexOf(current) !== -1) return apiError(400, 'current');
    await onDb(env, (d) => d.batch(list.flatMap((id) => [
      d.prepare('DELETE FROM account_session_stack WHERE session_id = ?').bind(id),
      d.prepare('DELETE FROM account_sessions WHERE id = ?').bind(id),
    ])));
    await writeUserAudit(env, { uid: who.uid, command: 'lock device ' + n + who.suffix, ok: true, ip });
    return json(200, { ok: true });
  }
  /* 范围同 main：只踢自己的其他会话（自己 = 本会话的栈底用户，account_sessions.uid；只取服务端会话） */
  const owner = await onDb(env, async (d) => {
    const r = current ? await d.prepare('SELECT uid FROM account_sessions WHERE id = ?').bind(current).first() : null;
    return r && Number.isInteger(Number(r.uid)) ? Number(r.uid) : null;
  });
  if (owner === null) return apiError(401, 'session');
  await onDb(env, (d) => d.batch([
    d.prepare('DELETE FROM account_session_stack WHERE session_id IN (SELECT id FROM account_sessions WHERE uid = ? AND id <> ?)').bind(owner, current),
    d.prepare('DELETE FROM account_sessions WHERE uid = ? AND id <> ?').bind(owner, current),
  ]));
  await writeUserAudit(env, { uid: who.uid, command: 'lock devices --all' + who.suffix, ok: true, ip });
  return json(200, { ok: true });
}

export const onRequestPost = guarded(async function (context) {
  const rp0 = await readPost(context.request);
  if (!rp0.ok) return rp0.response;
  const { body, action } = rp0;
  const v = await v6Admitted(context);
  if (!v) return apiError(401, 'session');
  if (action !== 'list' && action !== 'revoke' && action !== 'revoke-all') return apiError(400, 'action');
  /* 这条 action 的档（list webmaster；revoke / revoke-all root）：同一张路由表、同一个 permits */
  const va = await context.auth.v6(action);
  if (!va || va.allowed !== true) return apiError(403, 'permission', { need: va && va.level ? va.level : 'root' });
  return v6Devices(context, body, action, va);
});
