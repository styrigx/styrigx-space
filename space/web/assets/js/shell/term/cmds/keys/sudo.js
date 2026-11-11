import { ROOT_COMMAND, ADMIN_COMMAND } from '../../core/parse.js';
import { gate, layer, notHere, line, FLOW } from './gate.js';
import { isV6, v6Name } from '../../core/who.js';
import { fill } from '../../core/out.js';
import { SUDO_CMDS } from '../../core/ident-args.js';

/**
 * sudo（v5 S5，term-design-v5「钥匙」「账号」）：
 * - sudo styrigx：进站（终端里验证：解锁密码 / 通行密钥 → 终端收起 → 原进站动画 → 回原页）；已进站就提示 sudo -v
 * - sudo styrigx reset：恢复钥匙 → reset 层（reset@space:~#，不变）
 * - sudo root：登录账号（要先进站）；sudo root reset：账号恢复密钥 → reset@account:~#；sudo root reauth：账号再验证（原样保留）
 * - sudo -v：再验证当前这一层（root@account → 账号，styrigx@space → 钥匙；分享链接进来的不能 reauth）
 * - v6（P2b）：sudo useradd | userdel | usermod | passwd <名> | groups [名] | who → 身份层（shell/identity/layer.js）：每次输自己的凭据、借 root 跑这一条、不压栈。
 *   上面几种旧写法原样（分步割接），两套写法的第一个词不重叠。
 */
export default {
  name: 'sudo',
  args: [ADMIN_COMMAND, ROOT_COMMAND, '-v'],
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a0 = (p.args[0] || '').toLowerCase();
    const a1 = (p.args[1] || '').toLowerCase();
    const w = x.who();
    /* 割接（定稿 §十「sudo 不能动 root 的凭据：为 root 增删通行密钥一律拒」）：v6 会话里 sudo passkey … 交给身份层回 rootCreds（同 sudo passwd） */
    if (SUDO_CMDS.indexOf(a0) !== -1 || (a0 === 'passkey' && isV6(w))) {
      const I = layer(x, /** @type {any} */ ('ident'));
      if (!I) return notHere(x, 'sudo ' + p.args.join(' '));
      I.cmdSudo([a0].concat(p.args.slice(1)));
      return FLOW;
    }
    /* #404 未决项第 2 项（Gray 11-11 15:37）：sudo sub / sudo app 前端不支持——v6 的跑法是 su root 后直接用（sub / app 是 root 直通，#401 / #402） */
    if (a0 === 'sub' || a0 === 'app') return { out: [line(x, 'sudoNotYet', a0)] };
    /* #404 未决项第 3 项：v6 身份输已移除的 sudo -v / sudo root reauth（定稿 §十三 P4 删、v6-commands「删除」）——印一行 v6 做法，不落旧层的 notHere；P4 连命令一起删 */
    if (isV6(w) && a0 === '-v' && !a1) return { out: [x.k.plain(x.S.goneSudoV, 'err')] };
    if (isV6(w) && a0 === ROOT_COMMAND && a1 === 'reauth') return { out: [x.k.plain(x.S.goneSudoReauth, 'err')] };
    if (p.args.length > 2 || (a0 === '-v' && a1)) return { out: [x.k.plain(x.S.usageSudo)] };
    if (a0 === ADMIN_COMMAND && (a1 === '' || a1 === 'reset')) {
      const S = layer(x, 'space');
      if (!S) return notHere(x, 'sudo ' + ADMIN_COMMAND);
      if (a1 === 'reset') { S.cmdReset(); return FLOW; }
      /* 割接：已经以 v6 用户登录 → 同身份层「已经以 <名> 登录 · 先 exit」（定稿 §六：要换用户先 exit；sudo -v 在 v6 删除，不再指向它） */
      if (isV6(w)) return { out: [{ t: 'line', seg: fill(x.S.exitFirst, { u: ['', v6Name(w)], x: ['k', 'exit'] }), cls: 'err' }] };
      if (w !== 'nobody') return { out: [line(x, 'alreadyIn', 'sudo -v')] };
      S.unlock();
      return FLOW;
    }
    if (a0 === ROOT_COMMAND && (a1 === '' || a1 === 'reset' || a1 === 'reauth')) {
      const no = gate(x, 'entered');
      if (no) return no;
      const A = layer(x, 'acct');
      if (!A) return notHere(x, 'sudo ' + ROOT_COMMAND);
      if (a1 === 'reset') A.cmdReset();
      else if (a1 === 'reauth') A.cmdReauth();
      else A.cmdSession();
      return FLOW;
    }
    if (a0 === '-v') {
      const no = gate(x, 'keys');
      if (no) return no;
      const R = layer(x, w === 'root' ? 'acct' : 'space');
      if (!R) return notHere(x, 'sudo -v');
      R.cmdReauth();
      return FLOW;
    }
    return { out: [x.k.plain(x.S.usageSudo)] };
  },
};
