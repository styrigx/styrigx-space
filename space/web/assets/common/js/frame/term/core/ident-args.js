/**
 * @fileoverview v6 身份命令的参数（P2b）：纯函数，终端命令（cmds/ident、keys/sudo.js）和身份层（identity/layer.js）共用。
 * 写法同 私密库 styrigx/space-tasks 的 v6-identity-migration.md 的命令手册；服务端（workers/account/src/api/identity.js）再判一次。
 */

/** 用户名（同服务端 USER_NAME_RE） */
export const USER_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
/** sudo 能借 root 跑的命令（同服务端 SUDO_COMMANDS 的终端写法） */
export const SUDO_CMDS = Object.freeze(['useradd', 'userdel', 'usermod', 'passwd', 'groups', 'who']);

/**
 * useradd 的参数：<名> [-e YYYY-MM-DD] [-G 组,组]（顺序随意）。不合法 → null。
 * @param {string[]} a @returns {{name: string, expire?: string, groups?: string[]}|null}
 */
export function parseUseradd(a) {
  /** @type {{name: string, expire?: string, groups?: string[]}} */
  const r = { name: '' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-e') { if (!/^\d{4}-\d{2}-\d{2}$/.test(a[i + 1] || '')) return null; r.expire = a[++i]; continue; }
    if (a[i] === '-G') { if (!a[i + 1]) return null; r.groups = a[++i].split(',').filter(Boolean); continue; }
    if (r.name || a[i].charAt(0) === '-') return null;
    r.name = a[i];
  }
  return r.name ? r : null;
}

/** usermod -aG|-rG <组[,组]> <名> → { op, groups, name }；不合法 → null @param {string[]} a */
export function parseUsermod(a) {
  if (a.length !== 3 || (a[0] !== '-aG' && a[0] !== '-rG')) return null;
  const groups = a[1].split(',').filter(Boolean);
  return groups.length ? { op: a[0], groups: groups, name: a[2] } : null;
}

/**
 * sudo <命令…> → 服务端的 command 对象（不认识 → null）。passwd 只认 passwd <名>（sudo passwd 自己 / root 由服务端回 root-creds）。
 * @param {string[]} a
 */
export function sudoCommand(a) {
  const c = a[0] || '';
  const rest = a.slice(1);
  if (c === 'useradd') { const u = parseUseradd(rest); return u ? Object.assign({ action: 'useradd' }, u) : null; }
  if (c === 'userdel') return rest.length === 1 ? { action: 'userdel', name: rest[0] } : null;
  if (c === 'usermod') { const m = parseUsermod(rest); return m ? Object.assign({ action: 'usermod' }, m) : null; }
  if (c === 'passwd') return rest.length === 1 ? { action: 'passwd-user', name: rest[0] } : { action: 'passwd' };
  if (c === 'groups') return rest.length <= 1 ? { action: 'groups', user: rest[0] || '' } : null;
  if (c === 'who') return rest.length === 0 ? { action: 'who' } : null;
  return null;
}

