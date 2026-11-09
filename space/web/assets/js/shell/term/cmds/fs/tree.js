/**
 * @fileoverview 虚拟目录（终端统一 T3；T6 扩成设计稿 §8.3 的整棵树）：现在只有 ~ 和四个站的目录。
 */

/** 目录（ls 的结果，cd 的目标；wild = 旷野） */
export const DIRS = ['blog', 'curio', 'daymark', 'wild'];

/**
 * cd 的参数 → 目标目录（'~' 或 DIRS 之一）；不认识 → null
 * @param {string} cwd 当前目录（'~' 或 DIRS 之一） @param {string} [arg]
 * @returns {string|null}
 */
export function normDir(cwd, arg) {
  let a = String(arg == null ? '' : arg).trim();
  if (!a || a === '~' || a === '/' || a === '~/') return '~';
  a = a.replace(/^~\//, '').replace(/^\.\//, '').replace(/\/+$/, '');
  if (a === '..' || a === '.') return a === '.' ? (cwd || '~') : '~';
  const up = /^\.\.\/(.+)$/.exec(a);
  if (up) a = up[1];
  a = a.toLowerCase();
  return DIRS.indexOf(a) >= 0 ? a : null;
}
