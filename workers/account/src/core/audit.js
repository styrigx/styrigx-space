/**
 * 旧账号审计（account_audit 表）的写入随旧账号会话删除（v6 清理 #11/#12：writeAudit 没有调用方）；v6 的 su / sudo 审计在 core/user-audit.js。
 * 这里只剩共用的 IP 前缀（user-audit.js、rpc/account-verifier.js 用同一份）。
 *
 * 不 import 任何模块。
 */
/**
 * IP 前缀（不存完整 IP）：IPv4 取前 3 段，IPv6 取前 4 组，其他取前 12 字符。
 * @param {string} ip
 */
export function ipPrefix(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts.length >= 3 ? parts.slice(0, 3).join('.') + '.x' : ip;
  }
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::x';
  return String(ip).slice(0, 12);
}
