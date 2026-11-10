/**
 * @fileoverview 终端的命令表（v5 S5 终端合一：锁屏 tty1、主页 tty2、盾牌 tty3、账号 tty5 合成一张；AI 窗口 tty4 里的 $ 命令也用这张）。
 * 顺序 = man 索引顺序 = 补全顺序。v6 身份命令（P2b，cmds/ident）排最后，只给 v6 身份列（旧身份的 man 不变）。哪些身份列哪些命令由各命令的 audience 决定（core/who.js listedFor，唯一判断点）。
 */
import man from './base/man.js';
import open from './base/open.js';
import clear from './base/clear.js';
import history from './base/history.js';
import exit from './base/exit.js';
import cd from './fs/cd.js';
import ls from './fs/ls.js';
import cat from './fs/cat.js';
import pwd from './fs/pwd.js';
import theme from './ui/theme.js';
import ask from './ui/ask.js';
import find from './ui/find.js';
import sudo from './keys/sudo.js';
import lock from './keys/lock.js';
import share from './keys/share.js';
import { ACCOUNT_CMDS } from './acct/index.js';
import { SUB_CMD } from './sub/index.js';
import { IDENT_CMDS } from './ident/index.js';

export const CMDS = [man, open, cd, ls, cat, clear, history, exit, pwd, theme, find, ask, sudo, lock, share].concat(ACCOUNT_CMDS, [SUB_CMD], IDENT_CMDS);
/* man 的参数补全 = 这张表的命令名 */
man.args = CMDS.map(function (c) { return c.name; });
