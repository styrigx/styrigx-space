/**
 * 测试用：按六张票的真实格式签测试 cookie 值（与 workers/auth-gateway/functions/_kernel 同一套签名函数）。
 * - testLockSession(priv, epoch, role, by?)：role 'admin' | 'visitor'；admin 的 by 默认 password（可传 passkey）；
 *   visitor 固定 by=tempkey、tempkeyId=TEST_TEMPKEY_ID（验票只查这把钥匙有没有被作废）
 * - testAccountSession(priv, by, epoch, authAt, now?, deviceId?)：deviceId 默认 TEST_DEVICE_ID
 * - testTicket(priv, name, by, epoch, now?)：四张 reset / reauth 短票（name 用 realms.js 的票名常量）
 * - *Cookie() 版本直接返回「cookie名=值」
 */
import { signLockSessionTicket } from '../../../workers/auth-gateway/functions/_kernel/lock-session.js';
import { signAccountSessionTicket } from '../../../workers/auth-gateway/functions/_kernel/account-session.js';
import { signTicket } from '../../../workers/auth-gateway/functions/_kernel/tickets.js';
import { TICKETS, LOCK_SESSION_COOKIE, ACCOUNT_SESSION_COOKIE } from '../../../workers/auth-gateway/functions/_kernel/realms.js';

export const TEST_TEMPKEY_ID = 'tktesttesttest01';
export const TEST_DEVICE_ID = 'devtestdevtest01';

/**
 * @param {string} priv SGX_LOCK_PRIVATE
 * @param {number} epoch
 * @param {string} role 'admin' | 'visitor'
 * @param {string} [by] admin：password（默认）| passkey
 * @param {{ttlSec?:number, tempkeyId?:string}} [o]
 */
export function testLockSession(priv, epoch, role, by, o) {
  const opts = o || {};
  const visitor = role === 'visitor';
  return signLockSessionTicket(priv, {
    by: visitor ? 'tempkey' : (by || 'password'),
    role: role,
    epoch: epoch,
    exp: Date.now() + (opts.ttlSec || (visitor ? 3600 : 43200)) * 1000,
    tempkeyId: visitor ? (opts.tempkeyId || TEST_TEMPKEY_ID) : '',
  });
}
/** @param {string} priv @param {number} epoch @param {string} role @param {string} [by] @param {any} [o] */
export async function testLockSessionCookie(priv, epoch, role, by, o) {
  return LOCK_SESSION_COOKIE + '=' + (await testLockSession(priv, epoch, role, by, o));
}

/**
 * @param {string} priv SGX_ACCOUNT_PRIVATE
 * @param {string} by password | passkey
 * @param {number} epoch
 * @param {number} authAt
 * @param {number} [now]
 * @param {string} [deviceId]
 */
export function testAccountSession(priv, by, epoch, authAt, now, deviceId) {
  return signAccountSessionTicket(priv, { by: by, epoch: epoch, authAt: authAt, now: now, deviceId: deviceId || TEST_DEVICE_ID });
}
/** @param {string} priv @param {string} by @param {number} epoch @param {number} authAt @param {number} [now] @param {string} [deviceId] */
export async function testAccountSessionCookie(priv, by, epoch, authAt, now, deviceId) {
  return ACCOUNT_SESSION_COOKIE + '=' + (await testAccountSession(priv, by, epoch, authAt, now, deviceId));
}

/** @param {string} priv @param {string} name 票名 @param {string} by @param {number} epoch @param {number} [now] */
export function testTicket(priv, name, by, epoch, now) {
  return signTicket(priv, name, by, epoch, now);
}
/** @param {string} priv @param {string} name 票名 @param {string} by @param {number} epoch @param {number} [now] */
export async function testTicketCookie(priv, name, by, epoch, now) {
  return TICKETS[name].cookie + '=' + (await signTicket(priv, name, by, epoch, now));
}
