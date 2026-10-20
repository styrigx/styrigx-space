/**
 * 根凭证（SGX_ROOT_KEY）校验：全站只有这一份实现（PR3「根凭证统一」）。
 *
 * 用到根凭证的两条路径都走这里，再各自按用途签票：
 * - /api/root-auth   purpose=lock    → 锁屏门票 sgx-door(door=lock, by=root)（含锁屏未配置的引导）
 *                    purpose=account → 账号会话 sgx-account(by=root) + 账号门票 sgx-door(door=account, by=root)
 *                                      （「重置登录」：根凭证不再是普通登录入口，只用来重置账号登录方式）
 * - /api/lockreset   verify          → 恢复开关有效：重置锁屏门票(by=root)；
 *                                      否则 needOwner，再验账号凭证 → 重置锁屏门票(by=account+root)
 *
 * 本函数只做：共用限速检查 → 恒定时间比对（两边去空白）→ 失败计数 + 审计 / 成功清计数。
 * 不签任何票，不读恢复开关。fail closed：限速或计数 KV 出错一律 503。
 *
 * 失败响应与假入口逐字节相同（401 { ok:false, error:'auth' }）；传 padTo 时在返回前对齐耗时。
 */
import { timingSafeEqual, normalizeRootKey } from './crypto.js';
import { checkRootLimit, recordRootFail, clearRootFail } from './rootlimit.js';
import { writeRootAudit } from './rootlog.js';
import { REALM_ROOT } from './realms.js';

/**
 * @param {object} o
 * @param {any} o.env
 * @param {any} o.kv OWNER_KV
 * @param {string} o.ip
 * @param {string} o.key 用户输入的根凭证
 * @param {string} o.auditPath 审计 path（root-auth / account / lockreset）
 * @param {() => Promise<void>} [o.padTo] 失败返回前对齐耗时（root-auth 用）
 * @returns {Promise<{ok:true}|{ok:false, response:Response}>}
 */
export async function checkRootCredential(o) {
  const { env, kv, ip, auditPath } = o;
  const rootKey = (env && env[REALM_ROOT.secret]) || ''; /* SGX_ROOT_KEY */
  if (!rootKey || !kv) {
    return { ok: false, response: Response.json({ ok: false, error: 'config' }, { status: 500 }) };
  }
  /* 限流检查：KV 出错一律拒绝（fail closed） */
  try {
    const lim = await checkRootLimit(kv, ip);
    if (lim.limited) {
      await writeRootAudit(kv, ip, false, { path: auditPath });
      return { ok: false, response: Response.json({ ok: false, error: 'locked' }, { status: 429 }) };
    }
  } catch (e) {
    return { ok: false, response: Response.json({ ok: false, error: 'server' }, { status: 503 }) };
  }
  const key = typeof o.key === 'string' ? o.key : '';
  /* 两边都去掉空白字符后再比对；去空白后为空一律拒绝 */
  const ok = key && normalizeRootKey(key) && (await timingSafeEqual(normalizeRootKey(key), normalizeRootKey(rootKey)));
  if (!ok) {
    try {
      await recordRootFail(kv, ip);
    } catch (e) {
      await writeRootAudit(kv, ip, false, { path: auditPath });
      return { ok: false, response: Response.json({ ok: false, error: 'server' }, { status: 503 }) };
    }
    /* 审计写入放在 padTo 之前：真失败与假入口耗时一致 */
    await writeRootAudit(kv, ip, false, { path: auditPath });
    if (o.padTo) await o.padTo();
    return { ok: false, response: Response.json({ ok: false, error: 'auth' }, { status: 401 }) };
  }
  /* 成功：清掉该 IP 的失败计数（失败不影响主流程） */
  await clearRootFail(kv, ip);
  return { ok: true };
}
