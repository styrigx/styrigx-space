/**
 * 账号会话（AccountSessionTicket，cookie sgx-account-session）：签发、解析、验证、Account 纪元。
 *
 * 账号登录两个入口平级（账号通行密钥 / 账号密码），任一成功即签发本票。RootKey 不签账号会话
 * （丢了账号凭证走 AccountResetTicket 重设，再正常登录）。
 * 与锁屏会话（sgx-lock-session）完全独立：锁屏会话从不被当作账号认证，本票也从不被当作锁屏会话。
 *
 * 票内容：by.epoch.authAt.exp.deviceId，最后一段是签名：
 *   sig = Ed25519(SGX_ACCOUNT_PRIVATE, "sgx-account-session|by.epoch.authAt.exp.deviceId")，base64url
 * - by：passkey | password
 * - epoch：Account 纪元（D1 epoch 表 realm='account' 那一行，见 d1-state.js；改账号密码 / 删账号通行密钥时 +1）
 * - authAt：本次登录验证时刻（毫秒）；重签（纪元推进后保持当前设备）时保留原值
 * - exp：过期时刻（毫秒）
 * - deviceId：本次登录的设备 id（_kernel/account-devices.js；设备页列出、可单独退出，黑名单命中 reason=revoked）
 * 其它格式一律无效。
 *
 * 缺 SGX_ACCOUNT_PRIVATE / SGX_ACCOUNT_PUBLIC：签发返回 503 config，验证一律失败
 * （reason=no-pubkey）；只影响账号登录，网站其余部分不受影响。
 *
 * 叶子模块：只 import _kernel（crypto / realms / account-devices / d1-state），不 import 接口或 _middleware.js。
 */
import { ed25519Sign, ed25519Verify } from '../../../shared/crypto.js';
import { readCookie } from '../../../shared/cookies.js';
import { REALM_ACCOUNT, ACCOUNT_SESSION_COOKIE, COOKIE_EXPIRED, realmPrivateKey, realmPublicKey } from './realms.js';
import { readEpoch, bumpEpoch } from './d1-state.js';
import { newDeviceId, isDeviceId, isRevoked, getDevice, putDevice, recordLogin, deviceInfo, TOUCH_INTERVAL_MS } from './account-devices.js';
import { apiError } from '../../../shared/http.js';

export { ACCOUNT_SESSION_COOKIE };
export const ACCOUNT_SESSION_MAX_AGE = REALM_ACCOUNT.maxAge; /* 400 天：不点退出就一直登录 */
const SIG_PREFIX = ACCOUNT_SESSION_COOKIE + '|';

/** @param {string} by */
function isAccountBy(by) {
  return REALM_ACCOUNT.bys.indexOf(by) !== -1;
}

/**
 * 账号签名钥匙是否齐全（私钥 + 公钥）。缺任一 → 账号登录返回 503 config。
 * @param {any} env
 */
export function accountKeysReady(env) {
  return !!(realmPrivateKey(env, REALM_ACCOUNT) && realmPublicKey(env, REALM_ACCOUNT));
}

/** 缺账号钥匙时的统一响应（503；前端显示「服务器配置有误」，其余页面不受影响） */
export function accountConfigMissing() {
  return apiError(503, 'config', { message: 'SGX_ACCOUNT_PRIVATE / SGX_ACCOUNT_PUBLIC 未配置' });
}

/**
 * 读 account-epoch（D1，强一致）。出错时抛错（调用方 503）。
 * @param {any} env
 * @returns {Promise<number>}
 */
export async function getAccountEpoch(env) {
  return readEpoch(env, REALM_ACCOUNT);
}

/**
 * account-epoch +1（D1 原子自增；出错抛错，绝不写入）。
 * @param {any} env
 * @returns {Promise<number>} 新 epoch
 */
export async function bumpAccountEpoch(env) {
  return bumpEpoch(env, REALM_ACCOUNT);
}

/**
 * 签账号会话票值。
 * @param {string} privatePem
 * @param {{by:string, epoch:number, authAt:number, deviceId:string, now?:number}} t now：毫秒（测试用）
 */
export async function signAccountSessionTicket(privatePem, t) {
  if (!t || !isAccountBy(t.by)) throw new Error('signAccountSessionTicket: bad by ' + JSON.stringify(t && t.by));
  if (!isDeviceId(t.deviceId || '')) throw new Error('signAccountSessionTicket: bad deviceId');
  const exp = (t.now || Date.now()) + ACCOUNT_SESSION_MAX_AGE * 1000;
  const payload = t.by + '.' + t.epoch + '.' + t.authAt + '.' + exp + '.' + t.deviceId;
  const sig = await ed25519Sign(privatePem, SIG_PREFIX + payload);
  return payload + '.' + sig;
}

/**
 * 解析账号会话票值（不验签）。六段：by.epoch.authAt.exp.deviceId.sig。
 * @param {string} val
 * @returns {{by:string, epoch:number, authAt:number, exp:number, deviceId:string, sig:string}|null}
 */
export function parseAccountSessionTicket(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 6) return null;
  const [by, epochStr, authAtStr, expStr, deviceId, sig] = parts;
  if (!isAccountBy(by) || !isDeviceId(deviceId) || !sig) return null;
  const epoch = parseInt(epochStr, 10);
  const authAt = parseInt(authAtStr, 10);
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(authAt) || !Number.isFinite(exp)) return null;
  return { by, epoch, authAt, exp, deviceId, sig };
}

/**
 * 验证请求里的账号会话。只认 sgx-account-session，绝不读锁屏会话。
 * @param {any} request
 * @param {any} env
 * @returns {Promise<{ok:boolean, reason:string, by?:string, epoch?:number, authAt?:number, exp?:number, deviceId?:string}>}
 *   reason: ok / no-cookie / bad-format / expired / not-yet / no-pubkey / epoch-changed / d1-error / bad-sig / revoked
 */
export async function verifyAccountSession(request, env) {
  const val = readCookie(request, ACCOUNT_SESSION_COOKIE);
  if (!val) return { ok: false, reason: 'no-cookie' };
  const p = parseAccountSessionTicket(val);
  if (!p) return { ok: false, reason: 'bad-format' };
  const now = Date.now();
  if (p.exp <= now) return { ok: false, reason: 'expired' };
  if (p.authAt > now + 60000) return { ok: false, reason: 'not-yet' }; /* 允许 60 秒时钟 skew */
  const pub = realmPublicKey(env, REALM_ACCOUNT);
  if (!pub) return { ok: false, reason: 'no-pubkey' };
  let cur;
  try {
    cur = await getAccountEpoch(env);
  } catch (e) {
    return { ok: false, reason: 'd1-error' };
  }
  if (p.epoch !== cur) return { ok: false, reason: 'epoch-changed' };
  const ok = await ed25519Verify(pub, SIG_PREFIX + p.by + '.' + p.epoch + '.' + p.authAt + '.' + p.exp + '.' + p.deviceId, p.sig);
  if (!ok) return { ok: false, reason: 'bad-sig' };
  /* 单独退出的设备：每个请求读一次 D1 主库（不缓存），退出后那台的下一个请求就被拒 */
  try {
    if (await isRevoked(env, p.deviceId)) return { ok: false, reason: 'revoked' };
  } catch (e) {
    return { ok: false, reason: 'd1-error' };
  }
  await touchDevice(env, request, p);
  return {
    ok: true,
    reason: 'ok',
    by: p.by,
    epoch: p.epoch,
    authAt: p.authAt,
    exp: p.exp,
    deviceId: p.deviceId,
  };
}

/**
 * 刷新设备的 lastSeen（至多 30 分钟一次）；记录不见了（比如登录时没写进去）就按本次请求补一条。尽力而为。
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
    const cf = (request && request.cf) || {};
    rec.lastSeen = now;
    if (cf.country) rec.country = String(cf.country).slice(0, 4);
    if (cf.city) rec.city = String(cf.city).slice(0, 40);
    await putDevice(env, rec);
  } catch (e) { /* 写不进去不影响验证 */ }
}

/**
 * 签发账号会话 cookie（fail closed，永不抛错）。
 * 成功返回 null；失败返回 { status, body }：
 * - 缺 SGX_ACCOUNT_PRIVATE/PUBLIC → 503 config
 * - 读 account-epoch（D1）出错 → 503 server
 * - 签名出错 → 500 sign-failed
 * @param {any} env
 * @param {Headers} headers
 * @param {string} by passkey | password
 * @param {object} [opts]
 * @param {number} [opts.authAt] 默认当前时刻（新登录）；重签时传原值
 * @param {number} [opts.epoch] 默认读 D1 当前值
 * @param {string} [opts.deviceId] 沿用的设备 id（同一浏览器重新登录 / 纪元推进后重签）；不给就新建
 * @param {boolean} [opts.record] 是否写设备记录（默认 true；纪元推进后重签传 false）
 * @param {any} [opts.request] 写设备记录用（User-Agent、cf 国家城市）
 * @param {any} [opts.device] 前端 hints { model, platform, platformVersion }
 * @returns {Promise<{status:number, body:object}|null>}
 */
export async function issueAccountSession(env, headers, by, opts) {
  const o = opts || {};
  if (!accountKeysReady(env)) {
    return { status: 503, body: { ok: false, error: 'config' } };
  }
  let epoch = o.epoch;
  if (typeof epoch !== 'number') {
    try {
      epoch = await getAccountEpoch(env);
    } catch (e) {
      return { status: 503, body: { ok: false, error: 'server' } };
    }
  }
  try {
    const authAt = typeof o.authAt === 'number' ? o.authAt : Date.now();
    const deviceId = isDeviceId(o.deviceId || '') ? o.deviceId : newDeviceId();
    const cv = await signAccountSessionTicket(realmPrivateKey(env, REALM_ACCOUNT), { by: by, epoch: epoch, authAt: authAt, deviceId: deviceId });
    headers.append('Set-Cookie', ACCOUNT_SESSION_COOKIE + '=' + cv + '; ' + REALM_ACCOUNT.cookieAttrs + '; Max-Age=' + ACCOUNT_SESSION_MAX_AGE);
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
 * 清除账号会话 cookie。
 * @param {Headers} headers
 */
export function clearAccountSession(headers) {
  headers.append('Set-Cookie', ACCOUNT_SESSION_COOKIE + '=; ' + REALM_ACCOUNT.cookieAttrs + '; ' + COOKIE_EXPIRED);
}

/**
 * 登录签票的选项：同一浏览器已有有效账号会话（比如进账号安全前再验一次）就沿用它的 deviceId，不多记一台设备。
 * device：前端 navigator.userAgentData 给的型号 / 平台（account-devices.js 清洗）。
 * @param {any} request @param {any} env @param {any} body
 */
export async function accountSessionOpts(request, env, body) {
  let deviceId = '';
  try {
    const cur = await verifyAccountSession(request, env);
    if (cur.ok && cur.deviceId) deviceId = cur.deviceId;
  } catch (e) {}
  return { deviceId: deviceId || undefined, request: request, device: body && body.device };
}
