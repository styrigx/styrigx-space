/**
 * 根凭证限速（所有 root 路径共用一套：/api/root-auth、/api/lock-reset）。
 *
 * - 单 IP（IPv6 按 /64，见 http.js ipBucket）连错 5 次锁 15 分钟，锁定中码对也 429
 * - 全局只减速、不封锁：每小时真比对失败满 20 次后，之后每次根凭证校验先等 ROOT_GLOBAL_DELAY_MS 再比对，
 *   直到窗口过去。不设全局暂停：根凭证是锁屏和账号都丢了时的恢复入口，任何人（换 IP 很便宜）都不能
 *   靠刷错把主人锁在外面；防穷举靠单 IP 锁定 + 减速 + RootKey 本身足够长且随机
 * - 只有真比对失败计入全局（recordRootFail 默认）；无会话假入口只计单 IP（{ global:false }），不比对就不算猜测
 * - KV 读写出错一律抛错（调用方 fail closed，返回 503）
 *
 * KV 键（realms.js REALM_ROOT.kv）：
 * - root-fail:<ip 分桶>：{ count, lockedUntil }
 * - root-fail-global：{ count, windowStart }
 */
import { REALM_ROOT } from './realms.js';
import { ipBucket } from './http.js';

const ROOT_IP_MAX_FAIL = 5;
const ROOT_IP_LOCK_MS = 15 * 60 * 1000;
export const ROOT_GLOBAL_SLOW_AT = 20;
const ROOT_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
export const ROOT_GLOBAL_DELAY_MS = 3000;

function failKey(ip) { return REALM_ROOT.kv.failPrefix + ipBucket(ip); }
const GLOBAL_KEY = REALM_ROOT.kv.failGlobal;

/**
 * 检查是否被限速。KV 出错时抛错（调用方返回 503）。
 * @param {any} kv
 * @param {string} ip
 * @returns {Promise<{limited:boolean, delayMs:number}>} delayMs：全局减速时比对前要等的毫秒数
 */
export async function checkRootLimit(kv, ip) {
  if (!kv) throw new Error('kv-missing');
  const now = Date.now();
  const rec = await kv.get(failKey(ip), 'json'); /* 出错直接抛 */
  if (rec && rec.lockedUntil > now) {
    return { limited: true, delayMs: 0 };
  }
  const g = await kv.get(GLOBAL_KEY, 'json'); /* 出错直接抛 */
  const hot = !!(g && g.windowStart + ROOT_GLOBAL_WINDOW_MS >= now && (g.count || 0) >= ROOT_GLOBAL_SLOW_AT);
  return { limited: false, delayMs: hot ? ROOT_GLOBAL_DELAY_MS : 0 };
}

/**
 * 记录一次失败。KV 出错时抛错（调用方返回 503）。
 * @param {any} kv
 * @param {string} ip
 * @param {{global?:boolean}} [opts] global=false：只计单 IP（无会话假入口用）
 */
export async function recordRootFail(kv, ip, opts) {
  if (!kv) throw new Error('kv-missing');
  const now = Date.now();
  const rec = (await kv.get(failKey(ip), 'json')) || { count: 0 };
  rec.count = (rec.count || 0) + 1;
  if (rec.count >= ROOT_IP_MAX_FAIL) {
    rec.lockedUntil = now + ROOT_IP_LOCK_MS;
    rec.count = 0;
  }
  await kv.put(failKey(ip), JSON.stringify(rec), { expirationTtl: 3600 });
  if (opts && opts.global === false) return;
  const g = (await kv.get(GLOBAL_KEY, 'json')) || { count: 0, windowStart: now };
  if (!(g.windowStart + ROOT_GLOBAL_WINDOW_MS >= now)) {
    g.count = 0;
    g.windowStart = now;
  }
  g.count = (g.count || 0) + 1;
  await kv.put(GLOBAL_KEY, JSON.stringify({ count: g.count, windowStart: g.windowStart }), { expirationTtl: 7200 });
}

/**
 * 清除某 IP 的失败计数（成功后调用；失败不影响主流程）。
 * @param {any} kv
 * @param {string} ip
 */
export async function clearRootFail(kv, ip) {
  if (!kv) return;
  try { await kv.delete(failKey(ip)); } catch (e) {}
}

/**
 * 获取客户端 IP（CF-Connecting-IP 优先）。
 * @param {any} request
 */
export function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         'unknown';
}
