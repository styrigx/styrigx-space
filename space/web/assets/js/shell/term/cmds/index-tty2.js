/**
 * @fileoverview tty2（主页首屏 + Ctrl K 抽屉）的命令表（终端统一 T3）。顺序 = help 顺序 = 补全顺序。T4 起按 tty 拆 index-tty1 / index-full。
 */
import help from './base/help.js';
import clear from './base/clear.js';
import cd from './fs/cd.js';
import ls from './fs/ls.js';
import cat from './fs/cat.js';
import sudo from './ui/sudo.js';
import theme from './ui/theme.js';
import lock from './ui/lock.js';
import ask from './ui/ask.js';

export const TTY2_CMDS = [help, cd, ls, cat, sudo, theme, lock, ask, clear];
