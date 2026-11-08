/**
 * 账号登录会话（sudo root；票 TICKET.session，cookie sgx-account-session）：签发、验证、结束，以及改钥匙后的整体轮换。
 *
 * 票内容 by.epoch.authAt.exp.deviceId（格式与签名串见 lib/ticket.js；和命名 v2 之前一字不差，已登录的设备不受影响）：
 * - by：password | passkey（恢复密钥不签会话：丢了钥匙走 reset 重设，再正常登录）
 * - epoch：session 纪元（account_epoch name='session'；改钥匙、全部退出、reset finish 登出时 +1）
 * - authAt：本次登录验证时刻；纪元推进后重签时保留原值
 * - deviceId：本次登录的设备（core/devices.js；单独退出后 reason=revoked）
 * 与进站会话（sgx-lock-session）完全独立：进站会话从不被当作账号登录。
 *
 * 缺 SGX_ACCOUNT_PRIVATE / PUBLIC：签发 503 config（signingMissing），验证一律失败（no-pubkey）；只影响账号，网站其余部分不受影响。
 *
 * 只 import workers/account/src/lib/ 和本目录。
 */
import { readEpoch, bumpEpoch } from '../lib/db.js';
import { apiError } from '../lib/http.js';
import { signTicket, parseTicket, verifyTicket, ticketCookie, clearTicketCookie } from '../lib/ticket.js';
import { TICKET, EPOCH, SIGNING_PRIVATE, SIGNING_PUBLIC } from './config.js';
import { newDeviceId, isDeviceId, isRevoked, getDevice, putDevice, recordLogin, deviceInfo, clientPlace, pruneOtherDevices, TOUCH_INTERVAL_MS } from './devices.js';

export { readEpoch, bumpEpoch };

const CONF = TICKET.session;

/** 这个 by 能不能签 session 票 @param {any} by */
export function isSessionBy(by) {
  return CONF.bys.indexOf(by) !== -1;
}

/** 签名钥匙是否齐全（私钥 + 公钥） @param {any} env */
export function signingReady(env) {
  return !!(env && env[SIGNING_PRIVATE] && env[SIGNING_PUBLIC]);
}

/** 缺签名钥匙时的统一响应（503 config） */
export function signingMissing() {
  return apiError(503, 'config', { message: 'SGX_ACCOUNT_PRIVATE / SGX_ACCOUNT_PUBLIC not configured' });
}

/**
 * session 票值（测试和重签用）。
 * @param {string} privatePem @param {{by:string, epoch:number, authAt:number, deviceId:string, now?:number}} t now：毫秒（测试用）
 */
export function signSessionTicket(privatePem, t) {
  return signTicket(privatePem, CONF, { by: t.by, epoch: t.epoch, at: t.authAt, exp: (t.now || Date.now()) + CONF.maxAge * 1000, deviceId: t.deviceId });
}

/** 解析 session 票值（不验签） @param {string} val */
export function parseSessionTicket(val) {
  const p = parseTicket(CONF, val);
  return p ? { by: p.by, epoch: p.epoch, authAt: p.at, exp: p.exp, deviceId: p.deviceId || '', sig: p.sig } : null;
}

/**
 * @typedef {{ok:boolean, reason:string, by?:string, epoch?:number, authAt?:number, exp?:number, deviceId?:string}} SessionCheck
 */

/**
 * 验请求里的 session 票（只认 sgx-account-session，绝不读进站会话）；通过时刷新设备 lastSeen（节流）。
 * @param {any} request @param {any} env
 * @returns {Promise<SessionCheck>}
 *   reason: ok / no-cookie / bad-format / expired / not-yet / no-pubkey / epoch-changed / d1-error / bad-sig / revoked
 */
export async function verifySession(request, env) {
  const v = await verifyTicket(request, env, CONF, SIGNING_PUBLIC, () => readEpoch(env, EPOCH.session));
  if (!v.ok) return { ok: false, reason: v.reason };
  const deviceId = v.deviceId || '';
  /* 单独退出的设备：每个请求读一次 D1 主库（不缓存），退出后那台的下一个请求就被拒 */
  try {
    if (await isRevoked(env, deviceId)) return { ok: false, reason: 'revoked' };
  } catch (e) {
    return { ok: false, reason: 'd1-error' };
  }
  await touchDevice(env, request, { deviceId, by: /** @type {string} */ (v.by), authAt: /** @type {number} */ (v.at) });
  return { ok: true, reason: 'ok', by: v.by, epoch: v.epoch, authAt: v.at, exp: v.exp, deviceId };
}

/**
 * 刷新设备的 lastSeen（至多 30 分钟一次）；记录不见了就按本次请求补一条。尽力而为。
 * @param {any} env @param {any} request @param {{deviceId:string, by:string, authAt:number}} p
 */
async function touchDevice(env, request, p) {
  try {
    const now = Date.now();
    const rec = await getDevice(env, p.deviceId);
    if (!rec) {
      await putDevice(env, Object.assign({ deviceId: p.deviceId, by: p.by, createdAt: p.authAt, authAt: p.authAt, lastSeen: now }, deviceInfo(request, null)));
      return;
    }
    if (now - (rec.lastSeen || 0) < TOUCH_INTERVAL_MS) return;
    const place = clientPlace(request);
    rec.lastSeen = now;
    if (place.country) rec.country = place.country;
    if (place.city) rec.city = place.city;
    await putDevice(env, rec);
  } catch (e) { /* 写不进去不影响验证 */ }
}

/**
 * 签发 session cookie（fail closed，永不抛错）。成功 null；失败 { status, body }：
 * 缺签名钥匙 503 config；读纪元出错 503 server；签名出错 500 sign-failed。
 * @param {any} env @param {Headers} headers @param {string} by passkey | password
 * @param {{authAt?:number, epoch?:number, deviceId?:string, record?:boolean, request?:any, device?:any}} [opts]
 *   authAt：默认现在（新登录），重签时传原值；epoch：默认读 D1；deviceId：沿用的设备（不给就新建）；
 *   record：是否写设备记录（默认 true，重签传 false）；request / device：写设备记录用（UA、地点头、前端 hints）
 * @returns {Promise<{status:number, body:object}|null>}
 */
export async function issueSession(env, headers, by, opts) {
  const o = opts || {};
  if (!signingReady(env)) return { status: 503, body: { ok: false, error: 'config' } };
  let epoch = o.epoch;
  if (typeof epoch !== 'number') {
    try { epoch = await readEpoch(env, EPOCH.session); } catch (e) { return { status: 503, body: { ok: false, error: 'server' } }; }
  }
  try {
    const authAt = typeof o.authAt === 'number' ? o.authAt : Date.now();
    const deviceId = isDeviceId(o.deviceId || '') ? /** @type {string} */ (o.deviceId) : newDeviceId();
    const v = await signSessionTicket(env[SIGNING_PRIVATE], { by: by, epoch: epoch, authAt: authAt, deviceId: deviceId });
    headers.append('Set-Cookie', ticketCookie(CONF, v));
    if (o.record !== false) {
      try {
        await recordLogin(env, deviceId, by, authAt, deviceInfo(o.request, o.device));
      } catch (e) { /* 设备记录写不进去不挡登录：验证时 touchDevice 会补 */ }
    }
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'sign-failed' } };
  }
  return null;
}

/**
 * 结束会话的 Set-Cookie：清 session，连同挂在它上面的 reauth 一起清（reset 不归会话管，不碰）。
 * @param {Headers} headers
 */
export function endSession(headers) {
  headers.append('Set-Cookie', clearTicketCookie(TICKET.session));
  headers.append('Set-Cookie', clearTicketCookie(TICKET.reauth));
}

/**
 * 登录签票的选项：同一浏览器已有有效 session 就沿用它的 deviceId，不多记一台设备。
 * @param {any} request @param {any} env @param {any} body device：前端 navigator.userAgentData 给的型号 / 平台
 */
export async function sessionOpts(request, env, body) {
  let deviceId = '';
  try {
    const cur = await verifySession(request, env);
    if (cur.ok && cur.deviceId) deviceId = cur.deviceId;
  } catch (e) {}
  return { deviceId: deviceId || undefined, request: request, device: body && body.device };
}

/**
 * 改了钥匙 / 全部退出：session 纪元 +1（其他设备的 session 和 reauth 票全部失效）→ 本机 session 按原 by/authAt 重签 →
 * 删其他设备的行。本机的 reauth 票由调用方按新纪元重签（core/reauth.js reissueReauth）。出错抛错（调用方 503）。
 * @param {any} env @param {Headers} headers @param {SessionCheck} keep 本机的 session（verifySession 的结果；无效 = 不重签、一台都不留）
 * @returns {Promise<number>} 新纪元
 */
export async function rotateSessions(env, headers, keep) {
  const ne = await bumpEpoch(env, EPOCH.session);
  const keepId = keep && keep.ok ? keep.deviceId || '' : '';
  if (keep && keep.ok) {
    const err = await issueSession(env, headers, /** @type {string} */ (keep.by), { authAt: keep.authAt, epoch: ne, deviceId: keepId, record: false });
    if (err) throw new Error('reissue-failed');
  }
  await pruneOtherDevices(env, keepId);
  return ne;
}
