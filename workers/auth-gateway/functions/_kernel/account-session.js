/**
 * 账号会话（sgx-account）：签发、解析、验证、吊销纪元。
 *
 * 账号登录三个入口平级（账号通行密钥 / 账号密码 / 根凭证），任一成功即签发本票据。
 * 与 lock 会话（sgx-verified）完全独立：lock 会话从不被当作账号认证，
 * 本票据也从不被当作 lock 会话。
 *
 * 票据格式（六段）：by.epoch.authAt.exp.sid.sig
 * - sid：本次登录的设备会话 id（_kernel/account-devices.js；设备页列出、可单独退出，黑名单命中 reason=revoked）
 *   旧的五段票据（by.epoch.authAt.exp.sig，没有 sid）仍然认：/api/account GET 时自动换成带 sid 的新票，不用重新登录
 * - by：passkey | password | root（REALM_ACCOUNT.bys）
 * - epoch：KV account-epoch（改账号密码 / 删账号通行密钥时 +1）
 * - authAt：本次登录验证时刻（毫秒）；重签（epoch 推进后保持当前设备）时保留原值
 * - exp：过期时刻（毫秒）
 * - sig：Ed25519(SGX_ACCOUNT_PRIVATE, "by.epoch.authAt.exp.sid")（旧票不含 .sid），base64url
 *
 * 缺 SGX_ACCOUNT_PRIVATE / SGX_ACCOUNT_PUBLIC：签发返回 503 config，验证一律失败
 * （reason=no-pubkey）；只影响账号登录与进门，网站其余部分不受影响。
 *
 * 叶子模块：只 import _kernel（crypto / realms），不 import 接口或 _middleware.js。
 */
import { ed25519Sign, ed25519Verify } from './crypto.js';
import { REALM_ACCOUNT, realmPrivateKey, realmPublicKey, realmCookie, realmClearCookie } from './realms.js';
import { newDeviceId, isDeviceId, isRevoked, getDevice, putDevice, recordLogin, deviceInfo, TOUCH_INTERVAL_MS } from './account-devices.js';

export const ACCOUNT_COOKIE = REALM_ACCOUNT.cookie; /* 'sgx-account' */
export const ACCOUNT_MAX_AGE = REALM_ACCOUNT.maxAge; /* 400 天：不点退出就一直登录 */
export const ACCOUNT_BY_PASSKEY = 'passkey';
export const ACCOUNT_BY_PASSWORD = 'password';
export const ACCOUNT_BY_ROOT = 'root';
const ACCOUNT_EPOCH_KEY = REALM_ACCOUNT.kv.epoch; /* 'account-epoch' */

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
  return Response.json({ ok: false, error: 'config', message: 'SGX_ACCOUNT_PRIVATE / SGX_ACCOUNT_PUBLIC 未配置' }, { status: 503 });
}

/**
 * 读 account-epoch。KV 读取出错时抛错（调用方 503）；键不存在当 0。
 * @param {any} kv
 */
export async function getAccountEpoch(kv) {
  const v = await kv.get(ACCOUNT_EPOCH_KEY);
  if (v === null || v === undefined) return 0;
  return parseInt(v, 10) || 0;
}

/**
 * account-epoch +1（读出错抛错，绝不写入）。
 * @param {any} kv
 * @returns {Promise<number>} 新 epoch
 */
export async function bumpAccountEpoch(kv) {
  const v = await getAccountEpoch(kv);
  await kv.put(ACCOUNT_EPOCH_KEY, String(v + 1));
  return v + 1;
}

/**
 * 签账号票据值。
 * @param {string} privatePem
 * @param {string} by
 * @param {number} epoch
 * @param {number} authAt 毫秒
 * @param {number} [now] 毫秒（测试用）
 * @param {string} [sid] 设备会话 id；不给 = 旧五段格式（只有测试这样签）
 */
export async function signAccountTicket(privatePem, by, epoch, authAt, now, sid) {
  if (!isAccountBy(by)) throw new Error('signAccountTicket: bad by ' + JSON.stringify(by));
  if (sid !== undefined && sid !== '' && !isDeviceId(sid)) throw new Error('signAccountTicket: bad sid');
  const t = now || Date.now();
  const exp = t + ACCOUNT_MAX_AGE * 1000;
  const payload = by + '.' + epoch + '.' + authAt + '.' + exp + (sid ? '.' + sid : '');
  const sig = await ed25519Sign(privatePem, payload);
  return payload + '.' + sig;
}

/**
 * 解析账号票据值（不验签）。
 * @param {string} val
 * @returns {{by:string, epoch:number, authAt:number, exp:number, sid:string, sig:string}|null}
 */
export function parseAccountTicket(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 5 && parts.length !== 6) return null;
  let sid = '';
  if (parts.length === 6) {
    sid = parts.splice(4, 1)[0];
    if (!isDeviceId(sid)) return null;
  }
  const by = parts[0];
  if (!isAccountBy(by)) return null;
  const epoch = parseInt(parts[1], 10);
  const authAt = parseInt(parts[2], 10);
  const exp = parseInt(parts[3], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(authAt) || !Number.isFinite(exp)) return null;
  if (!parts[4]) return null;
  return { by, epoch, authAt, exp, sid, sig: parts[4] };
}

/** @param {any} request @param {string} name */
function readCookie(request, name) {
  const h = (request && request.headers && request.headers.get('Cookie')) || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

/**
 * 验证请求里的 sgx-account。只认本 cookie，绝不读 sgx-verified。
 * @param {any} request
 * @param {any} env
 * @returns {Promise<{ok:boolean, reason:string, by?:string, epoch?:number, authAt?:number, exp?:number, sid?:string}>}
 *   reason: ok / no-cookie / bad-format / expired / not-yet / no-pubkey / epoch-changed / kv-error / bad-sig / revoked
 *   sid：'' = 旧五段票（没有设备记录）
 */
export async function verifyAccountCookie(request, env) {
  const val = readCookie(request, ACCOUNT_COOKIE);
  if (!val) return { ok: false, reason: 'no-cookie' };
  const p = parseAccountTicket(val);
  if (!p) return { ok: false, reason: 'bad-format' };
  const now = Date.now();
  if (p.exp <= now) return { ok: false, reason: 'expired' };
  if (p.authAt > now + 60000) return { ok: false, reason: 'not-yet' }; /* 允许 60 秒时钟 skew */
  const pub = realmPublicKey(env, REALM_ACCOUNT);
  if (!pub) return { ok: false, reason: 'no-pubkey' };
  let cur;
  try {
    cur = await getAccountEpoch(env && env.KV_ACCOUNT_LOGIN);
  } catch (e) {
    return { ok: false, reason: 'kv-error' };
  }
  if (p.epoch !== cur) return { ok: false, reason: 'epoch-changed' };
  const ok = await ed25519Verify(pub, p.by + '.' + p.epoch + '.' + p.authAt + '.' + p.exp + (p.sid ? '.' + p.sid : ''), p.sig);
  if (!ok) return { ok: false, reason: 'bad-sig' };
  if (p.sid) {
    const kv = env && env.KV_ACCOUNT_LOGIN;
    try {
      if (await isRevoked(kv, p.sid)) return { ok: false, reason: 'revoked' };
    } catch (e) {
      return { ok: false, reason: 'kv-error' };
    }
    await touchDevice(kv, request, p);
  }
  return {
    ok: true,
    reason: 'ok',
    by: p.by,
    epoch: p.epoch,
    authAt: p.authAt,
    exp: p.exp,
    sid: p.sid,
  };
}

/**
 * 刷新设备的 lastSeen（至多 30 分钟一次）；记录不见了（比如 KV 丢了）就按本次请求补一条。尽力而为。
 * @param {any} kv @param {any} request @param {{sid:string, by:string, authAt:number}} p
 */
async function touchDevice(kv, request, p) {
  if (!kv) return;
  try {
    const now = Date.now();
    const rec = await getDevice(kv, p.sid);
    if (!rec) {
      await putDevice(kv, Object.assign({ sid: p.sid, by: p.by, createdAt: p.authAt, authAt: p.authAt, lastSeen: now }, deviceInfo(request, null)));
      return;
    }
    if (now - (rec.lastSeen || 0) < TOUCH_INTERVAL_MS) return;
    const cf = (request && request.cf) || {};
    rec.lastSeen = now;
    if (cf.country) rec.country = String(cf.country).slice(0, 4);
    if (cf.city) rec.city = String(cf.city).slice(0, 40);
    await putDevice(kv, rec);
  } catch (e) { /* 写不进去不影响验证 */ }
}

/**
 * 签发账号会话 cookie（fail closed，永不抛错）。
 * 成功返回 null；失败返回 { status, body }：
 * - 缺 SGX_ACCOUNT_PRIVATE/PUBLIC → 503 config
 * - 读 account-epoch 出错 → 503 server
 * - 签名出错 → 500 sign-failed
 * @param {any} env
 * @param {Headers} headers
 * @param {string} by passkey | password | root
 * @param {object} [opts]
 * @param {number} [opts.authAt] 默认当前时刻（新登录）；重签时传原值
 * @param {number} [opts.epoch] 默认读 KV
 * @param {string} [opts.sid] 沿用的设备会话 id（同一浏览器重新登录 / 纪元推进后重签）；不给就新建
 * @param {boolean} [opts.record] 是否写设备记录（默认 true；纪元推进后重签传 false）
 * @param {any} [opts.request] 写设备记录用（User-Agent、cf 国家城市）
 * @param {any} [opts.device] 前端 hints { model, platform, platformVersion }
 * @returns {Promise<{status:number, body:object}|null>}
 */
export async function issueAccountCookie(env, headers, by, opts) {
  const o = opts || {};
  if (!accountKeysReady(env)) {
    return { status: 503, body: { ok: false, error: 'config' } };
  }
  let epoch = o.epoch;
  if (typeof epoch !== 'number') {
    try {
      epoch = await getAccountEpoch(env && env.KV_ACCOUNT_LOGIN);
    } catch (e) {
      return { status: 503, body: { ok: false, error: 'server' } };
    }
  }
  try {
    const authAt = typeof o.authAt === 'number' ? o.authAt : Date.now();
    const sid = isDeviceId(o.sid || '') ? o.sid : newDeviceId();
    const cv = await signAccountTicket(realmPrivateKey(env, REALM_ACCOUNT), by, epoch, authAt, undefined, sid);
    headers.append('Set-Cookie', realmCookie(REALM_ACCOUNT, cv));
    if (o.record !== false && env && env.KV_ACCOUNT_LOGIN) {
      try {
        await recordLogin(env.KV_ACCOUNT_LOGIN, sid, by, authAt, deviceInfo(o.request, o.device));
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
export function clearAccountCookie(headers) {
  headers.append('Set-Cookie', realmClearCookie(REALM_ACCOUNT));
}

/**
 * 登录签票的选项：同一浏览器已有有效账号会话（比如进账号安全的门）就沿用它的 sid，不多记一台设备。
 * device：前端 navigator.userAgentData 给的型号 / 平台（account-devices.js 清洗）。
 * @param {any} request @param {any} env @param {any} body
 */
export async function accountSessionOpts(request, env, body) {
  let sid = '';
  try {
    const cur = await verifyAccountCookie(request, env);
    if (cur.ok && cur.sid) sid = cur.sid;
  } catch (e) {}
  return { sid: sid || undefined, request: request, device: body && body.device };
}
