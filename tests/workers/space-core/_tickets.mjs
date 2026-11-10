/**
 * 测试用：按三张锁屏票的真实格式签测试 cookie 值（与 workers/space-core/src/core 同一套签名函数）。
 * 账号票（会话 / reauth / reset）只在账号 Worker 签：见 tests/workers/account/_auth.mjs（账号拆分 PR3）。
 * - testLockSession(priv, epoch, by?, o?)：LockSessionTicket v2（by.epoch.exp.linkId，进门二值）；
 *   by = password（默认）| passkey | link（v5 S1 起取代 tempkey）；by=link 时 linkId 默认 TEST_LINK_ID
 *   （验票查 share_link 这一行：测试用的网关 D1 替身 makeAuthD1 跑完迁移后预置了一条有效的 TEST_LINK_ID，见 tests/workers/_harness.cjs）
 * - testTicket(priv, name, by, epoch, now?)：两张锁屏 reset / reauth 短票（name 用 realms.js 的票名常量）
 * - *Cookie() 版本直接返回「cookie名=值」
 */
import { signLockSessionTicket } from '../../../workers/space-core/src/core/lock-session.js';
import { signTicket } from '../../../workers/space-core/src/core/tickets.js';
import { TICKETS, LOCK_SESSION_COOKIE } from '../../../workers/space-core/src/core/realms.js';

/** by=link 测试会话默认的分享链接 id（share_link.id；makeAuthD1 预置这一行，一年后到期、没作废） */
export const TEST_LINK_ID = 'lktesttesttest01';
export const TEST_DEVICE_ID = 'devtestdevtest01';

/**
 * @param {string} priv SGX_SPACE_PRIVATE
 * @param {number} epoch
 * @param {string} [by] password（默认）| passkey | link
 * @param {{ttlSec?:number, linkId?:string}} [o]
 */
export function testLockSession(priv, epoch, by, o) {
  const opts = o || {};
  const b = by || 'password';
  const lk = b === 'link';
  return signLockSessionTicket(priv, {
    by: b,
    epoch: epoch,
    exp: Date.now() + (opts.ttlSec || (lk ? 3600 : 43200)) * 1000,
    linkId: lk ? (opts.linkId || TEST_LINK_ID) : '',
  });
}
/** @param {string} priv @param {number} epoch @param {string} [by] @param {any} [o] */
export async function testLockSessionCookie(priv, epoch, by, o) {
  return LOCK_SESSION_COOKIE + '=' + (await testLockSession(priv, epoch, by, o));
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

/** 测试用账号会话 cookie：fakeAuthorizeVerifier 只认这个值 */
export const TEST_ACCOUNT_COOKIE = 'sgx-account-session=test-account-session-ok';

/**
 * ACCOUNT_VERIFIER.authorize 的替身（P2-2 起网关问账号结论用 askAuthorize）：Cookie 头里有 TEST_ACCOUNT_COOKIE → { ok:true }；
 * 没 cookie → no-cookie；否则 missing。
 */
export function fakeAuthorizeVerifier() {
  const calls = [];
  return {
    calls,
    async authorize(cookieHeader, ctx, opts) {
      calls.push([cookieHeader, opts]);
      if (!cookieHeader) return { ok: false, reason: 'no-cookie' };
      return String(cookieHeader).split(/;\s*/).includes(TEST_ACCOUNT_COOKIE)
        ? { ok: true, reason: 'ok', deviceId: TEST_DEVICE_ID, scopes: [], reauth: false }
        : { ok: false, reason: 'missing' };
    },
  };
}
