import { fill } from '../../core/out.js';

/** tty：显示当前 tty（这里是 tty2）；tty <n>：打开那个 tty 的宿主（3 盾牌、4 AI、5 账号、2 本终端），不跳页 */
export default {
  name: 'tty',
  args: ['2', '3', '4', '5'],
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const n = p.args[0] || '';
    if (!n) return { out: [{ t: 'line', seg: [['', 'tty2']], cls: '' }] };
    if (p.args.length > 1 || ['2', '3', '4', '5'].indexOf(n) < 0) return { out: [x.k.plain(x.S.usageTty)] };
    if (n === '2' || !x.act.tty) return { out: [{ t: 'line', seg: [['', 'tty2']], cls: '' }] };
    const res = x.act.tty(Number(n));
    return { out: [x.k.arrow(fill(x.S.opening, { x: ['k', 'tty' + n] }))], after: res && res.go };
  },
};
