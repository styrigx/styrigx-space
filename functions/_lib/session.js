/**
 * 2.4.1 锁屏会话共享逻辑（space 三个解锁入口共用）。
 *
 * - sgx-verified cookie 的设置/清除只走这里的属性定义（一处定义）：
 *   Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; 正常 Max-Age=43200
 *   清除时用相同的 Domain/Path，Max-Age=0 + 过去时间的 Expires。
 * - cookie 值格式统一为 epoch.exp.sig，Ed25519(SGX_ED25519_PRIVATE) 签名，
 *   与 functions/_middleware.js 的验签逻辑对应。
 * - session-epoch 读写：KV 读取出错一律抛错（调用方返回 503，绝不继续写入）；
 *   只有 key 确实不存在时才当作 0。
 */
import { ed25519Sign } from './crypto.js';

export const SESSION_COOKIE = 'sgx-verified';
/* cookie 属性：只定义一处（diag 接口从这里解析，不许另起炉灶） */
export const COOKIE_ATTRS = 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax';
export const SESSION_MAX_AGE = 43200; /* 12 小时 */
export const EPOCH_KEY = 'session-epoch';

/**
 * 设置会话 cookie（统一属性）。
 * @param {Headers} headers
 * @param {string} value cookie 值（epoch.exp.sig）
 */
export function setVerifiedCookie(headers, value) {
  headers.append(
    'Set-Cookie',
    SESSION_COOKIE + '=' + value + '; ' + COOKIE_ATTRS + '; Max-Age=' + SESSION_MAX_AGE
  );
}

/**
 * 清除会话 cookie（与设置用相同的 Domain/Path，正确过期）。
 * @param {Headers} headers
 */
export function clearVerifiedCookie(headers) {
  headers.append(
    'Set-Cookie',
    SESSION_COOKIE + '=; ' + COOKIE_ATTRS + '; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  );
}

/**
 * 签名会话 cookie 值：epoch.exp.Ed25519(私钥, "epoch.exp")，12 小时有效。
 * @param {string} privatePem Ed25519 私钥（PKCS8 PEM，只配主站）
 * @param {number} epoch session epoch
 */
export async function signSessionCookie(privatePem, epoch) {
  const exp = String(Date.now() + SESSION_MAX_AGE * 1000);
  const payload = epoch + '.' + exp;
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
 */
export async function issueSessionCookie(env, headers) {
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
    cv = await signSessionCookie(edPriv, epoch);
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'session-sign-failed' } };
  }
  setVerifiedCookie(headers, cv);
  return null;
}

/**
 * 解析会话 cookie 值。
 * @param {string} val
 * @returns {{epoch:number, exp:number, sig:string}|null}
 */
export function parseSessionCookie(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 3) return null;
  const epoch = parseInt(parts[0], 10);
  const exp = parseInt(parts[1], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(exp)) return null;
  return { epoch, exp, sig: parts[2] };
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
