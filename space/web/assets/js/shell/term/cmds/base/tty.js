import { fill } from '../../core/out.js';

/** tty：显示当前 tty（站内终端 tty2，AI 窗口里的 $ 命令 tty4）；tty <n>：打开那个 tty 的宿主（2 站内终端、3 盾牌、4 AI、5 账号），不跳页 */
export default {
  name: 'tty',
  args: ['2', '3', '4', '5'],
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const n = p.args[0] || '';
    const me = x.tty || 'tty2';
    if (!n) return { out: [{ t: 'line', seg: [['', me]], cls: '' }] };
    if (p.args.length > 1 || ['2', '3', '4', '5'].indexOf(n) < 0) return { out: [x.k.plain(x.S.usageTty)] };
    if ('tty' + n === me || !x.act.tty) return { out: [{ t: 'line', seg: [['', me]], cls: '' }] };
    const res = x.act.tty(Number(n));
    return { out: [x.k.arrow(fill(x.S.opening, { x: ['k', 'tty' + n] }))], after: res && res.go };
  },
};
