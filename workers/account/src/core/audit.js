/**
 * 账号审计（account_audit 表）：只追加，保留 30 天，只记时间、IP 前缀、结果和事件名。
 *
 * 事件名 = <接口>-<action>（看名字就知道是从哪个入口做的），全部小写、连字符：
 * - session-password / session-passkey、reauth-password / reauth-passkey（登录 / 再验证，成功失败都记，ok 列区分）
 * - password-cooldown（账号密码输错刚进入冷却；session 和 reauth 共用一个计数）
 * - reset-recovery-key（恢复密钥换 reset 票，成功失败都记）、reset-password-set、reset-passkey-add、reset-passkey-delete、
 *   reset-finish-all / reset-finish-others / reset-finish-none（sudo root reset 最后一步的登出选择）
 * - keys-password-set、keys-passkey-add、keys-passkey-delete、keys-passkey-rename
 * - devices-revoke、devices-revoke-all、grants-add、grants-revoke
 *
 * 没有读接口（命名 v2 Q3 删了列表接口）：要看就直接查 D1。写入尽力而为：返回是否写进去，从不抛错；
 * 只有恢复密钥换票这一处据此 fail closed（写不进审计就不签 reset 票，见 core/reset.js）。
 *
 * 只 import workers/account/src/lib/。
 */
import { onDb, sweepExpired } from '../lib/db.js';

/** 全部事件名 */
export const AUDIT_EVENTS = Object.freeze([
  'session-password', 'session-passkey',
  'reauth-password', 'reauth-passkey',
  'password-cooldown',
  'reset-recovery-key', 'reset-password-set', 'reset-passkey-add', 'reset-passkey-delete',
  'reset-finish-all', 'reset-finish-others', 'reset-finish-none',
  'keys-password-set', 'keys-passkey-add', 'keys-passkey-delete', 'keys-passkey-rename',
  'devices-revoke', 'devices-revoke-all',
  'grants-add', 'grants-revoke',
]);

/** 保留期 */
export const AUDIT_TTL_MS = 30 * 24 * 3600 * 1000;

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

/**
 * 写一条审计。不认识的事件名不写（返回 false）。
 * @param {any} env @param {string} ip @param {string} event AUDIT_EVENTS 之一 @param {boolean} [ok] 默认 true
 * @returns {Promise<boolean>} 是否写进去
 */
export async function writeAudit(env, ip, event, ok) {
  if (AUDIT_EVENTS.indexOf(event) === -1) return false;
  try {
    const now = Date.now();
    const id = now + ':' + Math.random().toString(36).slice(2, 10);
    await onDb(env, async (d) => {
      await d.prepare('INSERT INTO account_audit (id, ts, ip_prefix, ok, event, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, now, ipPrefix(ip), ok === false ? 0 : 1, event, now + AUDIT_TTL_MS).run();
      await sweepExpired(d, 'account_audit', now);
    });
    return true;
  } catch (e) {
    return false;
  }
}
