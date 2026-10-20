/**
 * 门票（sgx-door）：进一道「门」（安全操作页）验过对应凭证后签发的 3 分钟短票。
 *
 * 每道门用自己凭证域的钥匙签（全站只剩账号、锁屏两套签名钥匙）：
 * - account：账号 → 安全与隐私（管理账号密码 / 账号通行密钥），SGX_ACCOUNT_* 签，
 *            纪元 = account-epoch（改账号密码 / 删账号通行密钥 +1）
 * - lock：安全与隐私 → 锁屏凭证（管理解锁密码 / 锁屏通行密钥 / 退出所有设备 / 根凭证记录），
 *         SGX_LOCK_* 签，纪元 = session-epoch（改锁屏凭证、退出所有设备 +1，门内操作随即重签）
 * - lockreset：重置锁屏（丢了锁屏凭证，没有会话）—— 只能设置解锁密码 / 增删锁屏通行密钥，
 *         SGX_LOCK_* 签，纪元 = session-epoch；by = root（恢复开关）| account+root（账号凭证 + 根凭证）
 *
 * 票据格式（七段）：door.<door>.<by>.<epoch>.<iat>.<exp>.<sig>
 * - by：本次进门用的凭证（passkey | password | root；重置锁屏另有 account+root）
 * - sig：Ed25519(<门的私钥>, "sgx-door|door.<door>.<by>.<epoch>.<iat>.<exp>")，
 *   签名串带 "sgx-door|" 前缀做域隔离：同一把钥匙签的会话票绝不会被当成门票，反之亦然
 * 同一时刻只有一张门票（一个 cookie），进另一道门会覆盖；离开门内页前端立即调 clear。
 *
 * cookie：sgx-door，只发主站（不带 Domain）、HttpOnly、Secure、SameSite=Strict、Max-Age=180。
 * 不续期：3 分钟到点就失效，前端倒计时以服务端返回的 expiresAt 为准。
 *
 * 叶子模块：只 import _kernel（crypto / realms），不 import 接口或 _middleware.js。
 */
import { ed25519Sign, ed25519Verify } from './crypto.js';
import { REALM_ACCOUNT, REALM_LOCK, realmPrivateKey, realmPublicKey, COOKIE_EXPIRED } from './realms.js';

export const DOOR_COOKIE = 'sgx-door';
export const DOOR_MAX_AGE = 180; /* 3 分钟，不续期 */
const DOOR_COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Strict';
const SIG_PREFIX = 'sgx-door|';

export const DOOR_ACCOUNT = 'account';
export const DOOR_LOCK = 'lock';
export const DOOR_LOCKRESET = 'lockreset';
export const DOOR_BY_ACCOUNT_ROOT = 'account+root';
const BYS_NORMAL = Object.freeze(['passkey', 'password', 'root']);
export const DOOR_BYS = Object.freeze(['passkey', 'password', 'root', DOOR_BY_ACCOUNT_ROOT]);

/** 每道门：签名钥匙（凭证域）+ 纪元键 + 允许的 by */
export const DOORS = Object.freeze({
  [DOOR_ACCOUNT]: Object.freeze({ realm: REALM_ACCOUNT, epochKey: REALM_ACCOUNT.kv.epoch, bys: BYS_NORMAL }),
  [DOOR_LOCK]: Object.freeze({ realm: REALM_LOCK, epochKey: REALM_LOCK.kv.epoch, bys: BYS_NORMAL }),
  [DOOR_LOCKRESET]: Object.freeze({ realm: REALM_LOCK, epochKey: REALM_LOCK.kv.epoch, bys: Object.freeze(['root', DOOR_BY_ACCOUNT_ROOT]) }),
});

/** @param {string} door */
function doorConf(door) {
  return Object.prototype.hasOwnProperty.call(DOORS, door) ? DOORS[door] : null;
}

/**
 * 读门的纪元（键不存在当 0；KV 出错抛错，调用方 fail closed）。
 * @param {any} kv @param {string} door
 */
export async function getDoorEpoch(kv, door) {
  const c = doorConf(door);
  if (!c) throw new Error('getDoorEpoch: bad door');
  const v = await kv.get(c.epochKey);
  if (v === null || v === undefined) return 0;
  return parseInt(v, 10) || 0;
}

/**
 * 签门票值。
 * @param {string} privatePem
 * @param {string} door
 * @param {string} by
 * @param {number} epoch
 * @param {number} [now] 毫秒（测试用）
 */
export async function signDoorTicket(privatePem, door, by, epoch, now) {
  const c = doorConf(door);
  if (!c) throw new Error('signDoorTicket: bad door ' + JSON.stringify(door));
  if (c.bys.indexOf(by) === -1) throw new Error('signDoorTicket: bad by ' + JSON.stringify(by));
  const iat = now || Date.now();
  const exp = iat + DOOR_MAX_AGE * 1000;
  const payload = 'door.' + door + '.' + by + '.' + epoch + '.' + iat + '.' + exp;
  const sig = await ed25519Sign(privatePem, SIG_PREFIX + payload);
  return payload + '.' + sig;
}

/**
 * 解析门票值（不验签）。
 * @param {string} val
 * @returns {{door:string, by:string, epoch:number, iat:number, exp:number, sig:string}|null}
 */
export function parseDoorTicket(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 7 || parts[0] !== 'door') return null;
  const door = parts[1];
  const by = parts[2];
  const c = doorConf(door);
  if (!c || c.bys.indexOf(by) === -1) return null;
  const epoch = parseInt(parts[3], 10);
  const iat = parseInt(parts[4], 10);
  const exp = parseInt(parts[5], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(iat) || !Number.isFinite(exp)) return null;
  if (!parts[6]) return null;
  return { door, by, epoch, iat, exp, sig: parts[6] };
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
 * 验请求里的门票，且必须是指定的那道门。fail closed：任何异常都无效。
 * @param {any} request
 * @param {any} env
 * @param {string} door
 * @returns {Promise<{ok:boolean, reason:string, by?:string, exp?:number}>}
 *   reason: ok / no-cookie / bad-format / wrong-door / expired / not-yet / no-pubkey / kv-error / epoch-changed / bad-sig
 */
export async function verifyDoorCookie(request, env, door) {
  try {
    const c = doorConf(door);
    if (!c) return { ok: false, reason: 'wrong-door' };
    const val = readCookie(request, DOOR_COOKIE);
    if (!val) return { ok: false, reason: 'no-cookie' };
    const p = parseDoorTicket(val);
    if (!p) return { ok: false, reason: 'bad-format' };
    if (p.door !== door) return { ok: false, reason: 'wrong-door' };
    const now = Date.now();
    if (p.exp <= now) return { ok: false, reason: 'expired' };
    if (p.iat > now + 60000) return { ok: false, reason: 'not-yet' };
    if (p.exp - p.iat > DOOR_MAX_AGE * 1000) return { ok: false, reason: 'bad-format' };
    const pub = realmPublicKey(env, c.realm);
    if (!pub) return { ok: false, reason: 'no-pubkey' };
    let cur;
    try {
      cur = await getDoorEpoch(env && env.OWNER_KV, door);
    } catch (e) {
      return { ok: false, reason: 'kv-error' };
    }
    if (p.epoch !== cur) return { ok: false, reason: 'epoch-changed' };
    const payload = 'door.' + p.door + '.' + p.by + '.' + p.epoch + '.' + p.iat + '.' + p.exp;
    const ok = await ed25519Verify(pub, SIG_PREFIX + payload, p.sig);
    if (!ok) return { ok: false, reason: 'bad-sig' };
    return { ok: true, reason: 'ok', by: p.by, exp: p.exp };
  } catch (e) {
    return { ok: false, reason: 'bad-format' };
  }
}

/**
 * 签发门票并写入 headers（fail closed，永不抛错）。成功返回 null，失败返回 { status, body }。
 * @param {any} env
 * @param {Headers} headers
 * @param {string} door
 * @param {string} by
 * @param {object} [opts]
 * @param {number} [opts.epoch] 默认读 KV（纪元刚推进时传新值）
 */
export async function issueDoorCookie(env, headers, door, by, opts) {
  const c = doorConf(door);
  if (!c) return { status: 500, body: { ok: false, error: 'server' } };
  const priv = realmPrivateKey(env, c.realm);
  if (!priv || !realmPublicKey(env, c.realm)) return { status: 503, body: { ok: false, error: 'config' } };
  let epoch = opts && typeof opts.epoch === 'number' ? opts.epoch : null;
  if (epoch === null) {
    try {
      epoch = await getDoorEpoch(env && env.OWNER_KV, door);
    } catch (e) {
      return { status: 503, body: { ok: false, error: 'server' } };
    }
  }
  try {
    const v = await signDoorTicket(priv, door, by, epoch);
    headers.append('Set-Cookie', DOOR_COOKIE + '=' + v + '; ' + DOOR_COOKIE_ATTRS + '; Max-Age=' + DOOR_MAX_AGE);
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'sign-failed' } };
  }
  return null;
}

/**
 * 纪元推进后重签门票（保持门内连续操作）：延续 by，不延长剩余时间
 * （iat 取 原 exp − 3 分钟，新票的 exp 与原票相同）。
 * @param {any} env @param {Headers} headers @param {string} door
 * @param {{ok:boolean, by?:string, exp?:number}} dv verifyDoorCookie 的结果
 * @param {number} newEpoch
 */
export async function reissueDoorWithEpoch(env, headers, door, dv, newEpoch) {
  if (!dv || !dv.ok || !dv.by || !dv.exp) return;
  const c = doorConf(door);
  if (!c) return;
  const priv = realmPrivateKey(env, c.realm);
  if (!priv) return;
  const left = dv.exp - Date.now();
  if (left <= 0) return;
  try {
    const iat = dv.exp - DOOR_MAX_AGE * 1000;
    const v = await signDoorTicket(priv, door, dv.by, newEpoch, iat);
    headers.append('Set-Cookie', DOOR_COOKIE + '=' + v + '; ' + DOOR_COOKIE_ATTRS + '; Max-Age=' + Math.ceil(left / 1000));
  } catch (e) {}
}

/** 清门票（离开门内页、退出账号时） @param {Headers} headers */
export function clearDoorCookie(headers) {
  headers.append('Set-Cookie', DOOR_COOKIE + '=; ' + DOOR_COOKIE_ATTRS + '; ' + COOKIE_EXPIRED);
}
