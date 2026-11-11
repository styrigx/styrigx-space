import { layer, notHere, line, needSu, FLOW } from './gate.js';
import { isV6 } from '../../core/who.js';
import { SUDO_CMDS } from '../../core/ident-args.js';

/**
 * sudo（v6，定稿 v5.2 §六：sudoers 用户每次输自己的凭据，借 root 执行一条，不发票据，不压栈）：
 * sudo useradd | userdel | usermod | passwd <名> | groups [名] | who → 身份层（shell/identity/layer.js）。
 * sudo passkey … → 身份层回 rootCreds（定稿 §十：sudo 不能动 root 的凭据）。
 * #404 未决项（Gray 11-11 15:37 定稿文案）：sudo sub / sudo app → sudoNotYet；已移除的 sudo -v / sudo root reauth → 一行「已移除 · v6 做法」
 * （v6 P4 起旧命令本身删了；访客照旧先提示 su）。旧写法 sudo styrigx [reset] / sudo root [reset] 随旧会话删除（定稿 §十三 P4），落到用法行。
 */
export default {
  name: 'sudo',
  args: [],
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a0 = (p.args[0] || '').toLowerCase();
    const a1 = (p.args[1] || '').toLowerCase();
    if (SUDO_CMDS.indexOf(a0) !== -1 || (a0 === 'passkey' && isV6(x.who()))) {
      const I = layer(x, /** @type {any} */ ('ident'));
      if (!I) return notHere(x, 'sudo ' + p.args.join(' '));
      I.cmdSudo([a0].concat(p.args.slice(1)));
      return FLOW;
    }
    if (a0 === 'sub' || a0 === 'app') return { out: [line(x, 'sudoNotYet', a0)] };
    /* 访客输旧的 sudo -v / sudo root …：同 main，先提示 su（main 的 gate） */
    if ((a0 === '-v' || a0 === 'root') && !isV6(x.who())) return { out: [needSu(x)] };
    if (a0 === '-v' && !a1) return { out: [x.k.plain(x.S.goneSudoV, 'err')] };
    if (a0 === 'root' && a1 === 'reauth' && p.args.length === 2) return { out: [x.k.plain(x.S.goneSudoReauth, 'err')] };
    return { out: [x.k.plain(x.S.usageSudo)] };
  },
};
