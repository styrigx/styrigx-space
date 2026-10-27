/**
 * 根凭证（SGX_ROOT_KEY）校验：全站只有这一份实现（PR3「根凭证统一」）。
 *
 * 用到根凭证的两条路径都走这里，再各自按用途签票：
 * - /api/root-auth   purpose=lock-reauth / lock-reset / account-reauth / account-reset
 *                    → 对应的 reset / reauth 票（by=root）；lock-reset 只在锁屏未设置时可用
 *                                      （「重置登录」：根凭证不是普通登录入口，只用来重置账号登录方式）
 * - /api/lock-reset  verify          → 重置开关有效：LockResetTicket(by=root)；
 *                                      否则 needAccount，再验账号凭证 → LockResetTicket(by=account)
 *
 * 本函数只做：共用限速检查（全局减速时先等）→ 恒定时间比对（两边去空白）→ 失败计数 + 审计 / 成功清计数。
 * 不签任何票，不读重置开关。fail closed：限速或计数 D1 出错一律 503。
 *
 * 失败响应与假入口逐字节相同（401 { ok:false, error:'auth' }）；传 padTo 时在返回前对齐耗时。
 */
import { timingSafeEqual, normalizeRootKey } from './crypto.js';
import { checkRootLimit, recordRootFail, clearRootFail } from './root-limit.js';
import { writeRootAudit } from './root-audit.js';
import { REALM_ROOT } from './realms.js';
import { apiError } from './http.js';

/**
 * @param {object} o
 * @param {any} o.env
 * @param {string} o.ip
 * @param {string} o.key 用户输入的根凭证
 * @param {string} o.auditPath 审计 path（root-auth / account / lock-reset）
 * @param {() => Promise<void>} [o.padTo] 失败返回前对齐耗时（root-auth 用）
 * @returns {Promise<{ok:true}|{ok:false, response:Response}>}
 */
export async function checkRootCredential(o) {
  const { env, ip, auditPath } = o;
  const rootKey = (env && env[REALM_ROOT.secret]) || ''; /* SGX_ROOT_KEY */
  if (!rootKey || !(env && env[REALM_ROOT.d1Binding])) {
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

/** @param {number} ms */
export function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}
