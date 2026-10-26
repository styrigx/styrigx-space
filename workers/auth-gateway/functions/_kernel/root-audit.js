/**
 * 根凭证审计（所有 root 路径共用一套）。
 *
 * 从 root-auth.js 抽出，供 /api/root-auth、/api/lock-reset 共用。
 * 每次使用（成功/失败/被限流/假入口）都在 KV 留一条记录：
 *   root-audit:<ts>:<rand> = { ts, ipPrefix, ok, decoy?, via?, path? }
 * 只记时间、IP 前缀和结果，保留 7 天。不对前端暴露 decoy/via 标记。
 * 写入失败或无 KV 时返回 false。成功路径（root-auth、lock-reset 签票前）据此 fail closed：写不进审计就 503、不签票；
 * 失败 / 限流路径只写不看返回值（本来就拒绝）。
 */

import { REALM_ROOT } from './realms.js';

const AUDIT_TTL = 7 * 24 * 3600; /* 7 天 */
export const AUDIT_PREFIX = REALM_ROOT.kv.auditPrefix;

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
 * 写审计记录（只写不读）。
 * @param {any} kv
 * @param {string} ip 客户端 IP
 * @param {boolean} ok 是否成功
 * @param {object} marks 可选标记：{ decoy?: boolean, via?: string, path?: string }
 * @returns {Promise<boolean>} 是否写入成功
 */
export async function writeRootAudit(kv, ip, ok, marks) {
  if (!kv) return false;
  try {
    const key = AUDIT_PREFIX + Date.now() + ':' + Math.random().toString(36).slice(2, 10);
    const rec = { ts: Date.now(), ipPrefix: ipPrefix(ip), ok: !!ok };
    if (marks) {
      if (marks.decoy) rec.decoy = true;
      if (marks.via) rec.via = marks.via;
      if (marks.path) rec.path = marks.path;
    }
    await kv.put(key, JSON.stringify(rec), { expirationTtl: AUDIT_TTL });
    return true;
  } catch (e) {
    return false;
  }
}
