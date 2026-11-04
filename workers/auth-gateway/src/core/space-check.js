/**
 * 进站凭证（SGX_LOCK_SPACE_KEY）校验：网关里只有这一份实现。
 *
 * 用到进站凭证的两条路径都走这里，再各自按用途签票：
 * - /api/space-auth   purpose=lock-reauth / lock-reset → 对应的锁屏短票（by=space）；lock-reset 只在锁屏未设置时可用
 * - /api/lock-reset  verify → 重置开关有效：LockResetTicket(by=space)；否则 needLock，再验锁屏凭证 → LockResetTicket(by=password|passkey)
 *
 * 本函数只做：共用限速检查（全局减速时先等）→ 恒定时间比对（两边去空白）→ 失败计数 + 审计 / 成功清计数。
 * 不签任何票，不读重置开关。fail closed：限速或计数 D1 出错一律 503。
 *
 * 失败响应与假入口逐字节相同（401 { ok:false, error:'auth' }）；传 padTo 时在返回前对齐耗时。
 *
 * 按域参数化：spaceChecker(realm) 给出某个根域的校验函数，
 * 密值名取 realm.spaceKey（方案 6.2：网关 REALM_LOCK.spaceKey = SGX_LOCK_SPACE_KEY；账号 Worker 自己一份同形代码用 SGX_ACCOUNT_ROOT_KEY）、计数 / 审计经 realm.d1Binding（同一个域的 spaceLimiter / spaceAuditor）；本模块不认识具体的域。
 * 本文件下半部分用 REALM_LOCK（SGX_LOCK_SPACE_KEY、D1_LOCK_AUTH）绑好再导出。
 */
import { timingSafeEqual, normalizeSpaceKey } from '../lib/crypto.js';
import { spaceLimiter } from './space-limit.js';
import { spaceAuditor } from './space-audit.js';
import { apiError } from '../lib/http.js';
import { REALM_LOCK } from './realms.js';

/**
 * 某个根域的校验函数。
 * @param {{id:string, d1Binding:string, spaceKey:string}} realm 根域描述对象（REALM_LOCK）
 */
export function spaceChecker(realm) {
  const { checkSpaceLimit, recordSpaceFail, clearSpaceFail } = spaceLimiter(realm);
  const { writeSpaceAudit } = spaceAuditor(realm);

  /**
   * @param {object} o
   * @param {any} o.env
   * @param {string} o.ip
   * @param {string} o.key 用户输入的进站凭证
   * @param {string} o.auditPath 审计 path（space-auth / account / lock-reset）
   * @param {() => Promise<void>} [o.padTo] 失败返回前对齐耗时（space-auth 用）
   * @returns {Promise<{ok:true}|{ok:false, response:Response}>}
   */
  async function checkSpaceCredential(o) {
    const { env, ip, auditPath } = o;
    const spaceKey = (env && env[realm.spaceKey]) || ''; /* SGX_LOCK_SPACE_KEY */
    if (!spaceKey || !(env && env[realm.d1Binding])) {
      return { ok: false, response: apiError(500, 'config') };
    }
    /* 限流检查：D1 出错一律拒绝（fail closed） */
    try {
      const lim = await checkSpaceLimit(env, ip);
      if (lim.limited) {
        await writeSpaceAudit(env, ip, false, { path: auditPath });
        return { ok: false, response: apiError(429, 'cooldown') };
      }
      if (lim.delayMs) await sleep(lim.delayMs);
    } catch (e) {
      return { ok: false, response: apiError(503, 'server') };
    }
    const key = typeof o.key === 'string' ? o.key : '';
    /* 两边都去掉空白字符后再比对；去空白后为空一律拒绝 */
    const ok = key && normalizeSpaceKey(key) && (await timingSafeEqual(normalizeSpaceKey(key), normalizeSpaceKey(spaceKey)));
    if (!ok) {
      try {
        await recordSpaceFail(env, ip);
      } catch (e) {
        await writeSpaceAudit(env, ip, false, { path: auditPath });
        return { ok: false, response: apiError(503, 'server') };
      }
      /* 审计写入放在 padTo 之前：真失败与假入口耗时一致 */
      await writeSpaceAudit(env, ip, false, { path: auditPath });
      if (o.padTo) await o.padTo();
      return { ok: false, response: apiError(401, 'auth') };
    }
    /* 成功：清掉该 IP 的失败计数（失败不影响主流程） */
    await clearSpaceFail(env, ip);
    return { ok: true };
  }

  return Object.freeze({ checkSpaceCredential });
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/* ---------------- 网关绑定：锁屏域（原 _kernel/space-check.js） ---------------- */

/**
 * 进站凭证（SGX_LOCK_SPACE_KEY）校验：网关里只有这一份实现。
 * 实现在本文件上半部分（按域参数化）；这里用 REALM_LOCK（spaceKey = SGX_LOCK_SPACE_KEY，计数 / 审计经 D1_LOCK_AUTH，realm='lock'）绑好再导出。
 * 用到进站凭证的两条路径（/api/space-auth、/api/lock-reset verify）都走这里，再各自按用途签票；本函数不签票、不读重置开关。
 */
export const { checkSpaceCredential } = spaceChecker(REALM_LOCK);
