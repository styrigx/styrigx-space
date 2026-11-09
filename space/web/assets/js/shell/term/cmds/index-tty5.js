/**
 * @fileoverview tty5（账号下拉 login@account / root@account / reset@account）的命令表（终端统一 T4）：补全用的命令名和参数候选；
 * 分发仍由 shell/account/commands.js parseCmd；sub-*（代理订阅 P2）由 shell/account/proxy.js。
 */
export const TTY5_TABLE = Object.freeze({
  names: ['help', 'sudo', 'su', 'login', 'passwd', 'passkey', 'cd', 'exit', 'clear',
    'sub', 'sub-key', 'sub-link', 'sub-add', 'sub-upload', 'sub-mv', 'sub-on', 'sub-off', 'sub-rm', 'sub-refresh'],
  args: { sudo: ['root', '-i', '-v'], passkey: ['add'], cd: ['profile', 'devices', 'security', 'apps', '~', '..'] },
});
