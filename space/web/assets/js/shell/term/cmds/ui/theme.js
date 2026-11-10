import { fill } from '../../core/out.js';

const MODES = ['dark', 'light', 'auto'];
/** theme [dark|light|auto]：不带参数打开外观面板 */
export default {
  name: 'theme',
  args: MODES,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a0 = (p.args[0] || '').toLowerCase();
    if (!a0) return { out: [x.k.arrow([['', x.S.themeOpen]])], after: function () { x.act.theme(''); } };
    if (MODES.indexOf(a0) < 0) return { out: [x.k.plain(x.S.usageTheme)] };
    x.act.theme(a0);
    return { out: [x.k.arrow(fill(x.S.themeSet, { x: ['k', a0] }))] };
  },
};
