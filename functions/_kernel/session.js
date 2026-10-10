/**
 * 2.8.0 会话角色分离（安全优先项）。
 *
 * - sgx-verified cookie 的设置/清除只走这里的属性定义（一处定义）：
 *   Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax
 * - cookie 值格式：role.epoch.exp.sig，Ed25519(SGX_ED25519_PRIVATE) 签名，
 *   与 functions/_middleware.js 的验签逻辑对应。
 *   role: 'owner'（密码/通行密钥，12 小时）或 'visitor'（Turnstile，1 小时）。
 *   旧格式（无 role，三段式）一律视为无效，不留兼容层。
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
 * 签名会话 cookie 值：role.epoch.exp.Ed25519(私钥, "role.epoch.exp")。
 * @param {string} privatePem Ed25519 私钥（PKCS8 PEM，只配主站）
 * @param {number} epoch session epoch
 * @param {string} role 'owner' 或 'visitor'
 */
export async function signSessionCookie(privatePem, epoch, role) {
  const r = role === ROLE_VISITOR ? ROLE_VISITOR : ROLE_OWNER;
  const maxAge = r === ROLE_VISITOR ? VISITOR_MAX_AGE : SESSION_MAX_AGE;
  const exp = String(Date.now() + maxAge * 1000);
  const payload = r + '.' + epoch + '.' + exp;
  const sig = await ed25519Sign(privatePem, payload);
  return payload + '.' + sig;
}

/**
 * 签发会话 cookie（fail closed，三解锁入口共用）。
 * 成功时在 headers 上设置 cookie 并返回 null；失败时返回 { status, body }，
 * 调用方直接用它构造响应。永远不抛错，避免外层 try/catch 吞掉明确错误码。
 * - SGX_ED25519_PRIVATE 为空 → 500 {ok:false, error:'no-session-key'}
 * - getSessionEpoch 抛错（KV 未绑定/读取出错）→ 503 {ok:false, error:'server'}
 * - signSessionCookie 抛错（importKey 失败等）→ 500 {ok:false, error:'session-sign-failed'}
 * @param {any} env
 * @param {Headers} headers
 * @param {string} role 'owner' 或 'visitor'（默认 owner）
 */
export async function issueSessionCookie(env, headers, role) {
  const r = role === ROLE_VISITOR ? ROLE_VISITOR : ROLE_OWNER;
  const edPriv = (env && env.SGX_ED25519_PRIVATE) || '';
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
  let cv;
  try {
    cv = await signSessionCookie(edPriv, epoch, r);
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'session-sign-failed' } };
  }
  const maxAge = r === ROLE_VISITOR ? VISITOR_MAX_AGE : SESSION_MAX_AGE;
  setVerifiedCookie(headers, cv, maxAge);
  return null;
}

/**
 * 解析会话 cookie 值。
 * 2.8.0：只认四段式 role.epoch.exp.sig；旧三段式（无 role）一律视为无效，不留兼容层。
 * @param {string} val
 * @returns {{role:string, epoch:number, exp:number, sig:string}|null}
 */
export function parseSessionCookie(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 4) return null;
  const role = parts[0];
  if (role !== ROLE_OWNER && role !== ROLE_VISITOR) return null;
  const epoch = parseInt(parts[1], 10);
  const exp = parseInt(parts[2], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(exp)) return null;
  return { role, epoch, exp, sig: parts[3] };
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
