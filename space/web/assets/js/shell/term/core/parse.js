/**
 * @fileoverview 终端公共件（终端统一 T1，设计稿 v1.5 §4）：命令行归一、命令字、环境提示符。纯函数 / 常量，不 import。
 * shell/terminal.js、shell/space/commands.js、shell/account/commands.js 共用这一份（以前各抄一份）。
 */

/** `sudo root` 的命令字（账号终端） */
export const ROOT_COMMAND = 'root';
/** `sudo styrigx` 的命令字（进站 / 盾牌） */
export const ADMIN_COMMAND = 'styrigx';
/** 环境提示符：账号没登录 / 已登录 */
export const ENV_GUEST = 'styrigx@space';
export const ENV_ROOT = 'root@account';

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
