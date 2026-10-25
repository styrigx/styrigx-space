/**
 * 2.11：根凭证限速（所有 root 路径共用一套）。
 *
 * 从 root-auth.js 抽出，供 /api/root-auth、/api/lock-reset 共用。
 * - IP 连错 5 次锁 15 分钟；全局每小时失败 20 次暂停验证 1 小时
 * - KV 读写出错一律抛错（调用方 fail closed，返回 503）
 *
 * KV 键（与 2.10.x 兼容，沿用 root-auth- 前缀）：
 * - root-auth-fail:<ip>：{ count, lockedUntil }
 * - root-auth-global：{ count, windowStart, pausedUntil }
 */

const ROOT_IP_MAX_FAIL = 5;
const ROOT_IP_LOCK_MS = 15 * 60 * 1000;
const ROOT_GLOBAL_MAX_FAIL = 20;
const ROOT_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const ROOT_GLOBAL_PAUSE_MS = 60 * 60 * 1000;

function failKey(ip) { return 'root-auth-fail:' + ip; }
const GLOBAL_KEY = 'root-auth-global';

/**
 * 检查是否被限速。KV 出错时抛错（调用方返回 503）。
 * @param {any} kv
 * @param {string} ip
 * @returns {Promise<{limited:boolean}>}
 */
export async function checkRootLimit(kv, ip) {
  if (!kv) throw new Error('kv-missing');
  const now = Date.now();
  const g = await kv.get(GLOBAL_KEY, 'json'); /* 出错直接抛 */
  if (g && g.pausedUntil > now) {
    return { limited: true };
  }
  if (g && g.windowStart + ROOT_GLOBAL_WINDOW_MS < now) {
    await kv.delete(GLOBAL_KEY);
  }
  const rec = await kv.get(failKey(ip), 'json'); /* 出错直接抛 */
  if (rec && rec.lockedUntil > now) {
    return { limited: true };
  }
  return { limited: false };
}

/**
 * 记录一次失败。KV 出错时抛错（调用方返回 503）。
 * @param {any} kv
 * @param {string} ip
 */
export async function recordRootFail(kv, ip) {
  if (!kv) throw new Error('kv-missing');
  const now = Date.now();
  const rec = (await kv.get(failKey(ip), 'json')) || { count: 0 };
  rec.count = (rec.count || 0) + 1;
  if (rec.count >= ROOT_IP_MAX_FAIL) {
    rec.lockedUntil = now + ROOT_IP_LOCK_MS;
    rec.count = 0;
  }
  await kv.put(failKey(ip), JSON.stringify(rec), { expirationTtl: 3600 });
  const g = (await kv.get(GLOBAL_KEY, 'json')) || { count: 0, windowStart: now };
  if (g.windowStart + ROOT_GLOBAL_WINDOW_MS < now) {
    g.count = 0;
    g.windowStart = now;
  }
  g.count = (g.count || 0) + 1;
  if (g.count >= ROOT_GLOBAL_MAX_FAIL) {
    g.pausedUntil = now + ROOT_GLOBAL_PAUSE_MS;
    g.count = 0;
  }
  await kv.put(GLOBAL_KEY, JSON.stringify(g), { expirationTtl: 7200 });
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
