/**
 * v6 身份统一（P1）：身份审计（account_user_audit 表）——只追加，保留 90 天。
 *
 * 记什么（定稿 v4 §十）：useradd / userdel / usermod / passwd、su、sudo、救援、登录失败，以及 root 的特权内容操作（root 改名片、批量 / 结构删除）。每行：做事的 uid（登录失败可能是 null）、
 * 命令、结果、时间、IP 前缀（不存完整 IP）。命令只记命令字和非秘密参数（用户名、组名、日期）；密码、一次性密码、恢复钥匙、
 * 令牌一律不进审计——调用方负责，这里再按命令字白名单拦一道、截长。
 * 旧的 account_audit（core/audit.js，30 天）原样不动，并存到 P4。
 *
 * P1 只提供写入函数和单测，还没有调用方（P2 / P3 的命令接上）。写入尽力而为：返回是否写进去，从不抛错。
 * 只 import lib/db.js 和 core/audit.js（ipPrefix 同一份）。
 */
import { onDb, sweepExpired } from '../lib/db.js';
import { ipPrefix } from './audit.js';

/** 保留期：90 天（Muse 复盘 5） */
export const USER_AUDIT_TTL_MS = 90 * 24 * 3600 * 1000;
/** 命令字白名单（审计行 command 的第一个词） */
export const USER_AUDIT_COMMANDS = Object.freeze(['useradd', 'userdel', 'usermod', 'passwd', 'passkey', 'su', 'sudo', 'exit', 'idle', 'lock', 'rescue', 'recovery-key', 'login-fail', 'expire',
  /* root 的特权内容操作（定稿 v4 §十：root 干的事都留痕）：root 改名片 profile、批量 / 结构删除 rm-bulk（P2 起账号侧；子站接口 Worker 接上新会话后同样写） */
  'profile', 'rm-bulk',
  /* 割接（v6 cutover）：root 的其他特权操作——代理订阅 sub、分享链接 share（网关）、奇趣导入 / 导出 import / export（子站经 AccountVerifier.auditRoot）；
     应用授权 app 随应用授权整套删除（v6 P4，定稿 v5.5 §十二） */
  'sub', 'share', 'import', 'export']);
/** command 最长字符数 */
export const USER_AUDIT_COMMAND_MAX = 200;

/**
 * 写一条身份审计。命令字不在白名单 → 不写（返回 false）。
 * @param {any} env
 * @param {{ uid: number|null, command: string, ok?: boolean, ip?: string }} entry
 * @returns {Promise<boolean>}
 */
export async function writeUserAudit(env, entry) {
  const command = entry && typeof entry.command === 'string' ? entry.command.trim().slice(0, USER_AUDIT_COMMAND_MAX) : '';
  if (USER_AUDIT_COMMANDS.indexOf(command.split(/\s+/)[0]) === -1) return false;
  const uid = entry && Number.isInteger(entry.uid) ? entry.uid : null;
  try {
    const now = Date.now();
    const id = now + ':' + Math.random().toString(36).slice(2, 10);
    await onDb(env, async (d) => {
      await d.prepare('INSERT INTO account_user_audit (id, ts, uid, command, ok, ip_prefix, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, now, uid, command, entry.ok === false ? 0 : 1, ipPrefix(entry.ip || ''), now + USER_AUDIT_TTL_MS).run();
      await sweepExpired(d, 'account_user_audit', now);
    });
    return true;
  } catch (e) {
    return false;
  }
}

/** 状态页审计卡读的命令（定稿 v5.5 §四「进站审计接口与状态页审计卡保留，恢复写入：记录 v6 的 su / sudo」）：su、sudo（定稿 §四 第 39 行；不读登录失败行，Gray 11-11 22:35）*/
const SU_SUDO_WHERE = "(command = 'su' OR command LIKE 'su %' OR command = 'sudo' OR command LIKE 'sudo %')";

/**
 * 状态页审计卡（GET /api/space-audit，网关经 AccountVerifier.auditList 读）：最近的 v6 su / sudo 审计，新的在前。
 * 字段按定稿 v5.5 §十 审计条：uid、命令、时间、IP 前缀（再加结果 ok）。只读；出错抛错（调用方 503）。
 * @param {any} env @param {{limit:number, since:number, now?:number}} q
 * @returns {Promise<Array<{ts:number, ipPrefix:string, ok:boolean, uid:number|null, command:string}>>}
 */
export async function listSuAudit(env, q) {
  const now = typeof q.now === 'number' ? q.now : Date.now();
  const limit = Math.max(1, Math.min(200, Math.floor(Number(q.limit) || 50)));
  const rows = await onDb(env, async (d) => ((await d.prepare('SELECT ts, uid, command, ok, ip_prefix FROM account_user_audit WHERE ts >= ? AND expires_at > ? AND ' +
    SU_SUDO_WHERE + ' ORDER BY ts DESC, id DESC LIMIT ?').bind(q.since, now, limit).all()).results) || []);
  return rows.map((r) => ({ ts: Number(r.ts), ipPrefix: String(r.ip_prefix || ''), ok: Number(r.ok) === 1, uid: r.uid === null || r.uid === undefined ? null : Number(r.uid), command: String(r.command || '') }));
}
