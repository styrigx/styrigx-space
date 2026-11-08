/**
 * 账号三张票的签名格式（命名 v2：session / reauth / reset 一套函数，不再分长票、短票）。
 *
 * 不认识具体的票：每个函数接一个票配置 conf（core/config.js 的 TICKET.<名字>）：
 *   { name, cookie, maxAge, bys, device, span }
 * 票内容（点分，最后一段是签名）：
 *   by.epoch.at.exp            （device = false：reset）
 *   by.epoch.at.exp.deviceId   （device = true：session、reauth）
 *   sig = Ed25519(SGX_ACCOUNT_PRIVATE, "<cookie 名>|<票内容>")，base64url
 * - at：session 是本次登录验证的时刻 authAt（纪元推进后重签时保留原值），reauth / reset 是签发时刻 iat
 * - span = true（reauth、reset）：exp − at 不许超过 maxAge（3 分钟，不续期）
 * 签名串带 cookie 名前缀做域隔离：同一把私钥签的三张票互相冒充不了。session 票的格式和签名串与拆分前一字不差，
 * 换代码后已登录的设备不用重新登录。
 *
 * cookie：每张票各自一个，属性一律 Path=/; HttpOnly; Secure; SameSite=Strict（只发主站），Max-Age = maxAge（重签时 = 剩余秒数）。
 *
 * 本 Worker lib/ 里的通用模块：只 import 同目录的 crypto.js、cookies.js。纪元、设备这些规则在 core/ 里。
 */
import { ed25519Sign, ed25519Verify } from './crypto.js';
import { readCookie, COOKIE_EXPIRED } from './cookies.js';

/** 三张票共用的 cookie 属性 */
export const TICKET_COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Strict';

/** deviceId：12 字节随机的 base64url（16 字符）；只认 [A-Za-z0-9_-]{8,32}，不含 '.' @param {any} v */
export function isDeviceId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(v);
}

/**
 * @typedef {{ by:string, epoch:number, at:number, exp:number, deviceId?:string }} TicketFields
 * @typedef {{ name:string, cookie:string, maxAge:number, bys:ReadonlyArray<string>, device:boolean, span:boolean }} TicketConf
 */

/** @param {TicketConf} conf @param {TicketFields} t */
function payloadOf(conf, t) {
  const base = t.by + '.' + t.epoch + '.' + t.at + '.' + t.exp;
  return conf.device ? base + '.' + t.deviceId : base;
}

/**
 * 签一张票（票值，不含 cookie 名）。字段不合法就抛错。
 * @param {string} privatePem @param {TicketConf} conf @param {TicketFields} t
 */
export async function signTicket(privatePem, conf, t) {
  if (!conf || !t || conf.bys.indexOf(t.by) === -1) throw new Error('signTicket: bad by ' + JSON.stringify(t && t.by));
  if (conf.device && !isDeviceId(t.deviceId)) throw new Error('signTicket: bad deviceId');
  for (const k of ['epoch', 'at', 'exp']) {
    if (!Number.isFinite(/** @type {any} */ (t)[k])) throw new Error('signTicket: bad ' + k);
  }
  const payload = payloadOf(conf, t);
  return payload + '.' + (await ed25519Sign(privatePem, conf.cookie + '|' + payload));
}

/**
 * 解析票值（不验签）。段数、by、deviceId、数字不对 → null。
 * @param {TicketConf} conf @param {string} val
 * @returns {(TicketFields & {sig:string})|null}
 */
export function parseTicket(conf, val) {
  if (!conf || !val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== (conf.device ? 6 : 5)) return null;
  const by = parts[0];
  if (conf.bys.indexOf(by) === -1) return null;
  const epoch = parseInt(parts[1], 10);
  const at = parseInt(parts[2], 10);
  const exp = parseInt(parts[3], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(at) || !Number.isFinite(exp)) return null;
  const deviceId = conf.device ? parts[4] : '';
  if (conf.device && !isDeviceId(deviceId)) return null;
  const sig = parts[parts.length - 1];
  if (!sig) return null;
  return { by, epoch, at, exp, deviceId, sig };
}

/**
 * 验请求里的某张票（只读这张票自己的 cookie）。fail closed：解析 / 验签里的任何异常都算无效。
 * @param {any} request @param {any} env @param {TicketConf} conf
 * @param {string} publicKeyName 验签公钥在 env 里的名字
 * @param {() => Promise<number>} readEpoch 读这张票的纪元（出错抛错 → d1-error）
 * @returns {Promise<{ok:boolean, reason:string, by?:string, epoch?:number, at?:number, exp?:number, deviceId?:string}>}
 *   reason: ok / no-cookie / bad-format / expired / not-yet / no-pubkey / d1-error / epoch-changed / bad-sig
 */
export async function verifyTicket(request, env, conf, publicKeyName, readEpoch) {
  /* 读请求本身出错（请求对象坏了）照常抛给调用方（authorize 回 error）；之后的任何异常都按无效票处理 */
  const val = readCookie(request, conf.cookie);
  if (!val) return { ok: false, reason: 'no-cookie' };
  try {
    const p = parseTicket(conf, val);
    if (!p) return { ok: false, reason: 'bad-format' };
    const now = Date.now();
    if (p.exp <= now) return { ok: false, reason: 'expired' };
    if (p.at > now + 60000) return { ok: false, reason: 'not-yet' }; /* 允许 60 秒时钟 skew */
    if (conf.span && p.exp - p.at > conf.maxAge * 1000) return { ok: false, reason: 'bad-format' };
    const pub = (env && env[publicKeyName]) || '';
    if (!pub) return { ok: false, reason: 'no-pubkey' };
    let cur;
    try {
      cur = await readEpoch();
    } catch (e) {
      return { ok: false, reason: 'd1-error' };
    }
    if (p.epoch !== cur) return { ok: false, reason: 'epoch-changed' };
    if (!(await ed25519Verify(pub, conf.cookie + '|' + payloadOf(conf, p), p.sig))) return { ok: false, reason: 'bad-sig' };
    return { ok: true, reason: 'ok', by: p.by, epoch: p.epoch, at: p.at, exp: p.exp, deviceId: p.deviceId };
  } catch (e) {
    return { ok: false, reason: 'bad-format' };
  }
}

/**
 * Set-Cookie 值：<cookie>=<票值>; <属性>; Max-Age=<秒>
 * @param {TicketConf} conf @param {string} value @param {number} [maxAge] 默认 conf.maxAge
 */
export function ticketCookie(conf, value, maxAge) {
  return conf.cookie + '=' + value + '; ' + TICKET_COOKIE_ATTRS + '; Max-Age=' + (maxAge || conf.maxAge);
}

/** 清除这张票的 Set-Cookie 值 @param {TicketConf} conf */
export function clearTicketCookie(conf) {
  return conf.cookie + '=; ' + TICKET_COOKIE_ATTRS + '; ' + COOKIE_EXPIRED;
}
