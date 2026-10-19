/**
 * 账号会话（sgx-account）：签发、解析、验证、吊销纪元。
 *
 * 账号登录三个入口平级（账号通行密钥 / 账号密码 / 根凭证），任一成功即签发本票据。
 * 与 lock 会话（sgx-verified）完全独立：lock 会话从不被当作账号认证，
 * 本票据也从不被当作 lock 会话。
 *
 * 票据格式（五段）：by.epoch.authAt.exp.sig
 * - by：passkey | password | root（REALM_ACCOUNT.bys）
 * - epoch：KV account-epoch（改账号密码 / 删账号通行密钥时 +1）
 * - authAt：本次登录验证时刻（毫秒）；重签（epoch 推进后保持当前设备）时保留原值
 * - exp：过期时刻（毫秒）
 * - sig：Ed25519(SGX_ACCOUNT_PRIVATE, "by.epoch.authAt.exp")，base64url
 *
 * 缺 SGX_ACCOUNT_PRIVATE / SGX_ACCOUNT_PUBLIC：签发返回 503 config，验证一律失败
 * （reason=no-pubkey）；只影响账号登录与进门，网站其余部分不受影响。
 *
 * 叶子模块：只 import _kernel（crypto / realms），不 import 接口或 _middleware.js。
 */
import { ed25519Sign, ed25519Verify } from './crypto.js';
import { REALM_ACCOUNT, realmPrivateKey, realmPublicKey, realmCookie, realmClearCookie } from './realms.js';

export const ACCOUNT_COOKIE = REALM_ACCOUNT.cookie; /* 'sgx-account' */
export const ACCOUNT_MAX_AGE = REALM_ACCOUNT.maxAge; /* 12 小时 */
export const ACCOUNT_RECENT_MS = REALM_ACCOUNT.recent * 1000; /* 10 分钟 */
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
 */
export async function signAccountTicket(privatePem, by, epoch, authAt, now) {
  if (!isAccountBy(by)) throw new Error('signAccountTicket: bad by ' + JSON.stringify(by));
  const t = now || Date.now();
  const exp = t + ACCOUNT_MAX_AGE * 1000;
  const payload = by + '.' + epoch + '.' + authAt + '.' + exp;
  const sig = await ed25519Sign(privatePem, payload);
  return payload + '.' + sig;
}

/**
 * 解析账号票据值（不验签）。
 * @param {string} val
 * @returns {{by:string, epoch:number, authAt:number, exp:number, sig:string}|null}
 */
export function parseAccountTicket(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 5) return null;
  const by = parts[0];
  if (!isAccountBy(by)) return null;
  const epoch = parseInt(parts[1], 10);
  const authAt = parseInt(parts[2], 10);
  const exp = parseInt(parts[3], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(authAt) || !Number.isFinite(exp)) return null;
  if (!parts[4]) return null;
  return { by, epoch, authAt, exp, sig: parts[4] };
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
 * @returns {Promise<{ok:boolean, reason:string, by?:string, epoch?:number, authAt?:number, exp?:number, recent?:boolean}>}
 *   reason: ok / no-cookie / bad-format / expired / not-yet / no-pubkey / epoch-changed / kv-error / bad-sig
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
    cur = await getAccountEpoch(env && env.OWNER_KV);
  } catch (e) {
    return { ok: false, reason: 'kv-error' };
  }
  if (p.epoch !== cur) return { ok: false, reason: 'epoch-changed' };
  const ok = await ed25519Verify(pub, p.by + '.' + p.epoch + '.' + p.authAt + '.' + p.exp, p.sig);
  if (!ok) return { ok: false, reason: 'bad-sig' };
  return {
    ok: true,
    reason: 'ok',
    by: p.by,
    epoch: p.epoch,
    authAt: p.authAt,
    exp: p.exp,
    recent: isAccountRecent(p.authAt, now),
  };
}

/**
 * 账号登录是否「近期」（now - authAt ≤ 10 分钟）。进门、账号页管理操作都要求近期。
 * @param {number} authAt
 * @param {number} [now]
 */
export function isAccountRecent(authAt, now) {
  const t = now || Date.now();
  return Number.isFinite(authAt) && t - authAt <= ACCOUNT_RECENT_MS && authAt <= t + 60000;
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
      epoch = await getAccountEpoch(env && env.OWNER_KV);
    } catch (e) {
      return { status: 503, body: { ok: false, error: 'server' } };
    }
  }
  try {
    const authAt = typeof o.authAt === 'number' ? o.authAt : Date.now();
    const cv = await signAccountTicket(realmPrivateKey(env, REALM_ACCOUNT), by, epoch, authAt);
    headers.append('Set-Cookie', realmCookie(REALM_ACCOUNT, cv));
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
