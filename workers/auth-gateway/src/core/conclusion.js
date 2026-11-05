/**
 * 网关结论（方案 2.3、4.3；P2-1 授权骨架）：网关验门、问账号 Worker，再把结论交给下游。
 *
 * - RPC 结论（方案 2.3.2）：conclusionFor(env, cookieHeader, clientContext, opts) →
 *     { lock: { ok, by, tempkeyId, reason }, account: { ok, deviceId, scopes, reauth, reason } }
 *   AuthVerifier.conclusion()（rpc/auth-verifier.js）就是它的薄包装。lock.ok=false 时不问账号（account.reason = 'no-lock'：进门是前置）；
 *   账号部分由 core/account-rpc.js askAuthorize 问 ACCOUNT_VERIFIER.authorize() 拿到，这里按白名单收下：
 *   deviceId 不合格式 / scopes 不是数组 → account.ok=false（bad-reply，fail closed）；不合格式的作用域丢掉，其余去重、按字母排序。
 * - HTTP 结论头（方案 2.3.1）：writeAccountConclusion(headers, account) 先剥掉所有 X-Styrigx-Account-*，再只写白名单值；
 *   某一项没有就不写这个头（不写 0）。stripAccountConclusion(headers) 只剥。浏览器带来的同名头在 app.js 第一步
 *   （core/lock-identity.js stripInternalHeaders，剥所有 x-styrigx-*）就已经剥掉，写之前这里再剥一次。
 *
 * P2-1 只新增，没有调用方：P2-2 起子站接口 Worker 经 AuthVerifier.conclusion() 用 RPC 结论；结论头只写给 styrigx-ai（第 4 件；
 * P4-2 起 search-index 退役，方案 2.3.1）。锁侧的 X-Styrigx-Lock-* 仍由 core/lock-identity.js 写。
 *
 * 网关里不出现账号票名（scripts/check-layers.mjs 规则 16）：复验结论只叫 account.reauth / X-Styrigx-Account-Reauth。
 * 作用域只认字符串格式（<应用>.<动作>，[a-z.]），不 import 账号 Worker 的作用域表（规则 14）。
 */
import { MAX_COOKIE_HEADER } from '../lib/cookies.js';
import { verifyLockSession } from './lock-session.js';
import { askAuthorize } from './account-rpc.js';

/** 账号结论头（方案 2.3.1） */
export const ACCOUNT_CONCLUSION_HEADERS = Object.freeze({
  session: 'X-Styrigx-Account-Session',
  device: 'X-Styrigx-Account-Device',
  scopes: 'X-Styrigx-Account-Scopes',
  reauth: 'X-Styrigx-Account-Reauth',
});

/** 账号结论头的公共前缀（小写） */
export const ACCOUNT_CONCLUSION_PREFIX = 'x-styrigx-account-';

/* 白名单 */
const LOCK_BYS = Object.freeze(['password', 'passkey', 'tempkey']);
const TEMPKEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 账号设备 id（同账号 Worker core/account-devices.js isDeviceId） */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
/** 作用域 id 格式：<应用>.<动作>，全小写，只用 [a-z.]（同账号 Worker core/scopes.js SCOPE_ID_RE） */
export const SCOPE_FORMAT_RE = /^[a-z]+\.[a-z]+$/;
const REASON_RE = /^[a-z0-9-]{1,32}$/;
const MAX_SCOPES = 32;

/** 原因代号只留 [a-z0-9-]{1,32}，否则用 fallback @param {any} r @param {string} fallback */
function reasonOf(r, fallback) {
  return typeof r === 'string' && REASON_RE.test(r) ? r : fallback;
}

/**
 * @typedef {{ ok: boolean, by: string, tempkeyId: string, reason: string }} LockConclusion
 * @typedef {{ ok: boolean, deviceId: string, scopes: string[], reauth: boolean, reason: string }} AccountConclusion
 * @typedef {{ lock: LockConclusion, account: AccountConclusion }} Conclusion
 */

/** @param {string} reason @returns {AccountConclusion} */
function accountDenied(reason) {
  return { ok: false, deviceId: '', scopes: [], reauth: false, reason };
}

/**
 * 锁屏会话（verifyLockSession 的结论）→ lock 结论：by 只认白名单；tempkeyId 只在 by=tempkey 且格式合规时给。
 * @param {any} s
 * @returns {LockConclusion}
 */
export function normalizeLockConclusion(s) {
  if (!s || typeof s !== 'object' || s.ok !== true) {
    return { ok: false, by: '', tempkeyId: '', reason: reasonOf(s && s.reason, 'no-session') };
  }
  const by = typeof s.by === 'string' && LOCK_BYS.indexOf(s.by) !== -1 ? s.by : '';
  const tk = typeof s.tempkeyId === 'string' ? s.tempkeyId : '';
  const tempkeyId = by === 'tempkey' && TEMPKEY_ID_RE.test(tk) ? tk : '';
  return { ok: true, by, tempkeyId, reason: 'ok' };
}

/**
 * 作用域白名单：只留字符串且合格式的，去重、按字母排序，最多 MAX_SCOPES 个。非数组 → null（看不懂）。
 * @param {any} list
 * @returns {string[]|null}
 */
export function normalizeScopes(list) {
  if (!Array.isArray(list)) return null;
  /** @type {string[]} */
  const out = [];
  for (const s of list) {
    if (typeof s === 'string' && SCOPE_FORMAT_RE.test(s) && out.indexOf(s) === -1) out.push(s);
    if (out.length >= MAX_SCOPES) break;
  }
  return out.sort();
}

/**
 * askAuthorize 的回答 → account 结论（白名单）。ok 不是 true、deviceId 不合格式、scopes 不是数组 → ok=false。
 * @param {any} a
 * @returns {AccountConclusion}
 */
export function normalizeAccountConclusion(a) {
  if (!a || typeof a !== 'object' || a.ok !== true) return accountDenied(reasonOf(a && a.reason, 'denied'));
  const deviceId = typeof a.deviceId === 'string' && DEVICE_ID_RE.test(a.deviceId) ? a.deviceId : '';
  const scopes = normalizeScopes(a.scopes);
  if (!deviceId || !scopes) return accountDenied('bad-reply');
  return { ok: true, deviceId, scopes, reauth: a.reauth === true, reason: 'ok' };
}

/** 把 Cookie 头还原成一个只带 Cookie 的内部请求（同 core/lock-session.js checkLockSession） @param {string} cookieHeader */
function cookieRequest(cookieHeader) {
  const c = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
  return new Request('https://internal.invalid/', { headers: c ? { Cookie: c } : {} });
}

/**
 * 网关结论（AuthVerifier.conclusion 的实现）：先验门（锁屏会话），进了门才问账号。永不抛错，出错 fail closed。
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 * @param {string} cookieHeader 浏览器发来的 Cookie 头（原样）
 * @param {any} [clientContext] { ua, country, city }（转给账号 Worker 刷设备 lastSeen 用）
 * @param {{reauth?:boolean}} [opts] 只有需要复验结论的接口才传 reauth: true（账号侧多读一张票）
 * @returns {Promise<Conclusion>}
 */
export async function conclusionFor(env, cookieHeader, clientContext, opts) {
  let lock;
  try {
    lock = normalizeLockConclusion(await verifyLockSession(cookieRequest(cookieHeader), env));
  } catch (e) {
    console.error('[sgx-auth] conclusion lock failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    lock = { ok: false, by: '', tempkeyId: '', reason: 'error' };
  }
  if (!lock.ok) return { lock, account: accountDenied('no-lock') };
  const want = { reauth: !!(opts && typeof opts === 'object' && opts.reauth === true) };
  let account;
  try {
    account = normalizeAccountConclusion(await askAuthorize(env, cookieHeader, clientContext, want));
  } catch (e) {
    account = accountDenied('error');
  }
  return { lock, account };
}

/** 这个头名是账号结论头吗（大小写不敏感） @param {string} name */
function isAccountConclusionHeader(name) {
  return String(name || '').toLowerCase().startsWith(ACCOUNT_CONCLUSION_PREFIX);
}

/**
 * 就地删掉所有 X-Styrigx-Account-*（任意大小写），返回同一个对象。
 * @param {Headers|null|undefined} headers
 */
export function stripAccountConclusion(headers) {
  if (!headers) return headers;
  const drop = [];
  for (const [k] of headers) if (isAccountConclusionHeader(k)) drop.push(k);
  for (const k of drop) headers.delete(k);
  return headers;
}

/**
 * 写账号结论头（方案 2.3.1）：先剥，再按白名单写；account.ok 不是 true → 一个都不写（= 下游看到的是无账号会话）。
 * - X-Styrigx-Account-Session: 1
 * - X-Styrigx-Account-Device: <deviceId>（合格式才写）
 * - X-Styrigx-Account-Scopes: 合格式的作用域，空格分隔、按字母排序（一个都没有就不写）
 * - X-Styrigx-Account-Reauth: 1（只在 reauth === true 时写）
 * @param {Headers} headers 要写的头（就地改）
 * @param {any} account conclusionFor(...).account，或同形状的对象
 * @returns {Headers}
 */
export function writeAccountConclusion(headers, account) {
  stripAccountConclusion(headers);
  const a = normalizeAccountConclusion(account);
  if (!a.ok) return headers;
  headers.set(ACCOUNT_CONCLUSION_HEADERS.session, '1');
  headers.set(ACCOUNT_CONCLUSION_HEADERS.device, a.deviceId);
  if (a.scopes.length) headers.set(ACCOUNT_CONCLUSION_HEADERS.scopes, a.scopes.join(' '));
  if (a.reauth) headers.set(ACCOUNT_CONCLUSION_HEADERS.reauth, '1');
  return headers;
}
