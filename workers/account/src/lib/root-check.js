/**
 * 根密钥（SGX_ACCOUNT_ROOT_KEY）校验：全站只有这一份实现（PR3「根凭证统一」）。
 *
 * 账号 Worker 里只有一条路径用它：POST /api/account 的 root-reauth / root-reset（identity/account-root.js），再按用途签账号短票。
 *
 * 本函数只做：共用限速检查（全局减速时先等）→ 恒定时间比对（两边去空白）→ 失败计数 + 审计 / 成功清计数。
 * 不签任何票，不读重置开关。fail closed：限速或计数 D1 出错一律 503。
 *
 * 失败响应与假入口逐字节相同（401 { ok:false, error:'auth' }）；传 padTo 时在返回前对齐耗时。
 *
 * 按域参数化：rootChecker(realm) 给出某个根域的校验函数，
 * 密值名取 realm.rootKey（方案 6.2：REALM_LOCK / REALM_ACCOUNT 各带 rootKey）、计数 / 审计经 realm.d1Binding（同一个域的 rootLimiter / rootAuditor）；本模块不认识具体的域。
 * 账号 identity/account-root.js 用账号库上的 REALM_ACCOUNT（SGX_ACCOUNT_ROOT_KEY、D1_ACCOUNT_AUTH）绑好再用。
 */
import { timingSafeEqual, normalizeRootKey } from './crypto.js';
import { rootLimiter } from './root-limit.js';
import { rootAuditor } from './root-audit.js';
import { apiError } from './http.js';

/**
 * 某个根域的校验函数。
 * @param {{id:string, d1Binding:string, rootKey:string}} realm 根域描述对象（REALM_ACCOUNT）
 */
export function rootChecker(realm) {
  const { checkRootLimit, recordRootFail, clearRootFail } = rootLimiter(realm);
  const { writeRootAudit } = rootAuditor(realm);

  /**
   * @param {object} o
   * @param {any} o.env
   * @param {string} o.ip
   * @param {string} o.key 用户输入的根凭证
   * @param {string} o.auditPath 审计 path（root-auth / account / lock-reset）
   * @param {() => Promise<void>} [o.padTo] 失败返回前对齐耗时（root-auth 用）
   * @returns {Promise<{ok:true}|{ok:false, response:Response}>}
   */
  async function checkRootCredential(o) {
    const { env, ip, auditPath } = o;
    const rootKey = (env && env[realm.rootKey]) || ''; /* SGX_ACCOUNT_ROOT_KEY */
    if (!rootKey || !(env && env[realm.d1Binding])) {
      return { ok: false, response: apiError(500, 'config') };
    }
    /* 限流检查：D1 出错一律拒绝（fail closed） */
    try {
      const lim = await checkRootLimit(env, ip);
      if (lim.limited) {
        await writeRootAudit(env, ip, false, { path: auditPath });
        return { ok: false, response: apiError(429, 'cooldown') };
      }
      if (lim.delayMs) await sleep(lim.delayMs);
    } catch (e) {
      return { ok: false, response: apiError(503, 'server') };
    }
    const key = typeof o.key === 'string' ? o.key : '';
    /* 两边都去掉空白字符后再比对；去空白后为空一律拒绝 */
    const ok = key && normalizeRootKey(key) && (await timingSafeEqual(normalizeRootKey(key), normalizeRootKey(rootKey)));
    if (!ok) {
      try {
        await recordRootFail(env, ip);
      } catch (e) {
        await writeRootAudit(env, ip, false, { path: auditPath });
        return { ok: false, response: apiError(503, 'server') };
      }
      /* 审计写入放在 padTo 之前：真失败与假入口耗时一致 */
      await writeRootAudit(env, ip, false, { path: auditPath });
      if (o.padTo) await o.padTo();
      return { ok: false, response: apiError(401, 'auth') };
    }
    /* 成功：清掉该 IP 的失败计数（失败不影响主流程） */
    await clearRootFail(env, ip);
    return { ok: true };
  }

  return Object.freeze({ checkRootCredential });
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}
