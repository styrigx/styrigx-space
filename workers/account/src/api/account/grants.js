/**
 * POST /api/account/grants：应用授权（终端 app allow | deny）。v6 P4（定稿 v5.2 §十三）起只认 v6 会话：路由档 root（permits 判过；
 * sudo 借来的 root 也算），没有 → 401 session；旧进站会话 / 账号 session / reauth 票删除。
 *
 * { action }（同源）：
 * - list → { ok, grants }
 * - revoke { app } → 删这一行，回新列表
 * - add { app } → 写回这一行（by = root），回新列表
 * grants 每项：{ app, name（英文原文，界面按字符串表翻译）, scopes, sensitive, granted, grantedAt, by, device:{ name, gone } | null }
 * device：授权时的设备（那台设备的行不在了 → gone = true）。审计：grants-add、grants-revoke。
 * 另在身份审计记 app allow|deny <app>（sudo 记真正执行的人 + via sudo）。
 */
import { json, apiError } from '../../lib/http.js';
import { SCOPES } from '../../core/scopes.js';
import { APP_IDS, isAppId, scopesOfApp, listGrants, addGrant, revokeGrant } from '../../core/grants.js';
import { getDevice, deviceView } from '../../core/devices.js';
import { writeAudit } from '../../core/audit.js';
import { writeUserAudit } from '../../core/user-audit.js';
import { dbReady } from '../../lib/db.js';
import { readPost, clientAddress, guarded, v6Admitted, auditActor } from './_request.js';

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
  /* v6 P4（定稿 v5.2 §十三）：只认 v6 会话（root 档，permits 判过）；旧会话 / reauth 票删除 */
  const v6 = await v6Admitted(context);
  if (!v6) return apiError(401, 'session');
  if (!dbReady(env)) return apiError(500, 'config');
  if (action !== 'list' && action !== 'revoke' && action !== 'add') return apiError(400, 'action');

  if (action !== 'list') {
    const app = body.app;
    if (!isAppId(app)) return apiError(400, 'params');
    try {
      if (action === 'add') await addGrant(env, app, { deviceId: '', by: 'root' });
      else await revokeGrant(env, app);
    } catch (e) {
      return apiError(503, 'server');
    }
    await writeAudit(env, clientAddress(request), 'grants-' + action);
    const who = auditActor(v6);
    await writeUserAudit(env, { uid: who.uid, command: 'app ' + (action === 'add' ? 'allow' : 'deny') + ' ' + app + who.suffix, ok: true, ip: clientAddress(request) });
  }
  let grants;
  try { grants = await grantListView(env); } catch (e) { return apiError(503, 'server'); }
  return json(200, { ok: true, grants: grants });
});
