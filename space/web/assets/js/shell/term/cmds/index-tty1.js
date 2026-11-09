/**
 * @fileoverview tty1（锁屏）的白名单命令表（终端统一 T4，设计稿 v1.5 §2.1 / §5）：只给补全用的命令名和参数候选。
 * 锁屏只 import 这一份（不带 fs / ui / account / sub 的命令），分发仍由 shell/space/commands.js 的 parseEntryCmd / parseResetCmd 精确匹配。
 */

/** 锁屏命令行 entry@space:~$ */
export const TTY1_TABLE = Object.freeze({
  names: ['help', 'man', 'sudo', 'clear'],
  args: { sudo: ['styrigx'], man: ['styrigx'] },
});
/** 锁屏 reset 层 reset@space:~# */
export const TTY1_RESET_TABLE = Object.freeze({
  names: ['help', 'passwd', 'passkey', 'exit', 'clear'],
  args: { passkey: ['ls', 'add', 'rm'] },
});
