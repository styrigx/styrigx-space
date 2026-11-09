/**
 * @fileoverview tty3（盾牌下拉 styrigx@space:~#）的命令表（终端统一 T4）：补全用的命令名和参数候选；分发仍由 shell/space/commands.js parseShieldCmd。
 */
export const TTY3_TABLE = Object.freeze({
  names: ['help', 'man', 'sudo', 'lock', 'passwd', 'passkey', 'exit', 'clear'],
  args: { sudo: ['styrigx'], passkey: ['add'], man: ['styrigx'] },
});
