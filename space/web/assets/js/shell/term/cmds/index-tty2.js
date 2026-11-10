/**
 * @fileoverview tty2（主页首屏 + Ctrl K 抽屉）的命令表（终端统一 T3）。顺序 = help 顺序 = 补全顺序。T4 起按 tty 拆 index-tty1 / index-full。
 */
import help from './base/help.js';
import clear from './base/clear.js';
import man from './base/man.js';
import open from './base/open.js';
import tty from './base/tty.js';
import pwd from './fs/pwd.js';
import cd from './fs/cd.js';
import ls from './fs/ls.js';
import cat from './fs/cat.js';
import sudo from './ui/sudo.js';
import theme from './ui/theme.js';
import lock from './ui/lock.js';
import ask from './ui/ask.js';
import find from './ui/find.js';
import { SUB_CMDS } from './sub/index.js';

export const TTY2_CMDS = [help, cd, ls, cat, sudo, theme, lock, ask, find, clear, man, pwd, open, tty].concat(SUB_CMDS);
/* man 的参数补全 = 这张表的命令名 */
man.args = TTY2_CMDS.map(function (c) { return c.name; });
