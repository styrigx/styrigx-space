/**
 * @fileoverview 终端公共件（终端统一 T1，设计稿 v1.5 §4）：命令行归一。纯函数 / 常量，不 import。
 * term/terminal.js 与各命令共用这一份。v6 P4 起旧命令字 sudo styrigx / sudo root 与旧环境提示符 root@account 随旧会话删除。
 */

/**
 * 命令行解析：小写、空白归一。
 * @param {string} s
 */
export function normCmd(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 一行命令 → 命令名 + 参数（只按空白切，不做管道 / 变量 / 通配符；空行 → null）
 * @param {string} line @returns {{cmd: string, args: string[], rest: string} | null}
 */
export function parse(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s) return null;
  const m = /^(\S+)\s*([\s\S]*)$/.exec(s);
  if (!m) return null;
  const rest = m[2].trim();
  return { cmd: m[1].toLowerCase(), args: rest ? rest.split(/\s+/) : [], rest: rest };
}
