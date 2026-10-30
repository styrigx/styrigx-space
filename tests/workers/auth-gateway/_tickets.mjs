/**
 * 测试用：按三张锁屏票的真实格式签测试 cookie 值（与 workers/auth-gateway/functions/_kernel 同一套签名函数）。
 * 账号票（会话 / reauth / reset）只在账号 Worker 签：见 tests/workers/account/_auth.mjs（账号拆分 PR3）。
 * - testLockSession(priv, epoch, role, by?)：role 'admin' | 'visitor'；admin 的 by 默认 password（可传 passkey）；
 *   visitor 固定 by=tempkey、tempkeyId=TEST_TEMPKEY_ID（验票只查这把钥匙有没有被作废）
 * - testTicket(priv, name, by, epoch, now?)：两张锁屏 reset / reauth 短票（name 用 realms.js 的票名常量）
 * - *Cookie() 版本直接返回「cookie名=值」
 */
import { signLockSessionTicket } from '../../../workers/auth-gateway/functions/_kernel/lock-session.js';
import { signTicket } from '../../../workers/auth-gateway/functions/_kernel/tickets.js';
import { TICKETS, LOCK_SESSION_COOKIE } from '../../../workers/auth-gateway/functions/_kernel/realms.js';

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

/** @param {string} priv @param {string} name 票名 @param {string} by @param {number} epoch @param {number} [now] */
export function testTicket(priv, name, by, epoch, now) {
  return signTicket(priv, name, by, epoch, now);
}
/** @param {string} priv @param {string} name 票名 @param {string} by @param {number} epoch @param {number} [now] */
export async function testTicketCookie(priv, name, by, epoch, now) {
  return TICKETS[name].cookie + '=' + (await signTicket(priv, name, by, epoch, now));
}

/* ---------- 账号会话：网关不验，问账号 Worker 的 AccountVerifier（服务绑定 ACCOUNT_VERIFIER） ---------- */

/** 测试用账号会话 cookie：fakeAccountVerifier 只认这个值 */
export const TEST_ACCOUNT_COOKIE = 'sgx-account-session=test-account-session-ok';

/**
 * ACCOUNT_VERIFIER 的替身：Cookie 头里有 TEST_ACCOUNT_COOKIE → { ok:true }；没 cookie → no-cookie；否则 denied。
 * calls 记下每次调用的 [cookieHeader, clientContext]（核对网关原样转 Cookie、带 UA / 地点）。
 * @param {{throws?:boolean}} [o]
 */
export function fakeAccountVerifier(o) {
  const calls = [];
  return {
    calls,
    async accountSession(cookieHeader, clientContext) {
      calls.push([cookieHeader, clientContext]);
      if (o && o.throws) throw new Error('down');
      if (!cookieHeader) return { ok: false, reason: 'no-cookie' };
      return String(cookieHeader).split(/;\s*/).includes(TEST_ACCOUNT_COOKIE) ? { ok: true } : { ok: false, reason: 'denied' };
    },
  };
}
