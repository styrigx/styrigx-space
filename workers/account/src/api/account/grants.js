/**
 * POST /api/account/grants：应用授权（授权卡、登录后的同意卡）。要进站会话 + 有效 session（401 account）。
 *
 * { action }（同源）：
 * - list → { ok, grants }
 * - revoke { app } → 删这一行（只降权，不要 reauth），回新列表
 * - add { app } → 再要挂在本机 session 上的 reauth 票（403 reauth），写回这一行，回新列表
 * grants 每项：{ app, name（英文原文，界面按字符串表翻译）, scopes, sensitive, granted, grantedAt, by, device:{ name, gone } | null }
 * device：授权时的设备（那台设备的行不在了 → gone = true）。审计：grants-add、grants-revoke。
 *
 * v6（割接）：请求带有效的 v6 新会话、且这条路由的档够（root，permits 判过；sudo 借来的 root 也算）→ 不要进站会话 / 账号 session /
 * reauth 票（v6 的「每次重验」就是 su root / sudo 本身），直接做；另在身份审计记 app allow|deny <app>（sudo 记真正执行的人 + via sudo）。
 * 旧会话照旧（新旧并存，旧入口 P4 删）。
 */
import { json, apiError } from '../../lib/http.js';
import { verifySession } from '../../core/session.js';
import { verifyReauth } from '../../core/reauth.js';
import { SCOPES } from '../../core/scopes.js';
import { APP_IDS, isAppId, scopesOfApp, listGrants, addGrant, revokeGrant } from '../../core/grants.js';
import { getDevice, deviceView } from '../../core/devices.js';
import { writeAudit } from '../../core/audit.js';
import { writeUserAudit } from '../../core/user-audit.js';
import { dbReady } from '../../lib/db.js';
import { readPost, lockDenial, clientAddress, guarded, v6Admitted, auditActor } from './_request.js';

/**
 * 授权卡列表：全部应用按作用域表顺序，一项一张卡。
 * @param {any} env
 */
export async function grantListView(env) {
  const rows = await listGrants(env);
  /** @type {Record<string, any>} */
  const byApp = {};
  for (const r of rows) byApp[r.app] = r;
  /** @type {Record<string, any>} */
  const devCache = {};
  const out = [];
  for (const app of APP_IDS) {
    const meta = SCOPES.filter((s) => s.app === app);
    const r = byApp[app] || null;
    let device = null;
    if (r) {
      const id = r.deviceId || '';
      if (!(id in devCache)) {
        let d = null;
        try { d = id ? await getDevice(env, id) : null; } catch (e) { d = null; }
        devCache[id] = d ? { name: deviceView(d, '').name, gone: false } : { name: '', gone: true };
      }
      device = devCache[id];
    }
    out.push({
      app: app,
      name: meta[0].name,
      scopes: scopesOfApp(app),
      sensitive: meta.reduce((a, s) => a.concat(s.sensitive), /** @type {string[]} */ ([])),
      granted: !!r,
      grantedAt: r ? r.grantedAt : 0,
      by: r ? r.by : '',
      device: device,
    });
  }
  return out;
}

export const onRequestPost = guarded(async function (context) {
  const { request, env } = context;
  const rp0 = await readPost(request);
  if (!rp0.ok) return rp0.response;
  const { body, action } = rp0;
  const v6 = await v6Admitted(context);
  if (!v6) {
    const denied = lockDenial(request, env);
    if (denied) return denied;
  } else if (!dbReady(env)) return apiError(500, 'config');
  if (action !== 'list' && action !== 'revoke' && action !== 'add') return apiError(400, 'action');
  /** @type {any} */
  let acc = null;
  if (!v6) {
    acc = await verifySession(request, env);
    if (!acc.ok) return apiError(401, 'account', { reason: acc.reason });
  }

  if (action !== 'list') {
    const app = body.app;
    if (!isAppId(app)) return apiError(400, 'params');
    if (action === 'add' && !v6) {
      const rv = await verifyReauth(request, env, acc);
      if (!rv.ok) return apiError(403, 'reauth', { reason: rv.reason });
    }
    try {
      if (action === 'add') await addGrant(env, app, v6 ? { deviceId: '', by: 'root' } : { deviceId: acc.deviceId || '', by: acc.by || '' });
      else await revokeGrant(env, app);
    } catch (e) {
      return apiError(503, 'server');
    }
    await writeAudit(env, clientAddress(request), 'grants-' + action);
    if (v6) {
      const who = auditActor(v6);
      await writeUserAudit(env, { uid: who.uid, command: 'app ' + (action === 'add' ? 'allow' : 'deny') + ' ' + app + who.suffix, ok: true, ip: clientAddress(request) });
    }
  }
  let grants;
  try { grants = await grantListView(env); } catch (e) { return apiError(503, 'server'); }
  return json(200, { ok: true, grants: grants });
});
