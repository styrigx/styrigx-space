/**
 * 根凭证限速（所有 root 路径共用一套：/api/root-auth、/api/lock-reset）。
 *
 * - 单 IP（IPv6 按 /64，见 http.js ipBucket）连错 5 次锁 15 分钟，锁定中码对也 429
 * - 全局只减速、不封锁：每小时真比对失败满 20 次后，之后每次根凭证校验先等 ROOT_GLOBAL_DELAY_MS 再比对，
 *   直到窗口过去。不设全局暂停：根凭证是锁屏和账号都丢了时的恢复入口，任何人（换 IP 很便宜）都不能
 *   靠刷错把主人锁在外面；防穷举靠单 IP 锁定 + 减速 + RootKey 本身足够长且随机
 * - 只有真比对失败计入全局（recordRootFail 默认）；无会话假入口只计单 IP（{ global:false }），不比对就不算猜测
 * - D1 读写出错一律抛错（调用方 fail closed，返回 503）
 *
 * 存储：D1 attempt_limit 表（attempt-limit.js；2026-10-27 从 KV root-fail:* / root-fail-global 搬来），realm = 'root'、kind = 'rootkey'：
 * - bucket = IP 分桶：count、locked_until（expires_at = 最后一次失败 + 1 小时）
 * - bucket = '*'：每小时窗口的失败次数
 * 每次记失败都是原子 UPSERT（并发的失败不会互相覆盖）。
 *
 * 按域参数化（账号拆分 PR1 搬到共享模块 workers/auth-gateway/functions/_kernel/lib/，零行为变化）：rootLimiter(realm) 给出某个根域的一套限速函数，
 * 行的 realm 列 = realm.id、经 realm.d1Binding 读写；本模块不认识具体的域。网关 _kernel/root-limit.js 用 REALM_LOCK
 * （realm='lock'、kind='rootkey'、D1_LOCK_AUTH；账号拆分 PR3 起锁屏根密钥的计数归锁屏域，原来的 REALM_ROOT 已删）绑好再导出。
 */
import { ipBucket } from './http.js';
import { readAttempt, globalHot, recordAttempt, recordGlobal, clearAttempt } from './attempt-limit.js';

const ROOT_IP_MAX_FAIL = 5;
const ROOT_IP_LOCK_MS = 15 * 60 * 1000;
export const ROOT_GLOBAL_SLOW_AT = 20;
const ROOT_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
export const ROOT_GLOBAL_DELAY_MS = 3000;

const KIND = 'rootkey';
const IP_TTL_MS = 3600 * 1000;

/**
 * 某个根域的限速函数。
 * @param {{id:string, d1Binding:string}} realm 根域描述对象（网关：REALM_LOCK）
 */
export function rootLimiter(realm) {
  /**
   * 检查是否被限速。D1 出错时抛错（调用方返回 503）。
   * @param {any} env 网关 env（D1_LOCK_AUTH）
   * @param {string} ip
   * @returns {Promise<{limited:boolean, delayMs:number}>} delayMs：全局减速时比对前要等的毫秒数
   */
  async function checkRootLimit(env, ip) {
    const rec = await readAttempt(env, realm, KIND, ipBucket(ip)); /* 出错直接抛（含 D1 未绑定） */
    if (rec && rec.lockedUntil > Date.now()) {
      return { limited: true, delayMs: 0 };
    }
    const hot = await globalHot(env, realm, KIND, ROOT_GLOBAL_WINDOW_MS, ROOT_GLOBAL_SLOW_AT);
    return { limited: false, delayMs: hot ? ROOT_GLOBAL_DELAY_MS : 0 };
  }

  /**
   * 记录一次失败（原子）。D1 出错时抛错（调用方返回 503）。
   * @param {any} env
   * @param {string} ip
   * @param {{global?:boolean}} [opts] global=false：只计单 IP（无会话假入口用）
   */
  async function recordRootFail(env, ip, opts) {
    await recordAttempt(env, realm, KIND, ipBucket(ip), { max: ROOT_IP_MAX_FAIL, ttlMs: IP_TTL_MS, lockMs: ROOT_IP_LOCK_MS });
    if (opts && opts.global === false) return;
    await recordGlobal(env, realm, KIND, ROOT_GLOBAL_WINDOW_MS);
  }

  /**
   * 清除某 IP 的失败计数（成功后调用；失败不影响主流程）。
   * @param {any} env
   * @param {string} ip
   */
  async function clearRootFail(env, ip) {
    try { await clearAttempt(env, realm, KIND, ipBucket(ip)); } catch (e) {}
  }

  return Object.freeze({ checkRootLimit, recordRootFail, clearRootFail });
}
