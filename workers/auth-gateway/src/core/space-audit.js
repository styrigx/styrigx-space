/**
 * 进站凭证审计（所有进站凭证路径共用一套）。
 *
 * 从 space-auth.js 抽出，供 /api/space-auth、/api/lock-reset 共用。
 * 每次使用（成功/失败/被限流/假入口）都在 D1 audit 表留一行（realm = 'root'；2026-10-27 从 KV space-audit:* 搬来）：
 *   (realm, id, ts, ip_prefix, ok, decoy, via, path, expires_at)
 * 只记时间、IP 前缀和结果，保留 7 天（expires_at = ts + 7 天；过期行读时不认，写入时顺手清掉）。只追加，不改。
 * 不对前端暴露 decoy/via 标记。
 * 写入失败或 D1 未绑定时返回 false。成功路径（space-auth、lock-reset 签票前）据此 fail closed：写不进审计就 503、不签票；
 * 失败 / 限流路径只写不看返回值（本来就拒绝）。
 *
 * 按域参数化：spaceAuditor(realm) 给出某个根域的写 / 读审计函数，
 * 行的 realm 列 = realm.id、经 realm.d1Binding 读写；本模块不认识具体的域。本文件下半部分用 REALM_LOCK
 * （realm='lock'、D1_LOCK_AUTH；账号拆分 PR3 起进站凭证的审计归锁屏域，原来的 REALM_ROOT 已删）绑好再导出。
 */

import { onAuthDb, sweepExpired } from './d1-state.js';
import { REALM_LOCK } from './realms.js';

const AUDIT_TTL_MS = 7 * 24 * 3600 * 1000; /* 7 天 */

/**
 * IP 前缀（审计用，不存完整 IP）。
 * IPv4 取前 3 段，IPv6 取前 4 组，其他取前 12 字符。
 * @param {string} ip
 */
export function ipPrefix(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts.length >= 3 ? parts.slice(0, 3).join('.') + '.x' : ip;
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 4).join(':') + '::x';
  }
  return String(ip).slice(0, 12);
}

/**
 * 某个根域的审计函数。
 * @param {{id:string, d1Binding:string}} realm 根域描述对象（网关：REALM_LOCK）
 */
export function spaceAuditor(realm) {
  /**
   * 写审计记录（只追加）。
   * @param {any} env 网关 env（D1_LOCK_AUTH）
   * @param {string} ip 客户端 IP
   * @param {boolean} ok 是否成功
   * @param {object} [marks] 可选标记：{ decoy?: boolean, via?: string, path?: string }
   * @returns {Promise<boolean>} 是否写入成功
   */
  async function writeSpaceAudit(env, ip, ok, marks) {
    try {
      const now = Date.now();
      const id = now + ':' + Math.random().toString(36).slice(2, 10);
      const m = marks || {};
      await onAuthDb(env, realm, async function (db, r) {
        await db.prepare('INSERT INTO audit (realm, id, ts, ip_prefix, ok, decoy, via, path, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(r.id, id, now, ipPrefix(ip), ok ? 1 : 0, m.decoy ? 1 : 0, String(m.via || ''), String(m.path || ''), now + AUDIT_TTL_MS).run();
        await sweepExpired(db, 'audit', r.id, now);
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 最近 limit 条审计（新的在前；过期的不认）。只给前端时间、IP 前缀、结果。出错抛错。
   * @param {any} env @param {number} limit
   * @returns {Promise<Array<{ts:number, ipPrefix:string, ok:boolean}>>}
   */
  async function listSpaceAudit(env, limit) {
    const res = await onAuthDb(env, realm, (db, r) => db.prepare(
      'SELECT ts, ip_prefix, ok FROM audit WHERE realm = ? AND expires_at > ? ORDER BY ts DESC, id DESC LIMIT ?'
    ).bind(r.id, Date.now(), limit).all());
    return ((res && res.results) || []).map(function (v) { return { ts: Number(v.ts), ipPrefix: String(v.ip_prefix), ok: !!v.ok }; });
  }

  return Object.freeze({ writeSpaceAudit, listSpaceAudit });
}

/* ---------------- 网关绑定：锁屏域（原 _kernel/space-audit.js） ---------------- */

/**
 * 进站凭证审计（/api/space-auth、/api/lock-reset 写，/api/space-audit 读）。
 * 实现在本文件上半部分（按域参数化）；这里用 REALM_LOCK（D1 audit 表 realm='lock'、D1_LOCK_AUTH）绑好再导出。
 * 账号恢复密钥的审计在账号 Worker（D1 styrigx-account 的 account_audit，事件 reset-recovery-key），这里不读。
 * 只追加、保留 7 天；写不进去返回 false（成功路径据此 fail closed）。
 */
export const { writeSpaceAudit, listSpaceAudit } = spaceAuditor(REALM_LOCK);
