/**
 * 重置（sudo root reset；票 TICKET.reset，cookie sgx-account-reset）：钥匙都丢了时用恢复密钥换一张 3 分钟的票，
 * 只能在 /api/account/reset 里重设账号密码、增删通行密钥，最后 finish 决定其他设备怎么登出。
 *
 * - openReset：恢复密钥（core/recovery-key.js）验过 → 签 reset 票（by = recovery-key，纪元 = reset 纪元）。不签会话。
 *   成功审计写不进去就不签票（503 server，fail closed）。
 * - reset 票下的写操作都不碰会话；只有 finish { signOut } 决定登出：
 *   - all：session 纪元 +1，不重签本机，清本机 session / reauth；删全部设备行
 *   - others：session 纪元 +1；本机有 session 就按原 by/authAt 重签（没有就等于 all）；删其他设备行；清本机 reauth
 *   - none：会话一律不动
 *   三种都让 reset 纪元 +1（这张 reset 票用完即废）、清 reset cookie、写审计 reset-finish-<值>。
 *   finish 读一下本机 session 只是为了知道 others 要留哪台设备，不拿它当凭证。
 * - 和会话互不顶替：reset 票不能管理钥匙页（/api/account/keys 只认 reauth 票），reauth 票也进不了 /api/account/reset。
 *
 * 只 import workers/account/src/lib/ 和本目录。
 */
import { readEpoch, bumpEpoch, dbReady } from '../lib/db.js';
import { json, apiError } from '../lib/http.js';
import { signTicket, verifyTicket, ticketCookie, clearTicketCookie } from '../lib/ticket.js';
import { TICKET, EPOCH, BY_RECOVERY_KEY, SIGNING_PRIVATE, SIGNING_PUBLIC, RECOVERY_KEY_SECRET } from './config.js';
import { checkRecoveryKey } from './recovery-key.js';
import { writeAudit } from './audit.js';
import { signingReady, verifySession, issueSession, endSession } from './session.js';
import { listDevices, pruneOtherDevices } from './devices.js';

const CONF = TICKET.reset;

/** finish 的三种登出选择（API 值，全部小写） */
export const RESET_SIGNOUT = Object.freeze(['all', 'others', 'none']);

/**
 * reset 票值（测试用）。iat 默认现在。
 * @param {string} privatePem @param {{epoch:number, iat?:number}} t
 */
export function signResetTicket(privatePem, t) {
  const iat = t.iat || Date.now();
  return signTicket(privatePem, CONF, { by: BY_RECOVERY_KEY, epoch: t.epoch, at: iat, exp: iat + CONF.maxAge * 1000 });
}

/**
 * 验请求里的 reset 票。
 * @param {any} request @param {any} env
 * @returns {Promise<{ok:boolean, reason:string, by?:string, exp?:number}>}
 */
export async function verifyReset(request, env) {
  const v = await verifyTicket(request, env, CONF, SIGNING_PUBLIC, () => readEpoch(env, EPOCH.reset));
  return v.ok ? { ok: true, reason: 'ok', by: v.by, exp: v.exp } : { ok: false, reason: v.reason };
}

/** 清 reset 票（只清它） @param {Headers} headers */
export function endReset(headers) {
  headers.append('Set-Cookie', clearTicketCookie(CONF));
}

/**
 * 恢复密钥换 reset 票。
 * @param {{env:any, ip:string, key:any}} o
 * @returns {Promise<Response>}
 */
export async function openReset(o) {
  const { env, ip } = o;
  const t0 = Date.now();
  /* 签名钥匙缺失 → 503 config（先于比对，不浪费限速次数） */
  if (!signingReady(env)) return apiError(503, 'config');
  if (!(env && env[RECOVERY_KEY_SECRET]) || !dbReady(env)) return apiError(500, 'config');
  const rc = await checkRecoveryKey({ env, ip, key: o.key, t0 });
  if (!rc.ok) return rc.response;
  let v;
  try {
    v = await signResetTicket(env[SIGNING_PRIVATE], { epoch: await readEpoch(env, EPOCH.reset) });
  } catch (e) {
    await writeAudit(env, ip, 'reset-recovery-key', false);
    return apiError(503, 'server');
  }
  /* 审计写入失败则不签发（fail closed）：不带 Set-Cookie 返回 */
  if (!(await writeAudit(env, ip, 'reset-recovery-key', true))) return apiError(503, 'server');
  const headers = new Headers();
  headers.append('Set-Cookie', ticketCookie(CONF, v));
  return json(200, { ok: true }, headers);
}

/**
 * finish { signOut }。调用前已验过 reset 票。
 * @param {any} env @param {any} request @param {string} ip @param {any} signOut
 * @returns {Promise<Response>} { ok, signOut, signedOut }（signedOut = 登出了几台设备）
 */
export async function finishReset(env, request, ip, signOut) {
  if (RESET_SIGNOUT.indexOf(signOut) === -1) return apiError(400, 'params');
  const headers = new Headers();
  let signedOut = 0;
  try {
    if (signOut !== 'none') {
      const acc = await verifySession(request, env);
      const keep = signOut === 'others' && acc.ok ? acc.deviceId || '' : '';
      const before = await listDevices(env);
      signedOut = before.filter((d) => !keep || d.deviceId !== keep).length;
      const ne = await bumpEpoch(env, EPOCH.session);
      if (keep) {
        const err = await issueSession(env, headers, /** @type {string} */ (acc.by), { authAt: acc.authAt, epoch: ne, deviceId: keep, record: false });
        if (err) throw new Error('reissue-failed');
        headers.append('Set-Cookie', clearTicketCookie(TICKET.reauth));
      } else {
        endSession(headers);
      }
      await pruneOtherDevices(env, keep);
    }
    /* 这张 reset 票用完即废 */
    await bumpEpoch(env, EPOCH.reset);
  } catch (e) {
    return apiError(503, 'epoch');
  }
  endReset(headers);
  await writeAudit(env, ip, 'reset-finish-' + signOut);
  return json(200, { ok: true, signOut: signOut, signedOut: signedOut }, headers);
}
