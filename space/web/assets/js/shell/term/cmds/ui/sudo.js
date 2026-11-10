import { ROOT_COMMAND, ADMIN_COMMAND } from '../../core/parse.js';
import { fill } from '../../core/out.js';

/** sudo root [reauth|reset]：账号终端；sudo styrigx：盾牌（T6 改成原地验证） */
export default {
  name: 'sudo',
  args: [ROOT_COMMAND, ADMIN_COMMAND],
  /** @param {any} x */
  help: function (x) { return [['sudo ' + ROOT_COMMAND, x.S.dAccount], ['sudo ' + ADMIN_COMMAND, x.S.dSecurity]]; },
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a0 = (p.args[0] || '').toLowerCase();
    const a1 = (p.args[1] || '').toLowerCase();
    const okRoot = a0 === ROOT_COMMAND && (a1 === '' || a1 === 'reauth' || a1 === 'reset') && p.args.length <= 2;
    if (!okRoot && !(a0 === ADMIN_COMMAND && p.args.length === 1)) return { out: [x.k.plain(x.S.usageSudo)] };
    const r = x.act.sudo(a0, a1);
    return { out: [x.k.arrow(fill(x.S.opening, { x: ['k', r.href] }))], after: r.go };
  },
};
