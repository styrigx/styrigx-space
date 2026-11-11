/**
 * v6 身份统一 P3：救援入口（定稿 v5.2 §九；命令名 rescue，Gray 2026-11-11 13:17 定）。
 *
 * 访客输恢复钥匙 → 读 Secrets Store 的 SGX_ACCOUNT_RESCUE_KEY（运行时只有 get()，经 secrets.js 换成字符串）→ 恒定时间比对 →
 * 通过则签 15 分钟一次性 root 会话（rescue 标志、不续期；core/identity-stack.js issueRescueSession）。
 *
 * - 指纹（§九）：签发成功时在 D1 account_recovery_key（复用 P1 的表，改作救援指纹表）记该值的哈希（不存明文），永久保留；
 *   同值再用直接拒；指纹写失败则拒绝救援（fail-closed：刚签的会话当场删掉，不发 cookie）。
 *   哈希 = SHA-256(域前缀 + 钥匙)：要按值查「用过没有」，所以不加随机盐；钥匙本身 ≥ 32 位随机（§九），SHA-256 不可逆推。
 * - 规范化：比对前两边都去掉全部空白（沿用已上线恢复密钥的 normalizeRecoveryKey：Samsung Pass 粘贴多行），去空白后为空一律拒。
 * - 限流（§九「单独限流（渐进延迟）」）：沿用 §十 已定的两维参数，单独的计数 kind（不和 su / 密码共用）：
 *   按 IP 硬上限（每分钟 6 次失败）；按救援入口本身（目标只有 root）渐进退避 1s → 5s → 30s → 5min，不硬锁。只有失败才写计数。
 * - 审计（§九 / §十）：account_user_audit——成功 `rescue`（uid 0），失败 `login-fail rescue`（钥匙错 / 同值复用 / 指纹写失败分开记）。
 *   钥匙值一律不进审计、不进日志。
 * - 防枚举（§十）：钥匙错与同值复用回同一个错误（401 auth）；只在审计里区分。
 *
 * 代码纪律（§九）：这里只读 env 里已换好的字符串，不出现任何 Secrets Store 写 / 删调用（单测 grep 静态检查）。
 *
 * 只 import lib/ 和 core/。
 */
import { timingSafeEqual } from '../lib/crypto.js';
import { onDb } from '../lib/db.js';
import { ipBucket } from '../lib/http.js';
import { readAttempt, recordAttempt, clearAttempt } from '../lib/attempt-limit.js';
import { RESCUE_KEY_SECRET } from './config.js';
import { normalizeRecoveryKey } from './recovery-key.js';
import { IP_LIMIT, NAME_BACKOFF_MS } from './identity-auth.js';
import { ROOT_UID } from './groups.js';
import { getUser } from './users.js';
import { issueRescueSession, endSession } from './identity-stack.js';

export { RESCUE_KEY_SECRET };

/** 救援入口的计数（单独的 kind，不和 su / 旧恢复密钥共用）：IP 维度 */
export const RESCUE_IP_LIMIT = Object.freeze({ kind: 'v6-rescue-ip', max: IP_LIMIT.max, windowMs: IP_LIMIT.windowMs });
/** 救援入口的计数：渐进退避（目标只有 root，一个桶） */
export const RESCUE_BACKOFF = Object.freeze({ kind: 'v6-rescue', bucket: 'root', table: NAME_BACKOFF_MS });
const BACKOFF_TTL_MS = 24 * 3600 * 1000;

/** 指纹的域前缀（别的哈希撞不上） */
const FP_PREFIX = 'sgx-rescue-fingerprint:v1:';

/** 钥匙值 → 指纹（hex SHA-256；不存明文） @param {string} key 已规范化 */
export async function rescueFingerprint(key) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(FP_PREFIX + key));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 冷却中？出错抛错。 @param {any} env @param {string} ip */
async function inCooldown(env, ip) {
  const now = Date.now();
  const byIp = await readAttempt(env, RESCUE_IP_LIMIT.kind, ipBucket(ip));
  if (byIp && byIp.lockedUntil > now) return true;
  const back = await readAttempt(env, RESCUE_BACKOFF.kind, RESCUE_BACKOFF.bucket);
  return !!(back && back.lockedUntil > now);
}

/** 记一次失败（两维，原子）。出错抛错。 @param {any} env @param {string} ip */
async function recordFail(env, ip) {
  await recordAttempt(env, RESCUE_IP_LIMIT.kind, ipBucket(ip), { max: RESCUE_IP_LIMIT.max, ttlMs: RESCUE_IP_LIMIT.windowMs, lockMs: RESCUE_IP_LIMIT.windowMs });
  await recordAttempt(env, RESCUE_BACKOFF.kind, RESCUE_BACKOFF.bucket, { max: 1, ttlMs: BACKOFF_TTL_MS, lockTable: RESCUE_BACKOFF.table.slice() });
}

/** 这把钥匙用过没有（指纹在表里）。出错抛错。 @param {any} env @param {string} fp */
async function fingerprintUsed(env, fp) {
  const row = await onDb(env, (d) => d.prepare('SELECT 1 AS x FROM account_recovery_key WHERE id = ?').bind(fp).first());
  return !!row;
}

/** 记指纹（主键冲突 = 并发的同值复用，同样抛错）。 @param {any} env @param {string} fp @param {number} now */
async function recordFingerprint(env, fp, now) {
  await onDb(env, (d) => d.prepare('INSERT INTO account_recovery_key (id, record, created_at, used_at) VALUES (?, ?, ?, ?)')
    .bind(fp, JSON.stringify({ kind: 'rescue-fingerprint', alg: 'sha256' }), now, now).run());
}

/**
 * 救援：验钥匙 → 签救援会话 → 记指纹（失败则作废会话、拒绝）。永不抛错。
 * @param {any} env 已换好密钥字符串的 env @param {{ip:string, key:any, now?:number}} q
 * @returns {Promise<{ok:true, token:string, id:string, expiresAt:number, cookie:string}
 *   |{ok:false, error:'auth'|'cooldown'|'config'|'server', audit:string}>}
 */
export async function rescue(env, q) {
  const now = typeof q.now === 'number' ? q.now : Date.now();
  const secret = normalizeRecoveryKey(env && typeof env[RESCUE_KEY_SECRET] === 'string' ? env[RESCUE_KEY_SECRET] : '');
  if (!secret) return { ok: false, error: 'config', audit: '' };
  try {
    if (await inCooldown(env, q.ip)) return { ok: false, error: 'cooldown', audit: '' };
  } catch (e) {
    return { ok: false, error: 'server', audit: '' };
  }
  const given = normalizeRecoveryKey(q.key);
  const match = (await timingSafeEqual(given, secret)) && given.length > 0;
  /** 失败：计数（D1 出错 → 503 server，fail closed） @param {string} audit */
  const fail = async (audit) => {
    try { await recordFail(env, q.ip); } catch (e) { return { ok: false, error: /** @type {'server'} */ ('server'), audit }; }
    return { ok: false, error: /** @type {'auth'} */ ('auth'), audit };
  };
  if (!match) return fail('login-fail rescue');
  let fp;
  try {
    fp = await rescueFingerprint(given);
    if (await fingerprintUsed(env, fp)) return fail('login-fail rescue reused');
  } catch (e) {
    return { ok: false, error: 'server', audit: 'login-fail rescue fingerprint' };
  }
  let root = null;
  try { root = await getUser(env, ROOT_UID); } catch (e) { return { ok: false, error: 'server', audit: '' }; }
  if (!root) return { ok: false, error: 'server', audit: '' };
  let s;
  try { s = await issueRescueSession(env, { epoch: root.epoch }, now); } catch (e) { return { ok: false, error: 'server', audit: '' }; }
  try {
    await recordFingerprint(env, fp, now);
  } catch (e) {
    /* fail-closed：指纹没记上（含并发的同值复用撞主键）→ 刚签的会话作废，不发 cookie */
    try { await endSession(env, s.id); } catch (e2) {}
    let reused = false;
    try { reused = await fingerprintUsed(env, fp); } catch (e3) {}
    if (reused) return fail('login-fail rescue reused');
    return { ok: false, error: 'server', audit: 'login-fail rescue fingerprint' };
  }
  try { await clearAttempt(env, RESCUE_BACKOFF.kind, RESCUE_BACKOFF.bucket); } catch (e) {}
  return { ok: true, token: s.token, id: s.id, expiresAt: s.expiresAt, cookie: s.cookie };
}
