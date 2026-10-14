/**
 * 2.8.0 会话角色分离（安全优先项）。
 * 2.11：会话票带 by 字段（by=root|owner），格式：by.role.epoch.exp.sig。
 *
 * - sgx-verified cookie 的设置/清除只走这里的属性定义（一处定义）：
 *   Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax
 * - cookie 值格式：by.role.epoch.exp.sig，Ed25519(SGX_LOCK_PRIVATE) 签名，
 *   与 functions/_middleware.js 的验签逻辑对应。
 *   by: 'root'（根密钥代开）或 'owner'（owner 凭证）
 *   role: 'owner'（密码/通行密钥，12 小时）或 'visitor'（Turnstile，1 小时）。
 *   旧格式（无 by，四段式）一律视为无效，不留兼容层。
 * - session-epoch 读写：KV 读取出错一律抛错（调用方返回 503，绝不继续写入）；
 *   只有 key 确实不存在时才当作 0。
 */
import { ed25519Sign } from './crypto.js';

export const SESSION_COOKIE = 'sgx-verified';
/* cookie 属性：只定义一处（diag 接口从这里解析，不许另起炉灶） */
export const COOKIE_ATTRS = 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax';
export const SESSION_MAX_AGE = 43200; /* 12 小时（owner） */
export const VISITOR_MAX_AGE = 3600; /* 1 小时（visitor），短于 owner */
export const EPOCH_KEY = 'session-epoch';
export const ROLE_OWNER = 'owner';
export const ROLE_VISITOR = 'visitor';
/* 2.11：会话签发方 */
export const BY_ROOT = 'root';
export const BY_OWNER = 'owner';

/**
 * 设置会话 cookie（统一属性）。
 * 2.4.1 dedup：同时下发一条不带 Domain 的清除头，干掉旧版（2.4.0）留下的
 * 主机绑定同名 cookie——否则浏览器会把新旧两个值都发过来。
 * @param {Headers} headers
 * @param {string} value cookie 值（role.epoch.exp.sig）
 * @param {number} maxAge Max-Age（秒），owner 用 SESSION_MAX_AGE，visitor 用 VISITOR_MAX_AGE
 */
export function setVerifiedCookie(headers, value, maxAge) {
  const age = maxAge || SESSION_MAX_AGE;
  headers.append(
    'Set-Cookie',
    SESSION_COOKIE + '=' + value + '; ' + COOKIE_ATTRS + '; Max-Age=' + age
  );
  headers.append(
    'Set-Cookie',
    SESSION_COOKIE + '=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  );
}

/**
 * 清除会话 cookie（与设置用相同的 Domain/Path，正确过期）。
 * 2.4.1 dedup：同时清除不带 Domain 的主机绑定旧 cookie。
 * @param {Headers} headers
 */
export function clearVerifiedCookie(headers) {
  headers.append(
    'Set-Cookie',
    SESSION_COOKIE + '=; ' + COOKIE_ATTRS + '; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  );
  headers.append(
    'Set-Cookie',
    SESSION_COOKIE + '=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  );
}

/**
 * 签名会话 cookie 值：by.role.epoch.exp.Ed25519(私钥, "by.role.epoch.exp")。
 * 2.11：by=root|owner，标识会话签发方。
 * @param {string} privatePem Ed25519 私钥（PKCS8 PEM，只配主站）
 * @param {number} epoch session epoch
 * @param {string} role 'owner' 或 'visitor'
 * @param {string} by 'root' 或 'owner'（默认 'owner'）
 */
export async function signSessionCookie(privatePem, epoch, role, by, maxAge) {
  if (role !== ROLE_OWNER && role !== ROLE_VISITOR) {
    throw new Error('signSessionCookie: role must be "owner" or "visitor", got ' + JSON.stringify(role));
  }
  by = by || BY_OWNER;
  if (by !== BY_ROOT && by !== BY_OWNER) {
    throw new Error('signSessionCookie: by must be "root" or "owner", got ' + JSON.stringify(by));
  }
  /* visitor 会话只能由 owner 签发（root 代开只用于 owner 会话） */
  if (role === ROLE_VISITOR && by !== BY_OWNER) {
    throw new Error('signSessionCookie: visitor session must be by=owner');
  }
  const age = maxAge || (role === ROLE_VISITOR ? VISITOR_MAX_AGE : SESSION_MAX_AGE);
  const exp = String(Date.now() + age * 1000);
  const payload = by + '.' + role + '.' + epoch + '.' + exp;
  const sig = await ed25519Sign(privatePem, payload);
  return payload + '.' + sig;
}

/**
 * 签发会话 cookie（fail closed，三解锁入口共用）。
 * 成功时在 headers 上设置 cookie 并返回 null；失败时返回 { status, body }，
 * 调用方直接用它构造响应。永远不抛错，避免外层 try/catch 吞掉明确错误码。
 * - SGX_LOCK_PRIVATE 为空 → 500 {ok:false, error:'no-session-key'}
 * - getSessionEpoch 抛错（KV 未绑定/读取出错）→ 503 {ok:false, error:'server'}
 * - signSessionCookie 抛错（importKey 失败等）→ 500 {ok:false, error:'session-sign-failed'}
 * @param {any} env
 * @param {Headers} headers
 * @param {string} role 'owner' 或 'visitor'（必须显式传，非法值返回 500 invalid-role）
 * @param {string} by 'root' 或 'owner'（默认 'owner'）；2.11 root 代开时传 'root'
 * @param {number} maxAgeOverride 可选：覆盖默认 Max-Age（秒）；2.11 root 代开的解锁会话约 12 小时
 */
export async function issueSessionCookie(env, headers, role, by, maxAgeOverride) {
  if (role !== ROLE_OWNER && role !== ROLE_VISITOR) {
    return { status: 500, body: { ok: false, error: 'invalid-role' } };
  }
  by = by || BY_OWNER;
  const edPriv = (env && env.SGX_LOCK_PRIVATE) || '';
  if (!edPriv) {
    return { status: 500, body: { ok: false, error: 'no-session-key' } };
  }
  const kv = env && env.OWNER_KV;
  let epoch;
  try {
    epoch = await getSessionEpoch(kv);
  } catch (e) {
    return { status: 503, body: { ok: false, error: 'server' } };
  }
  const maxAge = maxAgeOverride || (role === ROLE_VISITOR ? VISITOR_MAX_AGE : SESSION_MAX_AGE);
  let cv;
  try {
    cv = await signSessionCookie(edPriv, epoch, role, by, maxAge);
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'session-sign-failed' } };
  }
  setVerifiedCookie(headers, cv, maxAge);
  return null;
}

/**
 * 解析会话 cookie 值。
 * 2.11：五段式 by.role.epoch.exp.sig；旧四段式（无 by）一律视为无效，不留兼容层。
 * @param {string} val
 * @returns {{by:string, role:string, epoch:number, exp:number, sig:string}|null}
 */
export function parseSessionCookie(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 5) return null;
  const by = parts[0];
  if (by !== BY_ROOT && by !== BY_OWNER) return null;
  const role = parts[1];
  if (role !== ROLE_OWNER && role !== ROLE_VISITOR) return null;
  const epoch = parseInt(parts[2], 10);
  const exp = parseInt(parts[3], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(exp)) return null;
  return { by, role, epoch, exp, sig: parts[4] };
}

/**
 * 读取当前 session epoch。
 * KV 读取出错时抛错（调用方必须返回 503，绝不继续写入）；
 * 只有 key 确实不存在时才当作 0。
 * @param {any} kv
 */
export async function getSessionEpoch(kv) {
  const v = await kv.get(EPOCH_KEY); /* 出错直接抛，不吞 */
  if (v === null || v === undefined) return 0;
  return parseInt(v, 10) || 0;
}

/**
 * 用新 epoch 重签当前设备的会话 cookie（D2：删 lock 钥匙 / 改密码后保持当前设备不掉线）。
 * - sess：verifySessionDetailed 返回的 {ok, by, role}（必须 ok）
 * - newEpoch：bump 后的新 epoch
 * - 属性与有效期与原会话同（同 by/role、同默认 Max-Age）；失败时静默（调用方已返回业务成功）。
 * - lockreset 等无会话场景：sess 为 null/不 ok 时不做任何事。
 * - 必修安全项 2：by=root 的代开会话一律不重签（首次配 lock 的 bump 就是为了废止它，
 *   重签回来等于 epoch +1 白做）。此检查写在 helper 里，所有调用点都生效。
 * @param {any} env
 * @param {Headers} headers
 * @param {{ok:boolean, by:string, role:string}|null} sess
 * @param {number} newEpoch
 */
export async function reissueSessionWithEpoch(env, headers, sess, newEpoch) {
  if (!sess || !sess.ok || !sess.by || !sess.role) return;
  /* 必修安全项 2：by=root 代开会话不重签，随 epoch 失效。 */
  if (sess.by === BY_ROOT) return;
  const edPriv = (env && env.SGX_LOCK_PRIVATE) || '';
  if (!edPriv) return;
  try {
    const maxAge = sess.role === ROLE_VISITOR ? VISITOR_MAX_AGE : SESSION_MAX_AGE;
    const cv = await signSessionCookie(edPriv, newEpoch, sess.role, sess.by, maxAge);
    setVerifiedCookie(headers, cv, maxAge);
  } catch (e) {}
}

/**
 * session-epoch +1（改密码/删密码/退出所有设备时调用）。
 * 读取出错时抛错，绝不写入（杜绝"出错→当 0→写入 1→epoch 变小→旧 cookie 复活"）。
 * @param {any} kv
 * @returns {Promise<number>} 新 epoch
 */
export async function bumpSessionEpoch(kv) {
  const v = await getSessionEpoch(kv);
  await kv.put(EPOCH_KEY, String(v + 1));
  return v + 1;
}
